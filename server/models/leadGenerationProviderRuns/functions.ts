import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  leadGenerationProviderRunsTable,
  type LeadGenerationProviderRun,
  type NewLeadGenerationProviderRun,
} from './schema';
import { leadInputSetsTable } from '../conversationWorkflow/schema';

export async function claimLeadGenerationProviderRun(
  data: NewLeadGenerationProviderRun,
): Promise<{ run: LeadGenerationProviderRun; created: boolean }> {
  const inserted = await db.insert(leadGenerationProviderRunsTable)
    .values(data)
    .onConflictDoNothing({ target: leadGenerationProviderRunsTable.idempotencyKey })
    .returning();
  if (inserted[0]) return { run: inserted[0], created: true };

  const [existing] = await db.select()
    .from(leadGenerationProviderRunsTable)
    .where(eq(leadGenerationProviderRunsTable.idempotencyKey, data.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error('Provider run receipt could not be claimed.');
  return { run: existing, created: false };
}

export async function updateLeadGenerationProviderRun(
  id: number,
  updates: Partial<Omit<LeadGenerationProviderRun, 'id' | 'createdAt'>>,
): Promise<LeadGenerationProviderRun> {
  const [updated] = await db.update(leadGenerationProviderRunsTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(leadGenerationProviderRunsTable.id, id))
    .returning();
  if (!updated) throw new Error(`Provider run receipt ${id} was not found.`);
  return updated;
}

export async function getLeadGenerationProviderRunsByExecution(
  executionId: string,
): Promise<LeadGenerationProviderRun[]> {
  return db.select()
    .from(leadGenerationProviderRunsTable)
    .where(eq(leadGenerationProviderRunsTable.executionId, executionId))
    .orderBy(desc(leadGenerationProviderRunsTable.createdAt));
}

export async function getLatestLeadGenerationProviderRunsByThread(
  threadId: number,
): Promise<LeadGenerationProviderRun[]> {
  const rows: LeadGenerationProviderRun[] = await db.select()
    .from(leadGenerationProviderRunsTable)
    .where(eq(leadGenerationProviderRunsTable.threadId, threadId))
    .orderBy(desc(leadGenerationProviderRunsTable.createdAt))
    .limit(100);
  if (rows.length === 0) return [];
  const latestExecutionId = rows[0].executionId;
  return rows.filter((row) => row.executionId === latestExecutionId);
}

export async function getRecoverableLeadGenerationProviderRuns(): Promise<LeadGenerationProviderRun[]> {
  return db.select()
    .from(leadGenerationProviderRunsTable)
    .where(inArray(leadGenerationProviderRunsTable.status, ['pending', 'syncing']))
    .orderBy(leadGenerationProviderRunsTable.heartbeatAt);
}

/**
 * Acquire a cross-process recovery lease for stale or interrupted provider work.
 * A succeeded provider is recoverable only when it fetched rows but persisted
 * none, which covers a crash between dataset retrieval and the lead DB save.
 */
export async function claimRecoverableLeadGenerationProviderRunsForThread(
  threadId: number,
  userId: number,
  staleBefore: Date,
): Promise<LeadGenerationProviderRun[]> {
  const [latestRun] = await db.select({
    id: leadGenerationProviderRunsTable.id,
    executionId: leadGenerationProviderRunsTable.executionId,
  })
    .from(leadGenerationProviderRunsTable)
    .where(and(
      eq(leadGenerationProviderRunsTable.threadId, threadId),
      eq(leadGenerationProviderRunsTable.userId, userId),
    ))
    .orderBy(desc(leadGenerationProviderRunsTable.createdAt))
    .limit(1);
  if (!latestRun) return [];

  const candidates = await db.select()
    .from(leadGenerationProviderRunsTable)
    .where(and(
      eq(leadGenerationProviderRunsTable.threadId, threadId),
      eq(leadGenerationProviderRunsTable.userId, userId),
      eq(leadGenerationProviderRunsTable.executionId, latestRun.executionId),
      lt(leadGenerationProviderRunsTable.heartbeatAt, staleBefore),
      // Recovery is an execution continuation, not an approval mechanism.
      // Only receipts whose exact lead input belongs to an approved review
      // revision are eligible for an automatic lease.
      sql`EXISTS (
        SELECT 1 FROM ${leadInputSetsTable}
        WHERE ${leadInputSetsTable.userId} = ${userId}
          AND ${leadInputSetsTable.threadId} = ${threadId}
          AND ${leadInputSetsTable.status} = 'approved'
          AND ${leadInputSetsTable.inputIds} @> jsonb_build_array(${leadGenerationProviderRunsTable.leadInputId})
      )`,
      or(
        inArray(leadGenerationProviderRunsTable.status, ['pending', 'syncing']),
        and(
          // A succeeded-but-unsaved receipt can represent a crash between
          // dataset retrieval and persistence only when it is the final
          // provider receipt created for this sequential execution. Earlier
          // composite nodes legitimately persist zero rows.
          eq(leadGenerationProviderRunsTable.id, latestRun.id),
          eq(leadGenerationProviderRunsTable.status, 'succeeded'),
          eq(leadGenerationProviderRunsTable.persistedCount, 0),
          sql`${leadGenerationProviderRunsTable.fetchedCount} > 0`,
        ),
      ),
    ))
    .orderBy(leadGenerationProviderRunsTable.heartbeatAt);

  const claimed: LeadGenerationProviderRun[] = [];
  for (const candidate of candidates) {
    const [leased] = await db.update(leadGenerationProviderRunsTable)
      .set({
        heartbeatAt: new Date(),
        retryCount: sql`${leadGenerationProviderRunsTable.retryCount} + 1`,
        checkpoint: {
          ...(candidate.checkpoint || {}),
          recoveryClaimedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(
        eq(leadGenerationProviderRunsTable.id, candidate.id),
        eq(leadGenerationProviderRunsTable.threadId, threadId),
        eq(leadGenerationProviderRunsTable.userId, userId),
        eq(leadGenerationProviderRunsTable.executionId, latestRun.executionId),
        // PostgreSQL timestamps can retain microseconds that are truncated
        // when decoded into a JavaScript Date. Comparing the selected value
        // for exact equality therefore leaves an interrupted run unclaimed.
        // The stale cutoff is also a safe cross-process lease: the first
        // claimant refreshes heartbeatAt, so every later claimant misses it.
        lt(leadGenerationProviderRunsTable.heartbeatAt, staleBefore),
        or(
          inArray(leadGenerationProviderRunsTable.status, ['pending', 'syncing']),
          and(
            eq(leadGenerationProviderRunsTable.id, latestRun.id),
            eq(leadGenerationProviderRunsTable.status, 'succeeded'),
            eq(leadGenerationProviderRunsTable.persistedCount, 0),
            sql`${leadGenerationProviderRunsTable.fetchedCount} > 0`,
          ),
        ),
      ))
      .returning();
    if (leased) claimed.push(leased);
  }
  return claimed;
}

export async function getLeadGenerationProviderRunForUser(
  id: number,
  userId: number,
): Promise<LeadGenerationProviderRun | null> {
  const [row] = await db.select()
    .from(leadGenerationProviderRunsTable)
    .where(and(
      eq(leadGenerationProviderRunsTable.id, id),
      eq(leadGenerationProviderRunsTable.userId, userId),
    ))
    .limit(1);
  return row || null;
}
