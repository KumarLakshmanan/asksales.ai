/**
 * Publish one code-shipped support template and propagate it only to tenant
 * copies that remain admin-managed. Customized/custom copies are untouched.
 *
 * Dry run (default):
 *   npx tsx scripts/publish-code-support-template.ts \
 *     --template-key hospitality-sales-enquiries-v2 --admin-id <admin-id>
 *
 * Apply:
 *   npx tsx scripts/publish-code-support-template.ts \
 *     --template-key hospitality-sales-enquiries-v2 --admin-id <admin-id> --apply
 */
import 'dotenv/config';
import { and, count, eq } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { adminsTable } from '../models/admins/schema.js';
import {
  supportPlaybooksTable,
  supportPlaybookTemplatesTable,
  supportPlaybookRunsTable,
} from '../models/supportOrchestration/schema.js';
import {
  DEFAULT_SUPPORT_PLAYBOOKS,
  INDUSTRY_SUPPORT_PLAYBOOKS,
} from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { playbookChecksum } from '../services/agents/orchestration/PlaybookEngine.js';
import {
  enforcePlaybookControlMetadata,
  ensureDefaultSupportTemplates,
  updateSupportTemplate,
  validateSupportTemplateInput,
} from '../services/agents/orchestration/SupportPlaybookTemplateService.js';
import { option } from './lib/cliArgs.js';

function positiveIntegerOption(name: string): number {
  const value = Number(option(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function canonicalAssignments(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.map((item) => ({
    ...(item as Record<string, unknown>),
    enabled: (item as { enabled?: unknown }).enabled !== false,
  })));
}

async function main() {
  const templateKey = String(option('--template-key') || '').trim();
  const adminId = positiveIntegerOption('--admin-id');
  const apply = process.argv.includes('--apply');
  const definition = [...DEFAULT_SUPPORT_PLAYBOOKS, ...INDUSTRY_SUPPORT_PLAYBOOKS]
    .find((item) => item.key === templateKey);
  if (!definition) throw new Error(`Code-shipped template ${templateKey || '(empty)'} was not found.`);

  const [admin] = await db.select({ id: adminsTable.id, role: adminsTable.role, isVerified: adminsTable.isVerified })
    .from(adminsTable).where(eq(adminsTable.id, adminId)).limit(1);
  if (!admin?.isVerified) throw new Error(`Verified admin ${adminId} was not found.`);

  await ensureDefaultSupportTemplates();
  const [current] = await db.select().from(supportPlaybookTemplatesTable)
    .where(eq(supportPlaybookTemplatesTable.templateKey, templateKey)).limit(1);
  if (!current) throw new Error(`Template ${templateKey} could not be initialized.`);

  const assignments = definition.assignments.map((assignment) => ({ ...assignment, enabled: true }));
  const candidateGraph = enforcePlaybookControlMetadata(definition.graph, {
    templateKey,
    templateVersion: current.version,
    agentType: definition.agentType,
    systemDefault: true,
  });
  const input = {
    templateKey,
    name: definition.name,
    description: definition.description,
    agentType: definition.agentType,
    status: 'published' as const,
    graph: definition.graph,
    assignments,
  };
  const validationErrors = validateSupportTemplateInput(input);
  if (validationErrors.length) throw new Error(`Template is not publishable:\n${validationErrors.join('\n')}`);

  const [{ value: managedCopies }] = await db.select({ value: count() }).from(supportPlaybooksTable).where(and(
    eq(supportPlaybooksTable.templateKey, templateKey),
    eq(supportPlaybooksTable.templateMode, 'managed'),
  ));
  const [{ value: activeManagedRuns }] = await db.select({ value: count() })
    .from(supportPlaybookRunsTable)
    .innerJoin(supportPlaybooksTable, eq(supportPlaybooksTable.id, supportPlaybookRunsTable.playbookId))
    .where(and(
      eq(supportPlaybooksTable.templateKey, templateKey),
      eq(supportPlaybooksTable.templateMode, 'managed'),
      eq(supportPlaybookRunsTable.status, 'active'),
    ));
  const changed = current.name !== definition.name
    || current.description !== definition.description
    || current.agentType !== definition.agentType
    || current.status !== 'published'
    || playbookChecksum(current.graph) !== playbookChecksum(candidateGraph)
    || canonicalAssignments(current.assignments) !== canonicalAssignments(assignments);

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    templateKey,
    currentTemplateVersion: current.version,
    changed,
    managedCopies: Number(managedCopies),
    activeVersionBoundRuns: Number(activeManagedRuns),
    note: 'Active runs remain bound to their immutable existing playbook version.',
  }, null, 2));
  if (!apply || !changed) return;

  const result = await updateSupportTemplate(templateKey, input, adminId);
  if ('errors' in result) throw new Error(result.errors.join('\n'));
  if ('notFound' in result) throw new Error(`Template ${templateKey} disappeared during publication.`);
  console.log(JSON.stringify({
    publishedTemplateVersion: result.template.version,
    propagatedManagedCopies: result.propagated,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await pgPool?.end();
});
