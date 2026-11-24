import { assertBusinessConfigurationOwner } from '../../../tenancy/businessContext.js';
import { businessAuditActor } from '../../../tenancy/businessContext.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import {
  supportPlaybookAssignmentsTable,
  supportPlaybooksTable,
  supportPlaybookTemplatesTable,
  supportPlaybookVersionsTable,
  type PlaybookGraph,
  type PlaybookTemplateAssignment,
} from '../../../models/supportOrchestration/schema.js';
import { SUPPORT_INTENTS } from '../NLUService.js';
import {
  DEFAULT_SUPPORT_PLAYBOOKS,
  INDUSTRY_SUPPORT_PLAYBOOKS,
  SUPPORT_AGENT_TYPES,
  type SupportAgentType,
} from './DefaultSupportConfiguration.js';
import { playbookChecksum, validatePlaybookGraph } from './PlaybookEngine.js';
import { recordSupportAdminAudit } from './SupportAdminAuditService.js';
import { aiAgentConfigsTable } from '../../../models/aiAgentConfigs/schema.js';
import { SUPPORT_POLICY_CHANNELS } from '../pipeline/PolicyRuleSchema.js';

const CHANNELS = new Set<string>(SUPPORT_POLICY_CHANNELS);
const AGENTS = new Set<string>(SUPPORT_AGENT_TYPES);
const INTENTS = new Set<string>(SUPPORT_INTENTS);

export interface SupportTemplateInput {
  templateKey: string;
  name: string;
  description?: string | null;
  agentType: SupportAgentType;
  status?: 'published' | 'archived';
  graph: PlaybookGraph;
  assignments: PlaybookTemplateAssignment[];
}

export function isManagedTemplateCopy(mode: string | null | undefined, status?: string): boolean {
  return mode === 'managed' && status !== 'archived';
}

export function enforcePlaybookControlMetadata(
  graph: PlaybookGraph,
  provenance: { templateKey?: string | null; templateVersion?: number | null; agentType?: string | null; systemDefault: boolean },
): PlaybookGraph {
  return {
    ...graph,
    metadata: {
      ...(graph.metadata || {}),
      ...(provenance.templateKey ? { templateKey: provenance.templateKey } : {}),
      ...(provenance.templateVersion ? { templateVersion: provenance.templateVersion } : {}),
      systemDefault: provenance.systemDefault,
      ...(provenance.agentType ? { agentType: provenance.agentType } : {}),
      controls: {
        privacy: 'enforced',
        piiRedaction: 'enforced',
        safety: 'enforced',
        humanHandoff: 'enabled',
        toolApproval: 'required',
      },
    },
  };
}

function withTemplateMetadata(graph: PlaybookGraph, templateKey: string, templateVersion: number, agentType: string) {
  return enforcePlaybookControlMetadata(graph, { templateKey, templateVersion, agentType, systemDefault: true });
}

export function validateSupportTemplateInput(input: SupportTemplateInput): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]{2,119}$/.test(input.templateKey)) errors.push('Template key must be 3-120 lowercase letters, numbers, underscores, or hyphens.');
  if (!input.name.trim() || input.name.trim().length > 160) errors.push('Name must be between 1 and 160 characters.');
  if (!AGENTS.has(input.agentType)) errors.push('Unsupported agent type.');
  errors.push(...validatePlaybookGraph(input.graph));
  for (const assignment of input.assignments) {
    if (assignment.channel && !CHANNELS.has(assignment.channel)) errors.push(`Unsupported channel: ${assignment.channel}.`);
    if (assignment.intent && !INTENTS.has(assignment.intent)) errors.push(`Unsupported intent: ${assignment.intent}.`);
    if (!AGENTS.has(assignment.agentType)) errors.push(`Unsupported assignment agent: ${assignment.agentType}.`);
    if (assignment.agentType !== input.agentType) errors.push(`Assignment agent ${assignment.agentType} must match template agent ${input.agentType}.`);
    if (!Number.isInteger(assignment.priority) || assignment.priority < 0 || assignment.priority > 100_000) errors.push('Assignment priority must be an integer from 0 to 100000.');
    if (!Number.isInteger(assignment.trafficPercent) || assignment.trafficPercent < 0 || assignment.trafficPercent > 100) errors.push('Assignment traffic must be an integer from 0 to 100.');
  }
  if (input.graph.metadata?.agentType && input.graph.metadata.agentType !== input.agentType) {
    errors.push(`Playbook graph agent ${input.graph.metadata.agentType} must match template agent ${input.agentType}.`);
  }
  return [...new Set(errors)];
}

