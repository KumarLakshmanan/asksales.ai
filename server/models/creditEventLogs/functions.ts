import { resolveBillingOrganization } from '../../services/billing/organizations.js';
/**
 * Credit Event Logs Functions
 */

import { eq, desc, and, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { creditEventLogsTable, type CreditEventLogRecord, type InsertCreditEventLog } from "./schema.js";
import { chatThreadsTable } from "../chatThreads/schema.js";

function boundedPagination(limit?: number, offset?: number) {
  return {
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
    offset: Math.min(Math.max(Number(offset) || 0, 0), 100_000),
  };
}

function dailyWindowStart(days: number) {
  const boundedDays = Math.min(Math.max(Number(days) || 30, 1), 365);
  const startDate = new Date();
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - (boundedDays - 1));
  return startDate;
}

// Create a new event log
/**
 * Usage rows include reversal rows (negative credits) written when a charge is
 * refunded, so SUM(credits_used) is net of refunds. They are not new events, so
 * event counts leave them out.
 */
const EVENT_COUNT = sql`(count(*) FILTER (WHERE credits_used >= 0))::int`;

// WhatsApp message charges are logged one reference per message. Wallet
// drill-downs group them by the outreach that sent them (migration 600), and
// everything without an outreach (support replies, single messages) together.
export const WHATSAPP_OUTREACH_REFERENCE = 'whatsapp_outreach';
export const WHATSAPP_OTHER_MESSAGES_ID = 'other_messages';
const isWhatsAppCharge = sql`${creditEventLogsTable.referenceType} IN ('whatsapp_message_charge', 'whatsapp_message_charge_topup')`;
const whatsappBatchId = sql`(SELECT wmc.outreach_batch_id::text FROM whatsapp_message_charges wmc
  WHERE wmc.id = CASE WHEN ${creditEventLogsTable.referenceId} ~ '^[0-9]{1,18}$' THEN (${creditEventLogsTable.referenceId})::bigint END)`;
const referenceGroupType = sql`CASE WHEN ${isWhatsAppCharge} THEN ${WHATSAPP_OUTREACH_REFERENCE} ELSE COALESCE(${creditEventLogsTable.referenceType}, 'other') END`;
const referenceGroupId = sql`CASE WHEN ${isWhatsAppCharge} THEN COALESCE(${whatsappBatchId}, ${WHATSAPP_OTHER_MESSAGES_ID}) ELSE COALESCE(${creditEventLogsTable.referenceId}, 'none') END`;
const whatsappBatchTitle = sql`CASE WHEN ${isWhatsAppCharge} THEN COALESCE(
  (SELECT ob.name FROM outreach_batches ob WHERE ob.id::text = ${whatsappBatchId}), 'WhatsApp replies and other messages') END`;

/** The filter for one drill-down reference, including grouped WhatsApp charges. */
function referenceCondition(referenceType: string, referenceId: string): SQL {
  if (referenceType === WHATSAPP_OUTREACH_REFERENCE) {
    return referenceId === WHATSAPP_OTHER_MESSAGES_ID
      ? sql`${isWhatsAppCharge} AND ${whatsappBatchId} IS NULL`
      : sql`${isWhatsAppCharge} AND ${whatsappBatchId} = ${referenceId}`;
  }
  return and(
    referenceType === 'other' ? sql`reference_type IS NULL` : eq(creditEventLogsTable.referenceType, referenceType),
    referenceId === 'none' ? sql`reference_id IS NULL` : eq(creditEventLogsTable.referenceId, referenceId),
  )!;
}

/** Positive numeric from a JSON text value, or NULL. CASE keeps the cast from running on bad input. */
function jsonRate(path: SQL) {
  return sql`CASE WHEN (${path}) ~ '^[0-9]+([.][0-9]+)?$' THEN NULLIF((${path})::numeric, 0) END`;
}

/**
 * INR value of the credits in each row, using the purchase rate in force when
 * the charge happened (stored on the row), falling back to the insights pricing
 * snapshot and then to today's rate for rows written before rates were stored.
 */
