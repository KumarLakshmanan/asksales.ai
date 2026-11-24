/**
 * Admin Usage Controller
 * Comprehensive usage analytics for admin dashboard
 */

import type { Request, Response } from "express";
import { db } from "../models/db";
import { openaiUsagesTable } from "../models/openaiUsages/schema";
import { apifyUsagesTable } from "../models/apifyUsages/schema";
import { geminiUsagesTable } from "../models/geminiUsages/schema";
import { zerobounceUsagesTable } from "../models/zerobounceUsages/schema";
import { usersTable } from "../models/users/schema";
import { eq, gte, desc, sql, and } from "drizzle-orm";
import { logger } from '../utils/logger.js';
import { summarizeUsageMeasurements } from '../utils/usageMeasurements.js';
import { getDateRange } from "../utils/reportingDates.js";

/**
 * Get LLM Usage (OpenAI/OpenRouter)
 * Supports filtering by provider
 */
export async function getLLMUsage(req: Request, res: Response) {
  try {
    // Support both 'timeRange' (7d/30d) and 'days' (7/30/90/all) params
    const { timeRange, provider, days } = req.query;
    let startDate: Date;
    if (days === 'all') {
      startDate = new Date(0); // all time
    } else if (days) {
      startDate = getDateRange(`${days}d`);
    } else {
      startDate = getDateRange((timeRange as string) || '7d');
    }

    // Get usage records with user info (including threadId for conversation-level tracking)
    const usages = await db
      .select({
        id: openaiUsagesTable.id,
        userId: openaiUsagesTable.userId,
        threadId: openaiUsagesTable.threadId,
        model: openaiUsagesTable.model,
        provider: openaiUsagesTable.provider,
        purpose: openaiUsagesTable.purpose,
        service: openaiUsagesTable.service,
        promptTokens: openaiUsagesTable.promptTokens,
        completionTokens: openaiUsagesTable.completionTokens,
        totalTokens: openaiUsagesTable.totalTokens,
        estimatedCostCents: openaiUsagesTable.estimatedCostCents,
        durationMs: openaiUsagesTable.durationMs,
        responseSuccess: openaiUsagesTable.responseSuccess,
        createdAt: openaiUsagesTable.createdAt,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(openaiUsagesTable)
      .leftJoin(usersTable, eq(openaiUsagesTable.userId, usersTable.id))
      .where(
        provider
          ? and(
              gte(openaiUsagesTable.createdAt, startDate),
              eq(openaiUsagesTable.provider, provider as string)
            )
          : gte(openaiUsagesTable.createdAt, startDate)
      )
      .orderBy(desc(openaiUsagesTable.createdAt))
;

    // Define usage type
    type UsageRecord = typeof usages[number];
    
    // Calculate summary
    const totalCalls = usages.length;
    const summarize = (rows: UsageRecord[]) => summarizeUsageMeasurements(rows.map(u => ({
      tokens: u.totalTokens, costCents: u.estimatedCostCents, durationMs: u.durationMs,
    })));
    const measurements = summarize(usages);
    const totalTokens = measurements.tokens;
    const totalCostCents = measurements.costCents;
    const totalCost = totalCostCents == null ? null : totalCostCents / 100;
    const successCount = usages.filter((u: UsageRecord) => u.responseSuccess === 1).length;
    const successRate = totalCalls > 0 ? (successCount / totalCalls) * 100 : 0;
    const avgDurationMs = measurements.avgLatency;
    const avgLatency = avgDurationMs;
    const group = (key: (row: UsageRecord) => string | null) => {
      const groups: Record<string, UsageRecord[]> = Object.create(null);
      for (const row of usages) {
        const name = key(row);
        if (name !== null) (groups[name] ??= []).push(row);
      }
      return Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, summarize(rows)]));
    };
    const byModel = group(u => u.model);
    const byPurpose = group(u => u.purpose || 'unknown');
    const threadUsers = new Map(usages.filter((u: UsageRecord) => u.threadId).map((u: UsageRecord) => [String(u.threadId), u.userId]));
    const byThread = Object.fromEntries(Object.entries(group(u => u.threadId ? String(u.threadId) : null))
      .map(([id, data]) => [id, { ...data, userId: threadUsers.get(id) }]));
    const byDay = Object.entries(group(u => new Date(u.createdAt).toISOString().split('T')[0]))
      .map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date));
    const breakdown = Object.entries(byModel).map(([model, data]) => ({
      model, ...data, cost: data.costCents == null ? null : data.costCents / 100,
    })).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));

    // Build recentActivity array (formatted for admin UI table)
    const recentActivity = usages.slice(0, 100).map((u: UsageRecord) => ({
      id: u.id,
      model: u.model,
      purpose: u.purpose,
      service: u.service,
      threadId: u.threadId,
      userId: u.userId,
      userName: u.userName,
      userEmail: u.userEmail,
      tokens: u.totalTokens,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      cost: u.estimatedCostCents == null ? null : u.estimatedCostCents / 100,
      costCents: u.estimatedCostCents,
      latency: u.durationMs,
      success: u.responseSuccess === 1,
      createdAt: u.createdAt,
    }));

    res.json({
      success: true,
      records: usages,
      breakdown,
      recentActivity,
      summary: {
        totalCalls,
        totalTokens,
        totalCost,
        totalCostCents,
        avgLatency,
        avgDurationMs,
        measuredTokenCalls: measurements.measuredTokenCalls,
        measuredCostCalls: measurements.measuredCostCalls,
        measuredDurationCount: measurements.measuredDurationCount,
        totalDurationMs: measurements.totalDurationMs,
        successRate,
        byModel,
        byPurpose,
        byThread,
        byDay,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting LLM usage');
    res.status(500).json({ success: false, error: "Unable to retrieve LLM usage data. Please try again." });
  }
}

/**
 * Get Apify Usage
 * Actor-wise and cost breakdown
 */
export async function getApifyUsageDetailed(req: Request, res: Response) {
  try {
    const { timeRange = '7d', days } = req.query;
    let startDate: Date;
    if (days === 'all') {
      startDate = new Date(0);
    } else if (days) {
      startDate = getDateRange(`${days}d`);
    } else {
      startDate = getDateRange(timeRange as string);
    }

    // Get usage records with user info
    const usages = await db
      .select({
        id: apifyUsagesTable.id,
        userId: apifyUsagesTable.userId,
        actorId: apifyUsagesTable.actorId,
        actorName: apifyUsagesTable.actorName,
        runId: apifyUsagesTable.runId,
        purpose: apifyUsagesTable.purpose,
        service: apifyUsagesTable.service,
        computeUnits: apifyUsagesTable.computeUnits,
        dataTransferGb: apifyUsagesTable.dataTransferGb,
        itemsScraped: apifyUsagesTable.itemsScraped,
        estimatedCostCents: apifyUsagesTable.estimatedCostCents,
        durationMs: apifyUsagesTable.durationMs,
        responseSuccess: apifyUsagesTable.responseSuccess,
        createdAt: apifyUsagesTable.createdAt,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(apifyUsagesTable)
      .leftJoin(usersTable, eq(apifyUsagesTable.userId, usersTable.id))
      .where(gte(apifyUsagesTable.createdAt, startDate))
      .orderBy(desc(apifyUsagesTable.createdAt))
;

    // Define usage type for Apify
    type ApifyUsageRecord = typeof usages[number];
    
    // Calculate summary
    const totalRuns = usages.length;
    const totalItemsScraped = usages.reduce((sum: number, u: ApifyUsageRecord) => sum + (u.itemsScraped || 0), 0);
    const totalComputeUnits = usages.reduce((sum: number, u: ApifyUsageRecord) => sum + (Number(u.computeUnits) || 0), 0);
    const totalCostCents = usages.reduce((sum: number, u: ApifyUsageRecord) => sum + (Number(u.estimatedCostCents) || 0), 0);
    const successCount = usages.filter((u: ApifyUsageRecord) => u.responseSuccess === 1).length;
    const successRate = totalRuns > 0 ? (successCount / totalRuns) * 100 : 0;

    // By actor breakdown
    const byActor: Record<string, { runs: number; items: number; costCents: number; computeUnits: number }> = {};
    for (const usage of usages) {
      const actorName = usage.actorName || usage.actorId || 'unknown';
      if (!byActor[actorName]) {
        byActor[actorName] = { runs: 0, items: 0, costCents: 0, computeUnits: 0 };
      }
      byActor[actorName].runs += 1;
      byActor[actorName].items += usage.itemsScraped || 0;
      byActor[actorName].costCents += Number(usage.estimatedCostCents) || 0;
      byActor[actorName].computeUnits += Number(usage.computeUnits) || 0;
    }

    // By purpose breakdown
    const byPurpose: Record<string, { runs: number; items: number; costCents: number }> = {};
    for (const usage of usages) {
      const purpose = usage.purpose || 'unknown';
      if (!byPurpose[purpose]) {
        byPurpose[purpose] = { runs: 0, items: 0, costCents: 0 };
      }
      byPurpose[purpose].runs += 1;
      byPurpose[purpose].items += usage.itemsScraped || 0;
      byPurpose[purpose].costCents += Number(usage.estimatedCostCents) || 0;
    }

    // By day breakdown
    const byDayMap: Record<string, { runs: number; items: number; costCents: number }> = {};
    for (const usage of usages) {
      const date = new Date(usage.createdAt).toISOString().split('T')[0];
      if (!byDayMap[date]) {
        byDayMap[date] = { runs: 0, items: 0, costCents: 0 };
      }
      byDayMap[date].runs += 1;
      byDayMap[date].items += usage.itemsScraped || 0;
      byDayMap[date].costCents += Number(usage.estimatedCostCents) || 0;
    }
    
    const byDay = Object.entries(byDayMap)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      records: usages,
      summary: {
        totalRuns,
        totalItemsScraped,
        totalComputeUnits,
        totalCostCents,
        successRate,
        byActor,
        byPurpose,
        byDay,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting Apify usage');
    res.status(500).json({ success: false, error: "Unable to retrieve Apify usage data. Please try again." });
  }
}

/**
 * Get Gemini Usage
 * Image/Video generation breakdown
 */
export async function getGeminiUsageDetailed(req: Request, res: Response) {
  try {
    const { timeRange = '7d', days, operationType: opTypeFilter } = req.query;
    let startDate: Date;
    if (days === 'all') {
      startDate = new Date(0);
    } else if (days) {
      startDate = getDateRange(`${days}d`);
    } else {
      startDate = getDateRange(timeRange as string);
    }

    // Build where conditions
    const conditions = [gte(geminiUsagesTable.createdAt, startDate)];
    if (opTypeFilter) {
      conditions.push(eq(geminiUsagesTable.operationType, opTypeFilter as string));
    }

    // Get usage records with user info
    const usages = await db
      .select({
        id: geminiUsagesTable.id,
        userId: geminiUsagesTable.userId,
        operationType: geminiUsagesTable.operationType,
        model: geminiUsagesTable.model,
        inputTokens: geminiUsagesTable.inputTokens,
        outputTokens: geminiUsagesTable.outputTokens,
        imagesGenerated: geminiUsagesTable.imagesGenerated,
        videosGenerated: geminiUsagesTable.videosGenerated,
        costCents: geminiUsagesTable.costCents,
        service: geminiUsagesTable.service,
        purpose: geminiUsagesTable.purpose,
        status: geminiUsagesTable.status,
        createdAt: geminiUsagesTable.createdAt,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(geminiUsagesTable)
      .leftJoin(usersTable, eq(geminiUsagesTable.userId, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(geminiUsagesTable.createdAt))
;

    // Define usage type for Gemini
    type GeminiUsageRecord = typeof usages[number];
    
    // Calculate summary
    const totalRequests = usages.length;
    const totalImages = usages.reduce((sum: number, u: GeminiUsageRecord) => sum + (u.imagesGenerated || 0), 0);
    const totalVideos = usages.reduce((sum: number, u: GeminiUsageRecord) => sum + (u.videosGenerated || 0), 0);
    const summarize = (rows: GeminiUsageRecord[]) => summarizeUsageMeasurements(rows.map(u => ({
      tokens: u.inputTokens == null || u.outputTokens == null ? null : u.inputTokens + u.outputTokens,
      costCents: u.costCents,
    })));
    const measurements = summarize(usages);
    const totalCostCents = measurements.costCents;
    const successCount = usages.filter((u: GeminiUsageRecord) => u.status === 'success').length;
    const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;

    const group = (key: (row: GeminiUsageRecord) => string) => {
      const groups: Record<string, GeminiUsageRecord[]> = Object.create(null);
      for (const row of usages) (groups[key(row)] ??= []).push(row);
      return Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, {
        ...summarize(rows),
        requests: rows.length,
        images: rows.reduce((sum, u) => sum + (u.imagesGenerated || 0), 0),
        videos: rows.reduce((sum, u) => sum + (u.videosGenerated || 0), 0),
      }]));
    };
    const byOperationType = group(u => u.operationType || 'unknown');
    const byModel = group(u => u.model || 'unknown');
    const byDay = Object.entries(group(u => new Date(u.createdAt).toISOString().split('T')[0]))
      .map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date));
    const breakdown = Object.entries(byModel).map(([model, data]) => ({
      model, ...data, cost: data.costCents == null ? null : data.costCents / 100,
    })).sort((a, b) => b.calls - a.calls);

    // Build recentActivity for UI
    const recentActivity = usages.slice(0, 100).map((u: GeminiUsageRecord) => ({
      id: u.id,
      model: u.model,
      purpose: u.purpose || u.operationType,
      userName: u.userName,
      userEmail: u.userEmail,
      tokens: u.inputTokens == null || u.outputTokens == null ? null : u.inputTokens + u.outputTokens,
      cost: u.costCents == null ? null : Number(u.costCents) / 100,
      latency: null,
      createdAt: u.createdAt,
    }));

    res.json({
      success: true,
      records: usages,
      breakdown,
      recentActivity,
      summary: {
        totalRequests,
        totalCalls: totalRequests,
        totalImages,
        totalVideos,
        totalTokens: measurements.tokens,
        measuredTokenCalls: measurements.measuredTokenCalls,
        measuredCostCalls: measurements.measuredCostCalls,
        totalCost: totalCostCents == null ? null : totalCostCents / 100,
        totalCostCents,
        successRate,
        avgLatency: null,
        measuredDurationCount: 0,
        totalDurationMs: 0,
        byOperationType,
        byModel,
        byDay,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting Gemini usage');
    res.status(500).json({ success: false, error: "Unable to retrieve Gemini usage data. Please try again." });
  }
}

/**
 * Get ZeroBounce Usage
 * Email validation breakdown
 */
export async function getZerobounceUsageDetailed(req: Request, res: Response) {
  try {
    const { timeRange = '7d', days } = req.query;
    let startDate: Date;
    if (days === 'all') {
      startDate = new Date(0);
    } else if (days) {
      startDate = getDateRange(`${days}d`);
    } else {
      startDate = getDateRange(timeRange as string);
    }

    // Get usage records with user info
    const usages = await db
      .select({
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
        createdAt: zerobounceUsagesTable.createdAt,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(zerobounceUsagesTable)
      .leftJoin(usersTable, eq(zerobounceUsagesTable.userId, usersTable.id))
      .where(gte(zerobounceUsagesTable.createdAt, startDate))
      .orderBy(desc(zerobounceUsagesTable.createdAt))
;

    // Define usage type for ZeroBounce
    type ZBUsageRecord = typeof usages[number];
    
    // Calculate summary
    const totalRequests = usages.length;
    const totalEmailsValidated = usages.reduce((sum: number, u: ZBUsageRecord) => sum + (u.emailsValidated || 0), 0);
    const totalValidEmails = usages.reduce((sum: number, u: ZBUsageRecord) => sum + (u.validEmails || 0), 0);
    const totalInvalidEmails = usages.reduce((sum: number, u: ZBUsageRecord) => sum + (u.invalidEmails || 0), 0);
    const totalCreditsUsed = usages.reduce((sum: number, u: ZBUsageRecord) => sum + (u.creditsUsed || 0), 0);
    const totalCostCents = usages.reduce((sum: number, u: ZBUsageRecord) => sum + (Number(u.costCents) || 0), 0);
    const successCount = usages.filter((u: ZBUsageRecord) => u.status === 'success').length;
    const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;
    const validRate = totalEmailsValidated > 0 ? (totalValidEmails / totalEmailsValidated) * 100 : 0;

    // By operation type
    const byOperationType: Record<string, { requests: number; emails: number; valid: number; costCents: number }> = {};
    for (const usage of usages) {
      const opType = usage.operationType || 'unknown';
      if (!byOperationType[opType]) {
        byOperationType[opType] = { requests: 0, emails: 0, valid: 0, costCents: 0 };
      }
      byOperationType[opType].requests += 1;
      byOperationType[opType].emails += usage.emailsValidated || 0;
      byOperationType[opType].valid += usage.validEmails || 0;
      byOperationType[opType].costCents += Number(usage.costCents) || 0;
    }

    // By purpose
    const byPurpose: Record<string, { requests: number; emails: number; costCents: number }> = {};
    for (const usage of usages) {
      const purpose = usage.purpose || 'unknown';
      if (!byPurpose[purpose]) {
        byPurpose[purpose] = { requests: 0, emails: 0, costCents: 0 };
      }
      byPurpose[purpose].requests += 1;
      byPurpose[purpose].emails += usage.emailsValidated || 0;
      byPurpose[purpose].costCents += Number(usage.costCents) || 0;
    }

    // By day breakdown
    const byDayMap: Record<string, { requests: number; emails: number; valid: number; costCents: number }> = {};
    for (const usage of usages) {
      const date = new Date(usage.createdAt).toISOString().split('T')[0];
      if (!byDayMap[date]) {
        byDayMap[date] = { requests: 0, emails: 0, valid: 0, costCents: 0 };
      }
      byDayMap[date].requests += 1;
      byDayMap[date].emails += usage.emailsValidated || 0;
      byDayMap[date].valid += usage.validEmails || 0;
      byDayMap[date].costCents += Number(usage.costCents) || 0;
    }
    
    const byDay = Object.entries(byDayMap)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Email status breakdown
    const emailStatusBreakdown = {
      valid: totalValidEmails,
      invalid: totalInvalidEmails,
      catchAll: usages.reduce((sum: number, u: ZBUsageRecord) => sum + (u.catchAllEmails || 0), 0),
      unknown: usages.reduce((sum: number, u: ZBUsageRecord) => sum + (u.unknownEmails || 0), 0),
    };

    res.json({
      success: true,
      records: usages,
      summary: {
        totalRequests,
        totalEmailsValidated,
        totalValidEmails,
        totalInvalidEmails,
        totalCreditsUsed,
        totalCostCents,
        successRate,
        validRate,
        emailStatusBreakdown,
        byOperationType,
        byPurpose,
        byDay,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting ZeroBounce usage');
    res.status(500).json({ success: false, error: "Unable to retrieve ZeroBounce usage data. Please try again." });
  }
}

/**
 * Get Platform Usage Overview
 * Aggregated usage across all providers with trends
 */
export async function getPlatformUsage(req: Request, res: Response) {
  try {
    const { days } = req.query;
    let startDate: Date;
    if (days === 'all') {
      startDate = new Date(0);
    } else if (days) {
      startDate = getDateRange(`${days}d`);
    } else {
      startDate = getDateRange('30d');
    }

    // Query all providers in parallel
    const [llmUsages, geminiUsages, apifyUsages, zbUsages] = await Promise.all([
      db.select({
        provider: openaiUsagesTable.provider,
        totalTokens: sql<number>`coalesce(sum(${openaiUsagesTable.totalTokens}), 0)`,
        totalCalls: sql<number>`count(*)`,
        totalCostCents: sql<number>`coalesce(sum(${openaiUsagesTable.estimatedCostCents}), 0)`,
      })
        .from(openaiUsagesTable)
        .where(gte(openaiUsagesTable.createdAt, startDate))
        .groupBy(openaiUsagesTable.provider),

      db.select({
        operationType: geminiUsagesTable.operationType,
        totalCalls: sql<number>`count(*)`,
        totalImages: sql<number>`coalesce(sum(${geminiUsagesTable.imagesGenerated}), 0)`,
        totalVideos: sql<number>`coalesce(sum(${geminiUsagesTable.videosGenerated}), 0)`,
        totalCostCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
      })
        .from(geminiUsagesTable)
        .where(gte(geminiUsagesTable.createdAt, startDate))
        .groupBy(geminiUsagesTable.operationType),

      db.select({
        totalRuns: sql<number>`count(*)`,
        totalItemsScraped: sql<number>`coalesce(sum(${apifyUsagesTable.itemsScraped}), 0)`,
        totalCostCents: sql<number>`coalesce(sum(${apifyUsagesTable.estimatedCostCents}), 0)`,
      })
        .from(apifyUsagesTable)
        .where(gte(apifyUsagesTable.createdAt, startDate)),

      db.select({
        totalRequests: sql<number>`count(*)`,
        totalEmailsValidated: sql<number>`coalesce(sum(${zerobounceUsagesTable.emailsValidated}), 0)`,
        totalCostCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
      })
        .from(zerobounceUsagesTable)
        .where(gte(zerobounceUsagesTable.createdAt, startDate)),
    ]);

    // Daily trend across all providers
    const [llmDaily, geminiDaily, apifyDaily, zbDaily] = await Promise.all([
      db.select({
        date: sql<string>`date(${openaiUsagesTable.createdAt})`,
        calls: sql<number>`count(*)`,
        costCents: sql<number>`coalesce(sum(${openaiUsagesTable.estimatedCostCents}), 0)`,
      })
        .from(openaiUsagesTable)
        .where(gte(openaiUsagesTable.createdAt, startDate))
        .groupBy(sql`date(${openaiUsagesTable.createdAt})`)
        .orderBy(sql`date(${openaiUsagesTable.createdAt})`),

      db.select({
        date: sql<string>`date(${geminiUsagesTable.createdAt})`,
        calls: sql<number>`count(*)`,
        costCents: sql<number>`coalesce(sum(${geminiUsagesTable.costCents}), 0)`,
      })
        .from(geminiUsagesTable)
        .where(gte(geminiUsagesTable.createdAt, startDate))
        .groupBy(sql`date(${geminiUsagesTable.createdAt})`)
        .orderBy(sql`date(${geminiUsagesTable.createdAt})`),

      db.select({
        date: sql<string>`date(${apifyUsagesTable.createdAt})`,
        calls: sql<number>`count(*)`,
        costCents: sql<number>`coalesce(sum(${apifyUsagesTable.estimatedCostCents}), 0)`,
      })
        .from(apifyUsagesTable)
        .where(gte(apifyUsagesTable.createdAt, startDate))
        .groupBy(sql`date(${apifyUsagesTable.createdAt})`)
        .orderBy(sql`date(${apifyUsagesTable.createdAt})`),

      db.select({
        date: sql<string>`date(${zerobounceUsagesTable.createdAt})`,
        calls: sql<number>`count(*)`,
        costCents: sql<number>`coalesce(sum(${zerobounceUsagesTable.costCents}), 0)`,
      })
        .from(zerobounceUsagesTable)
        .where(gte(zerobounceUsagesTable.createdAt, startDate))
        .groupBy(sql`date(${zerobounceUsagesTable.createdAt})`)
        .orderBy(sql`date(${zerobounceUsagesTable.createdAt})`),
    ]);

    // Merge daily data
    const dailyMap: Record<string, { date: string; llmCalls: number; geminiCalls: number; apifyCalls: number; zbCalls: number; totalCostCents: number }> = {};
    for (const d of llmDaily) {
      if (!dailyMap[d.date]) dailyMap[d.date] = { date: d.date, llmCalls: 0, geminiCalls: 0, apifyCalls: 0, zbCalls: 0, totalCostCents: 0 };
      dailyMap[d.date].llmCalls += Number(d.calls);
      dailyMap[d.date].totalCostCents += Number(d.costCents);
    }
    for (const d of geminiDaily) {
      if (!dailyMap[d.date]) dailyMap[d.date] = { date: d.date, llmCalls: 0, geminiCalls: 0, apifyCalls: 0, zbCalls: 0, totalCostCents: 0 };
      dailyMap[d.date].geminiCalls += Number(d.calls);
      dailyMap[d.date].totalCostCents += Number(d.costCents);
    }
    for (const d of apifyDaily) {
      if (!dailyMap[d.date]) dailyMap[d.date] = { date: d.date, llmCalls: 0, geminiCalls: 0, apifyCalls: 0, zbCalls: 0, totalCostCents: 0 };
      dailyMap[d.date].apifyCalls += Number(d.calls);
      dailyMap[d.date].totalCostCents += Number(d.costCents);
    }
    for (const d of zbDaily) {
      if (!dailyMap[d.date]) dailyMap[d.date] = { date: d.date, llmCalls: 0, geminiCalls: 0, apifyCalls: 0, zbCalls: 0, totalCostCents: 0 };
      dailyMap[d.date].zbCalls += Number(d.calls);
      dailyMap[d.date].totalCostCents += Number(d.costCents);
    }
    const dailyTrend = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Build per-provider summary
    const providers = [];

    // LLM providers
    for (const row of llmUsages) {
      providers.push({
        provider: row.provider || 'unknown',
        category: 'llm',
        totalCalls: Number(row.totalCalls),
        totalTokens: Number(row.totalTokens),
        totalCostCents: Number(row.totalCostCents),
      });
    }

    // Gemini
    for (const row of geminiUsages) {
      providers.push({
        provider: `gemini_${row.operationType || 'unknown'}`,
        category: 'gemini',
        totalCalls: Number(row.totalCalls),
        totalImages: Number(row.totalImages),
        totalVideos: Number(row.totalVideos),
        totalCostCents: Number(row.totalCostCents),
      });
    }

    // Apify
    const apifyRow = apifyUsages[0];
    if (apifyRow) {
      providers.push({
        provider: 'apify',
        category: 'scraping',
        totalCalls: Number(apifyRow.totalRuns),
        totalItemsScraped: Number(apifyRow.totalItemsScraped),
        totalCostCents: Number(apifyRow.totalCostCents),
      });
    }

    // ZeroBounce
    const zbRow = zbUsages[0];
    if (zbRow) {
      providers.push({
        provider: 'zerobounce',
        category: 'validation',
        totalCalls: Number(zbRow.totalRequests),
        totalEmailsValidated: Number(zbRow.totalEmailsValidated),
        totalCostCents: Number(zbRow.totalCostCents),
      });
    }

    const totalCalls = providers.reduce((s, p) => s + (p.totalCalls || 0), 0);
    const totalCostCents = providers.reduce((s, p) => s + (p.totalCostCents || 0), 0);

    res.json({
      success: true,
      summary: {
        totalCalls,
        totalCostCents,
        totalCost: totalCostCents / 100,
      },
      providers,
      dailyTrend,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting platform usage');
    res.status(500).json({ success: false, error: "Unable to retrieve platform usage data. Please try again." });
  }
}
