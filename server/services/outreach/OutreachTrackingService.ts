import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import {
  MAX_UPCOMING_DAYS, deliveryStateLabels, emptyBatchCounts, recipientFilterStates,
  type BatchCounts, type DailyActivity, type DailyActivityDay, type DeliveryState, type OutreachBatch, type OutreachBatchList,
  type OutreachBatchSummary, type OutreachFailureReason, type OutreachRecipient, type OutreachRecipientPage, type ReceiptSupport, type RecipientFilter,
  type TemplatePerformance, type TemplatePerformanceReport, type UpcomingDay, type UpcomingSchedule,
} from '../../../shared/outreachTracking.js';
import { ADMISSION_STALE_MINUTES } from './OutreachBatchService.js';
import { messageDeliveryState, messageNextAttemptAt, recipientRawStatuses } from './OutreachDeliveryState.js';
import { getEffectiveDailyLimit } from './QuotaService.js';
import { nextDailyCapacityTime } from './providerRetry.js';
import { addUtcDays, projectSends, utcDay, type WaitingGroup } from './OutreachUpcomingProjection.js';
import { crmCsvCell } from '../../utils/crmWorkspaceValidation.js';
import { canonicalOutreachCtes, executeReportQuery } from './CampaignReportingService.js';
import { campaignReportFiltersSchema } from './CampaignReportFilters.js';
import {
  batchIdSchema, batchListSchema, batchRenameSchema, dailyActivitySchema, failureListSchema, recipientExportSchema, recipientListSchema,
  templatePerformanceSchema, upcomingSchema, type DailyActivityFilters,
} from './OutreachTrackingFilters.js';

export class OutreachTrackingError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/**
 * These queries read outreach_messages by batch_id only. They deliberately do
 * not use the canonical report projection, which joins legacy tables and
 * customer identity for every message and is too heavy for a large outreach.
 * The one exception is the business-wide day view, which needs that
 * projection to add older send records without counting them twice.
 */

/** When a waiting message is next due, and where it stands: the shared definition Reports also uses. */
export const nextAttemptAt = messageNextAttemptAt;
export const deliveryState = messageDeliveryState;

/** Message timestamps are stored as UTC without a zone; return them as ISO text. */
const utc = (column: SQL) => sql`to_char(${column},'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;
const likeText = (value: string) => `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;

const countKey: Record<DeliveryState, keyof BatchCounts> = {
  scheduled: 'scheduled', waiting: 'waiting', waiting_limit: 'waitingLimit', sending: 'sending', sent: 'sent',
  delivered: 'delivered', read: 'read', failed: 'failed', expired: 'expired', needs_attention: 'needsAttention', cancelled: 'cancelled',
};
function addState(counts: BatchCounts, state: string, count: number) {
  const key = countKey[state as DeliveryState];
  if (!key) return;
  counts[key] += count;
  counts.total += count;
}

/** A launch whose process died never leaves "admitting" by itself; report it as interrupted once it has gone quiet. */
function admission(row: Record<string, unknown>): OutreachBatch['admission'] {
  const stale = row.status === 'admitting' && row.updated_at
    && Date.now() - new Date(row.updated_at as string).getTime() > ADMISSION_STALE_MINUTES * 60_000;
  return stale ? 'interrupted' : row.status as OutreachBatch['admission'];
}

function toBatch(row: Record<string, unknown>): OutreachBatch {
  return {
    id: String(row.id), name: String(row.name), channel: String(row.channel),
    providerAccountId: row.provider_account_id ? String(row.provider_account_id) : null,
    templateName: row.template_name ? String(row.template_name) : null,
    templateLanguage: row.template_language ? String(row.template_language) : null,
    source: row.source as OutreachBatch['source'], admission: admission(row),
    createdAt: iso(row.created_at)!, scheduledAt: iso(row.scheduled_at), expiresAt: iso(row.expires_at),
    requested: Number(row.requested_count) || 0, skipped: Number(row.skipped_count) || 0,
    receiptSupport: (['full', 'partial', 'none'].includes(String(row.receipt_support)) ? row.receipt_support : 'full') as ReceiptSupport,
  };
}

function owner(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new OutreachTrackingError('This outreach belongs to another business.', 403);
  return scope.businessProfileId;
}

const kindPredicate = (kind: 'outreach' | 'follow_up' | 'all') =>
  kind === 'all' ? sql`m.message_kind IN('outreach','follow_up')` : sql`m.message_kind=${kind}`;