function creditValueInr(currentRechargeRate: number) {
  const stored = jsonRate(sql`${creditEventLogsTable.metadata}->>'purchaseCreditsPerInr'`);
  const snapshot = jsonRate(sql`${creditEventLogsTable.metadata}->'_insights'->'pricing'->>'creditsPerInr'`);
  return sql<string>`COALESCE(SUM(${creditEventLogsTable.creditsUsed} / COALESCE(${stored}, ${snapshot}, ${currentRechargeRate}::numeric)), 0)`;
}

/** Purchase rate stored on one usage row, if any. */
export function storedPurchaseRate(metadata: Record<string, unknown> | null | undefined): number | undefined {
  const insights = metadata?._insights as { pricing?: { creditsPerInr?: unknown } } | undefined;
  for (const value of [metadata?.purchaseCreditsPerInr, insights?.pricing?.creditsPerInr]) {
    const rate = Number(value);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return undefined;
}

export async function createCreditEventLog(data: InsertCreditEventLog): Promise<CreditEventLogRecord> {
  const [log] = await db.insert(creditEventLogsTable).values(data).returning();
  return log;
}

// Get event logs by user
export async function getCreditEventLogsByUser(
  userId: number,
  options?: {
    limit?: number;
    offset?: number;
    eventKey?: string;
    apiProvider?: string;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<{ logs: CreditEventLogRecord[]; total: number }> {
  const conditions = [eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId))];

  if (options?.eventKey) {
    conditions.push(eq(creditEventLogsTable.eventKey, options.eventKey));
  }
  if (options?.apiProvider) {
    if (options.apiProvider === 'platform') {
      conditions.push(sql`${creditEventLogsTable.apiProvider} IS NULL`);
    } else {
      conditions.push(eq(creditEventLogsTable.apiProvider, options.apiProvider));
    }
  }
  if (options?.startDate) {
    conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  }
  if (options?.endDate) {
    conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));
  }

  const whereClause = and(...conditions);
  const pagination = boundedPagination(options?.limit, options?.offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creditEventLogsTable)
    .where(whereClause);

  const logs = await db
    .select()
    .from(creditEventLogsTable)
    .where(whereClause)
    .orderBy(desc(creditEventLogsTable.createdAt))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { logs, total: countResult?.count || 0 };
}