/** Idempotently installs the code-shipped catalog into the admin template store. */
export async function ensureDefaultSupportTemplates(): Promise<void> {
  for (const definition of [...DEFAULT_SUPPORT_PLAYBOOKS, ...INDUSTRY_SUPPORT_PLAYBOOKS]) {
    const graph = withTemplateMetadata(definition.graph, definition.key, 1, definition.agentType);
    await db.insert(supportPlaybookTemplatesTable).values({
      templateKey: definition.key,
      name: definition.name,
      description: definition.description,
      agentType: definition.agentType,
      status: 'published',
      graph,
      assignments: definition.assignments.map((assignment) => ({ ...assignment, enabled: true })),
      version: 1,
    }).onConflictDoNothing({ target: supportPlaybookTemplatesTable.templateKey });
  }
}

export async function listSupportTemplates(includeArchived = true) {
  await ensureDefaultSupportTemplates();
  const query = db.select().from(supportPlaybookTemplatesTable);
  return includeArchived
    ? query.orderBy(asc(supportPlaybookTemplatesTable.agentType), asc(supportPlaybookTemplatesTable.name))
    : query.where(eq(supportPlaybookTemplatesTable.status, 'published'))
      .orderBy(asc(supportPlaybookTemplatesTable.agentType), asc(supportPlaybookTemplatesTable.name));
}

/**
 * Installs one published managed template for a tenant's currently active
 * specialist. This is intentionally separate from default provisioning:
 * industry templates must be an explicit owner choice.
 */
