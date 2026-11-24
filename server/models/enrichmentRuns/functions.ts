import { db } from '../db.js';
import { enrichmentRunsTable } from './schema.js';
import { enrichmentStepsTable } from '../enrichmentSteps/schema.js';
import { eq, desc, and } from 'drizzle-orm';

export async function createEnrichmentRun(data: {
  userId: number;
  leadId?: number | null;
  leadName?: string;
  leadEmail?: string;
}) {
  const [run] = await db.insert(enrichmentRunsTable).values({
    userId: data.userId,
    leadId: data.leadId ?? null,
    leadName: data.leadName ?? null,
    leadEmail: data.leadEmail ?? null,
    status: 'running',
  }).returning();
  return run;
}

export async function updateEnrichmentRun(id: number, data: Partial<{
  status: string;
  completedAt: Date;
  totalHandlesProcessed: number;
  totalIterations: number;
  emailsFound: number;
  phonesFound: number;
  websitesFound: number;
  errorMessage: string;
  billingTransactionId: number | null;
  billingCredits: string;
  billingStatus: string;
  providerDispatchStartedAt: Date;
  executionResult: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary: any;
}>) {
  const [updated] = await db.update(enrichmentRunsTable)
    .set(data)
    .where(eq(enrichmentRunsTable.id, id))
    .returning();
  return updated;
}

export async function getEnrichmentRunByRequestKey(userId: number, requestKey: string) {
  const [run] = await db.select().from(enrichmentRunsTable)
    .where(and(eq(enrichmentRunsTable.userId, userId), eq(enrichmentRunsTable.requestKey, requestKey)))
    .limit(1);
  return run;
}

export async function getEnrichmentRunsByUser(userId: number, limit = 50, offset = 0) {
  return db.select()
    .from(enrichmentRunsTable)
    .where(eq(enrichmentRunsTable.userId, userId))
    .orderBy(desc(enrichmentRunsTable.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getEnrichmentRunsByLead(userId: number, leadId: number) {
  return db.select()
    .from(enrichmentRunsTable)
    .where(and(eq(enrichmentRunsTable.userId, userId), eq(enrichmentRunsTable.leadId, leadId)))
    .orderBy(desc(enrichmentRunsTable.createdAt));
}

export async function getEnrichmentRunById(id: number) {
  const [run] = await db.select()
    .from(enrichmentRunsTable)
    .where(eq(enrichmentRunsTable.id, id))
    .limit(1);
  return run;
}

export async function getEnrichmentRunWithSteps(id: number) {
  const [run] = await db.select()
    .from(enrichmentRunsTable)
    .where(eq(enrichmentRunsTable.id, id))
    .limit(1);
  if (!run) return null;

  const steps = await db.select()
    .from(enrichmentStepsTable)
    .where(eq(enrichmentStepsTable.runId, id))
    .orderBy(enrichmentStepsTable.stepNumber);

  return { ...run, steps };
}
