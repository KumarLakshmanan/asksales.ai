/**
 * Admin ZeroBounce Usage Controller
 * Provides admin access to ZeroBounce API usage statistics
 */

import { Request, Response } from "express";
import { 
  getAllZerobounceUsages, 
  getGlobalZerobounceUsageStats 
} from "../models/zerobounceUsages/functions";
import { logger } from '../utils/logger.js';

/**
 * Get all ZeroBounce usage records
 * GET /api/admin/zerobounce-usage
 */
export async function getZerobounceUsage(req: Request, res: Response) {
  try {
    const { limit = 50, offset = 0, days = 30, operationType } = req.query;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Number(days));
    
    const usages = await getAllZerobounceUsages({
      limit: Number(limit),
      offset: Number(offset),
      startDate,
      operationType: operationType as string | undefined,
    });
    
    return res.json({
      success: true,
      usages,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[getZerobounceUsage] Error');
    return res.status(500).json({ error: "Unable to retrieve ZeroBounce usage. Please try again." });
  }
}

/**
 * Get ZeroBounce usage statistics
 * GET /api/admin/zerobounce-usage/stats
 */
export async function getZerobounceUsageStats(req: Request, res: Response) {
  try {
    const { days = 30 } = req.query;
    
    const stats = await getGlobalZerobounceUsageStats(Number(days));
    
    return res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error({ err: error }, '[getZerobounceUsageStats] Error');
    return res.status(500).json({ error: "Unable to retrieve ZeroBounce usage statistics. Please try again." });
  }
}
