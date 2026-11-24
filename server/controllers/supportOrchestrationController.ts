import { authorizeBusinessOwner } from '../middleware/businessPermissions.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { aiAgentConfigsTable } from '../models/aiAgentConfigs/schema.js';
import {
  supportPlaybookAssignmentsTable,
  supportPlaybooksTable,
  supportPlaybookVersionsTable,
  supportPlaybookTemplatesTable,
  supportDeliveryOutboxTable,
  supportToolExecutionsTable,
  type PlaybookGraph,
} from '../models/supportOrchestration/schema.js';
import { playbookChecksum, validatePlaybookGraph } from '../services/agents/orchestration/PlaybookEngine.js';
import { isPrivacyVaultConfigured } from '../services/agents/orchestration/PrivacyVaultService.js';
import { logger } from '../utils/logger.js';
import { channelGateway } from '../services/agents/pipeline/ChannelGateway.js';
import { recordSupportAdminAudit } from '../services/agents/orchestration/SupportAdminAuditService.js';
import { SUPPORT_AGENT_TYPES } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { SUPPORT_INTENTS } from '../services/agents/NLUService.js';
import { ensureDefaultSupportConfiguration } from '../services/agents/orchestration/DefaultSupportProvisioningService.js';
import {
  enforcePlaybookControlMetadata,
  installTenantPlaybookTemplate,
  listSupportTemplates,
  resetTenantPlaybookToTemplate,
} from '../services/agents/orchestration/SupportPlaybookTemplateService.js';
import { SUPPORT_POLICY_CHANNELS } from '../services/agents/pipeline/PolicyRuleSchema.js';
import { assignmentAgentAvailabilityError } from '../services/agents/pipeline/stages/AgentConfigurationStage.js';
import { sanitizeSupportToolData } from '../services/agents/orchestration/SafeToolExecutor.js';
import { toolApprovalsTable } from '../models/toolApprovals/schema.js';
import { APPROVAL_RESUME_BLOCKED_MESSAGE } from '../../shared/supportApprovalRecovery.js';

const CHANNELS = new Set<string>(SUPPORT_POLICY_CHANNELS);
const AGENTS = new Set<string>(SUPPORT_AGENT_TYPES);
const INTENTS = new Set<string>(SUPPORT_INTENTS);
const EMPTY_GRAPH: PlaybookGraph = {
  entryNodeId: 'start',
  nodes: [{ id: 'start', type: 'trigger', data: {} }],
  edges: [],
};

function userId(req: Request): number | null {
  return businessOwnerUserId(req) || null;
}

async function ownedPlaybook(ownerId: number, id: number) {
  const activeAgentType = await activeAgentTypeFor(ownerId);
  if (!activeAgentType) return null;
  return (await db.select().from(supportPlaybooksTable).where(and(
    eq(supportPlaybooksTable.id, id),
    eq(supportPlaybooksTable.userId, ownerId),
    eq(supportPlaybooksTable.agentType, activeAgentType),
  )).limit(1))[0] || null;
}

async function activeAgentTypeFor(ownerId: number): Promise<string | null> {
  await ensureDefaultSupportConfiguration(ownerId);
  const [active] = await db.select({ agentType: aiAgentConfigsTable.agentType })
    .from(aiAgentConfigsTable)
    .where(and(eq(aiAgentConfigsTable.userId, ownerId), eq(aiAgentConfigsTable.enabled, true)))
    .limit(1);
  return active?.agentType ?? null;
}

