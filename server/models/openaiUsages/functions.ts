 
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { db } from "../db";
import { openaiUsagesTable, type OpenAIUsage, type InsertOpenAIUsage } from "./schema";

// Create a new usage record
export async function createOpenAIUsage(data: InsertOpenAIUsage): Promise<OpenAIUsage> {
  const [usage] = await db.insert(openaiUsagesTable).values(data).returning();
  return usage;
}

// Get usage by ID
export async function getOpenAIUsageById(id: number): Promise<OpenAIUsage | undefined> {
  const [usage] = await db.select().from(openaiUsagesTable).where(eq(openaiUsagesTable.id, id));
  return usage;
}

// Get usage records by user ID
export async function getOpenAIUsagesByUserId(
  userId: number, 
  options?: { 
    limit?: number; 
    offset?: number;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<OpenAIUsage[]> {
  const conditions = [eq(openaiUsagesTable.userId, userId)];
  
  if (options?.startDate) {
    conditions.push(gte(openaiUsagesTable.createdAt, options.startDate));
  }
  if (options?.endDate) {
    conditions.push(lte(openaiUsagesTable.createdAt, options.endDate));
  }

  return await db
    .select()
    .from(openaiUsagesTable)
    .where(and(...conditions))
    .orderBy(desc(openaiUsagesTable.createdAt))
    .limit(options?.limit || 100)
    .offset(options?.offset || 0);
}

// Get usage records by thread ID
export async function getOpenAIUsagesByThreadId(threadId: number): Promise<OpenAIUsage[]> {
  return await db
    .select()
    .from(openaiUsagesTable)
    .where(eq(openaiUsagesTable.threadId, threadId))
    .orderBy(desc(openaiUsagesTable.createdAt));
}

// Get usage summary by user
export async function getOpenAIUsageSummaryByUser(userId: number, startDate?: Date, endDate?: Date): Promise<{
  totalCalls: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  estimatedCostCents: number;
  byPurpose: Record<string, { calls: number; tokens: number }>;
  byModel: Record<string, { calls: number; tokens: number }>;
}> {
  const conditions = [eq(openaiUsagesTable.userId, userId)];
  
  if (startDate) {
    conditions.push(gte(openaiUsagesTable.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(openaiUsagesTable.createdAt, endDate));
  }

  const usages = await db
    .select()
    .from(openaiUsagesTable)
    .where(and(...conditions));

  const summary = {
    totalCalls: usages.length,
    totalTokens: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    estimatedCostCents: 0,
    byPurpose: {} as Record<string, { calls: number; tokens: number }>,
    byModel: {} as Record<string, { calls: number; tokens: number }>,
  };

  for (const usage of usages) {
    summary.totalTokens += usage.totalTokens || 0;
    summary.totalPromptTokens += usage.promptTokens || 0;
    summary.totalCompletionTokens += usage.completionTokens || 0;
    summary.estimatedCostCents += usage.estimatedCostCents || 0;

    // By purpose
    if (!summary.byPurpose[usage.purpose]) {
      summary.byPurpose[usage.purpose] = { calls: 0, tokens: 0 };
    }
    summary.byPurpose[usage.purpose].calls += 1;
    summary.byPurpose[usage.purpose].tokens += usage.totalTokens || 0;

    // By model
    if (!summary.byModel[usage.model]) {
      summary.byModel[usage.model] = { calls: 0, tokens: 0 };
    }
    summary.byModel[usage.model].calls += 1;
    summary.byModel[usage.model].tokens += usage.totalTokens || 0;
  }

  return summary;
}

// Get recent usages with pagination
export async function getRecentOpenAIUsages(options?: {
  limit?: number;
  offset?: number;
  userId?: number;
  purpose?: string;
  service?: string;
}): Promise<OpenAIUsage[]> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (options?.userId) {
    conditions.push(eq(openaiUsagesTable.userId, options.userId));
  }
  if (options?.purpose) {
    conditions.push(eq(openaiUsagesTable.purpose, options.purpose));
  }
  if (options?.service) {
    conditions.push(eq(openaiUsagesTable.service, options.service));
  }

  const query = db
    .select()
    .from(openaiUsagesTable)
    .orderBy(desc(openaiUsagesTable.createdAt))
    .limit(options?.limit || 50)
    .offset(options?.offset || 0);

  if (conditions.length > 0) {
    return await query.where(and(...conditions));
  }

  return await query;
}

// Delete old usage records (for cleanup/GDPR)
export async function deleteOldOpenAIUsages(olderThanDays: number = 90): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const result = await db
    .delete(openaiUsagesTable)
    .where(lte(openaiUsagesTable.createdAt, cutoffDate));

  return result.rowCount || 0;
}
