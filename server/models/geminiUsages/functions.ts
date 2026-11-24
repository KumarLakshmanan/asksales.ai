/**
 * Gemini Usage Functions
 * CRUD operations for Gemini usage tracking
 */

import { db } from "../db";
import { geminiUsagesTable, NewGeminiUsage, GeminiUsage } from "./schema";
import { usersTable } from "../users/schema";
import { eq, desc, sql, and, gte, lte } from "drizzle-orm";
import { usageMetadata } from '../../services/insights/UsageContext.js';

/**
 * Record a new Gemini usage entry
 */
export async function createGeminiUsage(data: NewGeminiUsage): Promise<GeminiUsage> {
  const [usage] = await db.insert(geminiUsagesTable).values({ ...data, metadata:usageMetadata(data.metadata as Record<string,unknown>|null) }).returning();
  return usage;
}

/**
 * Get all Gemini usage (admin) with user info
 */
export async function getAllGeminiUsages(
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
    conditions.push(gte(geminiUsagesTable.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(geminiUsagesTable.createdAt, endDate));
  }
  if (operationType) {
    conditions.push(eq(geminiUsagesTable.operationType, operationType));
  }
  
  return db.select({
    id: geminiUsagesTable.id,
    userId: geminiUsagesTable.userId,
    operationType: geminiUsagesTable.operationType,
    model: geminiUsagesTable.model,
    prompt: geminiUsagesTable.prompt,
    inputTokens: geminiUsagesTable.inputTokens,
    outputTokens: geminiUsagesTable.outputTokens,
    imagesGenerated: geminiUsagesTable.imagesGenerated,
    videosGenerated: geminiUsagesTable.videosGenerated,
    costCents: geminiUsagesTable.costCents,
    service: geminiUsagesTable.service,
    purpose: geminiUsagesTable.purpose,
    status: geminiUsagesTable.status,
    errorMessage: geminiUsagesTable.errorMessage,
    createdAt: geminiUsagesTable.createdAt,
    userName: usersTable.name,
    userEmail: usersTable.email,
  })
    .from(geminiUsagesTable)
    .leftJoin(usersTable, eq(geminiUsagesTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(geminiUsagesTable.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get Gemini usage statistics for a user
 */
export async function getGeminiUsageStats(userId: number, days = 30, operationType?: string) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const conditions = [
    eq(geminiUsagesTable.userId, userId),
    gte(geminiUsagesTable.createdAt, startDate),
  ];
  if (operationType) {
    conditions.push(eq(geminiUsagesTable.operationType, operationType));
  }

  const [stats] = await db.select({
    totalRequests: sql<number>`count(*)`,
    totalInputTokens: sql<number>`coalesce(sum(${geminiUsagesTable.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${geminiUsagesTable.outputTokens}), 0)`,
    totalImages: sql<number>`coalesce(sum(${geminiUsagesTable.imagesGenerated}), 0)`,
    totalVideos: sql<number>`coalesce(sum(${geminiUsagesTable.videosGenerated}), 0)`,
    totalCostCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
    successCount: sql<number>`sum(case when ${geminiUsagesTable.status} = 'success' then 1 else 0 end)`,
    errorCount: sql<number>`sum(case when ${geminiUsagesTable.status} = 'error' then 1 else 0 end)`,
  })
    .from(geminiUsagesTable)
    .where(and(...conditions));
  
  return {
    totalRequests: Number(stats?.totalRequests || 0),
    totalInputTokens: Number(stats?.totalInputTokens || 0),
    totalOutputTokens: Number(stats?.totalOutputTokens || 0),
    totalImages: Number(stats?.totalImages || 0),
    totalVideos: Number(stats?.totalVideos || 0),
    totalCostCents: Number(stats?.totalCostCents || 0),
    successCount: Number(stats?.successCount || 0),
    errorCount: Number(stats?.errorCount || 0),
  };
}

/**
 * Get global Gemini usage statistics (admin)
 */
export async function getGlobalGeminiUsageStats(days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const [stats] = await db.select({
    totalRequests: sql<number>`count(*)`,
    totalInputTokens: sql<number>`coalesce(sum(${geminiUsagesTable.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${geminiUsagesTable.outputTokens}), 0)`,
    totalImages: sql<number>`coalesce(sum(${geminiUsagesTable.imagesGenerated}), 0)`,
    totalVideos: sql<number>`coalesce(sum(${geminiUsagesTable.videosGenerated}), 0)`,
    totalCostCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
    uniqueUsers: sql<number>`count(distinct ${geminiUsagesTable.userId})`,
  })
    .from(geminiUsagesTable)
    .where(gte(geminiUsagesTable.createdAt, startDate));
  
  // Get usage by operation type
  const byOperationType = await db.select({
    operationType: geminiUsagesTable.operationType,
    count: sql<number>`count(*)`,
    costCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
  })
    .from(geminiUsagesTable)
    .where(gte(geminiUsagesTable.createdAt, startDate))
    .groupBy(geminiUsagesTable.operationType);
  
  // Get daily usage
  const dailyUsage = await db.select({
    date: sql<string>`date(${geminiUsagesTable.createdAt})`,
    requests: sql<number>`count(*)`,
    costCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
  })
    .from(geminiUsagesTable)
    .where(gte(geminiUsagesTable.createdAt, startDate))
    .groupBy(sql`date(${geminiUsagesTable.createdAt})`)
    .orderBy(sql`date(${geminiUsagesTable.createdAt})`);
  
  // Get usage by user
  const byUser = await db.select({
    userId: geminiUsagesTable.userId,
    userName: usersTable.name,
    userEmail: usersTable.email,
    requests: sql<number>`count(*)`,
    imagesGenerated: sql<number>`coalesce(sum(${geminiUsagesTable.imagesGenerated}), 0)`,
    videosGenerated: sql<number>`coalesce(sum(${geminiUsagesTable.videosGenerated}), 0)`,
    costCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
  })
    .from(geminiUsagesTable)
    .leftJoin(usersTable, eq(geminiUsagesTable.userId, usersTable.id))
    .where(gte(geminiUsagesTable.createdAt, startDate))
    .groupBy(geminiUsagesTable.userId, usersTable.name, usersTable.email)
    .orderBy(sql`count(*) desc`)
    .limit(20);
  
  return {
    totalRequests: Number(stats?.totalRequests || 0),
    totalInputTokens: Number(stats?.totalInputTokens || 0),
    totalOutputTokens: Number(stats?.totalOutputTokens || 0),
    totalImages: Number(stats?.totalImages || 0),
    totalVideos: Number(stats?.totalVideos || 0),
    totalCostCents: Number(stats?.totalCostCents || 0),
    uniqueUsers: Number(stats?.uniqueUsers || 0),
    byOperationType,
    dailyUsage,
    byUser,
  };
}