export async function installTenantPlaybookTemplate(userId: number, requestedTemplateKey: string) {
  assertBusinessConfigurationOwner(userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('A valid owner user ID is required.');
  await ensureDefaultSupportTemplates();
  const requestedKey = requestedTemplateKey.trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, ${userId})`);
    const [active] = await tx.select({ agentType: aiAgentConfigsTable.agentType })
      .from(aiAgentConfigsTable)
      .where(and(eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.enabled, true)))
      .limit(1);
    if (!active) return { error: 'No active support agent is configured.', status: 409 } as const;

    const [template] = await tx.select().from(supportPlaybookTemplatesTable).where(and(
      eq(supportPlaybookTemplatesTable.templateKey, requestedKey),
      eq(supportPlaybookTemplatesTable.status, 'published'),
    )).limit(1);
    if (!template) return { error: 'Published support template not found.', status: 404 } as const;
    if (template.agentType !== active.agentType) {
      return { error: 'This template does not match the active support agent.', status: 409 } as const;
    }

    const [existingByKey] = await tx.select().from(supportPlaybooksTable).where(and(
      eq(supportPlaybooksTable.userId, userId),
      eq(supportPlaybooksTable.templateKey, template.templateKey),
    )).limit(1);
    if (existingByKey) return { playbook: existingByKey, created: false } as const;

    const [existingByName] = await tx.select().from(supportPlaybooksTable).where(and(
      eq(supportPlaybooksTable.userId, userId),
      eq(supportPlaybooksTable.name, template.name),
    )).limit(1);
    if (existingByName) {
      return { error: 'A playbook with this template name already exists. Rename it before installing the managed template.', status: 409 } as const;
    }

    const graphErrors = validatePlaybookGraph(template.graph);
    if (graphErrors.length) {
      return { error: 'The managed template is not publishable.', status: 409, details: graphErrors } as const;
    }

    const [playbook] = await tx.insert(supportPlaybooksTable).values({
      userId,
      agentType: template.agentType,
      name: template.name,
      description: template.description,
      status: 'published',
      draftGraph: template.graph,
      activeVersion: 1,
      templateKey: template.templateKey,
      templateVersion: template.version,
      templateMode: 'managed',
      createdBy: businessAuditActor(userId),
    }).returning();
    await tx.insert(supportPlaybookVersionsTable).values({
      playbookId: playbook.id,
      version: 1,
      graph: template.graph,
      checksum: playbookChecksum(template.graph),
      publishedBy: businessAuditActor(userId),
      publishedAt: new Date(),
    });
    await replaceTenantAssignments(tx, userId, playbook.id, template.assignments);
    await recordSupportAdminAudit(tx, {
      userId,
      actorType: 'owner',
      actorId: businessAuditActor(userId),
      action: 'playbook.template_installed',
      entityType: 'support_playbook',
      entityId: playbook.id,
      afterState: playbook,
      metadata: { templateKey: template.templateKey, templateVersion: template.version },
    });
    return { playbook, created: true } as const;
  });
}

async function replaceTenantAssignments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  userId: number,
  playbookId: number,
  assignments: PlaybookTemplateAssignment[],
) {
  await tx.delete(supportPlaybookAssignmentsTable).where(and(
    eq(supportPlaybookAssignmentsTable.userId, userId),
    eq(supportPlaybookAssignmentsTable.playbookId, playbookId),
  ));
  if (assignments.length) {
    await tx.insert(supportPlaybookAssignmentsTable).values(assignments.map((assignment) => ({
      userId,
      playbookId,
      channel: assignment.channel,
      intent: assignment.intent,
      agentType: assignment.agentType,
      priority: assignment.priority,
      trafficPercent: assignment.trafficPercent,
      enabled: assignment.enabled !== false,
    })));
  }
}

async function propagateTemplate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  template: typeof supportPlaybookTemplatesTable.$inferSelect,
  adminId: number,
): Promise<number> {
  const managedCopies = await tx.select().from(supportPlaybooksTable).where(and(
    eq(supportPlaybooksTable.templateKey, template.templateKey),
    eq(supportPlaybooksTable.templateMode, 'managed'),
  ));
  let propagated = 0;
  for (const current of managedCopies as Array<typeof supportPlaybooksTable.$inferSelect>) {
    // A code-template update is not authorization to reactivate a journey
    // the tenant explicitly archived (for example after an industry upgrade).
    if (current.agentType !== template.agentType || !isManagedTemplateCopy(current.templateMode, current.status)) continue;
    const versionResult = await tx.execute(sql`
      SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
      FROM support_playbook_versions WHERE playbook_id = ${current.id}
    `);
    const playbookVersion = Number((versionResult.rows[0] as { next_version: number }).next_version);
    await tx.insert(supportPlaybookVersionsTable).values({
      playbookId: current.id,
      version: playbookVersion,
      graph: template.graph,
      checksum: playbookChecksum(template.graph),
      publishedBy: null,
      publishedAt: template.status === 'published' ? new Date() : null,
    });
    const [updated] = await tx.update(supportPlaybooksTable).set({
      name: template.name,
      description: template.description,
      status: template.status,
      draftGraph: template.graph,
      activeVersion: template.status === 'published' ? playbookVersion : current.activeVersion,
      templateVersion: template.version,
      updatedAt: new Date(),
    }).where(eq(supportPlaybooksTable.id, current.id)).returning();
    await replaceTenantAssignments(tx, current.userId, current.id, template.assignments);
    await recordSupportAdminAudit(tx, {
      userId: current.userId,
      actorType: 'platform_admin',
      actorId: adminId,
      action: 'playbook.template_propagated',
      entityType: 'support_playbook',
      entityId: current.id,
      beforeState: current,
      afterState: updated,
      metadata: { templateKey: template.templateKey, templateVersion: template.version },
    });
    propagated += 1;
  }
  return propagated;
}

export async function createSupportTemplate(input: SupportTemplateInput, adminId: number) {
  const errors = validateSupportTemplateInput(input);
  if (errors.length) return { errors } as const;
  const graph = withTemplateMetadata(input.graph, input.templateKey, 1, input.agentType);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const template = await db.transaction(async (tx: any) => {
    const [row] = await tx.insert(supportPlaybookTemplatesTable).values({
      templateKey: input.templateKey,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      agentType: input.agentType,
      status: input.status || 'published',
      graph,
      assignments: input.assignments,
      version: 1,
      createdByAdmin: adminId,
      updatedByAdmin: adminId,
    }).returning();
    return row;
  });
  return { template, propagated: 0 } as const;
}

export async function updateSupportTemplate(templateKey: string, input: SupportTemplateInput, adminId: number) {
  const errors = validateSupportTemplateInput({ ...input, templateKey });
  if (errors.length) return { errors } as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260723, hashtext(${templateKey}))`);
    const current = (await tx.select().from(supportPlaybookTemplatesTable)
      .where(eq(supportPlaybookTemplatesTable.templateKey, templateKey)).limit(1))[0];
    if (!current) return { notFound: true } as const;
    if (current.agentType !== input.agentType) {
      return { errors: ['A published template cannot change agent ownership. Create a new template for the other agent.'] } as const;
    }
    const version = current.version + 1;
    const graph = withTemplateMetadata(input.graph, templateKey, version, input.agentType);
    const [template] = await tx.update(supportPlaybookTemplatesTable).set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      status: input.status || current.status,
      graph,
      assignments: input.assignments,
      version,
      updatedByAdmin: adminId,
      updatedAt: new Date(),
    }).where(eq(supportPlaybookTemplatesTable.id, current.id)).returning();
    const propagated = await propagateTemplate(tx, template, adminId);
    return { template, propagated } as const;
  });
}