// Every playbook mutation shares the activation lock and re-checks ownership
// inside its transaction, closing the switch-vs-edit race.
async function assertActiveAgentLocked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  ownerId: number,
  expectedAgentType: string,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, ${ownerId})`);
  const [active] = await tx.select({ agentType: aiAgentConfigsTable.agentType })
    .from(aiAgentConfigsTable)
    .where(and(eq(aiAgentConfigsTable.userId, ownerId), eq(aiAgentConfigsTable.enabled, true)))
    .limit(1);
  if (active?.agentType !== expectedAgentType) {
    const error = new Error('The active outreach agent changed. Reload before modifying playbooks.') as Error & { status?: number; code?: string };
    error.status = 409;
    error.code = 'ACTIVE_AGENT_CHANGED';
    throw error;
  }
}

export async function listPlaybooks(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const activeAgentType = await activeAgentTypeFor(ownerId);
  if (!activeAgentType) return res.status(409).json({ error: 'No active outreach agent is configured.' });
  const [playbooks, assignments, agentConfigs, templates] = await Promise.all([
    db.select().from(supportPlaybooksTable)
      .where(and(eq(supportPlaybooksTable.userId, ownerId), eq(supportPlaybooksTable.agentType, activeAgentType)))
      .orderBy(asc(supportPlaybooksTable.name)),
    db.select().from(supportPlaybookAssignmentsTable)
      .where(eq(supportPlaybookAssignmentsTable.userId, ownerId))
      .orderBy(asc(supportPlaybookAssignmentsTable.priority)),
    db.select({
      agentType: aiAgentConfigsTable.agentType,
      enabled: aiAgentConfigsTable.enabled,
      channelScope: aiAgentConfigsTable.channelScope,
    }).from(aiAgentConfigsTable).where(eq(aiAgentConfigsTable.userId, ownerId)),
    db.select({ templateKey: supportPlaybookTemplatesTable.templateKey, version: supportPlaybookTemplatesTable.version })
      .from(supportPlaybookTemplatesTable),
  ]);
  type AgentStatus = { agentType: string; enabled: boolean; channelScope: unknown };
  const agentStatus = new Map<string, AgentStatus>(
    (agentConfigs as AgentStatus[]).map((config: AgentStatus) => [config.agentType, config]),
  );
  const templateVersions = new Map<string, number>((templates as Array<{ templateKey: string; version: number }>).map(
    (template: { templateKey: string; version: number }) => [template.templateKey, template.version],
  ));
  return res.json(playbooks.map((playbook: typeof supportPlaybooksTable.$inferSelect) => ({
    ...playbook,
    templateCurrentVersion: playbook.templateKey ? templateVersions.get(playbook.templateKey) ?? null : null,
    assignments: assignments
      .filter((assignment: typeof supportPlaybookAssignmentsTable.$inferSelect) => assignment.playbookId === playbook.id && assignment.agentType === activeAgentType)
      .map((assignment: typeof supportPlaybookAssignmentsTable.$inferSelect) => {
        const config = assignment.agentType ? agentStatus.get(assignment.agentType) : null;
        return {
          ...assignment,
          agentEnabled: assignment.agentType == null ? true : Boolean(config?.enabled),
          agentChannels: Array.isArray(config?.channelScope) ? config.channelScope : [],
        };
      }),
  })));
}

export async function provisionDefaultPlaybooks(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const result = await ensureDefaultSupportConfiguration(ownerId);
  return res.json({ success: true, ...result });
}

export async function listAvailablePlaybookTemplates(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const activeAgentType = await activeAgentTypeFor(ownerId);
  if (!activeAgentType) return res.status(409).json({ error: 'No active support agent is configured.' });
  const installed = await db.select({ templateKey: supportPlaybooksTable.templateKey })
    .from(supportPlaybooksTable)
    .where(eq(supportPlaybooksTable.userId, ownerId));
  const installedKeys = new Set(installed
    .map((row: { templateKey: string | null }) => row.templateKey)
    .filter((key: string | null): key is string => Boolean(key)));
  const templates = await listSupportTemplates(false);
  return res.json(templates
    .filter((template: typeof supportPlaybookTemplatesTable.$inferSelect) => template.agentType === activeAgentType)
    .map((template: typeof supportPlaybookTemplatesTable.$inferSelect) => ({
      templateKey: template.templateKey,
      name: template.name,
      description: template.description,
      version: template.version,
      schemaVersion: template.graph.schemaVersion || 1,
      installed: installedKeys.has(template.templateKey),
    })));
}

export async function installPlaybookTemplate(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const templateKey = String(req.params.templateKey || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{2,119}$/.test(templateKey)) {
    return res.status(400).json({ error: 'Invalid template key.' });
  }
  const result = await installTenantPlaybookTemplate(ownerId, templateKey);
  if ('error' in result) return res.status(result.status).json({ error: result.error, ...('details' in result ? { details: result.details } : {}) });
  return res.status(result.created ? 201 : 200).json(result);
}

export async function getPlaybook(req: Request, res: Response) {
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid playbook ID' });
  const playbook = await ownedPlaybook(ownerId, id);
  if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
  const [versions, assignments] = await Promise.all([
    db.select().from(supportPlaybookVersionsTable)
      .where(eq(supportPlaybookVersionsTable.playbookId, id))
      .orderBy(desc(supportPlaybookVersionsTable.version)),
    db.select().from(supportPlaybookAssignmentsTable)
      .where(and(
        eq(supportPlaybookAssignmentsTable.userId, ownerId),
        eq(supportPlaybookAssignmentsTable.playbookId, id),
      ))
      .orderBy(asc(supportPlaybookAssignmentsTable.priority)),
  ]);
  return res.json({
    ...playbook,
    versions,
    assignments: assignments.filter((assignment: typeof supportPlaybookAssignmentsTable.$inferSelect) => assignment.agentType === playbook.agentType),
  });
}

export async function createPlaybook(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const activeAgentType = await activeAgentTypeFor(ownerId);
  if (!activeAgentType) return res.status(409).json({ error: 'No active outreach agent is configured.' });
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 160) return res.status(400).json({ error: 'Name must be between 1 and 160 characters' });
  const graph = enforcePlaybookControlMetadata((req.body.graph || EMPTY_GRAPH) as PlaybookGraph, {
    agentType: activeAgentType,
    systemDefault: false,
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await db.transaction(async (tx: any) => {
      await assertActiveAgentLocked(tx, ownerId, activeAgentType);
      const [row] = await tx.insert(supportPlaybooksTable).values({
        userId: ownerId,
        agentType: activeAgentType,
        name,
        description: String(req.body.description || '').trim() || null,
        draftGraph: graph,
        createdBy: req.user!.id,
      }).returning();
      await recordSupportAdminAudit(tx, {
        userId: ownerId, actorType: 'owner', actorId: req.user!.id,
        action: 'playbook.create', entityType: 'support_playbook', entityId: row.id, afterState: row,
      });
      return row;
    });
    return res.status(201).json(created);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'A playbook with this name already exists' });
    throw error;
  }
}

export async function updatePlaybook(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const current = await ownedPlaybook(ownerId, id);
  if (!current) return res.status(404).json({ error: 'Playbook not found' });
  const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
  if (!name || name.length > 160) return res.status(400).json({ error: 'Name must be between 1 and 160 characters' });
  const requestedGraph = (req.body.graph || current.draftGraph) as PlaybookGraph;
  const graph = enforcePlaybookControlMetadata(requestedGraph, {
    templateKey: current.templateKey,
    templateVersion: current.templateVersion,
    agentType: current.agentType,
    systemDefault: false,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, current.agentType);
    const [row] = await tx.update(supportPlaybooksTable).set({
      name,
      description: req.body.description === undefined ? current.description : String(req.body.description || '').trim() || null,
      draftGraph: graph,
      templateMode: current.templateKey ? 'customized' : 'custom',
      status: current.status === 'archived' ? 'draft' : current.status,
      updatedAt: new Date(),
    }).where(and(
      eq(supportPlaybooksTable.id, id),
      eq(supportPlaybooksTable.userId, ownerId),
    )).returning();
    await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: 'playbook.update', entityType: 'support_playbook', entityId: id,
      beforeState: current, afterState: row,
    });
    return row;
  });
  return res.json(updated);
}

export async function validatePlaybook(req: Request, res: Response) {
  if (!userId(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const errors = validatePlaybookGraph(req.body.graph);
    return res.json({ valid: errors.length === 0, errors, warnings: [] });
  } catch {
    return res.json({ valid: false, errors: ['Provide a valid playbook graph.'], warnings: [] });
  }
}

export async function publishPlaybook(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const current = await ownedPlaybook(ownerId, id);
  if (!current) return res.status(404).json({ error: 'Playbook not found' });
  const errors = validatePlaybookGraph(current.draftGraph);
  if (errors.length) return res.status(400).json({ error: 'Playbook is not publishable', details: errors });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const published = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, current.agentType);
    // Serialize publication per playbook so two owner requests cannot allocate
    // the same immutable version number.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${id})`);
    const lockedResult = await tx.execute(sql`
      SELECT draft_graph
      FROM support_playbooks
      WHERE id = ${id} AND user_id = ${ownerId}
      FOR UPDATE
    `);
    const lockedGraph = (lockedResult.rows[0] as { draft_graph?: PlaybookGraph } | undefined)?.draft_graph;
    if (!lockedGraph) throw new Error('Playbook disappeared during publication.');
    const lockedErrors = validatePlaybookGraph(lockedGraph);
    if (lockedErrors.length) {
      const validationError = new Error('Playbook changed and is no longer publishable.') as Error & { details?: string[] };
      validationError.details = lockedErrors;
      throw validationError;
    }
    const versionResult = await tx.execute(sql`
      SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
      FROM support_playbook_versions
      WHERE playbook_id = ${id}
    `);
    const version = Number((versionResult.rows[0] as { next_version: number }).next_version);
    const [snapshot] = await tx.insert(supportPlaybookVersionsTable).values({
      playbookId: id,
      version,
      graph: lockedGraph,
      checksum: playbookChecksum(lockedGraph),
      publishedBy: req.user!.id,
      publishedAt: new Date(),
    }).returning();
    await tx.update(supportPlaybooksTable).set({
      status: 'published',
      activeVersion: version,
      updatedAt: new Date(),
    }).where(and(eq(supportPlaybooksTable.id, id), eq(supportPlaybooksTable.userId, ownerId)));
    await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: 'playbook.publish', entityType: 'support_playbook', entityId: id,
      beforeState: current,
      afterState: { status: 'published', activeVersion: version, checksum: snapshot.checksum },
    });
    return snapshot;
  });
  return res.json(published);
}