async function loadBatch(userId: number, id: unknown) {
  const business = owner(userId);
  const parsed = batchIdSchema.safeParse(id);
  const result = parsed.success ? await db.execute(sql`SELECT * FROM outreach_batches
    WHERE id=${parsed.data}::uuid AND user_id=${userId} AND business_profile_id=${business}`) : { rows: [] };
  if (!result.rows[0]) throw new OutreachTrackingError('This outreach is not available in this business.', 404);
  return { business, row: result.rows[0] as Record<string, unknown>, id: String(result.rows[0].id) };
}

export async function listOutreachBatches(userId: number, input: unknown = {}): Promise<OutreachBatchList> {
  const filters = batchListSchema.parse(input);
  const business = owner(userId);
  const clauses: SQL[] = [sql`b.user_id=${userId}`, sql`b.business_profile_id=${business}`];
  if (filters.channel) clauses.push(sql`b.channel=${filters.channel}`);
  if (filters.q) clauses.push(sql`b.name ILIKE ${likeText(filters.q)}`);
  if (filters.templateName) clauses.push(sql`b.template_name=${filters.templateName}`);
  if (filters.state !== 'all') {
    const active = sql`((b.status='admitting' AND b.updated_at>now()-make_interval(mins=>${ADMISSION_STALE_MINUTES})) OR EXISTS(SELECT 1 FROM outreach_messages m WHERE m.batch_id=b.id
      AND m.message_kind='outreach' AND m.status IN('pending','sending')))`;
    clauses.push(filters.state === 'active' ? active : sql`NOT ${active}`);
  }
  const where = sql.join(clauses, sql` AND `);
  const [page, total] = await Promise.all([
    db.execute(sql`SELECT b.* FROM outreach_batches b WHERE ${where}
      ORDER BY b.created_at DESC,b.id DESC LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}`),
    db.execute(sql`SELECT COUNT(*)::int AS total FROM outreach_batches b WHERE ${where}`),
  ]);
  // The list shows stored counts. Only an outreach the background job has never counted is counted here.
  const rows = await Promise.all((page.rows as Record<string, unknown>[]).map(async row =>
    row.counts ? row : (await recountOutreachBatch(String(row.id)).catch(() => null)) ?? row));
  return {
    items: rows.map(row => ({ ...toBatch(row), counts: storedCounts(row.counts) ?? emptyBatchCounts() })),
    page: filters.page, pageSize: filters.pageSize, total: Number(total.rows[0]?.total) || 0,
  };
}

interface CountedBatch {
  counts: BatchCounts;
  followUps: BatchCounts;
  nextAttemptAt: string | null;
  lastActivityAt: string | null;
}

/** Counts every message of one outreach by delivery state. The only full count; pages read the stored result. */
async function countBatch(batchId: string): Promise<CountedBatch> {
  const grouped = await db.execute(sql`SELECT message_kind,state,COUNT(*)::int AS count,MIN(next_at) AS next_at,${utc(sql`MAX(last_at)`)} AS last_at FROM (
      SELECT m.message_kind,${deliveryState} AS state,${nextAttemptAt} AS next_at,
        GREATEST(m.sent_at,m.delivered_at,m.read_at,m.failed_at) AS last_at FROM outreach_messages m
      WHERE m.batch_id=${batchId}::uuid AND m.direction='outbound' AND m.message_kind IN('outreach','follow_up')
    ) states GROUP BY message_kind,state`);
  const counts = emptyBatchCounts(), followUps = emptyBatchCounts();
  let nextAttempt: number | null = null, waitingWithoutTime = false, lastActivityAt: string | null = null;
  for (const item of grouped.rows as Record<string, unknown>[]) {
    const state = String(item.state), count = Number(item.count) || 0;
    if (item.last_at && (!lastActivityAt || String(item.last_at) > lastActivityAt)) lastActivityAt = String(item.last_at);
    addState(item.message_kind === 'follow_up' ? followUps : counts, state, count);
    if (item.message_kind !== 'outreach' || !recipientFilterStates.waiting.includes(state as DeliveryState) || state === 'sending') continue;
    if (!item.next_at) { waitingWithoutTime = true; continue; }
    const due = new Date(item.next_at as string).getTime();
    if (nextAttempt === null || due < nextAttempt) nextAttempt = due;
  }
  // A waiting message with no recorded time goes out as capacity allows, so no single time is truthful.
  return { counts, followUps, lastActivityAt,
    nextAttemptAt: waitingWithoutTime || nextAttempt === null ? null : new Date(nextAttempt).toISOString() };
}

/**
 * Recounts one outreach and stores the result. The dirty flag is cleared
 * before counting, so a message that changes meanwhile marks it again and the
 * next pass picks it up.
 */
