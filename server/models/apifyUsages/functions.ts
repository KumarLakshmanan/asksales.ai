import { db } from "../db";
import { apifyUsagesTable, type ApifyUsage, type InsertApifyUsage } from "./schema";
 
import { eq, desc, sql, and, gte, lte, count, inArray } from "drizzle-orm";
import { usersTable } from "../users/schema";

/**
 * Insert a new Apify usage record
 */
export async function insertApifyUsage(usage: InsertApifyUsage): Promise<ApifyUsage> {
  const [inserted] = await db.insert(apifyUsagesTable)
    .values(usage)
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  if (usage.runId) {
    const [existing] = await db.select()
      .from(apifyUsagesTable)
      .where(and(
        eq(apifyUsagesTable.userId, usage.userId),
        eq(apifyUsagesTable.runId, usage.runId),
        eq(apifyUsagesTable.action, usage.action || 'run_actor'),
      ))
      .limit(1);
    if (existing) return existing;
  }
  throw new Error('Apify usage record could not be inserted or reconciled.');
}

/**
 * Get recent Apify usages across all users (admin view)
 */
export async function getRecentApifyUsages(options: { limit?: number; startDate?: Date } = {}) {
  const { limit = 100, startDate } = options;
  
  const conditions = [];
  if (startDate) {
    conditions.push(gte(apifyUsagesTable.createdAt, startDate));
  }
  
  return db.select({
    id: apifyUsagesTable.id,
    userId: apifyUsagesTable.userId,
    userName: usersTable.name,
    userEmail: usersTable.email,
    threadId: apifyUsagesTable.threadId,
    workflowId: apifyUsagesTable.workflowId,
    actorId: apifyUsagesTable.actorId,
    actorName: apifyUsagesTable.actorName,
    runId: apifyUsagesTable.runId,
    purpose: apifyUsagesTable.purpose,
    service: apifyUsagesTable.service,
    action: apifyUsagesTable.action,
    computeUnits: apifyUsagesTable.computeUnits,
    itemsScraped: apifyUsagesTable.itemsScraped,
    estimatedCostCents: apifyUsagesTable.estimatedCostCents,
    durationMs: apifyUsagesTable.durationMs,
    responseSuccess: apifyUsagesTable.responseSuccess,
    createdAt: apifyUsagesTable.createdAt,
  })
    .from(apifyUsagesTable)
    .leftJoin(usersTable, eq(apifyUsagesTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(apifyUsagesTable.createdAt))
    .limit(limit);
}

/**
 * Get usage summary for a user
 */
export async function getApifyUsageSummaryByUser(
  userId: number,
  startDate?: Date,
  endDate?: Date
): Promise<{
  totalRuns: number;
  totalComputeUnits: number;
  totalCostCents: number;
  totalItemsScraped: number;
  successRate: number;
}> {
  const conditions = [eq(apifyUsagesTable.userId, userId)];
  
  if (startDate) {
    conditions.push(gte(apifyUsagesTable.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(apifyUsagesTable.createdAt, endDate));
  }
  
  const [result] = await db.select({
    totalRuns: count(),
    totalComputeUnits: sql<number>`COALESCE(SUM(${apifyUsagesTable.computeUnits}), 0)::numeric`,
    totalCostCents: sql<number>`COALESCE(SUM(${apifyUsagesTable.estimatedCostCents}), 0)`,
    totalItemsScraped: sql<number>`COALESCE(SUM(${apifyUsagesTable.itemsScraped}), 0)`,
    successCount: sql<number>`SUM(CASE WHEN ${apifyUsagesTable.responseSuccess} = 1 THEN 1 ELSE 0 END)`,
  })
    .from(apifyUsagesTable)
    .where(and(...conditions));
  
  const totalRuns = Number(result?.totalRuns) || 0;
  const successCount = Number(result?.successCount) || 0;
  
  return {
    totalRuns,
    totalComputeUnits: Number(result?.totalComputeUnits) || 0,
    totalCostCents: Number(result?.totalCostCents) || 0,
    totalItemsScraped: Number(result?.totalItemsScraped) || 0,
    successRate: totalRuns > 0 ? (successCount / totalRuns) * 100 : 100,
  };
}

/**
 * Get all-users usage summary (admin view)
 */
export async function getApifyUsageSummaryAll(
  startDate?: Date,
  endDate?: Date
) {
  const conditions = [];
  if (startDate) {
    conditions.push(gte(apifyUsagesTable.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(apifyUsagesTable.createdAt, endDate));
  }
  
  // Basic aggregates
  const [basicStats] = await db.select({
    totalRuns: count(),
    totalComputeUnits: sql<number>`COALESCE(SUM(${apifyUsagesTable.computeUnits}), 0)::numeric`,
    totalCostCents: sql<number>`COALESCE(SUM(${apifyUsagesTable.estimatedCostCents}), 0)`,
    totalItemsScraped: sql<number>`COALESCE(SUM(${apifyUsagesTable.itemsScraped}), 0)`,
    successCount: sql<number>`SUM(CASE WHEN ${apifyUsagesTable.responseSuccess} = 1 THEN 1 ELSE 0 END)`,
    avgDurationMs: sql<number>`AVG(${apifyUsagesTable.durationMs})`,
  })
    .from(apifyUsagesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  
  // Group by actor
  const byActor = await db.select({
    actorId: apifyUsagesTable.actorId,
    actorName: apifyUsagesTable.actorName,
    runs: count(),
    computeUnits: sql<number>`COALESCE(SUM(${apifyUsagesTable.computeUnits}), 0)::numeric`,
    costCents: sql<number>`COALESCE(SUM(${apifyUsagesTable.estimatedCostCents}), 0)`,
    itemsScraped: sql<number>`COALESCE(SUM(${apifyUsagesTable.itemsScraped}), 0)`,
  })
    .from(apifyUsagesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(apifyUsagesTable.actorId, apifyUsagesTable.actorName);
  
  // Group by user
  const byUser = await db.select({
    userId: apifyUsagesTable.userId,
    userName: usersTable.name,
    userEmail: usersTable.email,
    runs: count(),
    computeUnits: sql<number>`COALESCE(SUM(${apifyUsagesTable.computeUnits}), 0)::numeric`,
    costCents: sql<number>`COALESCE(SUM(${apifyUsagesTable.estimatedCostCents}), 0)`,
    itemsScraped: sql<number>`COALESCE(SUM(${apifyUsagesTable.itemsScraped}), 0)`,
  })
    .from(apifyUsagesTable)
    .leftJoin(usersTable, eq(apifyUsagesTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(apifyUsagesTable.userId, usersTable.name, usersTable.email);
  
  // Daily breakdown
  const byDay = await db.select({
    date: sql<string>`DATE(${apifyUsagesTable.createdAt})`,
    runs: count(),
    computeUnits: sql<number>`COALESCE(SUM(${apifyUsagesTable.computeUnits}), 0)::numeric`,
    costCents: sql<number>`COALESCE(SUM(${apifyUsagesTable.estimatedCostCents}), 0)`,
    itemsScraped: sql<number>`COALESCE(SUM(${apifyUsagesTable.itemsScraped}), 0)`,
  })
    .from(apifyUsagesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`DATE(${apifyUsagesTable.createdAt})`)
    .orderBy(sql`DATE(${apifyUsagesTable.createdAt})`);
  
  const totalRuns = Number(basicStats?.totalRuns) || 0;
  const successCount = Number(basicStats?.successCount) || 0;
  
  // Build byActor map
  const byActorMap: Record<string, { name: string; runs: number; computeUnits: number; costCents: number; itemsScraped: number }> = {};
  for (const item of byActor) {
    byActorMap[item.actorId] = {
      name: item.actorName || item.actorId,
      runs: Number(item.runs),
      computeUnits: Number(item.computeUnits),
      costCents: Number(item.costCents),
      itemsScraped: Number(item.itemsScraped),
    };
  }
  
  // Build byUser map
  const byUserMap: Record<string, { userName: string; userEmail: string | null; runs: number; computeUnits: number; costCents: number; itemsScraped: number }> = {};
  for (const item of byUser) {
    byUserMap[String(item.userId)] = {
      userName: item.userName || `User ${item.userId}`,
      userEmail: item.userEmail,
      runs: Number(item.runs),
      computeUnits: Number(item.computeUnits),
      costCents: Number(item.costCents),
      itemsScraped: Number(item.itemsScraped),
    };
  }
  
  return {
    totalRuns,
    totalComputeUnits: Number(basicStats?.totalComputeUnits) || 0,
    totalCostCents: Number(basicStats?.totalCostCents) || 0,
    totalItemsScraped: Number(basicStats?.totalItemsScraped) || 0,
    successRate: totalRuns > 0 ? (successCount / totalRuns) * 100 : 100,
    avgDurationMs: Number(basicStats?.avgDurationMs) || 0,
    byActor: byActorMap,
    byUser: byUserMap,
    byDay: byDay.map((item: { date: string; runs: number; computeUnits: number; costCents: number; itemsScraped: number }) => ({
      date: item.date,
      runs: Number(item.runs),
      computeUnits: Number(item.computeUnits),
      costCents: Number(item.costCents),
      itemsScraped: Number(item.itemsScraped),
    })),
  };
}

/**
 * Get Apify usages by run ID for a specific user
 */
export async function getApifyUsagesByRunId(userId: number, runId: string): Promise<ApifyUsage[]> {
  return db.select()
    .from(apifyUsagesTable)
    .where(and(
      eq(apifyUsagesTable.userId, userId),
      eq(apifyUsagesTable.runId, runId)
    ))
    .orderBy(desc(apifyUsagesTable.createdAt));
}

/**
 * Get Apify usages by thread ID for a specific user
 */
export async function getApifyUsagesByThreadId(userId: number, threadId: number): Promise<ApifyUsage[]> {
  return db.select()
    .from(apifyUsagesTable)
    .where(and(
      eq(apifyUsagesTable.userId, userId),
      eq(apifyUsagesTable.threadId, threadId)
    ))
    .orderBy(desc(apifyUsagesTable.createdAt));
}

export { apifyUsagesTable, type ApifyUsage, type InsertApifyUsage };

/** Successful past runs of each actor for this user, used to estimate the
 * cost and duration of a reviewed search before it is approved. */
export async function getActorRunHistory(userId: number | null, actorIds: string[], sinceDays = 180): Promise<Array<{
  actorId: string; runs: number; items: number; costCents: number; avgDurationMs: number | null; maxDurationMs: number | null;
}>> {
  const ids = [...new Set(actorIds.filter(Boolean))];
  if (!ids.length) return [];
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const rows = await db.select({
    actorId: apifyUsagesTable.actorId,
    runs: count(),
    items: sql<number>`COALESCE(SUM(${apifyUsagesTable.itemsScraped}), 0)`,
    costCents: sql<number>`COALESCE(SUM(${apifyUsagesTable.estimatedCostCents}), 0)`,
    avgDurationMs: sql<number | null>`AVG(${apifyUsagesTable.durationMs})`,
    maxDurationMs: sql<number | null>`MAX(${apifyUsagesTable.durationMs})`,
  }).from(apifyUsagesTable).where(and(
    ...(userId === null ? [] : [eq(apifyUsagesTable.userId, userId)]),
    inArray(apifyUsagesTable.actorId, ids),
    eq(apifyUsagesTable.responseSuccess, 1),
    gte(apifyUsagesTable.createdAt, since),
    sql`${apifyUsagesTable.itemsScraped} > 0`,
  )).groupBy(apifyUsagesTable.actorId);
  return (Array.isArray(rows) ? rows : []).map(row => ({
    actorId: String(row.actorId), runs: Number(row.runs) || 0, items: Number(row.items) || 0, costCents: Number(row.costCents) || 0,
    avgDurationMs: row.avgDurationMs == null ? null : Number(row.avgDurationMs), maxDurationMs: row.maxDurationMs == null ? null : Number(row.maxDurationMs),
  }));
}

/** Per-scraper totals across all accounts (no account identifiers), used only
 * to estimate a first search for an account with no history of its own. */
export async function getActorRunHistoryAllAccounts(actorIds: string[], sinceDays = 180) {
  const { withSystemScope } = await import('../../tenancy/businessContext.js');
  return withSystemScope('Aggregate scraper cost per result for a pre-approval estimate', () => getActorRunHistory(null, actorIds, sinceDays));
}
