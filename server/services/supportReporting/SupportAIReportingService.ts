import { sql, type SQL } from "drizzle-orm";
import { db } from "../../models/db.js";
import { currentBusinessScope } from "../../tenancy/businessContext.js";

export class SupportReportValidationError extends Error {}
export interface SupportReportFilters {
  from?: string;
  to?: string;
  source: "all" | "widget" | "internal";
  teamId?: number;
  assistantId?: string;
}
export interface SupportReportQuery extends SupportReportFilters {
  sessionSearch: string;
  leadSearch: string;
  sessionPage: number;
  leadPage: number;
  limit: number;
}
export interface SupportQualityQuery extends SupportReportFilters {
  search: string;
  status: "open" | "reviewed" | "all";
  page: number;
  limit: number;
}
export interface StaffFeedbackInput {
  rating: "helpful" | "needs_review";
  reason?: "incorrect" | "missing_information" | "outdated" | "other";
  notes?: string;
  status: "open" | "reviewed";
}

type Query = Record<string, unknown>;
function text(query: Query, key: string, max = 200): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new SupportReportValidationError(`Invalid ${key}`);
  return value.trim() || undefined;
}
function positiveInteger(
  query: Query,
  key: string,
  fallback?: number,
  max = 2_147_483_647,
): number | undefined {
  if (query[key] === undefined) return fallback;
  const value = query[key];
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  ) {
    throw new SupportReportValidationError(`Invalid ${key}`);
  }
  return Number(value);
}
function date(query: Query, key: string): string | undefined {
  const value = text(query, key, 10);
  if (value === undefined && query[key] !== undefined)
    throw new SupportReportValidationError(`Invalid ${key}`);
  const parsed =
    value === undefined ? undefined : new Date(`${value}T00:00:00Z`);
  if (
    value !== undefined &&
    (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(parsed!.getTime()) ||
      parsed!.toISOString().slice(0, 10) !== value)
  ) {
    throw new SupportReportValidationError(`Invalid ${key}`);
  }
  return value;
}
function commonFilters(query: Query): SupportReportFilters {
  const from = date(query, "from");
  const to = date(query, "to");
  if (from && to && from > to)
    throw new SupportReportValidationError("from must be on or before to");
  const source = query.source ?? "all";
  if (!["all", "widget", "internal"].includes(source as string))
    throw new SupportReportValidationError("Invalid source");
  return {
    from,
    to,
    source: source as SupportReportFilters["source"],
    teamId: positiveInteger(query, "teamId"),
    assistantId: text(query, "assistantId", 100),
  };
}
export function parseSupportReportQuery(query: Query = {}): SupportReportQuery {
  return {
    ...commonFilters(query),
    sessionSearch: text(query, "sessionSearch") ?? "",
    leadSearch: text(query, "leadSearch") ?? "",
    sessionPage: positiveInteger(query, "sessionPage", 1)!,
    leadPage: positiveInteger(query, "leadPage", 1)!,
    limit: positiveInteger(query, "limit", 25, 100)!,
  };
}
export function parseSupportQualityQuery(
  query: Query = {},
): SupportQualityQuery {
  const status = query.status ?? "open";
  if (!["open", "reviewed", "all"].includes(status as string))
    throw new SupportReportValidationError("Invalid status");
  return {
    ...commonFilters(query),
    search: text(query, "search") ?? "",
    status: status as SupportQualityQuery["status"],
    page: positiveInteger(query, "page", 1)!,
    limit: positiveInteger(query, "limit", 25, 100)!,
  };
}
export function parseStaffFeedback(body: Query): StaffFeedbackInput {
  if (!body || !["helpful", "needs_review"].includes(body.rating as string))
    throw new SupportReportValidationError(
      "A helpful or needs_review rating is required",
    );
  if (
    body.reason !== undefined &&
    !["incorrect", "missing_information", "outdated", "other"].includes(
      body.reason as string,
    )
  )
    throw new SupportReportValidationError("Invalid feedback reason");
  if (
    body.status !== undefined &&
    !["open", "reviewed"].includes(body.status as string)
  )
    throw new SupportReportValidationError("Invalid feedback status");
  const notes = text(body, "notes", 2000);
  return {
    rating: body.rating as StaffFeedbackInput["rating"],
    ...(body.rating === "needs_review" && body.reason
      ? { reason: body.reason as StaffFeedbackInput["reason"] }
      : {}),
    ...(notes ? { notes } : {}),
    status:
      (body.status as StaffFeedbackInput["status"]) ??
      (body.rating === "helpful" ? "reviewed" : "open"),
  };
}
function all(predicates: SQL[]): SQL {
  return sql.join(predicates, sql` AND `);
}
function businessColumn(alias: string): SQL[] {
  const scope = currentBusinessScope();
  return scope
    ? [
        sql`${sql.raw(`${alias}.business_profile_id`)} = ${scope.businessProfileId}`,
      ]
    : [];
}
function scopedAnd(alias: string): SQL {
  const predicates = businessColumn(alias);
  return predicates.length ? sql`AND ${all(predicates)}` : sql``;
}
function sessionPredicate(userId: number, filters: SupportReportFilters): SQL {
  const predicates = [
    sql`t.user_id = ${userId}`,
    ...businessColumn("s"),
    ...businessColumn("t"),
    ...businessColumn("tm"),
  ];
  if (filters.from) predicates.push(sql`s.created_at >= ${filters.from}::date`);
  if (filters.to)
    predicates.push(
      sql`s.created_at < (${filters.to}::date + INTERVAL '1 day')`,
    );
  if (filters.source === "widget")
    predicates.push(sql`s.metadata->>'source' = 'widget'`);
  if (filters.source === "internal")
    predicates.push(sql`COALESCE(s.metadata->>'source', '') <> 'widget'`);
  if (filters.teamId) predicates.push(sql`t.id = ${filters.teamId}`);
  if (filters.assistantId)
    predicates.push(sql`(s.metadata->>'assistantId' = ${filters.assistantId}
    OR EXISTS (SELECT 1 FROM support_chat_messages am WHERE am.session_id = s.id ${scopedAnd("am")}
      AND COALESCE(am.metadata #>> '{provenance,assistant,assistantId}', am.metadata #>> '{assistant,assistantId}', am.metadata #>> '{provenance,resolvedAssistant,assistantId}') = ${filters.assistantId}))`);
  return all(predicates);
}
function leadPredicate(userId: number, filters: SupportReportFilters): SQL {
  const predicates = [
    sql`l.user_id = ${userId}`,
    sql`l.source = 'support_widget'`,
    sql`l.deleted_at IS NULL`,
    ...businessColumn("l"),
  ];
  if (filters.from) predicates.push(sql`l.created_at >= ${filters.from}::date`);
  if (filters.to)
    predicates.push(
      sql`l.created_at < (${filters.to}::date + INTERVAL '1 day')`,
    );
  if (filters.source === "internal") predicates.push(sql`FALSE`);
  else if (filters.source === "widget" || filters.teamId || filters.assistantId)
    predicates.push(
      sql`EXISTS (SELECT 1 FROM owned_sessions os WHERE os.lead_id = l.id)`,
    );
  return all(predicates);
}
function baseCte(userId: number, filters: SupportReportFilters): SQL {
  return sql`WITH owned_sessions AS (
    SELECT s.*, tm.name AS member_name, t.id AS team_id, t.name AS team_name
    FROM support_chat_sessions s JOIN team_members tm ON tm.id = s.member_id
    JOIN support_teams t ON t.id = tm.team_id WHERE ${sessionPredicate(userId, filters)}
  ), captured_leads AS (SELECT l.* FROM leads l WHERE ${leadPredicate(userId, filters)})`;
}
function literalPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
function sessionSearch(value: string, userId: number): SQL {
  if (!value) return sql`TRUE`;
  const pattern = literalPattern(value);
  return sql`(COALESCE(s.title,'') ILIKE ${pattern} ESCAPE '\\'
    OR COALESCE(s.member_name,'') ILIKE ${pattern} ESCAPE '\\'
    OR COALESCE(s.metadata->>'visitorName','') ILIKE ${pattern} ESCAPE '\\'
    OR COALESCE(s.metadata->>'visitorEmail','') ILIKE ${pattern} ESCAPE '\\'
    OR COALESCE(s.metadata->>'visitorPhone','') ILIKE ${pattern} ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM leads contact WHERE contact.id=s.lead_id AND contact.user_id=${userId}
      AND contact.deleted_at IS NULL ${scopedAnd("contact")}
      AND (COALESCE(contact.name,'') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(contact.email,'') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(contact.phone,'') ILIKE ${pattern} ESCAPE '\\'))
    OR EXISTS (SELECT 1 FROM support_chat_messages sm WHERE sm.session_id=s.id ${scopedAnd("sm")} AND sm.content ILIKE ${pattern} ESCAPE '\\'))`;
}
function leadSearch(value: string): SQL {
  if (!value) return sql`TRUE`;
  const pattern = literalPattern(value);
  return sql`(COALESCE(l.name,'') ILIKE ${pattern} ESCAPE '\\' OR COALESCE(l.email,'') ILIKE ${pattern} ESCAPE '\\'
    OR COALESCE(l.phone,'') ILIKE ${pattern} ESCAPE '\\' OR COALESCE(l.status,'') ILIKE ${pattern} ESCAPE '\\')`;
}
const privateMetadataKeys = new Set([
  "vaultid",
  "profilevaultid",
  "tokenmap",
  "commit",
  "deferredeffectcontext",
  "deferredeffects",
  "supportturn",
  "requestinputhash",
  "publictoken",
  "sessiontoken",
  "clientsessionkey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "authorization",
  "apikey",
  "password",
  "ciphertext",
  "encryptedpayload",
  "assistantawayreceipt",
]);
/** Operational capabilities and vault references are server-only even when nested in JSON metadata. */
export function safeSupportReadMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeSupportReadMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.replace(/[_-]/g, "").toLowerCase();
        return (
          !privateMetadataKeys.has(normalized) &&
          !/privacyvault|deferredcommit|committoken|capabilit|credential|secret/.test(
            normalized,
          )
        );
      })
      .map(([key, item]) => [key, safeSupportReadMetadata(item)]),
  );
}
function safeSupportRecord(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return { ...row, metadata: safeSupportReadMetadata(row.metadata) };
}

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** Runs a page's reads one after another in one transaction. In parallel each
 * read took its own pooled connection and repeated the tenant-scope setup, so a
 * single report request could hold most of the pool. */