export async function recountOutreachBatch(batchId: string): Promise<Record<string, unknown> | null> {
  await db.execute(sql`UPDATE outreach_batches SET counts_dirty=false WHERE id=${batchId}::uuid AND counts_dirty`);
  try {
    const counted = await countBatch(batchId);
    const result = await db.execute(sql`UPDATE outreach_batches SET counts=${JSON.stringify(counted.counts)}::jsonb,
        follow_up_counts=${JSON.stringify(counted.followUps)}::jsonb,next_attempt_at=${counted.nextAttemptAt}::timestamptz,
        last_activity_at=${counted.lastActivityAt}::timestamptz,counts_at=now()
      WHERE id=${batchId}::uuid RETURNING *`);
    return (result.rows[0] as Record<string, unknown>) ?? null;
  } catch (error) {
    await db.execute(sql`UPDATE outreach_batches SET counts_dirty=true WHERE id=${batchId}::uuid`).catch(() => undefined);
    throw error;
  }
}

/** How old a dirty count may be before a page recounts it itself instead of waiting for the background job. */
export const COUNTS_FRESH_SECONDS = 15;
const REFRESH_BATCH_SIZE = 100;

/**
 * The background pass, every few seconds: recount outreaches whose messages
 * changed, and mark launches whose process died as interrupted. Several
 * workers can run it at once; each claims different outreaches.
 */
export async function refreshOutreachBatchCounts(): Promise<{ recounted: number; failed: number; interrupted: number }> {
  const stale = await db.execute(sql`UPDATE outreach_batches SET status='interrupted',updated_at=now(),counts_dirty=true
    WHERE status='admitting' AND updated_at<now()-make_interval(mins=>${ADMISSION_STALE_MINUTES}) RETURNING id`);
  const claimed = await db.execute(sql`UPDATE outreach_batches SET counts_dirty=false WHERE id IN(
      SELECT id FROM outreach_batches WHERE counts_dirty ORDER BY counts_at NULLS FIRST LIMIT ${REFRESH_BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id`);
  let recounted = 0, failed = 0;
  for (const { id } of claimed.rows as Array<{ id: string }>) {
    try { await recountOutreachBatch(String(id)); recounted += 1; } catch { failed += 1; }
  }
  return { recounted, failed, interrupted: stale.rows.length };
}

const storedCounts = (value: unknown): BatchCounts | null =>
  value && typeof value === 'object' ? { ...emptyBatchCounts(), ...(value as Partial<BatchCounts>) } : null;

export async function getOutreachBatchSummary(userId: number, id: unknown): Promise<OutreachBatchSummary> {
  let { row } = await loadBatch(userId, id);
  const countedAt = row.counts_at ? new Date(row.counts_at as string).getTime() : 0;
  // Stored counts are used as they are unless they are known to be behind and the background job is late.
  if (!row.counts || (row.counts_dirty && Date.now() - countedAt > COUNTS_FRESH_SECONDS * 1000)) {
    row = (await recountOutreachBatch(String(row.id))) ?? row;
  }
  const reasons = row.skipped_reasons && typeof row.skipped_reasons === 'object' ? row.skipped_reasons as Record<string, unknown> : {};
  return {
    batch: toBatch(row), counts: storedCounts(row.counts) ?? emptyBatchCounts(),
    followUps: storedCounts(row.follow_up_counts) ?? emptyBatchCounts(),
    skippedReasons: Object.entries(reasons).map(([reason, count]) => ({ reason, count: Number(count) || 0 }))
      .sort((a, b) => b.count - a.count),
    nextAttemptAt: iso(row.next_attempt_at), lastActivityAt: iso(row.last_activity_at),
    checkedAt: iso(row.counts_at) ?? new Date().toISOString(),
  };
}

/** The address a person recognises for the channel: phone number, email address or handle. */
const recipientAddress = sql`(CASE WHEN c.channel IN('email','gmail','resend') THEN c.lead_email
  WHEN c.channel='instagram' THEN COALESCE(NULLIF(c.lead_instagram,''),c.external_thread_id)
  ELSE c.external_thread_id END)`;

interface RecipientQuery { status: RecipientFilter; kind: 'outreach' | 'follow_up' | 'all'; q?: string; cursor?: number }