// Get usage summary by event type
export async function getCreditUsageSummary(userId: number, startDate?: Date, endDate?: Date) {
  const conditions = [eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId))];
  if (startDate) conditions.push(gte(creditEventLogsTable.createdAt, startDate));
  if (endDate) conditions.push(lte(creditEventLogsTable.createdAt, endDate));

  const results = await db
    .select({
      eventKey: creditEventLogsTable.eventKey,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(and(...conditions))
    .groupBy(creditEventLogsTable.eventKey);

  return results.map((r: { eventKey: string; totalCredits: string; eventCount: number }) => ({
    eventKey: r.eventKey,
    totalCredits: parseFloat(r.totalCredits || "0"),
    eventCount: r.eventCount,
  }));
}

// Get all credit event logs (admin)
export async function getAllCreditEventLogs(
  options?: {
    limit?: number;
    offset?: number;
    userId?: number;
    eventKey?: string;
    service?: string;
    apiProvider?: string;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<{ logs: CreditEventLogRecord[]; total: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (options?.userId) {
    conditions.push(eq(creditEventLogsTable.userId, options.userId));
  }
  if (options?.eventKey) {
    conditions.push(eq(creditEventLogsTable.eventKey, options.eventKey));
  }
  if (options?.service) {
    conditions.push(eq(creditEventLogsTable.service, options.service));
  }
  if (options?.apiProvider) {
    if (options.apiProvider === 'platform') {
      conditions.push(sql`${creditEventLogsTable.apiProvider} IS NULL`);
    } else {
      conditions.push(eq(creditEventLogsTable.apiProvider, options.apiProvider));
    }
  }
  if (options?.startDate) {
    conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  }
  if (options?.endDate) {
    conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const pagination = boundedPagination(options?.limit, options?.offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creditEventLogsTable)
    .where(whereClause);

  const logs = await db
    .select()
    .from(creditEventLogsTable)
    .where(whereClause)
    .orderBy(desc(creditEventLogsTable.createdAt))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { logs, total: countResult?.count || 0 };
}

// Get daily credit usage for a user (for charts)
export async function getDailyCreditUsage(userId: number, days: number = 30): Promise<{
  date: string;
  totalCredits: number;
  eventCount: number;
}[]> {
  const startDate = dailyWindowStart(days);

  const results = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(and(
      eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId)),
      gte(creditEventLogsTable.createdAt, startDate)
    ))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`);

  return results.map((r: { date: string; totalCredits: string; eventCount: number }) => ({
    date: r.date,
    totalCredits: parseFloat(r.totalCredits || "0"),
    eventCount: r.eventCount,
  }));
}

// Get per-provider credit usage summary (e.g., OpenAI, Apify, Gemini, etc.)
export async function getProviderCreditSummary(userId: number, startDate?: Date, endDate?: Date) {
  const conditions = [eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId))];
  if (startDate) conditions.push(gte(creditEventLogsTable.createdAt, startDate));
  if (endDate) conditions.push(lte(creditEventLogsTable.createdAt, endDate));

  const results = await db
    .select({
      apiProvider: creditEventLogsTable.apiProvider,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(and(...conditions))
    .groupBy(creditEventLogsTable.apiProvider);

  return results.map((r: { apiProvider: string | null; totalCredits: string; totalApiCostCents: string; eventCount: number }) => ({
    apiProvider: r.apiProvider || 'platform',
    totalCredits: parseFloat(r.totalCredits || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
  }));
}

// Get per-category credit usage summary with sub-breakdowns
export async function getCategoryCreditSummary(userId: number, startDate?: Date, endDate?: Date) {
  const conditions = [eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId))];
  if (startDate) conditions.push(gte(creditEventLogsTable.createdAt, startDate));
  if (endDate) conditions.push(lte(creditEventLogsTable.createdAt, endDate));

  // Get both by service and event key — so the client can group and drill down
  const results = await db
    .select({
      eventKey: creditEventLogsTable.eventKey,
      service: creditEventLogsTable.service,
      apiProvider: creditEventLogsTable.apiProvider,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      lastUsed: sql<string>`MAX(created_at)`,
    })
    .from(creditEventLogsTable)
    .where(and(...conditions))
    .groupBy(creditEventLogsTable.eventKey, creditEventLogsTable.service, creditEventLogsTable.apiProvider);

  return results.map((r: { eventKey: string; service: string; apiProvider: string | null; totalCredits: string; totalApiCostCents: string; eventCount: number; lastUsed: string }) => ({
    eventKey: r.eventKey,
    service: r.service,
    apiProvider: r.apiProvider,
    totalCredits: parseFloat(r.totalCredits || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
    lastUsed: r.lastUsed,
  }));
}

// Global credit usage summary (admin - all users)
export async function getGlobalCreditSummary(options?: { startDate?: Date; endDate?: Date }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      eventKey: creditEventLogsTable.eventKey,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      uniqueUsers: sql<number>`count(DISTINCT user_id)::int`,
    })
    .from(creditEventLogsTable)
    .where(whereClause)
    .groupBy(creditEventLogsTable.eventKey);

  return results.map((r: { eventKey: string; totalCredits: string; totalApiCostCents: string; eventCount: number; uniqueUsers: number }) => ({
    eventKey: r.eventKey,
    totalCredits: parseFloat(r.totalCredits || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
    uniqueUsers: r.uniqueUsers,
  }));
}

// Daily global credit usage (admin charts)
export async function getGlobalDailyCreditUsage(days: number = 30): Promise<{
  date: string;
  totalCredits: number;
  eventCount: number;
}[]> {
  const startDate = dailyWindowStart(days);

  const results = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(gte(creditEventLogsTable.createdAt, startDate))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`);

  return results.map((r: { date: string; totalCredits: string; eventCount: number }) => ({
    date: r.date,
    totalCredits: parseFloat(r.totalCredits || "0"),
    eventCount: r.eventCount,
  }));
}

// Global provider credit summary (admin - all users)
export async function getGlobalProviderCreditSummary(options?: { startDate?: Date; endDate?: Date }) {
  const conditions: (SQL<unknown> | undefined)[] = [];
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      apiProvider: sql<string>`COALESCE(api_provider, 'platform')`,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      uniqueUsers: sql<number>`count(DISTINCT user_id)::int`,
    })
    .from(creditEventLogsTable)
    .where(whereClause)
    .groupBy(sql`COALESCE(api_provider, 'platform')`)
    .orderBy(sql`SUM(credits_used) DESC`);

  return results.map((r: { apiProvider: string; totalCredits: string; totalApiCostCents: string; eventCount: number; uniqueUsers: number }) => ({
    apiProvider: r.apiProvider,
    totalCredits: parseFloat(r.totalCredits || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
    uniqueUsers: r.uniqueUsers,
  }));
}