type ReadResult = Awaited<ReturnType<typeof db.execute>>;
async function readInOrder(reads: Array<(tx: typeof db) => Promise<ReadResult>>): Promise<ReadResult[]> {
  return db.transaction(async (tx: typeof db) => {
    const results: ReadResult[] = [];
    for (const read of reads) results.push(await read(tx));
    return results;
  });
}

export async function supportAIReport(
  userId: number,
  query: SupportReportQuery,
) {
  const cte = baseCte(userId, query);
  const results = await readInOrder([
    (tx: typeof db) => tx.execute(sql`${cte}, ordered_messages AS (
      SELECT m.*, lag(m.role) OVER w AS previous_role, lag(m.created_at) OVER w AS previous_created_at
      FROM support_chat_messages m JOIN owned_sessions s ON s.id=m.session_id WHERE TRUE ${scopedAnd("m")}
      WINDOW w AS (PARTITION BY m.session_id ORDER BY m.created_at,m.id)
    ) SELECT
      (SELECT COUNT(*)::int FROM owned_sessions) AS "totalSessions",
      (SELECT COUNT(*)::int FROM owned_sessions WHERE metadata->>'source'='widget') AS "widgetSessions",
      (SELECT COUNT(*)::int FROM ordered_messages) AS "totalMessages",
      (SELECT COUNT(*)::int FROM captured_leads) AS "leadsGenerated",
      (SELECT AVG(EXTRACT(EPOCH FROM (created_at-previous_created_at)))::float8 FROM ordered_messages
        WHERE role='assistant' AND previous_role='user' AND processing_status='completed' AND created_at>=previous_created_at) AS "averageResponseSeconds",
      (SELECT COUNT(*)::int FROM ordered_messages WHERE role='assistant' AND previous_role='user' AND processing_status='completed' AND created_at>=previous_created_at) AS "responseSampleCount",
      (SELECT COUNT(*)::int FROM ordered_messages WHERE role='assistant' AND metadata #>> '{staffFeedback,rating}' IN ('helpful','needs_review')) AS "feedbackCount",
      (SELECT 100.0 * COUNT(*) FILTER (WHERE metadata #>> '{staffFeedback,rating}'='helpful') / NULLIF(COUNT(*),0)
        FROM ordered_messages WHERE role='assistant' AND metadata #>> '{staffFeedback,rating}' IN ('helpful','needs_review'))::float8 AS "helpfulRate",
      (SELECT COUNT(*)::int FROM owned_sessions WHERE metadata #>> '{customerFeedback,rating}' IN ('helpful','not_helpful')) AS "csatCount",
      (SELECT 100.0 * COUNT(*) FILTER (WHERE metadata #>> '{customerFeedback,rating}'='helpful') / NULLIF(COUNT(*),0)
        FROM owned_sessions WHERE metadata #>> '{customerFeedback,rating}' IN ('helpful','not_helpful'))::float8 AS "satisfactionRate",
      (SELECT COUNT(*)::int FROM owned_sessions WHERE ticket_id IS NOT NULL OR automation_mode='human_paused'
        OR metadata->>'deliveryOutcome'='human_handoff' OR metadata->>'handoff'='true') AS "handoffCount",
      (SELECT 100.0 * COUNT(*) FILTER (WHERE ticket_id IS NOT NULL OR automation_mode='human_paused'
        OR metadata->>'deliveryOutcome'='human_handoff' OR metadata->>'handoff'='true') / NULLIF(COUNT(*),0) FROM owned_sessions)::float8 AS "handoffRate",
      (SELECT COUNT(*)::int FROM captured_leads WHERE status='converted' OR lead_status='converted') AS "convertedLeads",
      (SELECT 100.0 * COUNT(*) FILTER (WHERE status='converted' OR lead_status='converted') / NULLIF(COUNT(*),0) FROM captured_leads)::float8 AS "leadConversionRate"`),
    (tx: typeof db) => tx.execute(sql`${cte} SELECT s.id,s.member_id AS "memberId",s.title,s.summary,s.lead_id AS "leadId",s.ticket_id AS "ticketId",
      s.metadata,s.automation_mode AS "automationMode",s.created_at AS "createdAt",s.updated_at AS "updatedAt",
      s.member_name AS "memberName",s.team_id AS "teamId",s.team_name AS "teamName",
      (SELECT COUNT(*)::int FROM support_chat_messages m WHERE m.session_id=s.id ${scopedAnd("m")}) AS "messageCount",
      CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('id',l.id,'name',l.name,'email',l.email,'phone',l.phone) END AS "leadInfo"
      FROM owned_sessions s LEFT JOIN leads l ON l.id=s.lead_id AND l.user_id=${userId} AND l.deleted_at IS NULL ${currentBusinessScope() ? sql`AND l.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``}
      WHERE ${sessionSearch(query.sessionSearch, userId)} ORDER BY s.updated_at DESC,s.id DESC LIMIT ${query.limit} OFFSET ${(query.sessionPage - 1) * query.limit}`),
    (tx: typeof db) => tx.execute(
      sql`${cte} SELECT COUNT(*)::int AS total FROM owned_sessions s WHERE ${sessionSearch(query.sessionSearch, userId)}`,
    ),
    (tx: typeof db) => tx.execute(sql`${cte} SELECT l.id,l.name,l.email,l.phone,l.source,l.status,l.created_at AS "createdAt"
      FROM captured_leads l WHERE ${leadSearch(query.leadSearch)} ORDER BY l.created_at DESC,l.id DESC LIMIT ${query.limit} OFFSET ${(query.leadPage - 1) * query.limit}`),
    (tx: typeof db) => tx.execute(
      sql`${cte} SELECT COUNT(*)::int AS total FROM captured_leads l WHERE ${leadSearch(query.leadSearch)}`,
    ),
    (tx: typeof db) => tx.execute(
      sql`SELECT t.id,t.name FROM support_teams t WHERE t.user_id=${userId} ${currentBusinessScope() ? sql`AND t.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``} ORDER BY t.name,t.id`,
    ),
    (tx: typeof db) => tx.execute(sql`SELECT a.id,COALESCE(a.draft->>'name','Unnamed assistant') AS name FROM outreach_assistants a
      WHERE a.user_id=${userId} ${currentBusinessScope() ? sql`AND a.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``} ORDER BY name,a.id`),
  ]);
  const aggregate = results[0].rows[0];
  const {
    totalSessions,
    widgetSessions,
    totalMessages,
    leadsGenerated,
    ...metrics
  } = aggregate;
  return {
    sessions: results[1].rows.map(safeSupportRecord),
    leads: results[3].rows,
    stats: { totalSessions, widgetSessions, totalMessages, leadsGenerated },
    metrics,
    pagination: {
      sessions: pagination(
        query.sessionPage,
        query.limit,
        results[2].rows[0].total,
      ),
      leads: pagination(query.leadPage, query.limit, results[4].rows[0].total),
    },
    filters: { teams: results[5].rows, assistants: results[6].rows },
    leadScope: {
      source: "support_widget",
      dateField: "createdAt",
      requiresLinkedConversation:
        query.source !== "all" || Boolean(query.teamId || query.assistantId),
      excludesDeleted: true,
      conversionStatus: "converted",
    },
    metricDefinitions: {
      dates:
        "Sessions use conversation creation dates; captured leads use lead creation dates. Dates are inclusive UTC days.",
      leads:
        query.source !== "all" || query.teamId || query.assistantId
          ? "Captured widget leads linked to matching conversations."
          : "All captured widget leads, including historical leads without a conversation.",
      responseTime:
        "Time from a customer or staff message to the next completed first assistant reply.",
      helpfulRate:
        "Helpful staff ratings as a percentage of rated assistant answers.",
      satisfactionRate:
        "Helpful customer ratings as a percentage of rated widget conversations.",
      handoffRate:
        "Conversations with a recorded linked ticket, human pause, or explicit handoff as a percentage of conversations.",
      leadConversionRate:
        "Captured widget leads explicitly marked converted as a percentage of captured leads.",
    },
  };
}

function qualityCte(userId: number, query: SupportQualityQuery): SQL {
  return sql`${baseCte(userId, query)}, flagged_answers AS (
    SELECT m.id AS message_id,m.session_id,s.title AS session_title,s.team_name,m.content AS answer,m.sources,m.confidence,m.created_at,
      m.metadata->'staffFeedback' AS feedback,
      (SELECT q.content FROM support_chat_messages q WHERE q.session_id=m.session_id ${scopedAnd("q")} AND q.role='user'
        AND (q.created_at,q.id)<=(m.created_at,m.id) ORDER BY q.created_at DESC,q.id DESC LIMIT 1) AS question
    FROM support_chat_messages m JOIN owned_sessions s ON s.id=m.session_id
    WHERE m.role='assistant' ${scopedAnd("m")} AND m.metadata #>> '{staffFeedback,rating}' IN ('helpful','needs_review')
  )`;
}
function qualitySearch(query: SupportQualityQuery): SQL {
  const clauses = [sql`TRUE`];
  if (query.search) {
    const pattern = literalPattern(query.search);
    clauses.push(sql`(COALESCE(f.question,'') ILIKE ${pattern} ESCAPE '\\' OR f.answer ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(f.session_title,'') ILIKE ${pattern} ESCAPE '\\' OR COALESCE(f.feedback->>'notes','') ILIKE ${pattern} ESCAPE '\\')`);
  }
  return all(clauses);
}
function qualityStatus(query: SupportQualityQuery): SQL {
  return query.status === "all"
    ? sql`TRUE`
    : sql`COALESCE(f.feedback->>'status','open')=${query.status}`;
}
export async function supportAIQuality(
  userId: number,
  query: SupportQualityQuery,
) {
  const cte = qualityCte(userId, query);
  const [items, counts, summary, teams, assistants] = await readInOrder([
    (tx: typeof db) => tx.execute(sql`${cte} SELECT f.message_id AS "messageId",f.session_id AS "sessionId",f.session_title AS "sessionTitle",
      f.question,f.answer,f.sources,f.confidence,f.created_at AS "createdAt",f.feedback,f.team_name AS "teamName"
      FROM flagged_answers f WHERE ${qualitySearch(query)} AND ${qualityStatus(query)}
      ORDER BY f.feedback->>'updatedAt' DESC NULLS LAST,f.created_at DESC,f.message_id DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`),
    (tx: typeof db) => tx.execute(
      sql`${cte} SELECT COUNT(*)::int AS total FROM flagged_answers f WHERE ${qualitySearch(query)} AND ${qualityStatus(query)}`,
    ),
    (tx: typeof db) => tx.execute(sql`${cte} SELECT COUNT(*) FILTER (WHERE COALESCE(f.feedback->>'status','open')='open')::int AS open,
      COUNT(*) FILTER (WHERE f.feedback->>'status'='reviewed')::int AS reviewed,
      COUNT(*) FILTER (WHERE f.feedback->>'rating'='helpful')::int AS helpful FROM flagged_answers f WHERE ${qualitySearch(query)}`),
    (tx: typeof db) => tx.execute(
      sql`SELECT t.id,t.name FROM support_teams t WHERE t.user_id=${userId} ${currentBusinessScope() ? sql`AND t.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``} ORDER BY t.name,t.id`,
    ),
    (tx: typeof db) => tx.execute(sql`SELECT a.id,COALESCE(a.draft->>'name','Unnamed assistant') AS name FROM outreach_assistants a
      WHERE a.user_id=${userId} ${currentBusinessScope() ? sql`AND a.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``} ORDER BY name,a.id`),
  ]);
  return {
    items: items.rows,
    pagination: pagination(query.page, query.limit, counts.rows[0].total),
    summary: summary.rows[0],
    filters: { teams: teams.rows, assistants: assistants.rows },
  };
}
export async function saveSupportStaffFeedback(
  userId: number,
  actorUserId: number,
  messageId: number,
  feedback: StaffFeedbackInput,
) {
  const record = {
    ...feedback,
    actorUserId,
    updatedAt: new Date().toISOString(),
  };
  const result = await db.execute(sql`UPDATE support_chat_messages m
    SET metadata=jsonb_set(CASE WHEN jsonb_typeof(m.metadata)='object' THEN m.metadata ELSE '{}'::jsonb END,'{staffFeedback}',${JSON.stringify(record)}::jsonb,true)
    FROM support_chat_sessions s JOIN team_members tm ON tm.id=s.member_id JOIN support_teams t ON t.id=tm.team_id
    WHERE m.id=${messageId} AND m.role='assistant' AND m.session_id=s.id AND ${sessionPredicate(userId, { source: "all" })}
      ${currentBusinessScope() ? sql`AND m.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``}
    RETURNING m.id AS "messageId",m.session_id AS "sessionId",m.metadata->'staffFeedback' AS feedback`);
  return result.rows[0] ?? null;
}

/** Transcript reads intentionally omit public session secrets and deferred private commits. */
export async function supportSessionDetail(userId: number, sessionId: number) {
  const result =
    await db.execute(sql`SELECT s.id,s.member_id AS "memberId",s.title,s.summary,s.lead_id AS "leadId",s.ticket_id AS "ticketId",
    s.metadata,s.automation_mode AS "automationMode",s.created_at AS "createdAt",s.updated_at AS "updatedAt",
    tm.name AS "memberName",t.id AS "teamId",t.name AS "teamName",
    CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('id',l.id,'name',l.name,'email',l.email,'phone',l.phone) END AS "leadInfo"
    FROM support_chat_sessions s JOIN team_members tm ON tm.id=s.member_id JOIN support_teams t ON t.id=tm.team_id
    LEFT JOIN leads l ON l.id=s.lead_id AND l.user_id=${userId} AND l.deleted_at IS NULL ${scopedAnd("l")}
    WHERE s.id=${sessionId} AND ${sessionPredicate(userId, { source: "all" })}`);
  if (!result.rows[0]) return null;
  const messages =
    await db.execute(sql`SELECT m.id,m.session_id AS "sessionId",m.role,m.content,m.sources,m.confidence,m.metadata,
    m.request_id AS "requestId",m.processing_status AS "processingStatus",m.processing_started_at AS "processingStartedAt",
    m.processing_expires_at AS "processingExpiresAt",m.created_at AS "createdAt"
    FROM support_chat_messages m WHERE m.session_id=${sessionId} ${scopedAnd("m")} ORDER BY m.created_at,m.id`);
  return {
    ...safeSupportRecord(result.rows[0]),
    messageCount: messages.rows.length,
    messages: messages.rows.map(safeSupportRecord),
  };
}
