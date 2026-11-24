/**
 * ZeroBounce Usage Functions
 * CRUD operations for ZeroBounce usage tracking
 */

import { db } from "../db";
import { zerobounceUsagesTable, NewZerobounceUsage, ZerobounceUsage } from "./schema";
import { usersTable } from "../users/schema";
import { eq, desc, sql, and, gte, lte } from "drizzle-orm";

/**
 * Record a new ZeroBounce usage entry
 */
export async function createZerobounceUsage(data: NewZerobounceUsage): Promise<ZerobounceUsage> {
  const [usage] = await db.insert(zerobounceUsagesTable).values(data).returning();
  return usage;
}

/**
 * Get all ZeroBounce usage (admin) with user info
 */
export async function getAllZerobounceUsages(
  options?: {
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    operationType?: string;
  }
) {
  const { limit = 50, offset = 0, startDate, endDate, operationType } = options || {};
  
  const conditions = [];
  
  if (startDate) {
    conditions.push(gte(zerobounceUsagesTable.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(zerobounceUsagesTable.createdAt, endDate));
  }
  if (operationType) {
    conditions.push(eq(zerobounceUsagesTable.operationType, operationType));
  }
  
  return db.select({
    id: zerobounceUsagesTable.id,
    userId: zerobounceUsagesTable.userId,
    operationType: zerobounceUsagesTable.operationType,
    emailsValidated: zerobounceUsagesTable.emailsValidated,
    validEmails: zerobounceUsagesTable.validEmails,
    invalidEmails: zerobounceUsagesTable.invalidEmails,
    catchAllEmails: zerobounceUsagesTable.catchAllEmails,
    unknownEmails: zerobounceUsagesTable.unknownEmails,
    creditsUsed: zerobounceUsagesTable.creditsUsed,
    costCents: zerobounceUsagesTable.costCents,
    service: zerobounceUsagesTable.service,
    purpose: zerobounceUsagesTable.purpose,
    status: zerobounceUsagesTable.status,
    errorMessage: zerobounceUsagesTable.errorMessage,
    createdAt: zerobounceUsagesTable.createdAt,
    userName: usersTable.name,
    userEmail: usersTable.email,
  })
    .from(zerobounceUsagesTable)
    .leftJoin(usersTable, eq(zerobounceUsagesTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(zerobounceUsagesTable.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get ZeroBounce usage statistics for a user
 */
export async function getZerobounceUsageStats(userId: number, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const [stats] = await db.select({
    totalRequests: sql<number>`count(*)`,
    totalEmailsValidated: sql<number>`coalesce(sum(${zerobounceUsagesTable.emailsValidated}), 0)`,
    totalValidEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.validEmails}), 0)`,
    totalInvalidEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.invalidEmails}), 0)`,
    totalCatchAllEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.catchAllEmails}), 0)`,
    totalCreditsUsed: sql<number>`coalesce(sum(${zerobounceUsagesTable.creditsUsed}), 0)`,
    totalCostCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
    successCount: sql<number>`sum(case when ${zerobounceUsagesTable.status} = 'success' then 1 else 0 end)`,
    errorCount: sql<number>`sum(case when ${zerobounceUsagesTable.status} = 'error' then 1 else 0 end)`,
  })
    .from(zerobounceUsagesTable)
    .where(and(
      eq(zerobounceUsagesTable.userId, userId),
      gte(zerobounceUsagesTable.createdAt, startDate)
    ));
  
  return {
    totalRequests: Number(stats?.totalRequests || 0),
    totalEmailsValidated: Number(stats?.totalEmailsValidated || 0),
    totalValidEmails: Number(stats?.totalValidEmails || 0),
    totalInvalidEmails: Number(stats?.totalInvalidEmails || 0),
    totalCatchAllEmails: Number(stats?.totalCatchAllEmails || 0),
    totalCreditsUsed: Number(stats?.totalCreditsUsed || 0),
    totalCostCents: Number(stats?.totalCostCents || 0),
    successCount: Number(stats?.successCount || 0),
    errorCount: Number(stats?.errorCount || 0),
  };
}

/**
 * Get global ZeroBounce usage statistics (admin)
 */
export async function getGlobalZerobounceUsageStats(days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const [stats] = await db.select({
    totalRequests: sql<number>`count(*)`,
    totalEmailsValidated: sql<number>`coalesce(sum(${zerobounceUsagesTable.emailsValidated}), 0)`,
    totalValidEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.validEmails}), 0)`,
    totalInvalidEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.invalidEmails}), 0)`,
    totalCatchAllEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.catchAllEmails}), 0)`,
    totalCreditsUsed: sql<number>`coalesce(sum(${zerobounceUsagesTable.creditsUsed}), 0)`,
    totalCostCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
    uniqueUsers: sql<number>`count(distinct ${zerobounceUsagesTable.userId})`,
  })
    .from(zerobounceUsagesTable)
    .where(gte(zerobounceUsagesTable.createdAt, startDate));
  
  // Get usage by operation type
  const byOperationType = await db.select({
    operationType: zerobounceUsagesTable.operationType,
    count: sql<number>`count(*)`,
    emailsValidated: sql<number>`coalesce(sum(${zerobounceUsagesTable.emailsValidated}), 0)`,
    creditsUsed: sql<number>`coalesce(sum(${zerobounceUsagesTable.creditsUsed}), 0)`,
    costCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
  })
    .from(zerobounceUsagesTable)
    .where(gte(zerobounceUsagesTable.createdAt, startDate))
    .groupBy(zerobounceUsagesTable.operationType);
  
  // Get daily usage
  const dailyUsage = await db.select({
    date: sql<string>`date(${zerobounceUsagesTable.createdAt})`,
    requests: sql<number>`count(*)`,
    emailsValidated: sql<number>`coalesce(sum(${zerobounceUsagesTable.emailsValidated}), 0)`,
    creditsUsed: sql<number>`coalesce(sum(${zerobounceUsagesTable.creditsUsed}), 0)`,
    costCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
  })
    .from(zerobounceUsagesTable)
    .where(gte(zerobounceUsagesTable.createdAt, startDate))
    .groupBy(sql`date(${zerobounceUsagesTable.createdAt})`)
    .orderBy(sql`date(${zerobounceUsagesTable.createdAt})`);
  
  // Get usage by user
  const byUser = await db.select({
    userId: zerobounceUsagesTable.userId,
    userName: usersTable.name,
    userEmail: usersTable.email,
    requests: sql<number>`count(*)`,
    emailsValidated: sql<number>`coalesce(sum(${zerobounceUsagesTable.emailsValidated}), 0)`,
    validEmails: sql<number>`coalesce(sum(${zerobounceUsagesTable.validEmails}), 0)`,
    creditsUsed: sql<number>`coalesce(sum(${zerobounceUsagesTable.creditsUsed}), 0)`,
    costCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
  })
    .from(zerobounceUsagesTable)
    .leftJoin(usersTable, eq(zerobounceUsagesTable.userId, usersTable.id))
    .where(gte(zerobounceUsagesTable.createdAt, startDate))
    .groupBy(zerobounceUsagesTable.userId, usersTable.name, usersTable.email)
    .orderBy(sql`count(*) desc`)
    .limit(20);
  
  return {
    totalRequests: Number(stats?.totalRequests || 0),
    totalEmailsValidated: Number(stats?.totalEmailsValidated || 0),
    totalValidEmails: Number(stats?.totalValidEmails || 0),
    totalInvalidEmails: Number(stats?.totalInvalidEmails || 0),
    totalCatchAllEmails: Number(stats?.totalCatchAllEmails || 0),
    totalCreditsUsed: Number(stats?.totalCreditsUsed || 0),
    totalCostCents: Number(stats?.totalCostCents || 0),
    uniqueUsers: Number(stats?.uniqueUsers || 0),
    byOperationType,
    dailyUsage,
    byUser,
  };
}