// Per-user credit analytics for admin (provider breakdown + daily usage + references)
export async function getUserCreditAnalyticsForAdmin(userId: number, days: number = 30) {
  const startDate = dailyWindowStart(days);

  // Provider breakdown
  const providers = await db
    .select({
      apiProvider: sql<string>`COALESCE(api_provider, 'platform')`,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(eq(creditEventLogsTable.userId, userId))
    .groupBy(sql`COALESCE(api_provider, 'platform')`)
    .orderBy(sql`SUM(credits_used) DESC`);

  // Daily usage
  const daily = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(and(eq(creditEventLogsTable.userId, userId), gte(creditEventLogsTable.createdAt, startDate)))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`);

  // Top references
  const references = await db
    .select({
      referenceType: sql<string>`COALESCE(${creditEventLogsTable.referenceType}, 'other')`,
      referenceId: sql<string>`COALESCE(${creditEventLogsTable.referenceId}, 'none')`,
      totalCredits: sql<string>`COALESCE(SUM(${creditEventLogsTable.creditsUsed}), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      lastUsed: sql<string>`MAX(${creditEventLogsTable.createdAt})`,
      title: sql<string | null>`MAX(${chatThreadsTable.title})`,
    })
    .from(creditEventLogsTable)
    .leftJoin(
      chatThreadsTable,
      and(
        sql`COALESCE(${creditEventLogsTable.referenceType}, 'other') = 'chat_thread'`,
        sql`${chatThreadsTable.id} = CASE
          WHEN ${creditEventLogsTable.referenceId} ~ '^[0-9]+$'
          THEN CAST(${creditEventLogsTable.referenceId} AS INTEGER)
          ELSE NULL
        END`
      )
    )
    .where(eq(creditEventLogsTable.userId, userId))
    .groupBy(sql`COALESCE(${creditEventLogsTable.referenceType}, 'other'), COALESCE(${creditEventLogsTable.referenceId}, 'none')`)
    .orderBy(sql`SUM(${creditEventLogsTable.creditsUsed}) DESC`)
    .limit(20);

  // Totals
  const [totalsResult] = await db
    .select({
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      totalEvents: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(eq(creditEventLogsTable.userId, userId));

  return {
    providers: providers.map((r: { apiProvider: string; totalCredits: string; totalApiCostCents: string; eventCount: number }) => ({
      apiProvider: r.apiProvider,
      totalCredits: parseFloat(r.totalCredits || "0"),
      totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
      eventCount: r.eventCount,
    })),
    daily: daily.map((r: { date: string; totalCredits: string; eventCount: number }) => ({
      date: r.date,
      totalCredits: parseFloat(r.totalCredits || "0"),
      eventCount: r.eventCount,
    })),
    references: references.map((r: { referenceType: string; referenceId: string; totalCredits: string; eventCount: number; lastUsed: string; title: string | null }) => ({
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      totalCredits: parseFloat(r.totalCredits || "0"),
      eventCount: r.eventCount,
      lastUsed: r.lastUsed,
      title: r.title || null,
    })),
    totals: {
      totalCredits: parseFloat(totalsResult?.totalCredits || "0"),
      totalApiCostCents: parseFloat(totalsResult?.totalApiCostCents || "0"),
      totalEvents: totalsResult?.totalEvents || 0,
    },
  };
}

// Group credit events by referenceId (thread/chat/lead etc.) for drill-down
export async function getCreditEventsByReference(userId: number, options?: {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  apiProvider?: string; // optional filter for provider-first drilldown
  referenceType?: string; // optional filter for specific reference type
}): Promise<{
  groups: { referenceType: string; referenceId: string; totalCredits: number; eventCount: number; lastUsed: string; description: string; title: string | null }[];
  total: number;
  totalCreditsSum: number;
  totalEventsSum: number;
}> {
  const conditions = [eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId))];
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));
  if (options?.apiProvider) {
    if (options.apiProvider === 'platform') {
      conditions.push(sql`api_provider IS NULL`);
    } else {
      conditions.push(eq(creditEventLogsTable.apiProvider, options.apiProvider));
    }
  }
  if (options?.referenceType) {
    conditions.push(sql`${referenceGroupType} = ${options.referenceType}`);
  }

  const whereClause = and(...conditions);
  const pagination = boundedPagination(options?.limit, options?.offset);

  const [countResult] = await db
    .select({
      count: sql<number>`count(DISTINCT ${referenceGroupType} || ':' || ${referenceGroupId})::int`,
      totalCreditsSum: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalEventsSum: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(whereClause);

  const results = await db
    .select({
      referenceType: sql<string>`${referenceGroupType}`,
      referenceId: sql<string>`${referenceGroupId}`,
      totalCredits: sql<string>`COALESCE(SUM(${creditEventLogsTable.creditsUsed}), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      lastUsed: sql<string>`MAX(${creditEventLogsTable.createdAt})`,
      description: sql<string>`(array_agg(${creditEventLogsTable.description} ORDER BY ${creditEventLogsTable.createdAt} DESC))[1]`,
      title: sql<string | null>`COALESCE(MAX(${chatThreadsTable.title}), MAX(${whatsappBatchTitle}))`,
    })
    .from(creditEventLogsTable)
    .leftJoin(
      chatThreadsTable,
      sql`COALESCE(${creditEventLogsTable.referenceType}, 'other') = 'chat_thread'
        AND ${chatThreadsTable.id} = CASE WHEN ${creditEventLogsTable.referenceId} ~ '^[0-9]+$' THEN (${creditEventLogsTable.referenceId})::integer ELSE NULL END`
    )
    .where(whereClause)
    .groupBy(sql`1, 2`)
    .orderBy(sql`SUM(${creditEventLogsTable.creditsUsed}) DESC`)
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    groups: results.map((r: { referenceType: string; referenceId: string; totalCredits: string; eventCount: number; lastUsed: string; description: string; title: string | null }) => ({
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      totalCredits: parseFloat(r.totalCredits || "0"),
      eventCount: r.eventCount,
      lastUsed: r.lastUsed,
      description: r.description || '',
      title: r.title || null,
    })),
    total: countResult?.count || 0,
    totalCreditsSum: parseFloat(countResult?.totalCreditsSum as unknown as string || "0"),
    totalEventsSum: countResult?.totalEventsSum || 0,
  };
}

// Get provider breakdown for a specific reference (drill-down level 2)
export async function getCreditEventProviderBreakdown(userId: number, referenceType: string, referenceId: string, options?: {
  startDate?: Date;
  endDate?: Date;
}): Promise<{ apiProvider: string; totalCredits: number; eventCount: number; totalApiCostCents: number }[]> {
  const conditions = [
    eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId)),
    referenceCondition(referenceType, referenceId),
  ];
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const results = await db
    .select({
      apiProvider: sql<string>`COALESCE(api_provider, 'platform')`,
      totalCredits: sql<string>`COALESCE(SUM(credits_used), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(and(...conditions))
    .groupBy(sql`COALESCE(api_provider, 'platform')`)
    .orderBy(sql`SUM(credits_used) DESC`);

  return results.map((r: { apiProvider: string; totalCredits: string; totalApiCostCents: string; eventCount: number }) => ({
    apiProvider: r.apiProvider,
    totalCredits: parseFloat(r.totalCredits || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
  }));
}

// Get individual events for a specific reference + provider (drill-down level 3)
export async function getCreditEventDetails(userId: number, referenceType: string, referenceId: string, apiProvider?: string, options?: {
  limit?: number;
  offset?: number;
}): Promise<{ logs: CreditEventLogRecord[]; total: number }> {
  const conditions = [
    eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId)),
    referenceCondition(referenceType, referenceId),
  ];
  if (apiProvider) {
    if (apiProvider === 'platform') {
      conditions.push(sql`api_provider IS NULL`);
    } else {
      conditions.push(eq(creditEventLogsTable.apiProvider, apiProvider));
    }
  }

  const whereClause = and(...conditions);
  const pagination = boundedPagination(options?.limit, options?.offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creditEventLogsTable)
    .where(whereClause);

  const logs = await db
    .select()
    .from(creditEventLogsTable)
    .where(whereClause)
    .orderBy(desc(creditEventLogsTable.createdAt))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { logs, total: countResult?.count || 0 };
}

// ===== Revenue Analytics Functions =====

// Revenue summary: total charged vs total API cost, grouped by provider
export async function getRevenueSummary(options?: { startDate?: Date; endDate?: Date; currentRechargeRate?: number }) {
  const conditions: (SQL<unknown> | undefined)[] = [];
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      apiProvider: sql<string>`COALESCE(api_provider, 'platform')`,
      totalCreditsCharged: sql<string>`COALESCE(SUM(credits_used), 0)`,
      grossRevenueINR: creditValueInr(options?.currentRechargeRate ?? 10),
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      uniqueUsers: sql<number>`count(DISTINCT user_id)::int`,
    })
    .from(creditEventLogsTable)
    .where(whereClause)
    .groupBy(sql`COALESCE(api_provider, 'platform')`)
    .orderBy(sql`SUM(credits_used) DESC`);

  return results.map((r: { apiProvider: string; totalCreditsCharged: string; grossRevenueINR: string; totalApiCostCents: string; eventCount: number; uniqueUsers: number }) => ({
    apiProvider: r.apiProvider,
    totalCreditsCharged: parseFloat(r.totalCreditsCharged || "0"),
    grossRevenueINR: parseFloat(r.grossRevenueINR || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
    uniqueUsers: r.uniqueUsers,
  }));
}

// Daily revenue data for charts
export async function getDailyRevenue(days: number = 30, currentRechargeRate = 10) {
  const startDate = dailyWindowStart(days);

  const results = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      totalCreditsCharged: sql<string>`COALESCE(SUM(credits_used), 0)`,
      grossRevenueINR: creditValueInr(currentRechargeRate),
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(gte(creditEventLogsTable.createdAt, startDate))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`);

  return results.map((r: { date: string; totalCreditsCharged: string; grossRevenueINR: string; totalApiCostCents: string; eventCount: number }) => ({
    date: r.date,
    totalCreditsCharged: parseFloat(r.totalCreditsCharged || "0"),
    grossRevenueINR: parseFloat(r.grossRevenueINR || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
  }));
}

// Revenue drill-down: by event key within a provider
export async function getRevenueByEventKey(options?: { apiProvider?: string; startDate?: Date; endDate?: Date; currentRechargeRate?: number }) {
  const conditions: (SQL<unknown> | undefined)[] = [];
  if (options?.apiProvider) {
    if (options.apiProvider === 'platform') {
      conditions.push(sql`api_provider IS NULL`);
    } else {
      conditions.push(eq(creditEventLogsTable.apiProvider, options.apiProvider));
    }
  }
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      eventKey: creditEventLogsTable.eventKey,
      service: sql<string>`COALESCE(service, 'unknown')`,
      apiProvider: sql<string>`COALESCE(api_provider, 'platform')`,
      totalCreditsCharged: sql<string>`COALESCE(SUM(credits_used), 0)`,
      grossRevenueINR: creditValueInr(options?.currentRechargeRate ?? 10),
      totalApiCostCents: sql<string>`COALESCE(SUM(api_cost_cents), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
    })
    .from(creditEventLogsTable)
    .where(whereClause)
    .groupBy(creditEventLogsTable.eventKey, sql`COALESCE(service, 'unknown')`, sql`COALESCE(api_provider, 'platform')`)
    .orderBy(sql`SUM(credits_used) DESC`);

  return results.map((r: { eventKey: string; service: string; apiProvider: string; totalCreditsCharged: string; grossRevenueINR: string; totalApiCostCents: string; eventCount: number }) => ({
    eventKey: r.eventKey,
    service: r.service,
    apiProvider: r.apiProvider,
    totalCreditsCharged: parseFloat(r.totalCreditsCharged || "0"),
    grossRevenueINR: parseFloat(r.grossRevenueINR || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
  }));
}

// Revenue drill-down: individual transactions for a provider + event key
export async function getRevenueTransactions(options: {
  apiProvider?: string;
  eventKey?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ logs: CreditEventLogRecord[]; total: number }> {
  const conditions: (SQL<unknown> | undefined)[] = [];
  if (options.apiProvider) {
    if (options.apiProvider === 'platform') {
      conditions.push(sql`api_provider IS NULL`);
    } else {
      conditions.push(eq(creditEventLogsTable.apiProvider, options.apiProvider));
    }
  }
  if (options.eventKey) conditions.push(eq(creditEventLogsTable.eventKey, options.eventKey));
  if (options.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const pagination = boundedPagination(options.limit, options.offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creditEventLogsTable)
    .where(whereClause);

  const revenueTransactionLogs = await db
    .select()
    .from(creditEventLogsTable)
    .where(whereClause)
    .orderBy(desc(creditEventLogsTable.createdAt))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { logs: revenueTransactionLogs, total: countResult?.count || 0 };
}

// Get spending grouped by referenceType (campaign-wise spending view)
export async function getCampaignWiseSpending(userId: number, options?: {
  startDate?: Date;
  endDate?: Date;
}): Promise<{
  referenceType: string;
  totalCredits: number;
  totalApiCostCents: number;
  eventCount: number;
  firstUsed: string;
  lastUsed: string;
}[]> {
  const conditions = [eq(creditEventLogsTable.organizationId, await resolveBillingOrganization(userId))];
  if (options?.startDate) conditions.push(gte(creditEventLogsTable.createdAt, options.startDate));
  if (options?.endDate) conditions.push(lte(creditEventLogsTable.createdAt, options.endDate));

  const results = await db
    .select({
      referenceType: sql<string>`COALESCE(${creditEventLogsTable.referenceType}, 'other')`,
      totalCredits: sql<string>`COALESCE(SUM(${creditEventLogsTable.creditsUsed}), 0)`,
      totalApiCostCents: sql<string>`COALESCE(SUM(${creditEventLogsTable.apiCostCents}), 0)`,
      eventCount: sql<number>`${EVENT_COUNT}`,
      firstUsed: sql<string>`MIN(${creditEventLogsTable.createdAt})`,
      lastUsed: sql<string>`MAX(${creditEventLogsTable.createdAt})`,
    })
    .from(creditEventLogsTable)
    .where(and(...conditions))
    .groupBy(sql`COALESCE(${creditEventLogsTable.referenceType}, 'other')`)
    .orderBy(sql`SUM(${creditEventLogsTable.creditsUsed}) DESC`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return results.map((r: any) => ({
    referenceType: r.referenceType,
    totalCredits: parseFloat(r.totalCredits || "0"),
    totalApiCostCents: parseFloat(r.totalApiCostCents || "0"),
    eventCount: r.eventCount,
    firstUsed: r.firstUsed,
    lastUsed: r.lastUsed,
  }));
}
