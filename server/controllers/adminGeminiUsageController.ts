/**
 * Admin Gemini Usage Controller
 * Provides admin access to Gemini API usage statistics
 */

import { Request, Response } from "express";
import { 
  getAllGeminiUsages, 
  getGlobalGeminiUsageStats 
} from "../models/geminiUsages/functions";
import { logger } from '../utils/logger.js';

/**
 * Get all Gemini usage records
 * GET /api/admin/gemini-usage
 */
export async function getGeminiUsage(req: Request, res: Response) {
  try {
    const { limit = 50, offset = 0, days = 30, operationType } = req.query;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Number(days));
    
    const usages = await getAllGeminiUsages({
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
    logger.error({ err: error }, '[getGeminiUsage] Error');
    return res.status(500).json({ error: "Unable to retrieve Gemini usage. Please try again." });
  }
}

/**
 * Get Gemini usage statistics
 * GET /api/admin/gemini-usage/stats
 */
export async function getGeminiUsageStats(req: Request, res: Response) {
  try {
    const { days = 30 } = req.query;
    
    const stats = await getGlobalGeminiUsageStats(Number(days));
    
    return res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error({ err: error }, '[getGeminiUsageStats] Error');
    return res.status(500).json({ error: "Unable to retrieve Gemini usage statistics. Please try again." });
  }
}
