import { db } from "../db";
import { systemLogsTable } from "./schema";
import { desc, eq, and, gte, lte, sql, ilike, or, lt } from "drizzle-orm";
import { redactLogText, redactLogValue } from '../../utils/logRedaction.js';

export type SystemLogLevel = "error" | "warn" | "info" | "debug";

export interface CreateSystemLogParams {
  level: SystemLogLevel;
  message: string;
  source?: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface GetSystemLogsParams {
  level?: SystemLogLevel;
  source?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
  search?: string;
}

let lastRetentionCleanupAt = 0;
const RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function retentionDays() {
  const configured = Number(process.env.SYSTEM_LOG_RETENTION_DAYS || 30);
  return Number.isInteger(configured) ? Math.min(365, Math.max(7, configured)) : 30;
}

async function maybePruneSystemLogs() {
  if (Date.now() - lastRetentionCleanupAt < RETENTION_CHECK_INTERVAL_MS) return;
  lastRetentionCleanupAt = Date.now();
  const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
  await db.delete(systemLogsTable).where(lt(systemLogsTable.createdAt, cutoff));
}

/**
 * Insert a single log entry into system_logs.
 * Non-throwing — errors are silently swallowed to avoid log-loop.
 */
export async function createSystemLog(params: CreateSystemLogParams): Promise<void> {
  try {
    const context = redactLogValue(params.context ?? null) as Record<string, unknown> | null;
    await db.insert(systemLogsTable).values({
      level: params.level,
      message: redactLogText(params.message).slice(0, 5000),
      source: params.source ? redactLogText(params.source).slice(0, 255) : undefined,
      stack: params.stack ? redactLogText(params.stack).slice(0, 8000) : undefined,
      context: context && JSON.stringify(context).length <= 50_000 ? context : { redacted: true, reason: 'context_too_large' },
    });
    await maybePruneSystemLogs();
  } catch {
    // Intentionally silenced — writing logs must never throw
  }
}

/**
 * Retrieve paginated system logs with optional filters.
 */
export async function getSystemLogs(params: GetSystemLogsParams = {}): Promise<{
  data: typeof systemLogsTable.$inferSelect[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  retentionDays: number;
}> {
  const { level, source, from, to, search, page = 1, limit = 50 } = params;

  const conditions = [];
  if (level) conditions.push(eq(systemLogsTable.level, level));
  if (source) conditions.push(ilike(systemLogsTable.source, `%${source}%`));
  if (search) conditions.push(or(
    ilike(systemLogsTable.message, `%${search}%`),
    ilike(systemLogsTable.source, `%${search}%`),
  )!);
  if (from) conditions.push(gte(systemLogsTable.createdAt, from));
  if (to) conditions.push(lte(systemLogsTable.createdAt, to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(systemLogsTable)
      .where(where)
      .orderBy(desc(systemLogsTable.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemLogsTable)
      .where(where),
  ]);

  const total = countResult[0]?.count ?? 0;
  const redactedRows = rows.map((row: typeof systemLogsTable.$inferSelect) => ({
    ...row,
    message: redactLogText(row.message),
    source: row.source ? redactLogText(row.source) : row.source,
    stack: row.stack ? redactLogText(row.stack) : row.stack,
    context: redactLogValue(row.context) as Record<string, unknown> | null,
  }));
  return { data: redactedRows, total, page, limit, totalPages: Math.ceil(total / limit), retentionDays: retentionDays() };
}

/**
 * Delete all rows for a given level (or all rows when level is omitted).
 */
export async function clearSystemLogs(level?: SystemLogLevel): Promise<number> {
  if (level) {
    const result = await db
      .delete(systemLogsTable)
      .where(eq(systemLogsTable.level, level))
      .returning({ id: systemLogsTable.id });
    return result.length;
  }
  const result = await db.delete(systemLogsTable).returning({ id: systemLogsTable.id });
  return result.length;
}

/**
 * Return a breakdown of log counts per level.
 */
export async function getSystemLogStats(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      level: systemLogsTable.level,
      count: sql<number>`count(*)::int`,
    })
    .from(systemLogsTable)
    .groupBy(systemLogsTable.level);

  return Object.fromEntries(rows.map((r: { level: string; count: number }) => [r.level, r.count]));
}