export async function archivePlaybook(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const current = await ownedPlaybook(ownerId, id);
  if (!current) return res.status(404).json({ error: 'Playbook not found' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, current.agentType);
    const [row] = await tx.update(supportPlaybooksTable).set({
      status: 'archived',
      templateMode: current.templateKey ? 'customized' : 'custom',
      updatedAt: new Date(),
    })
      .where(and(eq(supportPlaybooksTable.id, id), eq(supportPlaybooksTable.userId, ownerId)))
      .returning();
    await tx.update(supportPlaybookAssignmentsTable).set({ enabled: false, updatedAt: new Date() })
      .where(and(
        eq(supportPlaybookAssignmentsTable.userId, ownerId),
        eq(supportPlaybookAssignmentsTable.playbookId, id),
      ));
    await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: 'playbook.archive', entityType: 'support_playbook', entityId: id,
      beforeState: current, afterState: row,
    });
    return row;
  });
  return res.json(updated);
}

export async function setPlaybookEnabled(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const current = await ownedPlaybook(ownerId, id);
  if (!current) return res.status(404).json({ error: 'Playbook not found' });
  const enabled = req.body.enabled === true;
  if (enabled && (current.status !== 'published' || !current.activeVersion)) {
    return res.status(409).json({ error: 'Publish the playbook before enabling it.' });
  }
  const row = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, current.agentType);
    const [updated] = await tx.update(supportPlaybooksTable).set({ enabled, updatedAt: new Date() })
      .where(and(eq(supportPlaybooksTable.id, id), eq(supportPlaybooksTable.userId, ownerId))).returning();
    await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: enabled ? 'playbook.enable' : 'playbook.disable',
      entityType: 'support_playbook', entityId: id,
      beforeState: current, afterState: updated,
    });
    return updated;
  });
  return res.json(row);
}

