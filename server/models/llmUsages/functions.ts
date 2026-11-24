 
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { db } from "../db";
import { openaiUsagesTable, type OpenAIUsage, type InsertOpenAIUsage } from "../openaiUsages/schema";
import { usageMetadata } from '../../services/insights/UsageContext.js';
export { getOpenAIUsageById, getOpenAIUsagesByThreadId, deleteOldOpenAIUsages } from "../openaiUsages/functions";

// Alias for better naming - now supports multiple LLM providers
export type LLMUsage = OpenAIUsage;
export type InsertLLMUsage = InsertOpenAIUsage;

// Create a new usage record (works for both OpenAI and OpenRouter)
export async function createLLMUsage(data: InsertLLMUsage): Promise<LLMUsage> {
  const [usage] = await db.insert(openaiUsagesTable).values({ ...data, metadata: usageMetadata(data.metadata) }).returning();
  return usage;
}

// Backward compatibility alias
export const createOpenAIUsage = createLLMUsage;

// Get usage records by user ID
export async function getOpenAIUsagesByUserId(
  userId: number, 
  options?: { 
    limit?: number; 
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    provider?: string; // Filter by provider
  }
): Promise<OpenAIUsage[]> {
  const conditions = [eq(openaiUsagesTable.userId, userId)];
  
  if (options?.startDate) {
    conditions.push(gte(openaiUsagesTable.createdAt, options.startDate));
  }
  if (options?.endDate) {
    conditions.push(lte(openaiUsagesTable.createdAt, options.endDate));
  }
  if (options?.provider) {
    conditions.push(eq(openaiUsagesTable.provider, options.provider));
  }

  return await db
    .select()
    .from(openaiUsagesTable)
    .where(and(...conditions))
    .orderBy(desc(openaiUsagesTable.createdAt))
    .limit(options?.limit || 100)
    .offset(options?.offset || 0);
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
  byProvider: Record<string, { calls: number; tokens: number; costCents: number }>; // New: breakdown by provider
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
    byProvider: {} as Record<string, { calls: number; tokens: number; costCents: number }>,
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

    // By provider (new)
    const providerKey = usage.provider || 'openai'; // Default to openai for backward compat
    if (!summary.byProvider[providerKey]) {
      summary.byProvider[providerKey] = { calls: 0, tokens: 0, costCents: 0 };
    }
    summary.byProvider[providerKey].calls += 1;
    summary.byProvider[providerKey].tokens += usage.totalTokens || 0;
    summary.byProvider[providerKey].costCents += usage.estimatedCostCents || 0;
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
  provider?: string; // New: filter by provider
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
  if (options?.provider) {
    conditions.push(eq(openaiUsagesTable.provider, options.provider));
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

