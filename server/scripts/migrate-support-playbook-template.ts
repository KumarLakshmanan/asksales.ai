/**
 * Safely move one tenant from explicitly named legacy playbooks to a managed
 * industry template. Historical versions, runs, and audits are preserved.
 *
 * Dry-run (default):
 *   npx tsx scripts/migrate-support-playbook-template.ts --user-id <tenant-user-id> \
 *     --template-key hospitality-sales-enquiries-v2 \
 *     --legacy-template-keys hotel-availability-booking-v1,hotel-reservation-payment-safety-v1
 *
 * Apply, including explicit supersession of legacy active runs:
 *   npx tsx scripts/migrate-support-playbook-template.ts --user-id <tenant-user-id> \
 *     --template-key hospitality-sales-enquiries-v2 \
 *     --legacy-template-keys hotel-availability-booking-v1,hotel-reservation-payment-safety-v1 \
 *     --supersede-active-runs --apply
 */
import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { aiAgentConfigsTable } from '../models/aiAgentConfigs/schema.js';
import {
  supportPlaybookAssignmentsTable,
  supportPlaybookRunsTable,
  supportPlaybooksTable,
} from '../models/supportOrchestration/schema.js';
import { installTenantPlaybookTemplate } from '../services/agents/orchestration/SupportPlaybookTemplateService.js';
import { recordSupportAdminAudit } from '../services/agents/orchestration/SupportAdminAuditService.js';
import { option } from './lib/cliArgs.js';