/** One keyset page of recipients, ordered by message id. Returns one extra row when more follow. */
async function selectRecipients(userId: number, business: number, batchId: string, query: RecipientQuery, limit: number): Promise<OutreachRecipient[]> {
  const inner: SQL[] = [
    sql`m.batch_id=${batchId}::uuid`, sql`m.user_id=${userId}`, sql`m.business_profile_id=${business}`,
    sql`m.direction='outbound'`, kindPredicate(query.kind),
  ];
  if (query.cursor) inner.push(sql`m.id>${query.cursor}`);
  if (query.q) {
    const digits = query.q.replace(/[^0-9]/g, '');
    const text = likeText(query.q.replace(/^@/, ''));
    // Every address a person might type: name, email, Instagram handle or the saved number or thread.
    const anyField = sql`c.lead_name ILIKE ${text} OR c.lead_email ILIKE ${text} OR c.lead_instagram ILIKE ${text} OR c.external_thread_id ILIKE ${text}`;
    // A number search matches anywhere in the saved number, so a local number finds its international form.
    if (digits.length >= 3 && /^[+\d\s().-]+$/.test(query.q)) inner.push(sql`(c.external_thread_id LIKE ${`%${digits}%`} OR ${anyField})`);
    else inner.push(sql`(${anyField})`);
  }
  const states = query.status === 'all' ? null : recipientFilterStates[query.status];
  // The raw statuses each filter can come from, so the (batch, kind, status) index narrows the rows before the state is worked out.
  const prefilter = query.status === 'all' ? null : recipientRawStatuses[query.status];
  if (prefilter) inner.push(sql`m.status IN(${sql.join(prefilter.map(status => sql`${status}`), sql`,`)})`);
  const result = await db.execute(sql`SELECT * FROM (
      SELECT m.id,m.conversation_id,c.lead_id,c.lead_name,${recipientAddress} AS recipient,${deliveryState} AS state,
        ${utc(sql`m.sent_at`)} AS sent_at,${utc(sql`m.delivered_at`)} AS delivered_at,${utc(sql`m.read_at`)} AS read_at,
        ${utc(sql`m.failed_at`)} AS failed_at,${nextAttemptAt} AS next_at,NULLIF(m.error_message,'') AS reason,
        m.metadata->'outreachQueue'->>'providerCode' AS provider_code
      FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
        AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      WHERE ${sql.join(inner, sql` AND `)}
    ) recipients
    ${states ? sql`WHERE state IN(${sql.join(states.map(state => sql`${state}`), sql`,`)})` : sql``}
    ORDER BY id LIMIT ${limit + 1}`);
  return (result.rows as Record<string, unknown>[]).map(row => ({
    messageId: Number(row.id), conversationId: Number(row.conversation_id), leadId: row.lead_id ? Number(row.lead_id) : null,
    name: String(row.lead_name || '').trim() || 'Unknown contact', recipient: row.recipient ? String(row.recipient) : null,
    state: row.state as DeliveryState,
    sentAt: (row.sent_at as string) || null, deliveredAt: (row.delivered_at as string) || null,
    readAt: (row.read_at as string) || null, failedAt: (row.failed_at as string) || null,
    nextAttemptAt: iso(row.next_at), reason: row.reason ? String(row.reason) : null,
    providerCode: row.provider_code ? String(row.provider_code) : null,
  }));
}

export async function listOutreachRecipients(userId: number, id: unknown, input: unknown = {}): Promise<OutreachRecipientPage> {
  const filters = recipientListSchema.parse(input);
  const { business, id: batchId } = await loadBatch(userId, id);
  const rows = await selectRecipients(userId, business, batchId, filters, filters.limit);
  const items = rows.slice(0, filters.limit);
  return { items, nextCursor: rows.length > filters.limit ? items[items.length - 1].messageId : null };
}

const EXPORT_CHUNK = 2000;
const exportColumns = ['Name', 'Sent to', 'Status', 'Sent at', 'Delivered at', 'Read at', 'Failed at', 'Next attempt', 'Reason', 'Provider code'];

