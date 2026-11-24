import type { Request, Response } from "express";
import {
  getSystemLogs,
  getSystemLogStats,
  clearSystemLogs,
  type SystemLogLevel,
} from "../models/systemLogs/functions";
import { logger } from "../utils/logger.js";

/**
 * GET /api/admin/system-logs
 * Query params: level, source, from, to, page, limit
 */
export async function getSystemLogsHandler(req: Request, res: Response) {
  try {
    const {
      level,
      source,
      from,
      to,
      page = "1",
      limit = "50",
      search,
    } = req.query as Record<string, string>;

    if (level && !['error', 'warn', 'info', 'debug'].includes(level)) return res.status(400).json({ success: false, error: 'Invalid log level' });
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if (fromDate && Number.isNaN(fromDate.getTime()) || toDate && Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date filter' });
    }
    if (fromDate && toDate && fromDate > toDate) return res.status(400).json({ success: false, error: 'From date must be before to date' });
    if (source && source.length > 255 || search && search.length > 200) return res.status(400).json({ success: false, error: 'Log filter is too long' });
    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return res.status(400).json({ success: false, error: 'Invalid pagination' });
    }
    const result = await getSystemLogs({ level: level as SystemLogLevel | undefined, source: source?.trim() || undefined,
      search: search?.trim() || undefined, from: fromDate, to: toDate, page: parsedPage, limit: parsedLimit });

    return res.json({ success: true, ...result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[SystemLogsController] Error fetching system logs");
    return res.status(500).json({ success: false, error: "Unable to retrieve system logs. Please try again." });
  }
}

/**
 * GET /api/admin/system-logs/stats
 * Returns count per level.
 */
export async function getSystemLogStatsHandler(_req: Request, res: Response) {
  try {
    const stats = await getSystemLogStats();
    return res.json({ success: true, stats });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[SystemLogsController] Error fetching log stats");
    return res.status(500).json({ success: false, error: "Unable to retrieve log statistics. Please try again." });
  }
}

/**
 * DELETE /api/admin/system-logs
 * Optional query param: level (clears only that level if provided)
 */
export async function clearSystemLogsHandler(req: Request, res: Response) {
  try {
    const { level } = req.query as { level?: string };
    if (level && !['error', 'warn', 'info', 'debug'].includes(level)) return res.status(400).json({ success: false, error: 'Invalid log level' });
    const deleted = await clearSystemLogs(level as SystemLogLevel | undefined);
    logger.info({ deletedCount: deleted, level: level ?? "all", adminId: req.user?.id }, "[SystemLogsController] System logs cleared");
    return res.json({ success: true, deleted });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[SystemLogsController] Error clearing system logs");
    return res.status(500).json({ success: false, error: "Unable to clear system logs. Please try again." });
  }
}
