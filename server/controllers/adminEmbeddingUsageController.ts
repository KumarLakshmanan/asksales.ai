/**
 * Admin Embedding Usage Controller
 * Analytics for embedding API usage
 */

import type { Request, Response } from "express";
import { db } from "../models/db";
import { embeddingUsagesTable } from "../models/embeddingUsages/schema";
import { usersTable } from "../models/users/schema";
import { eq, gte, desc, and } from "drizzle-orm";
import { logger } from '../utils/logger.js';
import { getDateRange } from "../utils/reportingDates.js";

export async function getEmbeddingUsage(req: Request, res: Response) {
  try {
    const { timeRange, provider, days } = req.query;
    let startDate: Date;
    if (days === 'all') {
      startDate = new Date(0);
    } else if (days) {
      startDate = getDateRange(`${days}d`);
    } else {
      startDate = getDateRange((timeRange as string) || '7d');
    }

    const conditions = [gte(embeddingUsagesTable.createdAt, startDate)];
    if (provider) {
      conditions.push(eq(embeddingUsagesTable.provider, provider as string));
    }

    const usages = await db
      .select({
        id: embeddingUsagesTable.id,
        userId: embeddingUsagesTable.userId,
        provider: embeddingUsagesTable.provider,
        model: embeddingUsagesTable.model,
        purpose: embeddingUsagesTable.purpose,
        service: embeddingUsagesTable.service,
        inputTokens: embeddingUsagesTable.inputTokens,
        totalTokens: embeddingUsagesTable.totalTokens,
        estimatedCostCents: embeddingUsagesTable.estimatedCostCents,
        originalCostCents: embeddingUsagesTable.originalCostCents,
        dimensions: embeddingUsagesTable.dimensions,
        textsCount: embeddingUsagesTable.textsCount,
        responseSuccess: embeddingUsagesTable.responseSuccess,
        durationMs: embeddingUsagesTable.durationMs,
        createdAt: embeddingUsagesTable.createdAt,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(embeddingUsagesTable)
      .leftJoin(usersTable, eq(embeddingUsagesTable.userId, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(embeddingUsagesTable.createdAt))
;

    type UsageRecord = typeof usages[number];

    const totalCalls = usages.length;
    const totalTokens = usages.reduce((s: number, u: UsageRecord) => s + (u.totalTokens || 0), 0);
    const totalCostCents = usages.reduce((s: number, u: UsageRecord) => s + (u.estimatedCostCents || 0), 0);
    const totalOriginalCostCents = usages.reduce((s: number, u: UsageRecord) => s + (u.originalCostCents || 0), 0);
    const successCount = usages.filter((u: UsageRecord) => u.responseSuccess === 1).length;
    const successRate = totalCalls > 0 ? (successCount / totalCalls) * 100 : 0;
    const totalTexts = usages.reduce((s: number, u: UsageRecord) => s + (u.textsCount || 0), 0);
    const avgDurationMs = totalCalls > 0
      ? usages.reduce((s: number, u: UsageRecord) => s + (u.durationMs || 0), 0) / totalCalls
      : 0;

    const byModel: Record<string, { calls: number; tokens: number; costCents: number }> = {};
    const byProvider: Record<string, { calls: number; tokens: number; costCents: number }> = {};
    for (const u of usages) {
      if (!byModel[u.model]) byModel[u.model] = { calls: 0, tokens: 0, costCents: 0 };
      byModel[u.model].calls += 1;
      byModel[u.model].tokens += u.totalTokens || 0;
      byModel[u.model].costCents += u.estimatedCostCents || 0;

      const prov = u.provider || 'unknown';
      if (!byProvider[prov]) byProvider[prov] = { calls: 0, tokens: 0, costCents: 0 };
      byProvider[prov].calls += 1;
      byProvider[prov].tokens += u.totalTokens || 0;
      byProvider[prov].costCents += u.estimatedCostCents || 0;
    }

    return res.json({
      success: true,
      data: {
        usages,
        summary: {
          totalCalls,
          totalTokens,
          totalCost: totalCostCents / 100,
          totalCostCents,
          totalOriginalCostCents,
          revenue: (totalCostCents - totalOriginalCostCents) / 100,
          successRate: Math.round(successRate * 10) / 10,
          totalTexts,
          avgDurationMs: Math.round(avgDurationMs),
          byModel,
          byProvider,
        },
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[adminEmbeddingUsage] Failed to fetch embedding usage');
    return res.status(500).json({ success: false, error: 'Failed to fetch embedding usage' });
  }
}

export async function getEmbeddingUsageStats(req: Request, res: Response) {
  try {
    const { days } = req.query;
    const startDate = days === 'all' ? new Date(0) : getDateRange(`${days || '30'}d`);

    const usages = await db
      .select({
        provider: embeddingUsagesTable.provider,
        model: embeddingUsagesTable.model,
        totalTokens: embeddingUsagesTable.totalTokens,
        estimatedCostCents: embeddingUsagesTable.estimatedCostCents,
        originalCostCents: embeddingUsagesTable.originalCostCents,
        textsCount: embeddingUsagesTable.textsCount,
        responseSuccess: embeddingUsagesTable.responseSuccess,
      })
      .from(embeddingUsagesTable)
      .where(gte(embeddingUsagesTable.createdAt, startDate));

    type StatsRecord = typeof usages[number];

    const totalCalls = usages.length;
    const totalTokens = usages.reduce((s: number, u: StatsRecord) => s + (u.totalTokens || 0), 0);
    const totalCostCents = usages.reduce((s: number, u: StatsRecord) => s + (u.estimatedCostCents || 0), 0);
    const totalOriginalCostCents = usages.reduce((s: number, u: StatsRecord) => s + (u.originalCostCents || 0), 0);
    const totalTexts = usages.reduce((s: number, u: StatsRecord) => s + (u.textsCount || 0), 0);

    return res.json({
      success: true,
      data: {
        totalCalls,
        totalTokens,
        totalCost: totalCostCents / 100,
        totalOriginalCost: totalOriginalCostCents / 100,
        revenue: (totalCostCents - totalOriginalCostCents) / 100,
        totalTexts,
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[adminEmbeddingUsage] Failed to fetch stats');
    return res.status(500).json({ success: false, error: 'Failed to fetch embedding usage stats' });
  }
}