/** "2026-11-10 13:35" in the reader's timezone, which spreadsheets sort and parse reliably. */
function localTime(timezone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (value: string | null) => {
    if (!value) return '';
    const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
}

/**
 * Streams every recipient of an outreach as CSV, a chunk at a time, so a very
 * large outreach never has to fit in memory. `write` resolves when the chunk
 * has been flushed and rejects when the reader has gone away.
 */
export interface RecipientExportResult { batchId: string; businessProfileId: number; status: RecipientFilter; kind: string; rows: number }

export async function exportOutreachRecipients(userId: number, id: unknown, input: unknown, write: (chunk: string) => Promise<void>,
  started?: (batch: OutreachBatch) => void, progress?: (result: RecipientExportResult) => void): Promise<RecipientExportResult> {
  const filters = recipientExportSchema.parse(input);
  const { business, row, id: batchId } = await loadBatch(userId, id);
  const result: RecipientExportResult = { batchId, businessProfileId: business, status: filters.status, kind: filters.kind, rows: 0 };
  // The caller sees how far a download got even when the reader leaves partway.
  progress?.(result);
  started?.(toBatch(row));
  const time = localTime(filters.tz);
  // The byte-order mark makes spreadsheet apps read names in any script correctly.
  await write(`\uFEFF${exportColumns.map(crmCsvCell).join(',')}\r\n`);
  let cursor: number | undefined;
  for (;;) {
    const rows = await selectRecipients(userId, business, batchId, { status: filters.status, kind: filters.kind, cursor }, EXPORT_CHUNK);
    const page = rows.slice(0, EXPORT_CHUNK);
    if (!page.length) break;
    await write(page.map(item => [
      item.name, item.recipient, deliveryStateLabels[item.state], time(item.sentAt), time(item.deliveredAt), time(item.readAt),
      time(item.failedAt), ['scheduled', 'waiting', 'waiting_limit'].includes(item.state) ? time(item.nextAttemptAt) : '',
      ['failed', 'expired', 'needs_attention', 'waiting_limit'].includes(item.state) ? item.reason : '', item.providerCode,
    ].map(crmCsvCell).join(',')).join('\r\n') + '\r\n');
    result.rows += page.length;
    if (rows.length <= EXPORT_CHUNK) break;
    cursor = page[page.length - 1].messageId;
  }
  return result;
}

const activityColumns = [
  ['sent', sql`m.sent_at`, sql`TRUE`],
  ['delivered', sql`m.delivered_at`, sql`TRUE`],
  // A read receipt implies delivery. Some arrive without a delivery receipt; those count as delivered when they were read,
  // so Delivered is never lower than Read.
  ['delivered', sql`m.read_at`, sql`m.delivered_at IS NULL`],
  ['read', sql`m.read_at`, sql`TRUE`],
  // A message that failed once and later went through keeps its old failure time; only count the ones still failed or expired.
  ['failed', sql`m.failed_at`, sql`${deliveryState} IN('failed','expired')`],
] as const;

/**
 * Sends from before Message tracking: recorded only in the older sent_messages
 * and outreach_jobs tables. The Reports projection already drops the ones that
 * are also an outreach message, so these rows add only what is missing and the
 * business-wide days agree with Reports. Older rows have no read or failure
 * time: a failure counts on the day it was sent, or created if never sent.
 */
function legacyActivityQuery(userId: number, filters: DailyActivityFilters, lower: SQL, upper: SQL): SQL {
  const report = campaignReportFiltersSchema.parse({ channel: filters.channel, messageKind: filters.kind });
  const columns = [
    ['sent', sql`i.sent_at`, sql`TRUE`],
    ['delivered', sql`i.delivered_at`, sql`TRUE`],
    ['failed', sql`COALESCE(i.sent_at,i.created_at)`, sql`i.state='failed'`],
  ] as const;
  const parts = columns.map(([name, column, extra]) => sql`
    SELECT to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${filters.tz},'YYYY-MM-DD') AS day,${name} AS series
    FROM intents i WHERE i.message_id IS NULL AND ${extra} AND ${column}>=${lower} AND ${column}<${upper}`);
  return sql`WITH ${canonicalOutreachCtes(userId, report)}
    SELECT day,series,COUNT(*)::int AS count FROM (${sql.join(parts, sql` UNION ALL `)}) events GROUP BY day,series`;
}

/**
 * Per-day numbers, each counted on the day it happened in the reader's
 * timezone. With `batchId` it covers one outreach; without, every outbound
 * outreach message in the business, including messages sent before Message
 * tracking existed and older send records that have no outreach message.
 */
export async function getDailyActivity(userId: number, input: unknown, batchId?: unknown): Promise<DailyActivity> {
  const filters = dailyActivitySchema.parse(input);
  const scope: SQL[] = [];
  let business: number;
  if (batchId !== undefined) {
    const batch = await loadBatch(userId, batchId);
    business = batch.business;
    scope.push(sql`m.batch_id=${batch.id}::uuid`);
  } else {
    business = owner(userId);
  }
  scope.push(sql`m.user_id=${userId}`, sql`m.business_profile_id=${business}`, sql`m.direction='outbound'`, kindPredicate(filters.kind));
  if (filters.templateName) scope.push(sql`m.template_name=${filters.templateName}`);
  const channels = filters.channel === 'email' ? ['email', 'gmail', 'resend'] : filters.channel ? [filters.channel] : null;
  const join = channels ? sql`JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
    AND c.business_profile_id=m.business_profile_id AND c.channel IN(${sql.join(channels.map(channel => sql`${channel}`), sql`,`)})` : sql``;
  const where = sql.join(scope, sql` AND `);
  // Stored times are UTC without a zone. The bounds are local midnights turned into UTC, so the time indexes are used.
  const lower = sql`((${filters.from}::date)::timestamp AT TIME ZONE ${filters.tz}) AT TIME ZONE 'UTC'`;
  const upper = sql`((${filters.to}::date + 1)::timestamp AT TIME ZONE ${filters.tz}) AT TIME ZONE 'UTC'`;
  const parts = activityColumns.map(([name, column, extra]) => sql`
    SELECT to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${filters.tz},'YYYY-MM-DD') AS day,${name} AS series
    FROM outreach_messages m ${join} WHERE ${where} AND ${extra} AND ${column}>=${lower} AND ${column}<${upper}`);
  const current = db.execute(sql`SELECT day,series,COUNT(*)::int AS count FROM (${sql.join(parts, sql` UNION ALL `)}) events GROUP BY day,series`);
  // Older send records have no outreach and no template, so they belong only in the business-wide, all-template view.
  const legacy = batchId === undefined && !filters.templateName
    ? executeReportQuery(db, legacyActivityQuery(userId, filters, lower, upper)) : Promise.resolve({ rows: [] });
  const [result, older] = await Promise.all([current, legacy]);

  const byDay = new Map<string, DailyActivityDay>();
  const end = Date.parse(`${filters.to}T00:00:00Z`);
  for (let at = Date.parse(`${filters.from}T00:00:00Z`); at <= end; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    byDay.set(date, { date, sent: 0, delivered: 0, read: 0, failed: 0 });
  }
  const totals = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const row of [...result.rows, ...older.rows] as Record<string, unknown>[]) {
    const day = byDay.get(String(row.day)), series = String(row.series) as keyof typeof totals, count = Number(row.count) || 0;
    if (!day || !(series in totals)) continue;
    day[series] += count;
    totals[series] += count;
  }
  return { timezone: filters.tz, from: filters.from, to: filters.to, days: [...byDay.values()], totals };
}