export async function createPlaybookAssignment(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const playbookId = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const playbook = await ownedPlaybook(ownerId, playbookId);
  if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
  const activeAgentType = await activeAgentTypeFor(ownerId);
  if (!activeAgentType) return res.status(409).json({ error: 'No active outreach agent is configured.' });
  const channel = req.body.channel == null ? null : String(req.body.channel);
  const requestedAgentType = req.body.agentType == null ? null : String(req.body.agentType);
  if (channel && !CHANNELS.has(channel)) return res.status(400).json({ error: 'Unsupported channel' });
  if (requestedAgentType && requestedAgentType !== activeAgentType) {
    return res.status(409).json({ error: 'Assignments must use the active outreach agent.' });
  }
  const agentType = activeAgentType;
  if (!AGENTS.has(agentType)) return res.status(400).json({ error: 'A supported agent type is required' });
  const intent = req.body.intent == null ? null : String(req.body.intent);
  if (intent && !INTENTS.has(intent)) return res.status(400).json({ error: 'Unsupported intent' });
  if (playbook.agentType !== agentType) {
    return res.status(409).json({ error: 'Assignments must match the playbook owner.' });
  }
  const [agentConfig] = await db.select({
    enabled: aiAgentConfigsTable.enabled,
    channelScope: aiAgentConfigsTable.channelScope,
    metadata: aiAgentConfigsTable.metadata,
  }).from(aiAgentConfigsTable).where(and(
    eq(aiAgentConfigsTable.userId, ownerId),
    eq(aiAgentConfigsTable.agentType, agentType),
  )).limit(1);
  const availabilityError = assignmentAgentAvailabilityError(agentConfig, channel);
  if (availabilityError) return res.status(409).json({ error: availabilityError });
  // Tenant assignments are global, not percentage canaries. Keep the column
  // for historical/admin compatibility while fixing owner-created routes at 100%.
  const trafficPercent = 100;
  const priority = Number(req.body.priority ?? 100);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100_000) {
    return res.status(400).json({ error: 'priority must be an integer from 0 to 100000' });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assignment = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, agentType);
    if (playbook.templateKey) await tx.update(supportPlaybooksTable).set({
      templateMode: 'customized',
      updatedAt: new Date(),
    }).where(eq(supportPlaybooksTable.id, playbookId));
    const [row] = await tx.insert(supportPlaybookAssignmentsTable).values({
      userId: ownerId,
      playbookId,
      channel,
      intent,
      agentType,
      priority,
      trafficPercent,
      enabled: req.body.enabled !== false,
    }).returning();
    await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: 'playbook_assignment.create', entityType: 'support_playbook_assignment', entityId: row.id,
      afterState: row, metadata: { playbookId },
    });
    return row;
  });
  return res.status(201).json(assignment);
}

export async function setPlaybookAssignmentEnabled(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const playbookId = Number(req.params.id);
  const assignmentId = Number(req.params.assignmentId);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const enabled = req.body.enabled === true;
  const [assignment] = await db.select().from(supportPlaybookAssignmentsTable).where(and(
    eq(supportPlaybookAssignmentsTable.id, assignmentId),
    eq(supportPlaybookAssignmentsTable.playbookId, playbookId),
    eq(supportPlaybookAssignmentsTable.userId, ownerId),
  )).limit(1);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  const playbook = await ownedPlaybook(ownerId, assignment.playbookId);
  if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
  if (enabled && (!playbook.enabled || playbook.status !== 'published')) {
    return res.status(409).json({ error: 'Enable and publish the playbook before enabling an assignment.' });
  }
  const row = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, playbook.agentType);
    const [updated] = await tx.update(supportPlaybookAssignmentsTable).set({ enabled, trafficPercent: 100, updatedAt: new Date() })
      .where(and(
        eq(supportPlaybookAssignmentsTable.id, assignmentId),
        eq(supportPlaybookAssignmentsTable.userId, ownerId),
      )).returning();
    await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: enabled ? 'playbook_assignment.enable' : 'playbook_assignment.disable',
      entityType: 'support_playbook_assignment', entityId: assignmentId,
      beforeState: assignment, afterState: updated,
    });
    return updated;
  });
  return res.json(row);
}

export async function deletePlaybookAssignment(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const assignmentId = Number(req.params.assignmentId);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const activeAgentType = await activeAgentTypeFor(ownerId);
  if (!activeAgentType) return res.status(409).json({ error: 'No active outreach agent is configured.' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deleted = await db.transaction(async (tx: any) => {
    await assertActiveAgentLocked(tx, ownerId, activeAgentType);
    const assignment = (await tx.select().from(supportPlaybookAssignmentsTable).where(and(
      eq(supportPlaybookAssignmentsTable.id, assignmentId),
      eq(supportPlaybookAssignmentsTable.userId, ownerId),
    )).limit(1))[0];
    if (assignment) {
      const [playbook] = await tx.select({ agentType: supportPlaybooksTable.agentType })
        .from(supportPlaybooksTable)
        .where(eq(supportPlaybooksTable.id, assignment.playbookId)).limit(1);
      if (!playbook || playbook.agentType !== activeAgentType) return null;
    }
    if (assignment) await tx.update(supportPlaybooksTable).set({
      templateMode: sql`CASE WHEN template_key IS NOT NULL THEN 'customized' ELSE template_mode END`,
      updatedAt: new Date(),
    }).where(eq(supportPlaybooksTable.id, assignment.playbookId));
    const [row] = await tx.delete(supportPlaybookAssignmentsTable).where(and(
      eq(supportPlaybookAssignmentsTable.id, assignmentId),
      eq(supportPlaybookAssignmentsTable.userId, ownerId),
    )).returning();
    if (row) await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: 'playbook_assignment.delete', entityType: 'support_playbook_assignment', entityId: assignmentId,
      beforeState: row,
    });
    return row;
  });
  if (!deleted) return res.status(404).json({ error: 'Assignment not found' });
  return res.status(204).send();
}

