import { assertBusinessConfigurationOwner } from '../../../tenancy/businessContext.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { aiAgentConfigsTable, supportAgentTemplatesTable } from '../../../models/aiAgentConfigs/schema.js';
import { SUPPORT_TOOL_NAMES } from './SafeToolExecutor.js';
import {
  DEFAULT_SUPPORT_AGENT_PROFILES,
  SUPPORT_AGENT_TYPES,
  enforceMandatoryAgentControls,
  type SupportAgentType,
} from './DefaultSupportConfiguration.js';
import { recordSupportAdminAudit } from './SupportAdminAuditService.js';
import { SUPPORT_POLICY_CHANNELS, validatePolicyRules } from '../pipeline/PolicyRuleSchema.js';

const AGENTS = new Set<string>(SUPPORT_AGENT_TYPES);
const CHANNELS = new Set<string>(SUPPORT_POLICY_CHANNELS);

export interface SupportAgentTemplateInput {
  agentType: SupportAgentType;
  displayName: string;
  description?: string | null;
  systemPrompt: string;
  toolsEnabled: string[];
  escalationRules: unknown;
  channelScope: string[];
  priority: number;
  metadata?: Record<string, unknown>;
}

export function validateSupportAgentTemplate(input: SupportAgentTemplateInput): string[] {
  const errors: string[] = [];
  if (!AGENTS.has(input.agentType)) errors.push('Unsupported agent type.');
  if (!input.displayName.trim() || input.displayName.length > 120) errors.push('Display name must be between 1 and 120 characters.');
  if (!input.systemPrompt.trim()) errors.push('System prompt is required.');
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) errors.push('Priority must be an integer from 1 to 1000.');
  for (const channel of input.channelScope) if (!CHANNELS.has(channel)) errors.push(`Unsupported channel: ${channel}.`);
  for (const tool of input.toolsEnabled) if (!SUPPORT_TOOL_NAMES.has(tool)) errors.push(`Unsupported support tool: ${tool}.`);
  errors.push(...validatePolicyRules(input.escalationRules));
  return [...new Set(errors)];
}

export async function ensureDefaultSupportAgentTemplates() {
  for (const profile of DEFAULT_SUPPORT_AGENT_PROFILES) {
    await db.insert(supportAgentTemplatesTable).values({
      agentType: profile.type,
      displayName: profile.name,
      description: profile.description,
      systemPrompt: profile.prompt,
      toolsEnabled: profile.toolsEnabled,
      escalationRules: profile.escalationRules,
      channelScope: profile.channels,
      priority: profile.priority,
      metadata: profile.metadata,
      version: 1,
    }).onConflictDoNothing({ target: supportAgentTemplatesTable.agentType });
  }
}

export async function listSupportAgentTemplates() {
  await ensureDefaultSupportAgentTemplates();
  return db.select().from(supportAgentTemplatesTable).orderBy(asc(supportAgentTemplatesTable.priority));
}

export async function updateSupportAgentTemplate(agentType: string, input: SupportAgentTemplateInput, adminId: number) {
  const errors = validateSupportAgentTemplate({ ...input, agentType: agentType as SupportAgentType });
  if (errors.length) return { errors } as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260724, hashtext(${agentType}))`);
    const current = (await tx.select().from(supportAgentTemplatesTable)
      .where(eq(supportAgentTemplatesTable.agentType, agentType)).limit(1))[0];
    if (!current) return { notFound: true } as const;
    const version = current.version + 1;
    const controls = enforceMandatoryAgentControls(agentType, input.escalationRules, input.metadata || {});
    const [template] = await tx.update(supportAgentTemplatesTable).set({
      displayName: input.displayName.trim(),
      description: input.description?.trim() || null,
      systemPrompt: input.systemPrompt,
      toolsEnabled: [...new Set(input.toolsEnabled)],
      escalationRules: controls.escalationRules,
      channelScope: [...new Set(input.channelScope)],
      priority: input.priority,
      metadata: { ...controls.metadata, defaultProfileVersion: version },
      version,
      updatedByAdmin: adminId,
      updatedAt: new Date(),
    }).where(eq(supportAgentTemplatesTable.id, current.id)).returning();

    const copies = await tx.select().from(aiAgentConfigsTable).where(and(
      eq(aiAgentConfigsTable.agentType, agentType),
      eq(aiAgentConfigsTable.templateMode, 'managed'),
    ));
    for (const copy of copies as Array<typeof aiAgentConfigsTable.$inferSelect>) {
      const [updated] = await tx.update(aiAgentConfigsTable).set({
        displayName: template.displayName,
        description: template.description,
        systemPrompt: template.systemPrompt,
        toolsEnabled: template.toolsEnabled,
        escalationRules: template.escalationRules,
        channelScope: template.channelScope,
        priority: template.priority,
        metadata: template.metadata,
        templateVersion: version,
        updatedAt: new Date(),
      }).where(eq(aiAgentConfigsTable.id, copy.id)).returning();
      await recordSupportAdminAudit(tx, {
        userId: copy.userId,
        actorType: 'platform_admin', actorId: adminId,
        action: 'agent_config.template_propagated', entityType: 'ai_agent_config', entityId: copy.id,
        beforeState: copy, afterState: updated,
        metadata: { agentType, templateVersion: version },
      });
    }
    return { template, propagated: copies.length } as const;
  });
}

export async function resetTenantAgentToTemplate(userId: number, agentType: string) {
  assertBusinessConfigurationOwner(userId);
  await ensureDefaultSupportAgentTemplates();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, ${userId})`);
    const [current] = await tx.select().from(aiAgentConfigsTable).where(and(
      eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.agentType, agentType),
    )).limit(1);
    const [template] = await tx.select().from(supportAgentTemplatesTable)
      .where(eq(supportAgentTemplatesTable.agentType, agentType)).limit(1);
    if (!current?.enabled || !template) return null;
    const [updated] = await tx.update(aiAgentConfigsTable).set({
      displayName: template.displayName,
      description: template.description,
      systemPrompt: template.systemPrompt,
      toolsEnabled: template.toolsEnabled,
      escalationRules: template.escalationRules,
      channelScope: template.channelScope,
      priority: template.priority,
      metadata: template.metadata,
      templateVersion: template.version,
      templateMode: 'managed',
      updatedAt: new Date(),
    }).where(eq(aiAgentConfigsTable.id, current.id)).returning();
    await recordSupportAdminAudit(tx, {
      userId, actorType: 'owner', actorId: userId,
      action: 'agent_config.reset_to_admin_template', entityType: 'ai_agent_config', entityId: current.id,
      beforeState: current, afterState: updated,
      metadata: { agentType, templateVersion: template.version },
    });
    return updated;
  });
}