export async function listOutreachFailures(userId: number, id: unknown, input: unknown = {}): Promise<OutreachFailureReason[]> {
  const filters = failureListSchema.parse(input);
  const { business, id: batchId } = await loadBatch(userId, id);
  // Reasons that differ only by a number or an id (a phone number, a message id, a retry count) are one reason.
  // Each group shows one real example of its wording.
  const result = await db.execute(sql`SELECT provider_code,MIN(reason) AS reason,COUNT(*)::int AS count FROM (
      SELECT ${deliveryState} AS state,m.metadata->'outreachQueue'->>'providerCode' AS provider_code,
        COALESCE(NULLIF(m.error_message,''),'No reason was recorded') AS reason
      FROM outreach_messages m WHERE m.batch_id=${batchId}::uuid AND m.user_id=${userId} AND m.business_profile_id=${business}
        AND m.direction='outbound' AND ${kindPredicate(filters.kind)}
        AND (m.manual_review_required OR m.status NOT IN('sent','delivered','read','pending','sending'))
    ) failures WHERE state IN('failed','expired','needs_attention')
    GROUP BY provider_code,regexp_replace(regexp_replace(left(reason,500),'[0-9A-Za-z_-]*[0-9][0-9A-Za-z_-]{7,}','<id>','g'),'[0-9]+','#','g')
    ORDER BY count DESC,MIN(reason) LIMIT 50`);
  return (result.rows as Record<string, unknown>[]).map(row => ({
    reason: String(row.reason), providerCode: row.provider_code ? String(row.provider_code) : null, count: Number(row.count) || 0,
  }));
}

const channelNames = (channel: string) => channel === 'email' ? ['email', 'gmail', 'resend'] : [channel];
const channelJoin = (channel?: string) => channel ? sql`JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
  AND c.business_profile_id=m.business_profile_id AND c.channel IN(${sql.join(channelNames(channel).map(name => sql`${name}`), sql`,`)})` : sql``;

/**
 * How each template did for the messages sent with it in the range. Delivered
 * and read describe those same messages, whenever the receipt arrived, so the
 * rates are true rates for the template.
 */
