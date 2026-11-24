import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { getOpenAIUsagesByUserId, getOpenAIUsageSummaryByUser, getRecentOpenAIUsages } from "../models/openaiUsages/functions";
import { logger } from '../utils/logger.js';

// Get usage summary for the current user
export async function getMyOpenAIUsageSummaryHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { range = '7d' } = req.query;

    // Calculate date range
    const now = new Date();
    let startDate: Date | undefined;
    
    switch (range) {
      case '1d':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
    }

    const baseSummary = await getOpenAIUsageSummaryByUser(userId, startDate, now);
    
    // Get all records to calculate additional metrics
    const usages = await getOpenAIUsagesByUserId(userId, {
      limit: 10000, // Get all records for the period
      startDate,
      endDate: now,
    });

    // Calculate success rate
    const successCount = usages.filter(u => u.responseSuccess).length;
    const successRate = usages.length > 0 ? successCount / usages.length : 0;

    // Calculate average duration
    const totalDuration = usages.reduce((sum, u) => sum + (u.durationMs || 0), 0);
    const avgDurationMs = usages.length > 0 ? totalDuration / usages.length : 0;

    // Calculate by day
    const byDayMap: Record<string, { calls: number; tokens: number; costCents: number }> = {};
    for (const usage of usages) {
      const date = new Date(usage.createdAt).toISOString().split('T')[0];
      if (!byDayMap[date]) {
        byDayMap[date] = { calls: 0, tokens: 0, costCents: 0 };
      }
      byDayMap[date].calls += 1;
      byDayMap[date].tokens += usage.totalTokens || 0;
      byDayMap[date].costCents += usage.estimatedCostCents || 0;
    }
    
    const byDay = Object.entries(byDayMap)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Transform byPurpose and byModel to include costCents
    const byModel: Record<string, { calls: number; tokens: number; costCents: number }> = {};
    const byPurpose: Record<string, { calls: number; tokens: number; costCents: number }> = {};
    
    for (const usage of usages) {
      // By model
      if (!byModel[usage.model]) {
        byModel[usage.model] = { calls: 0, tokens: 0, costCents: 0 };
      }
      byModel[usage.model].calls += 1;
      byModel[usage.model].tokens += usage.totalTokens || 0;
      byModel[usage.model].costCents += usage.estimatedCostCents || 0;

      // By purpose
      if (!byPurpose[usage.purpose]) {
        byPurpose[usage.purpose] = { calls: 0, tokens: 0, costCents: 0 };
      }
      byPurpose[usage.purpose].calls += 1;
      byPurpose[usage.purpose].tokens += usage.totalTokens || 0;
      byPurpose[usage.purpose].costCents += usage.estimatedCostCents || 0;
    }

    const summary = {
      totalCalls: baseSummary.totalCalls,
      totalTokens: baseSummary.totalTokens,
      totalCostCents: baseSummary.estimatedCostCents,
      avgDurationMs,
      successRate,
      byModel,
      byPurpose,
      byDay,
    };

    return res.json(summary);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting OpenAI usage summary');
    return res.status(500).json({ 
      error: "Unable to retrieve OpenAI usage summary. Please try again." 
    });
  }
}

// Admin: Get all recent usage records
export async function getAllOpenAIUsageHandler(req: Request, res: Response) {
  try {
    // Check if user is admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userRole = (req as any).user.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: "Admin access required" 
      });
    }

    const { limit = 100, offset = 0, userId, purpose, service } = req.query;

    const usages = await getRecentOpenAIUsages({
      limit: Number(limit),
      offset: Number(offset),
      userId: userId ? Number(userId) : undefined,
      purpose: purpose as string | undefined,
      service: service as string | undefined,
    });

    return res.json({
      success: true,
      data: usages,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        count: usages.length,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting all OpenAI usage');
    return res.status(500).json({ 
      success: false, 
      error: "Unable to retrieve OpenAI usage. Please try again." 
    });
  }
}