export async function resetPlaybookToAdminTemplate(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid playbook ID' });
  const playbook = await ownedPlaybook(ownerId, id);
  if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
  const updated = await resetTenantPlaybookToTemplate(ownerId, id);
  if (!updated) return res.status(404).json({ error: 'Managed admin template not found for this playbook.' });
  return res.json(updated);
}

export async function listDeliveryActions(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const status = String(req.query.status || 'uncertain');
  const allowedStatuses = new Set(['pending', 'sending', 'sent', 'failed', 'uncertain']);
  if (!allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid delivery status' });
  const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 250));
  const rows = await db.select().from(supportDeliveryOutboxTable).where(and(
    eq(supportDeliveryOutboxTable.userId, ownerId),
    eq(supportDeliveryOutboxTable.status, status),
  )).orderBy(desc(supportDeliveryOutboxTable.createdAt)).limit(limit);
  return res.json(rows);
}

export async function reconcileDeliveryAction(req: Request, res: Response) {
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid delivery action ID' });
  const outcome = String(req.body.outcome || '');
  if (outcome !== 'sent' && outcome !== 'failed') {
    return res.status(400).json({ error: 'outcome must be sent or failed' });
  }
  const note = String(req.body.note || '').trim();
  if (note.length < 3 || note.length > 2000) {
    return res.status(400).json({ error: 'A reconciliation note between 3 and 2000 characters is required' });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await db.transaction(async (tx: any) => {
    const [row] = await tx.update(supportDeliveryOutboxTable).set({
      status: outcome,
      providerMessageId: outcome === 'sent'
        ? String(req.body.providerMessageId || '').trim() || null
        : null,
      sentAt: outcome === 'sent' ? new Date() : null,
      lastError: outcome === 'failed' ? `Operator confirmed not sent: ${note}`.slice(0, 2000) : null,
      nextAttemptAt: outcome === 'failed' ? new Date() : null,
      leaseExpiresAt: null,
      ...(outcome === 'failed' ? {
        maxAttempts: sql`GREATEST(${supportDeliveryOutboxTable.maxAttempts}, ${supportDeliveryOutboxTable.attemptCount} + 1)`,
      } : {}),
      reconciledBy: req.user!.id,
      reconciledAt: new Date(),
      reconciliationNote: note,
      updatedAt: new Date(),
    }).where(and(
      eq(supportDeliveryOutboxTable.id, id),
      eq(supportDeliveryOutboxTable.userId, ownerId),
      sql`${supportDeliveryOutboxTable.status} IN ('sending', 'uncertain', 'failed')`,
    )).returning();
    if (row) await recordSupportAdminAudit(tx, {
      userId: ownerId, actorType: 'owner', actorId: req.user!.id,
      action: 'delivery.reconcile', entityType: 'support_delivery_outbox', entityId: id,
      afterState: row, metadata: { outcome, note },
    });
    if (
      row
      && outcome === 'sent'
      && row.payload.metadata?.dispatchKind === 'manual_support_reply'
    ) {
      const ticketId = Number(row.payload.metadata.ticketId);
      if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
        throw new Error('Manual support delivery is missing its ticket identity.');
      }
      const attachments = Array.isArray(row.payload.metadata.attachments)
        ? row.payload.metadata.attachments
        : [];
      await tx.execute(sql`
        WITH inserted AS (
          INSERT INTO support_ticket_messages
            (ticket_id, user_id, direction, content, is_internal, attachments, delivery_action_id, created_at)
          SELECT ${ticketId}, ${ownerId}, 'outbound', ${row.payload.text}, FALSE,
                 ${JSON.stringify(attachments)}::jsonb, ${id}, NOW()
          FROM support_tickets
          WHERE id = ${ticketId}
            AND user_id = ${ownerId}
          ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO NOTHING
          RETURNING ticket_id
        )
        UPDATE support_tickets
        SET total_messages = COALESCE(total_messages, 0) + 1,
            updated_at = NOW()
        WHERE id IN (SELECT ticket_id FROM inserted)
          AND user_id = ${ownerId}
      `);
      if (['whatsapp', 'instagram', 'facebook'].includes(row.channel)) {
        await tx.execute(sql`
          INSERT INTO outreach_messages
            (conversation_id, user_id, direction, content, status, is_read, is_ai_generated,
             external_message_id, delivery_action_id, created_at)
          VALUES
            (${row.conversationId}, ${ownerId}, 'outbound', ${row.payload.text}, 'sent',
             TRUE, FALSE, ${row.providerMessageId}, ${id}, NOW())
          ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO NOTHING
        `);
      }
    }
    if (row) {
      await tx.execute(sql`
        UPDATE agent_audit_logs
        SET delivery_status = ${outcome === 'sent' ? 'sent_reconciled' : 'retry_scheduled'},
            delivery_deferred = ${outcome !== 'sent'},
            provider_message_id = ${outcome === 'sent' ? row.providerMessageId : null}
        WHERE user_id = ${ownerId}
          AND delivery_action_id = ${id}
      `);
    }
    return row;
  });
  if (!updated) return res.status(409).json({ error: 'Only sending, uncertain, or failed actions can be reconciled' });
  logger.info({ ownerId, deliveryActionId: id, outcome }, '[SupportOrchestration] Delivery action reconciled');
  return res.json(updated);
}

export async function listToolExecutions(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const status = String(req.query.status || 'failed');
  if (!new Set(['running', 'failed', 'success']).has(status)) {
    return res.status(400).json({ error: 'Invalid tool execution status' });
  }
  const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 250));
  const rows = await db.select().from(supportToolExecutionsTable).where(and(
    eq(supportToolExecutionsTable.userId, ownerId),
    eq(supportToolExecutionsTable.status, status),
  )).orderBy(desc(supportToolExecutionsTable.lastAttemptAt)).limit(limit);
  return res.json(rows);
}