export async function getTemplatePerformance(userId: number, input: unknown): Promise<TemplatePerformanceReport> {
  const filters = templatePerformanceSchema.parse(input);
  const business = owner(userId);
  const lower = sql`((${filters.from}::date)::timestamp AT TIME ZONE ${filters.tz}) AT TIME ZONE 'UTC'`;
  const upper = sql`((${filters.to}::date + 1)::timestamp AT TIME ZONE ${filters.tz}) AT TIME ZONE 'UTC'`;
  const scope = sql`m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound'
    AND m.message_kind IN('outreach','follow_up') AND m.template_name IS NOT NULL`;
  const [sent, failed] = await Promise.all([
    db.execute(sql`SELECT m.template_name,m.template_language,COUNT(DISTINCT m.batch_id)::int AS outreaches,COUNT(*)::int AS sent,
        COUNT(*) FILTER(WHERE m.status IN('delivered','read') OR m.delivered_at IS NOT NULL OR m.read_at IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER(WHERE m.status='read' OR m.read_at IS NOT NULL)::int AS read,${utc(sql`MAX(m.sent_at)`)} AS last_sent_at
      FROM outreach_messages m ${channelJoin(filters.channel)}
      WHERE ${scope} AND m.sent_at>=${lower} AND m.sent_at<${upper}
      GROUP BY m.template_name,m.template_language`),
    db.execute(sql`SELECT m.template_name,m.template_language,COUNT(*)::int AS failed
      FROM outreach_messages m ${channelJoin(filters.channel)}
      WHERE ${scope} AND m.status IN('failed','bounced') AND ${deliveryState} IN('failed','expired')
        AND m.failed_at>=${lower} AND m.failed_at<${upper}
      GROUP BY m.template_name,m.template_language`),
  ]);
  const templates = new Map<string, TemplatePerformance>();
  const entry = (row: Record<string, unknown>) => {
    const key = `${row.template_name}\u0000${row.template_language ?? ''}`;
    if (!templates.has(key)) templates.set(key, { templateName: String(row.template_name),
      templateLanguage: row.template_language ? String(row.template_language) : null,
      outreaches: 0, sent: 0, delivered: 0, read: 0, failed: 0, lastSentAt: null });
    return templates.get(key)!;
  };
  for (const row of sent.rows as Record<string, unknown>[]) Object.assign(entry(row), {
    outreaches: Number(row.outreaches) || 0, sent: Number(row.sent) || 0, delivered: Number(row.delivered) || 0,
    read: Number(row.read) || 0, lastSentAt: (row.last_sent_at as string) || null,
  });
  for (const row of failed.rows as Record<string, unknown>[]) entry(row).failed = Number(row.failed) || 0;
  return { timezone: filters.tz, from: filters.from, to: filters.to,
    templates: [...templates.values()].sort((a, b) => b.sent - a.sent || b.failed - a.failed || a.templateName.localeCompare(b.templateName)) };
}

