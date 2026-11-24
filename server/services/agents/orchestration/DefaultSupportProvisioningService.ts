import { eq, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { aiAgentConfigsTable, supportAgentTemplatesTable } from '../../../models/aiAgentConfigs/schema.js';
import {
  supportPlaybookAssignmentsTable,
  supportPlaybooksTable,
  supportPlaybookVersionsTable,
  supportPlaybookTemplatesTable,
  type PlaybookGraph,
} from '../../../models/supportOrchestration/schema.js';
import { recordSupportAdminAudit } from './SupportAdminAuditService.js';
import { playbookChecksum, validatePlaybookGraph } from './PlaybookEngine.js';
import {
  DEFAULT_SUPPORT_PLAYBOOKS,
  enforceMandatoryAgentControls,
} from './DefaultSupportConfiguration.js';
import { ensureDefaultSupportTemplates } from './SupportPlaybookTemplateService.js';
import { ensureDefaultSupportAgentTemplates } from './SupportAgentTemplateService.js';
import { canonicalJson as stableJson } from '../../../utils/canonicalJson.js';

export interface DefaultSupportProvisioningResult {
  agentsCreated: number;
  agentsSafetyUpdated: number;
  agentsTemplateRepaired: number;
  playbooksCreated: number;
  assignmentsCreated: number;
  skippedExistingPlaybooks: number;
}

/**
 * Migration 147 introduced managed templates after some installations had
 * already seeded bare ai_agent_configs rows. Those rows have no provenance and
 * an empty tool set, so they silently disable the specialist at runtime even
 * though the current template is complete. Keep this deliberately narrow: a
 * real owner-authored configuration must never be mistaken for a legacy seed.
 */
export function isLegacyUnlinkedAgentConfig(config: {
  templateMode?: string | null;
  templateVersion?: number | null;
  toolsEnabled?: unknown;
  modelOverride?: string | null;
  metadata?: unknown;
}): boolean {
  const metadata = config.metadata && typeof config.metadata === 'object' && !Array.isArray(config.metadata)
    ? config.metadata as Record<string, unknown>
    : {};
  return config.templateMode === 'custom'
    && config.templateVersion == null
    && Array.isArray(config.toolsEnabled)
    && config.toolsEnabled.length === 0
    && !config.modelOverride
    && metadata.mandatoryControlProfileVersion === 1;
}

function templateKey(graph: PlaybookGraph | null | undefined): string | null {
  const key = graph?.metadata?.templateKey;
  return typeof key === 'string' && key.trim() ? key : null;
}

/**
 * Creates the safe starter configuration for one application owner.
 *
 * The operation is serialized per owner and only inserts missing records. It
 * never republishes, re-enables, renames, or rewrites a playbook/configuration
 * that an owner may have customized.
 */
export async function ensureDefaultSupportConfiguration(
  userId: number,
): Promise<DefaultSupportProvisioningResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('A valid owner user ID is required.');

  await ensureDefaultSupportTemplates();
  await ensureDefaultSupportAgentTemplates();

  for (const playbook of DEFAULT_SUPPORT_PLAYBOOKS) {
    const errors = validatePlaybookGraph(playbook.graph);
    if (errors.length > 0) {
      throw new Error(`Default playbook ${playbook.key} is invalid: ${errors.join(' ')}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    // A two-key lock avoids collisions with application-level locks that use a
    // single integer and makes concurrent first-page loads deterministic.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260722, ${userId})`);

    let agentsCreated = 0;
    let agentsSafetyUpdated = 0;
    let agentsTemplateRepaired = 0;
    let playbooksCreated = 0;
    let assignmentsCreated = 0;
    let skippedExistingPlaybooks = 0;

    const existingAgentConfigs = await tx.select().from(aiAgentConfigsTable)
      .where(eq(aiAgentConfigsTable.userId, userId));
    type ExistingAgentConfig = typeof aiAgentConfigsTable.$inferSelect;
    const agentTemplates = await tx.select().from(supportAgentTemplatesTable);
    const orderedExisting = [...existingAgentConfigs].sort((left, right) =>
      (left.priority ?? 10) - (right.priority ?? 10) || left.id - right.id,
    );
    const enabledExisting = orderedExisting.filter((config) => config.enabled);
    let activeConfig = enabledExisting[0]
      || orderedExisting.find((config) => config.agentType === 'general_service')
      || orderedExisting[0]
      || null;

    // Provisioning is also the repair boundary for legacy/corrupt tenants.
    // Keep the deterministic winner and audit every state repaired here.
    for (const config of enabledExisting.slice(1)) {
      const [updated] = await tx.update(aiAgentConfigsTable).set({ enabled: false, updatedAt: new Date() })
        .where(eq(aiAgentConfigsTable.id, config.id)).returning();
      await recordSupportAdminAudit(tx, {
        userId, actorType: 'system', action: 'agent_config.single_active_repaired',
        entityType: 'ai_agent_config', entityId: config.id,
        beforeState: config, afterState: updated,
        metadata: { retainedAgentType: activeConfig?.agentType ?? null },
      });
    }
    if (activeConfig && !activeConfig.enabled) {
      const before = activeConfig;
      const [updated] = await tx.update(aiAgentConfigsTable).set({ enabled: true, updatedAt: new Date() })
        .where(eq(aiAgentConfigsTable.id, activeConfig.id)).returning();
      activeConfig = updated;
      await recordSupportAdminAudit(tx, {
        userId, actorType: 'system', action: 'agent_config.missing_active_repaired',
        entityType: 'ai_agent_config', entityId: updated.id,
        beforeState: before, afterState: updated,
        metadata: { agentType: updated.agentType },
      });
    }
    const fallbackTemplate = [...agentTemplates].sort((left, right) =>
      left.priority - right.priority || left.id - right.id,
    )[0];
    const activeAgentType = activeConfig?.agentType
      || agentTemplates.find((template: typeof supportAgentTemplatesTable.$inferSelect) => template.agentType === 'general_service')?.agentType
      || fallbackTemplate?.agentType;
    const existingAgentsByType = new Map<string, ExistingAgentConfig>(
      (existingAgentConfigs as ExistingAgentConfig[]).map(
        (config: ExistingAgentConfig) => [config.agentType, {
          ...config,
          enabled: config.id === activeConfig?.id,
        }],
      ),
    );

    for (const profile of agentTemplates as Array<typeof supportAgentTemplatesTable.$inferSelect>) {
      const existing = existingAgentsByType.get(profile.agentType);
      if (existing) {
        const controls = enforceMandatoryAgentControls(
          profile.agentType,
          existing.escalationRules,
          existing.metadata,
        );
        const nextRules = controls.escalationRules;
        const nextMetadata = controls.metadata;
        const repairTemplateLink = isLegacyUnlinkedAgentConfig({ ...existing, metadata: nextMetadata });
        if (stableJson(existing.escalationRules) !== stableJson(nextRules)
          || stableJson(existing.metadata) !== stableJson(nextMetadata)
          || repairTemplateLink) {
          const [updated] = await tx.update(aiAgentConfigsTable).set({
            escalationRules: nextRules,
            metadata: nextMetadata,
            ...(repairTemplateLink ? {
              toolsEnabled: profile.toolsEnabled,
              channelScope: profile.channelScope,
              priority: profile.priority,
              templateVersion: profile.version,
              // Preserve the legacy prompt, enabled state, and training data.
              // The owner can explicitly reset the whole record to managed.
              templateMode: 'customized',
            } : {}),
            updatedAt: new Date(),
          }).where(eq(aiAgentConfigsTable.id, existing.id)).returning();
          agentsSafetyUpdated += 1;
          if (repairTemplateLink) agentsTemplateRepaired += 1;
          await recordSupportAdminAudit(tx, {
            userId,
            actorType: 'system',
            action: repairTemplateLink
              ? 'agent_config.legacy_template_repaired'
              : 'agent_config.mandatory_controls_applied',
            entityType: 'ai_agent_config',
            entityId: existing.id,
            beforeState: existing,
            afterState: updated,
            metadata: {
              agentType: profile.agentType,
              mandatoryControlProfileVersion: 1,
              ...(repairTemplateLink ? { templateVersion: profile.version } : {}),
            },
          });
        }
        continue;
      }

      const [created] = await tx.insert(aiAgentConfigsTable).values({
        userId,
        agentType: profile.agentType,
        enabled: profile.agentType === activeAgentType,
        displayName: profile.displayName,
        description: profile.description,
        systemPrompt: profile.systemPrompt,
        toolsEnabled: profile.toolsEnabled,
        escalationRules: profile.escalationRules,
        channelScope: profile.channelScope,
        priority: profile.priority,
        metadata: profile.metadata,
        templateVersion: profile.version,
        templateMode: 'managed',
      }).onConflictDoNothing({
        target: [aiAgentConfigsTable.businessProfileId, aiAgentConfigsTable.userId, aiAgentConfigsTable.agentType],
      }).returning();

      if (!created) continue;
      agentsCreated += 1;
      await recordSupportAdminAudit(tx, {
        userId,
        actorType: 'system',
        action: 'agent_config.seed',
        entityType: 'ai_agent_config',
        entityId: created.id,
        afterState: created,
        metadata: { agentType: profile.agentType, defaultProfileVersion: profile.version },
      });
    }

    const existingPlaybooks = await tx.select().from(supportPlaybooksTable)
      .where(eq(supportPlaybooksTable.userId, userId));
    const existingKeys = new Set(existingPlaybooks
      .map((playbook: typeof supportPlaybooksTable.$inferSelect) => playbook.templateKey || templateKey(playbook.draftGraph))
      .filter((key: string | null): key is string => Boolean(key)));
    const existingNames = new Set(existingPlaybooks
      .map((playbook: typeof supportPlaybooksTable.$inferSelect) => playbook.name));

    // Only the universal starter set is provisioned automatically. Industry
    // templates live in the same governed catalog, but a tenant must install
    // one explicitly so a hospitality journey can never affect an unrelated
    // SaaS, clinic, or retail account.
    const defaultTemplateKeys = new Set(DEFAULT_SUPPORT_PLAYBOOKS.map((definition) => definition.key));
    const templates = (await tx.select().from(supportPlaybookTemplatesTable)
      .where(eq(supportPlaybookTemplatesTable.status, 'published')))
      .filter((definition: typeof supportPlaybookTemplatesTable.$inferSelect) => (
        defaultTemplateKeys.has(definition.templateKey)
      ));
    for (const definition of templates as Array<typeof supportPlaybookTemplatesTable.$inferSelect>) {
      if (existingKeys.has(definition.templateKey) || existingNames.has(definition.name)) {
        skippedExistingPlaybooks += 1;
        continue;
      }

      const [playbook] = await tx.insert(supportPlaybooksTable).values({
        userId,
        agentType: definition.agentType,
        name: definition.name,
        description: definition.description,
        status: 'published',
        draftGraph: definition.graph,
        activeVersion: 1,
        templateKey: definition.templateKey,
        templateVersion: definition.version,
        templateMode: 'managed',
        createdBy: userId,
      }).onConflictDoNothing().returning();

      // A same-name user playbook always wins; do not rewrite or attach
      // assignments to an unknown custom record.
      if (!playbook) {
        skippedExistingPlaybooks += 1;
        continue;
      }

      const [version] = await tx.insert(supportPlaybookVersionsTable).values({
        playbookId: playbook.id,
        version: 1,
        graph: definition.graph,
        checksum: playbookChecksum(definition.graph),
        publishedBy: userId,
        publishedAt: new Date(),
      }).returning();

      const createdAssignments = definition.assignments.length > 0
        ? await tx.insert(supportPlaybookAssignmentsTable).values(
          definition.assignments.map((assignment) => ({
            userId,
            playbookId: playbook.id,
            channel: assignment.channel,
            intent: assignment.intent,
            agentType: assignment.agentType,
            priority: assignment.priority,
            trafficPercent: assignment.trafficPercent,
            enabled: assignment.enabled !== false,
          })),
        ).returning()
        : [];

      playbooksCreated += 1;
      assignmentsCreated += createdAssignments.length;
      existingKeys.add(definition.templateKey);
      existingNames.add(definition.name);

      await recordSupportAdminAudit(tx, {
        userId,
        actorType: 'system',
        action: 'playbook.default_provisioned',
        entityType: 'support_playbook',
        entityId: playbook.id,
        afterState: {
          ...playbook,
          activeVersion: version.version,
          assignments: createdAssignments,
        },
        metadata: {
          templateKey: definition.templateKey,
          templateVersion: definition.version,
          agentType: definition.agentType,
          controls: definition.graph.metadata?.controls,
        },
      });
    }

    return {
      agentsCreated,
      agentsSafetyUpdated,
      agentsTemplateRepaired,
      playbooksCreated,
      assignmentsCreated,
      skippedExistingPlaybooks,
    };
  });
}