export async function listApprovalRecovery(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Public projections deliberately exclude protected payloads, digests,
    // arguments, prior provider output and the stored error text itself.
    const rows = await db.select({ id: toolApprovalsTable.id, threadId: toolApprovalsTable.threadId,
      toolName: toolApprovalsTable.toolName, status: toolApprovalsTable.status, resumeStatus: toolApprovalsTable.resumeStatus,
      expiresAt: toolApprovalsTable.expiresAt, updatedAt: toolApprovalsTable.updatedAt,
    }).from(toolApprovalsTable).where(and(eq(toolApprovalsTable.userId, ownerId),
      inArray(toolApprovalsTable.status, ['approved', 'executing']), inArray(toolApprovalsTable.resumeStatus, ['ready', 'running']),
      isNotNull(toolApprovalsTable.resumeError),
    )).orderBy(desc(toolApprovalsTable.updatedAt)).limit(100);
    return res.json(rows.map((row: Record<string, unknown>) => ({ ...row, message: APPROVAL_RESUME_BLOCKED_MESSAGE })));
  } catch {
    logger.error({ ownerId }, '[Support approval recovery] Read unavailable');
    return res.status(503).json({ error: 'Approval recovery is temporarily unavailable.' });
  }
}

export async function reconcileToolExecution(req: Request, res: Response) {
  const ownerId = userId(req);
  const id = Number(req.params.id);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid tool execution ID' });
  const outcome = String(req.body.outcome || '');
  if (outcome !== 'succeeded' && outcome !== 'not_executed') {
    return res.status(400).json({ error: 'outcome must be succeeded or not_executed' });
  }
  const note = String(req.body.note || '').trim();
  if (note.length < 3 || note.length > 2000) {
    return res.status(400).json({ error: 'A reconciliation note between 3 and 2000 characters is required' });
  }
  const result = outcome === 'succeeded' ? sanitizeSupportToolData(req.body.result) : null;
  if (outcome === 'succeeded' && (!result || typeof result !== 'object')) {
    return res.status(400).json({ error: 'A confirmed successful result object is required' });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await db.transaction(async (tx: any) => {
    // Read the link without a row lock, then follow the same approval ->
    // execution lock order as claims and completion. Revalidate the link after
    // waiting so a concurrent retry cannot redirect this reconciliation.
    const [identity] = await tx.select({ approvalId: supportToolExecutionsTable.approvalId })
      .from(supportToolExecutionsTable).where(and(
        eq(supportToolExecutionsTable.id, id),
        eq(supportToolExecutionsTable.userId, ownerId),
      )).limit(1);
    if (!identity) return null;
    if (identity.approvalId) {
      await tx.select({ id: toolApprovalsTable.id }).from(toolApprovalsTable).where(and(
        eq(toolApprovalsTable.id, identity.approvalId), eq(toolApprovalsTable.userId, ownerId),
      )).for('update').limit(1);
    }
    const [current] = await tx.select().from(supportToolExecutionsTable).where(and(
      eq(supportToolExecutionsTable.id, id),
      eq(supportToolExecutionsTable.userId, ownerId),
    )).for('update').limit(1);
    if (!current || current.approvalId !== identity.approvalId || !['running', 'failed'].includes(current.status)) return null;
    const [row] = await tx.update(supportToolExecutionsTable).set({
      status: outcome === 'succeeded' ? 'success' : 'failed',
      result: outcome === 'succeeded' ? result : null,
      error: outcome === 'not_executed' ? `Owner confirmed no side effect: ${note}` : null,
      completedAt: new Date(),
      reconciledBy: req.user!.id,
      reconciledAt: new Date(),
      reconciliationStatus: outcome === 'succeeded' ? 'confirmed_success' : 'confirmed_not_executed',
      reconciliationNote: note,
    }).where(and(
      eq(supportToolExecutionsTable.id, id),
      eq(supportToolExecutionsTable.userId, ownerId),
      eq(supportToolExecutionsTable.status, current.status),
    )).returning();
    if (row) await recordSupportAdminAudit(tx, {
      userId: ownerId,
      actorType: 'owner',
      actorId: req.user!.id,
      action: 'tool_execution.reconcile',
      entityType: 'support_tool_execution',
      entityId: id,
      beforeState: current,
      afterState: row,
      metadata: { outcome, note },
    });
    if (row && current.approvalId) {
      await tx.update(toolApprovalsTable).set(outcome === 'succeeded'
        ? {
            status: 'consumed',
            resumeStatus: 'completed',
            resumedAt: new Date(),
            executionResult: result,
            consumedAt: new Date(),
            consumedExecutionId: row.id,
            resumeError: null,
            updatedAt: new Date(),
          }
        : {
            status: 'approved',
            resumeStatus: 'ready',
            resumeAvailableAt: new Date(),
            resumeError: null,
            updatedAt: new Date(),
          }).where(and(
            eq(toolApprovalsTable.id, current.approvalId),
            eq(toolApprovalsTable.userId, ownerId),
          ));
    }
    return row || null;
  });
  if (!updated) return res.status(409).json({ error: 'Only running or failed tool executions can be reconciled' });
  return res.json(updated);
}

export async function simulateSupportTurn(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const message = String(req.body.message || '').trim();
  const channel = String(req.body.channel || 'web');
  const mockKnownName = req.body.mockProfile?.knownName === true;
  if (!message || message.length > 20_000) {
    return res.status(400).json({ error: 'Message must be between 1 and 20000 characters' });
  }
  if (!CHANNELS.has(channel)) return res.status(400).json({ error: 'Unsupported simulator channel' });

  const requestedSession = Number(req.body.previewSessionId);
  const conversationId = Number.isSafeInteger(requestedSession) && requestedSession <= -1_500_000_000 && requestedSession > -2_000_000_000
    ? requestedSession : -(1_500_000_000 + crypto.randomInt(0, 500_000_000));
  const result = await channelGateway.process({
    userId: ownerId,
    conversationId,
    channel: channel as 'email' | 'whatsapp' | 'instagram' | 'facebook' | 'web',
    senderIdentifier: 'simulator',
    inboundText: message,
    rawMessageId: `simulator:${crypto.randomUUID()}`,
    metadata: {
      executionMode: 'preview',
      conversationKind: 'owner_simulator',
      simulationAssistantId:req.body.assistantId,
      simulationRevision:req.body.assistantRevision === 'draft' ? 'draft' : 'published',
      ...(mockKnownName ? { mockContactProfile: { knownName: true } } : {}),
    },
  });
  const ctx = result.context;
  if (!result.success) {
    const routingBlocked = ctx?.metadata?.assistantRoutingBlocked === true;
    return res.json({
      success: false,
      code: routingBlocked ? 'SUPPORT_ASSISTANT_UNAVAILABLE' : 'SUPPORT_SIMULATION_FAILED',
      error: routingBlocked && result.error
        ? result.error : 'The reply preview could not be generated. Please try again.',
      outcome: result.method,
      sideEffectsSuppressed: true,
    });
  }
  return res.json({
    success: result.success,
    previewSessionId: conversationId,
    toolMode: 'read_only',
    outcome: result.method,
    replyText: ctx?.guardrailResult?.finalText || ctx?.agentResult?.replyText || '',
    redactedInput: ctx?.message.inboundText || '',
    intent: ctx?.nlu?.intent || null,
    riskLevel: ctx?.nlu?.riskLevel || null,
    classificationConfidence: ctx?.nlu?.classificationConfidence ?? null,
    confidence: ctx?.confidence ?? 0,
    agentType: ctx?.metadata?.agentConfig?.agentType || null,
    resolvedAssistant:ctx?.metadata?.resolvedAssistant || null,
    knowledgeSources:ctx?.contextLanes?.knowledge?.evidence || [],
    playbook: ctx?.metadata?.playbookDirective || null,
    toolCalls: ctx?.agentResult?.toolCallsExecuted || [],
    guardrail: ctx?.guardrailResult || ctx?.metadata?.inboundGuardrail || null,
    policyViolations: ctx?.policyViolations || [],
    piiTypes: ctx?.metadata?.privacy?.piiTypes || [],
    handoffReason: ctx?.agentResult?.escalationReason || result.error || null,
    sideEffectsSuppressed: true,
  });
}

export async function getOrchestrationReport(req: Request, res: Response) {
  const ownerId = userId(req);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const days = Math.max(1, Math.min(Number(req.query.days || 30), 365));
  // Twelve report reads ran in parallel and could take every pooled
  // connection for one page view. They run in order on one connection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [outcomes, delivery, handoffs, playbooks, privacy, tools, privacyAccess, knowledgeGaps, guardrails, csat, adminAudit, integrations] = await db.transaction(async (tx: any) => {
    const reads = [
    () => tx.execute(sql`
      SELECT channel, outcome, COUNT(*)::int AS count,
             AVG(confidence)::real AS avg_confidence,
             AVG(duration_ms)::real AS avg_duration_ms
      FROM agent_audit_logs
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY channel, outcome ORDER BY channel, outcome
    `),
    () => tx.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM support_delivery_outbox
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY status ORDER BY status
    `),
    () => tx.execute(sql`
      SELECT status, priority, COUNT(*)::int AS count,
             AVG(EXTRACT(EPOCH FROM (COALESCE(resolved_at, NOW()) - created_at)))::real AS avg_age_seconds
      FROM handoff_queue
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY status, priority ORDER BY status, priority
    `),
    () => tx.execute(sql`
      SELECT p.id, p.name, r.playbook_version AS version,
             COUNT(r.id)::int AS runs,
             AVG(r.compliance_score)::real AS avg_compliance,
             COUNT(*) FILTER (WHERE r.status = 'completed')::int AS completed
      FROM support_playbooks p
      LEFT JOIN support_playbook_runs r ON r.playbook_id = p.id
        AND r.created_at >= NOW() - (${days} * INTERVAL '1 day')
      WHERE p.user_id = ${ownerId}
      GROUP BY p.id, p.name, r.playbook_version ORDER BY p.name, r.playbook_version
    `),
    () => tx.execute(sql`
      SELECT COUNT(*)::int AS retained_records,
             COUNT(*) FILTER (WHERE expires_at <= NOW() + INTERVAL '7 days')::int AS expiring_within_7_days
      FROM support_privacy_vault WHERE user_id = ${ownerId}
    `),
    () => tx.execute(sql`
      SELECT tool_name, risk_level, status, COUNT(*)::int AS count
      FROM support_tool_executions
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY tool_name, risk_level, status
      ORDER BY tool_name, status
    `),
    () => tx.execute(sql`
      SELECT action, COUNT(*)::int AS count, MAX(created_at) AS last_access_at
      FROM support_privacy_access_logs
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY action ORDER BY action
    `),
    () => tx.execute(sql`
      SELECT COALESCE(intent, 'unclassified') AS intent,
             COUNT(*)::int AS count,
             AVG(confidence)::real AS avg_confidence
      FROM agent_audit_logs
      WHERE user_id = ${ownerId}
        AND created_at >= NOW() - (${days} * INTERVAL '1 day')
        AND COALESCE(jsonb_array_length(kb_sources_used), 0) = 0
        AND (outcome IN ('pending_approval', 'human_handoff', 'blocked', 'error') OR confidence < 0.7)
      GROUP BY COALESCE(intent, 'unclassified')
      ORDER BY count DESC, intent ASC
      LIMIT 20
    `),
    () => tx.execute(sql`
      SELECT violation_type, COUNT(*)::int AS count
      FROM (
        SELECT COALESCE(item->>'ruleType', item->>'rule_type', 'policy') AS violation_type
        FROM agent_audit_logs a
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.policy_violations, '[]'::jsonb)) AS item
        WHERE a.user_id = ${ownerId} AND a.created_at >= NOW() - (${days} * INTERVAL '1 day')
        UNION ALL
        SELECT COALESCE(NULLIF(item #>> '{}', ''), 'outbound_guardrail') AS violation_type
        FROM agent_audit_logs a
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.guardrail_violations, '[]'::jsonb)) AS item
        WHERE a.user_id = ${ownerId} AND a.created_at >= NOW() - (${days} * INTERVAL '1 day')
      ) violations
      GROUP BY violation_type ORDER BY count DESC, violation_type ASC
      LIMIT 20
    `),
    () => tx.execute(sql`
      SELECT COUNT(*)::int AS responses,
             AVG(rating)::real AS average_rating,
             COUNT(*) FILTER (WHERE rating = 1)::int AS rating_1,
             COUNT(*) FILTER (WHERE rating = 2)::int AS rating_2,
             COUNT(*) FILTER (WHERE rating = 3)::int AS rating_3,
             COUNT(*) FILTER (WHERE rating = 4)::int AS rating_4,
             COUNT(*) FILTER (WHERE rating = 5)::int AS rating_5
      FROM support_ticket_reviews
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
    `),
    () => tx.execute(sql`
      SELECT id, actor_type, actor_id, action, entity_type, entity_id, metadata, created_at
      FROM support_admin_audit_logs
      WHERE user_id = ${ownerId} AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      ORDER BY created_at DESC
      LIMIT 50
    `),
    () => tx.execute(sql`
      SELECT
        EXISTS(SELECT 1 FROM admin_api_credentials WHERE is_active = TRUE AND platform IN ('openai', 'vertex_ai', 'gemini', 'openrouter', 'custom_ai')) AS llm,
        EXISTS(SELECT 1 FROM admin_api_credentials WHERE is_active = TRUE AND platform IN ('openai', 'openai_embedding', 'vertex_ai', 'gemini', 'gemini_embedding', 'openrouter')) AS moderation,
        EXISTS(SELECT 1 FROM channel_credentials WHERE user_id = ${ownerId} AND is_active = TRUE AND platform ILIKE '%whatsapp%') AS whatsapp,
        EXISTS(SELECT 1 FROM channel_credentials WHERE user_id = ${ownerId} AND is_active = TRUE AND platform ILIKE '%instagram%') AS instagram,
        EXISTS(SELECT 1 FROM channel_credentials WHERE user_id = ${ownerId} AND is_active = TRUE AND platform ILIKE '%facebook%') AS facebook,
        EXISTS(SELECT 1 FROM email_senders WHERE user_id = ${ownerId} AND is_verified = TRUE) AS email
    `),
    ];
    const results = [];
    for (const read of reads) results.push(await read());
    return results;
  });
  const history = await db.execute(sql`SELECT id, action, reason, created_at,
    COALESCE(metadata->>'actor', CASE WHEN member_id IS NOT NULL THEN 'member:' || member_id::text ELSE 'legacy:unknown' END) AS actor
    FROM support_privacy_access_logs WHERE user_id=${ownerId}
      AND created_at >= NOW()-(${days} * INTERVAL '1 day') ORDER BY created_at DESC,id DESC LIMIT 100`);
  return res.json({
    periodDays: days,
    outcomes: outcomes.rows,
    delivery: delivery.rows,
    handoffs: handoffs.rows,
    playbooks: playbooks.rows,
    privacy: {
      ...(privacy.rows[0] || { retained_records: 0, expiring_within_7_days: 0 }),
      configured: isPrivacyVaultConfigured(),
    },
    tools: tools.rows,
    privacyAccess: privacyAccess.rows,
    privacyAccessHistory: history.rows,
    knowledgeGaps: knowledgeGaps.rows,
    guardrails: guardrails.rows,
    csat: csat.rows[0] || { responses: 0, average_rating: null },
    adminAudit: adminAudit.rows,
    readiness: {
      ...(integrations.rows[0] || {}),
      privacyVault: isPrivacyVaultConfigured(),
      moderationEnabled: process.env.SUPPORT_MODERATION_ENABLED === 'true',
      moderationConfigured: Boolean(process.env.OPENAI_API_KEY || (integrations.rows[0] as any)?.moderation),
      moderationFailClosed: process.env.SUPPORT_MODERATION_FAIL_CLOSED !== 'false',
    },
  });
}

export function supportOrchestrationErrorHandler(error: unknown, _req: Request, res: Response, _next: unknown) {
  logger.error({ err: error }, '[SupportOrchestrationController] Request failed');
  if (!res.headersSent) res.status(500).json({ error: 'Support orchestration request failed' });
}