/** The calendar date a moment falls on in a timezone, as YYYY-MM-DD. */
function localDay(at: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * What is waiting to go out, day by day, for one outreach (`batchId`) or the
 * whole business. "Due" is when each message's next attempt falls; the other
 * numbers estimate what the daily limit will really let through.
 *
 * The limit is shared by every outreach on a channel. For one outreach the
 * estimate assumes it has the remaining allowance to itself.
 */
export async function getUpcomingSchedule(userId: number, input: unknown, batchId?: unknown, now = Date.now()): Promise<UpcomingSchedule> {
  const filters = upcomingSchema.parse(input);
  let business: number, batchChannel: string | null = null;
  const scope: SQL[] = [];
  if (batchId !== undefined) {
    const batch = await loadBatch(userId, batchId);
    business = batch.business;
    batchChannel = String(batch.row.channel);
    scope.push(sql`m.batch_id=${batch.id}::uuid`);
  } else business = owner(userId);
  scope.push(sql`m.user_id=${userId}`, sql`m.business_profile_id=${business}`, sql`m.direction='outbound'`,
    sql`m.message_kind IN('outreach','follow_up')`, sql`m.status='pending'`, sql`NOT m.manual_review_required`);

  const today = utcDay(now), localToday = localDay(now, filters.tz);
  const wanted = filters.until ? Math.round((Date.parse(`${filters.until}T00:00:00Z`) - Date.parse(`${localToday}T00:00:00Z`)) / 86_400_000) + 1 : 31;
  const dayCount = Math.min(Math.max(wanted, 1), MAX_UPCOMING_DAYS);

  // The channel comes from the outreach itself when there is one, which avoids a join for every waiting message.
  const channel = batchChannel
    ? sql`${batchChannel}::text`
    : sql`(CASE WHEN c.channel IN('gmail','resend') THEN 'email' ELSE c.channel END)`;
  const join = batchChannel ? sql`` : sql`JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
    AND c.business_profile_id=m.business_profile_id
    ${filters.channel ? sql`AND c.channel IN(${sql.join(channelNames(filters.channel).map(name => sql`${name}`), sql`,`)})` : sql``}`;
  const waiting = await db.execute(sql`SELECT channel,due_day,expires_day,batch_id,COUNT(*)::int AS count FROM (
      SELECT ${channel} AS channel,m.batch_id,
        to_char(GREATEST(COALESCE(${nextAttemptAt},now()),now()) AT TIME ZONE 'UTC','YYYY-MM-DD') AS due_day,
        to_char(m.confirmation_expires_at,'YYYY-MM-DD') AS expires_day
      FROM outreach_messages m ${join} WHERE ${sql.join(scope, sql` AND `)}
    ) waiting GROUP BY channel,due_day,expires_day,batch_id`);
  const rows = waiting.rows as Array<{ channel: string; due_day: string; expires_day: string | null; batch_id: string | null; count: number }>;

  const channels = [...new Set(rows.map(row => row.channel))].sort();
  const limits = await Promise.all(channels.map(async name => {
    const [dailyLimit, used] = await Promise.all([
      getEffectiveDailyLimit(userId, name),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
          AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
        WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound'
          AND c.channel IN(${sql.join(channelNames(name).map(item => sql`${item}`), sql`,`)})
          AND m.sent_at>=date_trunc('day',now() AT TIME ZONE 'UTC')`),
    ]);
    return { channel: name, dailyLimit, usedToday: Number(used.rows[0]?.count) || 0 };
  }));

  const days: UpcomingDay[] = Array.from({ length: dayCount }, (_, index) => ({
    // Each limit day is shown as the local date on which it begins.
    date: localDay(Date.parse(`${addUtcDays(today, index)}T00:00:00Z`), filters.tz), due: 0, expectedToSend: 0, held: 0, willExpire: 0, outreaches: [],
  }));
  let afterRange = 0;
  for (const limit of limits) {
    const groups: WaitingGroup[] = rows.filter(row => row.channel === limit.channel)
      .map(row => ({ dueDay: row.due_day, expiresDay: row.expires_day, count: Number(row.count) || 0 }));
    const projection = projectSends(groups, { today, days: dayCount, dailyLimit: limit.dailyLimit, usedToday: limit.usedToday });
    projection.days.forEach((day, index) => {
      days[index].due += day.due; days[index].expectedToSend += day.expectedToSend;
      days[index].held += day.held; days[index].willExpire += day.willExpire;
    });
    afterRange += projection.afterRange;
  }

  if (batchId === undefined) {
    const perDay = new Map<number, Map<string, number>>();
    for (const row of rows) {
      const index = Math.round((Date.parse(`${row.due_day < today ? today : row.due_day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (!row.batch_id || index < 0 || index >= dayCount) continue;
      const day = perDay.get(index) || new Map<string, number>();
      day.set(row.batch_id, (day.get(row.batch_id) || 0) + (Number(row.count) || 0));
      perDay.set(index, day);
    }
    const top = new Map([...perDay].map(([index, counts]) => [index, [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)] as const));
    const ids = [...new Set([...top.values()].flatMap(list => list.map(([id]) => id)))];
    const names = ids.length ? await db.execute(sql`SELECT id,name FROM outreach_batches
      WHERE id IN(${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) AND user_id=${userId} AND business_profile_id=${business}`) : { rows: [] };
    const nameOf = new Map((names.rows as Array<{ id: string; name: string }>).map(row => [String(row.id), String(row.name)]));
    for (const [index, list] of top) days[index].outreaches = list.filter(([id]) => nameOf.has(id)).map(([id, due]) => ({ batchId: id, name: nameOf.get(id)!, due }));
  }

  return {
    timezone: filters.tz, from: days[0].date, until: days[days.length - 1].date, days, limits,
    limitResetsAt: new Date(nextDailyCapacityTime(now)).toISOString(),
    waiting: rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0), afterRange,
  };
}

/** Renames an outreach. The name is only a label; nothing about delivery depends on it. */
export async function renameOutreachBatch(userId: number, id: unknown, input: unknown): Promise<OutreachBatch> {
  const { name } = batchRenameSchema.parse(input);
  const { business, id: batchId } = await loadBatch(userId, id);
  const result = await db.execute(sql`UPDATE outreach_batches SET name=${name.replace(/\s+/g, ' ')},updated_at=now()
    WHERE id=${batchId}::uuid AND user_id=${userId} AND business_profile_id=${business} RETURNING *`);
  if (!result.rows[0]) throw new OutreachTrackingError('This outreach is not available in this business.', 404);
  return toBatch(result.rows[0] as Record<string, unknown>);
}