function positiveUserId(): number {
  const value = Number(option('--user-id'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('--user-id must be a positive integer.');
  return value;
}

async function main() {
  const userId = positiveUserId();
  const templateKey = String(option('--template-key') || '').trim();
  const legacyTemplateKeys = String(option('--legacy-template-keys') || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const apply = process.argv.includes('--apply');
  const supersedeActiveRuns = process.argv.includes('--supersede-active-runs');
  if (!templateKey) throw new Error('--template-key is required.');
  if (!legacyTemplateKeys.length) throw new Error('--legacy-template-keys requires at least one explicit template key.');
  if (legacyTemplateKeys.includes(templateKey)) throw new Error('The target template cannot also be a legacy template.');

  const [activeAgent] = await db.select({ agentType: aiAgentConfigsTable.agentType })
    .from(aiAgentConfigsTable)
    .where(and(eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.enabled, true)))
    .limit(1);
  if (!activeAgent) throw new Error(`User ${userId} has no active support agent.`);

  const legacyPlaybooks = await db.select({
    id: supportPlaybooksTable.id,
    name: supportPlaybooksTable.name,
    status: supportPlaybooksTable.status,
    agentType: supportPlaybooksTable.agentType,
    templateKey: supportPlaybooksTable.templateKey,
  }).from(supportPlaybooksTable).where(and(
    eq(supportPlaybooksTable.userId, userId),
    inArray(supportPlaybooksTable.templateKey, legacyTemplateKeys),
  ));
  const foundLegacyKeys = new Set(legacyPlaybooks.map((playbook: { templateKey: string | null }) => playbook.templateKey));
  const missingLegacyKeys = legacyTemplateKeys.filter((key) => !foundLegacyKeys.has(key));
  if (missingLegacyKeys.length) throw new Error(`Legacy playbooks not found: ${missingLegacyKeys.join(', ')}.`);
  if (legacyPlaybooks.some((playbook: { agentType: string }) => playbook.agentType !== activeAgent.agentType)) {
    throw new Error('Every legacy playbook must belong to the currently active support agent.');
  }
  const legacyIds = legacyPlaybooks.map((playbook: { id: number }) => playbook.id);
  const activeRuns = legacyIds.length ? await db.select({
    id: supportPlaybookRunsTable.id,
    conversationId: supportPlaybookRunsTable.conversationId,
    playbookId: supportPlaybookRunsTable.playbookId,
    updatedAt: supportPlaybookRunsTable.updatedAt,
  }).from(supportPlaybookRunsTable).where(and(
    eq(supportPlaybookRunsTable.userId, userId),
    eq(supportPlaybookRunsTable.status, 'active'),
    inArray(supportPlaybookRunsTable.playbookId, legacyIds),
  )) : [];

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    userId,
    activeAgent: activeAgent.agentType,
    targetTemplateKey: templateKey,
    legacyPlaybooks,
    activeLegacyRuns: activeRuns,
    willSupersedeActiveRuns: apply && supersedeActiveRuns,
  }, null, 2));
  if (!apply) return;
  if (activeRuns.length && !supersedeActiveRuns) {
    throw new Error('Legacy active runs exist. Re-run with --supersede-active-runs only after explicitly reviewing them.');
  }

  const installation = await installTenantPlaybookTemplate(userId, templateKey);
  if ('error' in installation) throw new Error(installation.error);
  const targetPlaybook = installation.playbook;
  if (targetPlaybook.agentType !== activeAgent.agentType || targetPlaybook.status !== 'published') {
    throw new Error('The target managed playbook is not published for the active agent.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260822, ${userId})`);
    const currentLegacy = await tx.select().from(supportPlaybooksTable).where(and(
      eq(supportPlaybooksTable.userId, userId),
      inArray(supportPlaybooksTable.templateKey, legacyTemplateKeys),
    ));
    const currentLegacyIds = currentLegacy.map((playbook: typeof supportPlaybooksTable.$inferSelect) => playbook.id);
    const currentRuns = currentLegacyIds.length ? await tx.select().from(supportPlaybookRunsTable).where(and(
      eq(supportPlaybookRunsTable.userId, userId),
      eq(supportPlaybookRunsTable.status, 'active'),
      inArray(supportPlaybookRunsTable.playbookId, currentLegacyIds),
    )) : [];
    if (currentRuns.length && !supersedeActiveRuns) throw new Error('A legacy run became active during migration.');

    if (currentRuns.length) {
      await tx.update(supportPlaybookRunsTable).set({
        status: 'superseded',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(supportPlaybookRunsTable.userId, userId),
        eq(supportPlaybookRunsTable.status, 'active'),
        inArray(supportPlaybookRunsTable.playbookId, currentLegacyIds),
      ));
    }
    if (currentLegacyIds.length) {
      await tx.update(supportPlaybookAssignmentsTable).set({ enabled: false, updatedAt: new Date() }).where(and(
        eq(supportPlaybookAssignmentsTable.userId, userId),
        inArray(supportPlaybookAssignmentsTable.playbookId, currentLegacyIds),
      ));
      await tx.update(supportPlaybooksTable).set({ status: 'archived', updatedAt: new Date() }).where(and(
        eq(supportPlaybooksTable.userId, userId),
        inArray(supportPlaybooksTable.id, currentLegacyIds),
      ));
    }
    await recordSupportAdminAudit(tx, {
      userId,
      actorType: 'system',
      action: 'playbook.managed_template_migrated',
      entityType: 'support_playbook_migration',
      entityId: targetPlaybook.id,
      beforeState: { legacyPlaybooks: currentLegacy, activeRuns: currentRuns },
      afterState: {
        targetPlaybookId: targetPlaybook.id,
        targetTemplateKey: templateKey,
        archivedPlaybookIds: currentLegacyIds,
        supersededRunIds: currentRuns.map((run: typeof supportPlaybookRunsTable.$inferSelect) => run.id),
      },
      metadata: { script: 'migrate-support-playbook-template', targetCreated: installation.created },
    });
    return { archivedPlaybookIds: currentLegacyIds, supersededRunIds: currentRuns.map((run: typeof supportPlaybookRunsTable.$inferSelect) => run.id) };
  });
  console.log(JSON.stringify({ installedPlaybookId: targetPlaybook.id, targetCreated: installation.created, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await pgPool?.end();
});
