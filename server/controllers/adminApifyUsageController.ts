/**
 * Admin Apify Usage Controller
 * Provides admin endpoints for viewing Apify usage across all users
 */

import { Request, Response } from "express";
import {
  getRecentApifyUsages,
  getApifyUsageSummaryAll,
} from "../models/apifyUsages/functions";
import { logger } from '../utils/logger.js';

/**
 * Get all Apify usage records (admin view)
 * GET /api/admin/apify-usage
 */
export async function getAllApifyUsageHandler(req: Request, res: Response) {
  try {
    const { range = '7d', limit = 100 } = req.query;
    
    // Calculate start date based on range
    const now = new Date();
    let startDate: Date;
    
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
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    const usages = await getRecentApifyUsages({
      limit: Number(limit),
      startDate,
    });
    
    return res.json(usages);
  } catch (error) {
    logger.error({ err: error }, '[getAllApifyUsageHandler] Error');
    return res.status(500).json({ error: "Unable to retrieve Apify usage. Please try again." });
  }
}

/**
 * Get Apify usage summary (admin view)
 * GET /api/admin/apify-usage/summary
 */
export async function getApifyUsageSummaryHandler(req: Request, res: Response) {
  try {
    const { range = '7d' } = req.query;
    
    // Calculate start date based on range
    const now = new Date();
    let startDate: Date;
    
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
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    const summary = await getApifyUsageSummaryAll(startDate, now);
    
    return res.json(summary);
  } catch (error) {
    logger.error({ err: error }, '[getApifyUsageSummaryHandler] Error');
    return res.status(500).json({ error: "Unable to retrieve Apify usage summary. Please try again." });
  }
}
