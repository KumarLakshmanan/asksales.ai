/**
 * Admin User Usage Controller
 * Provides admin access to user-specific API usage statistics across all platforms
 */

import { Request, Response } from "express";
import { getOpenAIUsageSummaryByUser } from "../models/openaiUsages/functions";
import { getApifyUsageSummaryByUser } from "../models/apifyUsages/functions";
import { getGeminiUsageStats } from "../models/geminiUsages/functions";
import { getZerobounceUsageStats } from "../models/zerobounceUsages/functions";
import { logger } from '../utils/logger.js';
import { adminManagementIdSchema, adminUserUsageQuerySchema } from '../utils/adminManagementValidation.js';
import type { AdminUserUsageResponse } from '../../shared/adminUserUsage.js';

/**
 * Get all platform usage statistics for a specific user
 * GET /api/admin/users/:userId/usage
 */
export async function getUserUsageStats(req: Request, res: Response) {
  try {
    const target = adminManagementIdSchema.shape.id.safeParse(req.params.userId);
    const range = adminUserUsageQuerySchema.safeParse(req.query);
    if (!target.success || !range.success) {
      return res.status(400).json({ error: "Invalid user ID or usage range" });
    }
    const userId = Number(target.data);
    const daysNum = range.data.days;
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);
    if (!Number.isFinite(startDate.getTime()) || startDate >= endDate) {
      return res.status(400).json({ error: "Usage range is outside the supported date range" });
    }

    // Fetch all platform usages in parallel
    const [openaiStats, apifyStats, geminiStats, zerobounceStats] = await Promise.all([
      getOpenAIUsageSummaryByUser(userId, startDate, endDate),
      getApifyUsageSummaryByUser(userId, startDate, endDate),
      getGeminiUsageStats(userId, daysNum),
      getZerobounceUsageStats(userId, daysNum),
    ]);

    const response: AdminUserUsageResponse = {
      success: true,
      userId,
      days: daysNum,
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      usage: {
        openai: openaiStats,
        apify: apifyStats,
        gemini: geminiStats,
        zerobounce: zerobounceStats,
      },
      // Calculate totals across all platforms
      totals: {
        totalCostCents: 
          (openaiStats.estimatedCostCents || 0) +
          (apifyStats.totalCostCents || 0) +
          (geminiStats.totalCostCents || 0) +
          (zerobounceStats.totalCostCents || 0),
        totalApiCalls:
          (openaiStats.totalCalls || 0) +
          (apifyStats.totalRuns || 0) +
          (geminiStats.totalRequests || 0) +
          (zerobounceStats.totalRequests || 0),
      },
    };
    return res.json(response);
  } catch (error) {
    logger.error({ err: error }, '[getUserUsageStats] Error');
    return res.status(500).json({ error: "Unable to retrieve usage statistics. Please try again." });
  }
}