export async function resetTenantPlaybookToTemplate(userId: number, playbookId: number) {
  assertBusinessConfigurationOwner(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, ${userId})`);
    const current = (await tx.select().from(supportPlaybooksTable).where(and(
      eq(supportPlaybooksTable.id, playbookId),
      eq(supportPlaybooksTable.userId, userId),
    )).limit(1))[0];
    if (!current?.templateKey) return null;
    const [active] = await tx.select({ agentType: aiAgentConfigsTable.agentType })
      .from(aiAgentConfigsTable)
      .where(and(eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.enabled, true)))
      .limit(1);
    if (active?.agentType !== current.agentType) return null;
    const template = (await tx.select().from(supportPlaybookTemplatesTable)
      .where(eq(supportPlaybookTemplatesTable.templateKey, current.templateKey)).limit(1))[0];
    if (!template) return null;
    if (template.agentType !== current.agentType) return null;
    const versionResult = await tx.execute(sql`
      SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
      FROM support_playbook_versions WHERE playbook_id = ${playbookId}
    `);
    const playbookVersion = Number((versionResult.rows[0] as { next_version: number }).next_version);
    await tx.insert(supportPlaybookVersionsTable).values({
      playbookId,
      version: playbookVersion,
      graph: template.graph,
      checksum: playbookChecksum(template.graph),
      publishedBy: businessAuditActor(userId),
      publishedAt: template.status === 'published' ? new Date() : null,
    });
    const [updated] = await tx.update(supportPlaybooksTable).set({
      name: template.name,
      description: template.description,
      status: template.status,
      draftGraph: template.graph,
      activeVersion: template.status === 'published' ? playbookVersion : current.activeVersion,
      templateVersion: template.version,
      templateMode: 'managed',
      updatedAt: new Date(),
    }).where(eq(supportPlaybooksTable.id, playbookId)).returning();
    await replaceTenantAssignments(tx, userId, playbookId, template.assignments);
    await recordSupportAdminAudit(tx, {
      userId,
      actorType: 'owner',
      actorId: businessAuditActor(userId),
      action: 'playbook.reset_to_admin_template',
      entityType: 'support_playbook',
      entityId: playbookId,
      beforeState: current,
      afterState: updated,
      metadata: { templateKey: template.templateKey, templateVersion: template.version },
    });
    return updated;
  });
}
