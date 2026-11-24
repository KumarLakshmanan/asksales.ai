import { eq, ilike, or, gte, lte, desc, asc, sql, type SQL } from 'drizzle-orm';
import { leadsTable } from '../models/leads/schema.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';

// Listing and export must apply the same directory filters and business scope.
export function leadDirectoryQuery(userId: number, query: Record<string, unknown>, options: { ignoreThreadId?: boolean } = {}) {
  const search = query.search as string || "";
  const status = query.status as string || "";
  const source = query.source as string || "";
  const scoreRange = query.scoreRange as string || "";
  const sortBy = query.sortBy as string || "created_at_desc";
  const timeFilter = query.timeFilter as string || "";
  const threadId = !options.ignoreThreadId && query.threadId ? parseInt(query.threadId as string) : null;

  // Build filters - always filter by userId for security
  const conditions: (SQL | undefined)[] = [eq(leadsTable.userId, userId)];
  const scope = currentBusinessScope();
  if (scope) conditions.push(eq(leadsTable.businessProfileId, scope.businessProfileId));

  // Thread ID filter - leads whose campaignData.threadId names this chat thread.
  // Reads the stored key from migration 587, indexed on (business_profile_id,
  // user_id, key); casting the JSON value could not use an index and failed on
  // any non-numeric threadId in the account.
  if (threadId) {
    conditions.push(
      sql`${leadsTable}.legacy_campaign_thread_key = ${String(threadId)}`
    );
  }

  // Search filter
  if (search) {
    conditions.push(
      or(
        ilike(leadsTable.name, `%${search}%`),
        ilike(leadsTable.email, `%${search}%`),
        ilike(leadsTable.company, `%${search}%`),
        ilike(leadsTable.role, `%${search}%`),
        ilike(leadsTable.firstName, `%${search}%`),
        ilike(leadsTable.lastName, `%${search}%`)
      )
    );
  }

  // Match the table/detail fallback, including legacy rows with no pipeline state.
  const displayedStatus = sql<string>`COALESCE(NULLIF(${leadsTable.leadStatus}, ''), NULLIF(${leadsTable.status}, ''), 'new')`;
  if (status) {
    conditions.push(eq(displayedStatus, status));
  }

  // Source filter — case-insensitive with alias expansion.
  // e.g. "instagram" also matches "instagram_webhook", "email" matches "inbound_email".
  if (source) {
    const s = source.toLowerCase();
    if (s === 'instagram') {
      conditions.push(or(
        sql`LOWER(${leadsTable.source}) = 'instagram'`,
        sql`LOWER(${leadsTable.source}) = 'instagram_webhook'`
      ));
    } else if (s === 'facebook') {
      conditions.push(or(
        sql`LOWER(${leadsTable.source}) = 'facebook'`,
        sql`LOWER(${leadsTable.source}) = 'facebook_webhook'`
      ));
    } else if (s === 'email' || s === 'inbound_email') {
      conditions.push(or(
        sql`LOWER(${leadsTable.source}) = 'email'`,
        sql`LOWER(${leadsTable.source}) = 'inbound_email'`
      ));
    } else if (s === 'manual') {
      conditions.push(or(
        sql`LOWER(${leadsTable.source}) = 'manual'`,
        sql`LOWER(${leadsTable.source}) = 'manual_entry'`
      ));
    } else {
      conditions.push(sql`LOWER(${leadsTable.source}) = LOWER(${source})`);
    }
  }

  // Score range filter
  if (scoreRange) {
    const [min, max] = scoreRange.split("-").map(Number);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      conditions.push(gte(leadsTable.score, min));
      conditions.push(lte(leadsTable.score, max));
    }
  }

  if (timeFilter) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (timeFilter === 'yesterday') {
      const end = new Date(start);
      start.setDate(start.getDate() - 1);
      end.setMilliseconds(-1);
      conditions.push(gte(leadsTable.createdAt, start), lte(leadsTable.createdAt, end));
    } else {
      const daysByFilter: Record<string, number> = {
        today: 1,
        last7days: 7,
        last30days: 30,
        lastyear: 365,
      };
      const days = daysByFilter[timeFilter];
      if (days) {
        start.setDate(start.getDate() - (days - 1));
        conditions.push(gte(leadsTable.createdAt, start));
      }
    }
  }

  // Build sort
  let orderBy: SQL = desc(leadsTable.createdAt);
  switch (sortBy) {
    case "created_at_asc":
      orderBy = asc(leadsTable.createdAt);
      break;
    case "score_desc":
      orderBy = desc(leadsTable.score);
      break;
    case "score_asc":
      orderBy = asc(leadsTable.score);
      break;
    case "name_asc":
      orderBy = asc(leadsTable.name);
      break;
    case "name_desc":
      orderBy = desc(leadsTable.name);
      break;
  }

  return { conditions, displayedStatus, orderBy: [orderBy, desc(leadsTable.id)] };
}
