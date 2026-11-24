import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { isValidSocialReportCron as validCron, type FriendlyReportSchedule } from '../../shared/socialReportSchedule.js';
import { isDirectInstagramLogin } from '../utils/instagramOAuthCredential.js';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { channelCredentialsTable, type ChannelCredentialRecord } from '../models/channelCredentials/schema.js';
import { decryptMetaSecret } from '../utils/metaCredentialSecrets.js';
import { getGraphApiBase, getGraphApiVersion } from '../utils/metaApiVersion.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../utils/timezone.js';
import { asRecord } from '../../shared/records.js';
import { isEmailAddress } from '../../shared/emailAddress.js';

type Platform = 'facebook' | 'instagram' | 'youtube';
type JsonRecord = Record<string, unknown>;
type SnapshotRow = Record<string, unknown>;
type SocialQueryExecutor = { execute: (query: SQL) => Promise<unknown> };

const PLATFORMS = new Set<Platform>(['facebook', 'instagram', 'youtube']);
const SNAPSHOT_SOURCES = new Set(['official_api', 'manual_import', 'provider_export']);
const LISTENING_SOURCES = new Set(['official_api', 'public_export']);
const SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'mixed', 'unknown']);
const CANONICAL_METRICS = new Set([
  'impressions', 'reach', 'engagements', 'views', 'likes', 'comments', 'replies', 'reposts', 'quotes', 'shares',
  'clicks', 'watch_time_seconds', 'average_view_duration_seconds', 'followers', 'subscribers_gained', 'subscribers_lost',
]);
const METRIC_ALIASES: Record<string, keyof CanonicalMetrics> = {
  impressions: 'impressions', page_impressions: 'impressions', reach: 'reach',
  engagements: 'engagements', engagement: 'engagements', total_interactions: 'engagements',
  page_post_engagements: 'engagements', accounts_engaged: 'engagements',
  views: 'views', video_views: 'views', page_video_views: 'views', page_media_view: 'views', page_total_media_view_unique: 'reach', likes: 'likes',
  comments: 'comments', shares: 'shares', clicks: 'clicks', profile_links_taps: 'clicks',
  replies: 'replies', reposts: 'reposts', quotes: 'quotes',
  estimatedMinutesWatched: 'watch_time_seconds', estimated_minutes_watched: 'watch_time_seconds', watch_time_seconds: 'watch_time_seconds',
  averageViewDuration: 'average_view_duration_seconds', average_view_duration: 'average_view_duration_seconds', average_view_duration_seconds: 'average_view_duration_seconds',
  followers: 'followers', subscribersGained: 'subscribers_gained', subscribers_gained: 'subscribers_gained',
  subscribersLost: 'subscribers_lost', subscribers_lost: 'subscribers_lost',
};

type CanonicalMetrics = Partial<Record<
  'impressions' | 'reach' | 'engagements' | 'views' | 'likes' | 'comments' | 'replies' | 'reposts' | 'quotes' | 'shares' |
  'clicks' | 'watch_time_seconds' | 'average_view_duration_seconds' | 'followers' | 'subscribers_gained' | 'subscribers_lost', number
>>;

const ownerId = (req: Request): number | undefined => businessOwnerUserId(req);
const validReportId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const resultRows = (result: unknown): SnapshotRow[] => (result as { rows?: SnapshotRow[] })?.rows || [];

export function isValidIanaTimeZone(timezone: unknown): timezone is string {
  // Some ICU builds accept ambiguous aliases such as "IST". Persist only UTC
  // or a region-style IANA identifier so recommendations remain portable.
  if (typeof timezone !== 'string' || timezone.length > 80 || (timezone !== 'UTC' && !timezone.includes('/'))) return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); return true; } catch { return false; }
}

function validPlatform(value: unknown): value is Platform { return typeof value === 'string' && PLATFORMS.has(value as Platform); }
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validDate(value: unknown): value is string { return typeof value === 'string' && isValidIsoDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)); }
function positiveCredentialId(value: unknown): value is number { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }

export function normalizeSocialMetrics(input: unknown): CanonicalMetrics | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const normalized: CanonicalMetrics = {};
  for (const [key, value] of Object.entries(input as JsonRecord)) {
    const canonical = METRIC_ALIASES[key];
    if (!canonical || !CANONICAL_METRICS.has(canonical)) continue;
    if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) continue;
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) return null;
    // YouTube's estimatedMinutesWatched is minutes; preserve a single seconds
    // unit in normalized data. Average duration is already a seconds metric.
    const normalizedValue = key === 'estimatedMinutesWatched' || key === 'estimated_minutes_watched' ? numberValue * 60 : numberValue;
    normalized[canonical] = (normalized[canonical] || 0) + normalizedValue;
  }
  return Object.keys(normalized).length ? normalized : null;
}

export function extractMetaTotalMetrics(input: unknown): CanonicalMetrics | null {
  const payload = asRecord(input);
  const metrics: JsonRecord = {};
  for (const item of Array.isArray(payload.data) ? payload.data : []) {
    const row = asRecord(item);
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name) continue;
    const totalValue = asRecord(row.total_value).value;
    const values = Array.isArray(row.values) ? row.values : [];
    const value = totalValue ?? values.reduce((sum, sample) => sum + (Number(asRecord(sample).value) || 0), 0);
    if (Number.isFinite(Number(value))) metrics[name] = Number(value);
  }
  return normalizeSocialMetrics(metrics);
}

export function extractMetaDailyMetrics(input: unknown): Map<string, CanonicalMetrics> {
  const payload = asRecord(input);
  const byDay = new Map<string, JsonRecord>();
  for (const item of Array.isArray(payload.data) ? payload.data : []) {
    const metric = asRecord(item); const name = typeof metric.name === 'string' ? metric.name : '';
    for (const sample of Array.isArray(metric.values) ? metric.values : []) {
      const value = asRecord(sample); const timestamp = typeof value.end_time === 'string' ? value.end_time : '';
      if (!name || !timestamp) continue;
      const boundary = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
      if (!Number.isFinite(boundary.getTime())) continue;
      boundary.setUTCDate(boundary.getUTCDate() - 1);
      const day = boundary.toISOString().slice(0, 10); const metrics = byDay.get(day) || {}; metrics[name] = value.value; byDay.set(day, metrics);
    }
  }
  return new Map([...byDay.entries()].flatMap(([day, metrics]) => {
    const normalized = normalizeSocialMetrics(metrics);
    return normalized ? [[day, normalized] as const] : [];
  }));
}

export function createSourceSnapshotId(input: { platform: Platform; accountIdentifier: string; windowStart: Date; windowEnd: Date; source: string; metrics: CanonicalMetrics; sourceSnapshotId?: unknown }): string {
  if (typeof input.sourceSnapshotId === 'string' && input.sourceSnapshotId.trim()) {
    const key = input.sourceSnapshotId.trim();
    if (input.source !== 'official_api') return key.slice(0, 255);
    const metrics = Object.fromEntries(Object.entries(input.metrics).sort(([a], [b]) => a.localeCompare(b)));
    const revision = crypto.createHash('sha256').update(JSON.stringify(metrics)).digest('hex');
    return `${key.slice(0, 140)}:v:${revision}`;
  }
  // A deterministic, non-secret source key makes manually imported snapshots
  // idempotent too. The raw provider payload is deliberately never persisted.
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({ ...input, metrics: input.metrics })).digest('hex')}`;
}

async function hasOwnedAnalyticsAccount(userId: number, platform: Platform, accountIdentifier: string): Promise<boolean> {
  const credentialPlatforms = platform === 'facebook' ? ['facebook_api', 'facebook_page'] : platform === 'instagram' ? ['instagram_api'] : ['youtube'];
  const candidates = await db.select({ id: channelCredentialsTable.id }).from(channelCredentialsTable).where(and(
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.accountIdentifier, accountIdentifier),
    eq(channelCredentialsTable.isActive, true),
  )).limit(20);
  if (!candidates.length) return false;
  // Platform is checked in SQL-compatible code rather than trusting an account
  // identifier supplied by a browser. This keeps an imported tenant snapshot
  // bound to an account which the tenant owns.
  const full: Array<Pick<ChannelCredentialRecord, 'platform'>> = await db.select({ platform: channelCredentialsTable.platform }).from(channelCredentialsTable).where(and(
    eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.accountIdentifier, accountIdentifier), eq(channelCredentialsTable.isActive, true),
  )).limit(20);
  return full.some(row => credentialPlatforms.includes(row.platform));
}

async function insertSnapshot(input: {
  userId: number; platform: Platform; accountIdentifier: string; windowStart: Date; windowEnd: Date;
  source: string; sourceSnapshotId?: unknown; metrics: CanonicalMetrics; timezone: string; dimensions?: JsonRecord;
}): Promise<{ snapshot: SnapshotRow | null; duplicate: boolean }> {
  let sourceSnapshotId = createSourceSnapshotId(input);
  if (input.source === 'official_api' && typeof input.sourceSnapshotId === 'string') {
    const sourceKey = input.sourceSnapshotId.trim().slice(0, 140);
    const previous = resultRows(await db.execute(sql`
      SELECT * FROM social_metric_snapshots WHERE user_id = ${input.userId} AND platform = ${input.platform}
        AND account_identifier = ${input.accountIdentifier} AND metric_window_start = ${input.windowStart}
        AND metric_window_end = ${input.windowEnd} AND source = 'official_api'
        AND (source_snapshot_id = ${sourceKey} OR starts_with(source_snapshot_id, ${`${sourceKey}:v:`}))
      ORDER BY captured_at DESC, id DESC LIMIT 1
    `))[0];
    if (previous && createSourceSnapshotId({ ...input, metrics: normalizeSocialMetrics(previous.metrics) || {} }) === sourceSnapshotId) {
      return { snapshot: previous, duplicate: true };
    }
    // A -> B -> A is a new correction too; content hashes alone would retain B.
    sourceSnapshotId += `:r:${crypto.randomUUID()}`;
  }
  const result = await db.execute(sql`INSERT INTO social_metric_snapshots
    (user_id, platform, account_identifier, metric_window_start, metric_window_end, source, source_snapshot_id, metrics, dimensions, timezone)
    VALUES (${input.userId}, ${input.platform}, ${input.accountIdentifier}, ${input.windowStart}, ${input.windowEnd}, ${input.source}, ${sourceSnapshotId}, ${JSON.stringify(input.metrics)}::jsonb, ${JSON.stringify(input.dimensions || {})}::jsonb, ${input.timezone})
    ON CONFLICT (business_profile_id, user_id, platform, account_identifier, metric_window_start, metric_window_end, source, source_snapshot_id) DO NOTHING
    RETURNING *`);
  const rows = resultRows(result);
  return { snapshot: rows[0] || null, duplicate: !rows.length };
}

function parseSnapshotInput(body: JsonRecord): { platform: Platform; accountIdentifier: string; windowStart: Date; windowEnd: Date; metrics: CanonicalMetrics; source: string; timezone: string; sourceSnapshotId?: unknown } | null {
  const platform = body.platform;
  const accountIdentifier = typeof body.accountIdentifier === 'string' ? body.accountIdentifier.trim() : '';
  const timezone = body.timezone ?? DEFAULT_BUSINESS_TIMEZONE;
  const source = body.source;
  if (!validPlatform(platform) || !accountIdentifier || accountIdentifier.length > 255 || !validDate(body.windowStart) || !validDate(body.windowEnd) || !SNAPSHOT_SOURCES.has(String(source)) || !isValidIanaTimeZone(timezone)) return null;
  const windowStart = new Date(body.windowStart); const windowEnd = new Date(body.windowEnd);
  if (windowStart >= windowEnd || windowEnd.getTime() > Date.now() + 5 * 60_000 || windowEnd.getTime() - windowStart.getTime() > 366 * 86_400_000) return null;
  const metrics = normalizeSocialMetrics(body.metrics);
  if (!metrics) return null;
  return { platform, accountIdentifier, windowStart, windowEnd, metrics, source: String(source), timezone, sourceSnapshotId: body.sourceSnapshotId };
}

/** Ingests canonical metrics only. Raw provider payloads and credentials never enter this table. */
export async function ingestSocialSnapshot(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const input = parseSnapshotInput(asRecord(req.body));
  if (!input) return res.status(400).json({ error: 'A known platform, owned account, valid closed time window, canonical numeric metrics, source, and IANA timezone are required.' });
  if (!await hasOwnedAnalyticsAccount(userId, input.platform, input.accountIdentifier)) return res.status(403).json({ error: 'The account is not an active account in this workspace.' });
  const inserted = await insertSnapshot({ userId, ...input });
  return res.status(inserted.duplicate ? 200 : 201).json(inserted);
}

function snapshotFilter(req: Request): { platform?: Platform; accountIdentifier?: string; start?: Date; end?: Date } | null {
  if (['start', 'end'].some(key => req.query[key] !== undefined && (typeof req.query[key] !== 'string' || !validDate(req.query[key])))) return null;
  const platform = req.query.platform;
  const accountIdentifier = typeof req.query.accountIdentifier === 'string' ? req.query.accountIdentifier.trim() : undefined;
  const start = typeof req.query.start === 'string' && validDate(req.query.start) ? new Date(req.query.start) : undefined;
  const end = typeof req.query.end === 'string' && validDate(req.query.end) ? new Date(req.query.end) : undefined;
  if (platform !== undefined && !validPlatform(platform)) return null;
  if ((start && end) && start >= end) return null;
  return { platform: platform as Platform | undefined, accountIdentifier, start, end };
}

async function snapshotsFor(userId: number, filter: { platform?: Platform; accountIdentifier?: string; start?: Date; end?: Date }, limit = 200, database:SocialQueryExecutor=db): Promise<SnapshotRow[]> {
  const predicates = [sql`user_id = ${userId}`];
  if (filter.platform) predicates.push(sql`platform = ${filter.platform}`);
  if (filter.accountIdentifier) predicates.push(sql`account_identifier = ${filter.accountIdentifier}`);
  if (filter.start) predicates.push(sql`metric_window_start >= ${filter.start}`);
  if (filter.end) predicates.push(sql`metric_window_end <= ${filter.end}`);
  return resultRows(await database.execute(sql`SELECT * FROM social_metric_snapshots WHERE ${sql.join(predicates, sql` AND `)} ORDER BY metric_window_end DESC, captured_at DESC, id DESC LIMIT ${limit}`));
}

export function immediatelyPreviousPeriod(start: Date, end: Date): { start: Date; end: Date } | null {
  const duration = end.getTime() - start.getTime();
  return duration > 0 ? { start: new Date(start.getTime() - duration), end: new Date(start) } : null;
}

export async function listSocialSnapshots(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const filter = snapshotFilter(req); if (!filter) return res.status(400).json({ error: 'Invalid analytics filter.' });
  return res.json(await snapshotsFor(userId, filter));
}

function localSlot(date: Date, timezone: string): { dayOfWeek: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const day = parts.find(part => part.type === 'weekday')?.value || 'Sun';
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  return { dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day), hour };
}

const engagementSignal = (metrics: CanonicalMetrics): number => metrics.engagements ?? ((metrics.likes || 0) + (metrics.comments || 0) + (metrics.replies || 0) + (metrics.reposts || 0) + (metrics.quotes || 0) + (metrics.shares || 0));

/** Lifetime post outcomes are descriptive: older posts have had longer to accumulate engagement. */
export function rankPublishingSlots(source: SnapshotRow[], timezone: string) {
  const observed = source.flatMap(row => {
    const metrics = normalizeSocialMetrics(row.metrics);
    const date = new Date(String(row.published_at));
    const measured = metrics && ['engagements', 'likes', 'comments', 'shares', 'replies'].some(key => Object.prototype.hasOwnProperty.call(metrics, key));
    return measured && Number.isFinite(date.getTime()) ? [{ id: row.provider_id, date, metrics: metrics! }] : [];
  });
  const slots = new Map<string, { total: number; reach: number; rateTotal: number; rateCount: number; count: number }>();
  for (const item of observed) {
    const local = localSlot(item.date, timezone); const key = `${local.dayOfWeek}-${local.hour}`;
    const slot = slots.get(key) || { total: 0, reach: 0, rateTotal: 0, rateCount: 0, count: 0 };
    const engagement = engagementSignal(item.metrics); slot.total += engagement; slot.count++;
    if ((item.metrics.reach || 0) > 0) { slot.reach += item.metrics.reach!; slot.rateTotal += engagement / item.metrics.reach! * 100; slot.rateCount++; }
    slots.set(key, slot);
  }
  const sampleSize = observed.length; const fallbackUsed = sampleSize < 8 || slots.size < 3;
  // Never mix engagement counts and percentages when ranking different slots.
  const useRates = observed.length > 0 && observed.every(item => (item.metrics.reach || 0) > 0);
  const score = (slot: { total: number; count: number; rateTotal: number; rateCount: number }) => useRates ? slot.rateTotal / slot.rateCount : slot.total / slot.count;
  const recommendedSlots = fallbackUsed ? [] : [...slots.entries()].sort((a,b) => score(b[1])-score(a[1])).slice(0,3).map(([key,slot]) => {
    const [dayOfWeek,hour] = key.split('-').map(Number);
    return { dayOfWeek, hour, averageEngagement: Number((slot.total/slot.count).toFixed(2)), averageEngagementRate: useRates ? Number(score(slot).toFixed(2)) : null, observations: slot.count };
  });
  const confidence = Number((fallbackUsed ? Math.min(.25,sampleSize/32) : Math.min(.9,sampleSize/40*Math.min(1,slots.size/6))).toFixed(4));
  const methodology = `${fallbackUsed ? 'Insufficient evidence: at least 8 measured posts across 3 weekday/hour slots required.' : `Publication weekday/hour ranked by average ${useRates ? 'engagement per reached account' : 'measured engagements'}.`} Last 180 days, excluding posts less than 24 hours old. Lifetime outcomes are descriptive; post age, format and topic can influence results. This does not establish a causal best time.`;
  return { observed, sampleSize, fallbackUsed, recommendedSlots, confidence, methodology };
}

export async function computeBestTimes(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const body = asRecord(req.body); const { platform, accountIdentifier, timezone = DEFAULT_BUSINESS_TIMEZONE } = body;
  if (!validPlatform(platform) || typeof accountIdentifier !== 'string' || !accountIdentifier.trim() || !isValidIanaTimeZone(timezone)) return res.status(400).json({ error: 'platform, active accountIdentifier, and IANA timezone are required.' });
  if (!await hasOwnedAnalyticsAccount(userId, platform, accountIdentifier.trim())) return res.status(403).json({ error: 'The account is not an active account in this workspace.' });
  const source = resultRows(await db.execute(sql`SELECT DISTINCT ON (content.provider_id) content.* FROM social_content_items content
    JOIN channel_credentials credential ON credential.id=content.credential_id
    WHERE content.user_id=${userId} AND credential.user_id=${userId} AND credential.is_active=TRUE
      AND content.platform=${platform} AND credential.account_identifier=${accountIdentifier.trim()}
      AND content.published_at >= NOW() - INTERVAL '180 days' AND content.published_at <= NOW() - INTERVAL '1 day'
    ORDER BY content.provider_id,content.metrics_updated_at DESC NULLS LAST LIMIT 10000`));
  const { observed, sampleSize, fallbackUsed, recommendedSlots, confidence, methodology } = rankPublishingSlots(source, timezone);
  const result = await db.execute(sql`INSERT INTO social_best_time_recommendations
    (user_id, platform, account_identifier, timezone, sample_size, confidence, fallback_used, methodology, recommended_slots, source_snapshot_ids)
    VALUES (${userId}, ${platform}, ${accountIdentifier.trim()}, ${timezone}, ${sampleSize}, ${confidence}, ${fallbackUsed}, ${methodology}, ${JSON.stringify(recommendedSlots)}::jsonb, ${JSON.stringify(observed.map(item => item.id))}::jsonb) RETURNING *`);
  return res.status(201).json(resultRows(result)[0]);
}

export async function listBestTimes(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const platform = req.query.platform; const accountIdentifier = req.query.accountIdentifier;
  if (platform !== undefined && !validPlatform(platform)) return res.status(400).json({ error: 'Unknown platform.' });
  const predicates = [sql`user_id = ${userId}`];
  if (platform) predicates.push(sql`platform = ${platform}`);
  if (typeof accountIdentifier === 'string' && accountIdentifier) predicates.push(sql`account_identifier = ${accountIdentifier}`);
  return res.json(resultRows(await db.execute(sql`SELECT * FROM social_best_time_recommendations WHERE ${sql.join(predicates, sql` AND `)} ORDER BY computed_at DESC LIMIT 100`)));
}

export async function ingestListeningEvent(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const body = asRecord(req.body); const platform = body.platform; const eventId = typeof body.providerEventId === 'string' ? body.providerEventId.trim() : '';
  const credentialId = Number(body.credentialId);
  const text = typeof body.body === 'string' ? body.body.trim() : ''; const occurredAt = body.occurredAt;
  const publicUrl = typeof body.publicUrl === 'string' ? body.publicUrl.trim() : undefined;
  const sentimentScore = body.sentimentScore === undefined ? null : Number(body.sentimentScore);
  if (!validPlatform(platform) || !positiveCredentialId(credentialId) || !eventId || eventId.length > 255 || !text || text.length > 20_000 || !validDate(occurredAt) || !LISTENING_SOURCES.has(String(body.source)) || !SENTIMENTS.has(String(body.sentiment ?? 'unknown')) || (sentimentScore !== null && (!Number.isFinite(sentimentScore) || sentimentScore < -1 || sentimentScore > 1))) return res.status(400).json({ error: 'An owned account and valid public-source listening event fields are required.' });
  if (publicUrl && !/^https:\/\//i.test(publicUrl)) return res.status(400).json({ error: 'publicUrl must use HTTPS.' });
  const expectedPlatforms = platform === 'facebook' ? ['facebook_api','facebook_page'] : platform === 'instagram' ? ['instagram_api'] : ['youtube'];
  const credential = (await db.select().from(channelCredentialsTable).where(and(eq(channelCredentialsTable.id,credentialId),eq(channelCredentialsTable.userId,userId),eq(channelCredentialsTable.isActive,true))).limit(1))[0];
  if (!credential?.accountIdentifier || !expectedPlatforms.includes(credential.platform)) return res.status(404).json({ error: 'The selected social account is not active in this workspace.' });
  const metadata = { ...asRecord(body.metadata), collection: 'manual', credentialId, accountIdentifier: credential.accountIdentifier };
  const postId = asRecord(body.metadata).contentId;
  if (postId !== undefined) {
    if (typeof postId !== 'string' || !/^[\d_]+$/.test(postId)) return res.status(400).json({error:'Invalid post ID.'});
    const ownedPost = resultRows(await db.execute(sql`SELECT provider_id FROM social_content_items WHERE user_id=${userId} AND credential_id=${credentialId} AND provider_id=${postId} LIMIT 1`))[0];
    if (!ownedPost) return res.status(404).json({error:'Post not found in the selected account.'});
  }
  if (JSON.stringify(metadata).length > 16_000) return res.status(400).json({ error: 'metadata is too large.' });
  const result = await db.execute(sql`INSERT INTO social_listening_events
    (user_id, platform, provider_event_id, public_url, author_handle, body, occurred_at, sentiment, sentiment_score, metadata, source)
    VALUES (${userId}, ${platform}, ${eventId}, ${publicUrl || null}, ${typeof body.authorHandle === 'string' ? body.authorHandle.slice(0, 255) : null}, ${text}, ${new Date(occurredAt)}, ${String(body.sentiment ?? 'unknown')}, ${sentimentScore}, ${JSON.stringify(metadata)}::jsonb, ${String(body.source)})
    ON CONFLICT (business_profile_id, user_id, platform, provider_event_id) DO NOTHING RETURNING *`);
  const rows = resultRows(result); return res.status(rows.length ? 201 : 200).json({ event: rows[0] || null, duplicate: !rows.length });
}

export async function listListeningEvents(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const platform = req.query.platform;
  const credentialId = req.query.credentialId === undefined ? undefined : Number(req.query.credentialId);
  const sentiment = typeof req.query.sentiment === 'string' ? req.query.sentiment : undefined;
  const start = typeof req.query.start === 'string' && validDate(req.query.start) ? new Date(req.query.start) : undefined;
  const end = typeof req.query.end === 'string' && validDate(req.query.end) ? new Date(req.query.end) : undefined;
  if (platform !== undefined && !validPlatform(platform)) return res.status(400).json({ error: 'Unknown platform.' });
  if (credentialId !== undefined && !positiveCredentialId(credentialId)) return res.status(400).json({ error: 'Invalid listening account.' });
  if (sentiment && !SENTIMENTS.has(sentiment)) return res.status(400).json({ error: 'Unknown sentiment.' });
  if ((req.query.start !== undefined && !start) || (req.query.end !== undefined && !end) || (start && end && start >= end)) return res.status(400).json({ error: 'Invalid listening date range.' });
  const predicates = [sql`user_id=${userId}`];
  if (platform) predicates.push(sql`platform=${platform}`);
  if (credentialId !== undefined) {
    if (!platform) return res.status(400).json({ error: 'A platform is required with the listening account.' });
    const expectedPlatforms = platform === 'facebook' ? ['facebook_api','facebook_page'] : platform === 'instagram' ? ['instagram_api'] : ['youtube'];
    const credential = (await db.select().from(channelCredentialsTable).where(and(eq(channelCredentialsTable.id,credentialId),eq(channelCredentialsTable.userId,userId),eq(channelCredentialsTable.isActive,true))).limit(1))[0];
    if (!credential || !expectedPlatforms.includes(credential.platform)) return res.status(404).json({ error: 'The selected social account is not active in this workspace.' });
    predicates.push(sql`metadata->>'credentialId'=${String(credentialId)}`);
  }
  if (sentiment) predicates.push(sql`sentiment=${sentiment}`);
  if (start) predicates.push(sql`occurred_at >= ${start}`);
  if (end) predicates.push(sql`occurred_at <= ${end}`);
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0,200) : '';
  if (search) predicates.push(sql`(body ILIKE ${`%${search.replace(/[\\%_]/g, '\\$&')}%`} OR author_handle ILIKE ${`%${search.replace(/[\\%_]/g, '\\$&')}%`})`);
  // Owned comment review and live-thread actions share one workflow. Manual
  // notes and tagged posts retain their independent evidence review status.
  const reviewStatus = sql`COALESCE((SELECT CASE WHEN workflow.status='open' THEN 'new' ELSE workflow.status END
    FROM social_comment_workflows workflow WHERE social_listening_events.source='official_api'
      AND social_listening_events.metadata->>'collection'='owned_post_comments'
      AND workflow.user_id=social_listening_events.user_id
      AND workflow.credential_id::text=social_listening_events.metadata->>'credentialId'
      AND workflow.post_id=social_listening_events.metadata->>'contentId'
      AND workflow.comment_id=social_listening_events.provider_event_id LIMIT 1),metadata->>'reviewStatus','new')`;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !['new','reviewed','follow_up','escalated','resolved'].includes(status)) return res.status(400).json({ error: 'Unknown review status.' });
  if (status) predicates.push(sql`${reviewStatus}=${status}`);
  const kind = typeof req.query.kind === 'string' ? req.query.kind : 'comments';
  if (!['all','comments','tags','manual'].includes(kind)) return res.status(400).json({error:'Unknown listening source.'});
  const postId = typeof req.query.postId === 'string' ? req.query.postId : undefined;
  if (postId !== undefined && (!/^[\d_]+$/.test(postId) || !credentialId)) return res.status(400).json({error:'A valid post ID and account are required.'});
  if (postId) predicates.push(sql`metadata->>'contentId'=${postId} AND COALESCE(metadata->>'collection','manual') <> 'account_tagged_content'`);
  const sourceKind = sql`CASE WHEN metadata->>'collection'='owned_post_comments' THEN 'comments' WHEN metadata->>'collection'='account_tagged_content' THEN 'tags' ELSE 'manual' END`;
  const sourcePredicates = [...predicates];
  if (kind !== 'all') predicates.push(sql`${sourceKind}=${kind}`);
  // Only an owned captured post may provide a detail link. Tagged content is
  // external and must not accidentally link to another account's post.
  const eventFields = sql`events.*, (COALESCE(events.metadata,'{}'::jsonb) || jsonb_build_object('reviewStatus',events.review_status)) AS metadata, (CASE WHEN events.metadata->>'collection'='owned_post_comments' THEN 'comments' WHEN events.metadata->>'collection'='account_tagged_content' THEN 'tags' ELSE 'manual' END) AS kind,
    (SELECT jsonb_build_object('id',content.provider_id,'caption',content.caption,'type',content.content_type,'thumbnailUrl',content.thumbnail_url,'permalink',content.permalink)
      FROM social_content_items content WHERE content.user_id=${userId} AND content.credential_id::text=events.metadata->>'credentialId'
      AND content.provider_id=events.metadata->>'contentId' AND COALESCE(events.metadata->>'collection','manual') <> 'account_tagged_content' LIMIT 1) AS post`;
  if (req.query.paginated !== '1') return res.json(resultRows(await db.execute(sql`SELECT ${eventFields} FROM (SELECT social_listening_events.*, ${reviewStatus} AS review_status FROM social_listening_events WHERE ${sql.join(predicates, sql` AND `)}) events ORDER BY occurred_at DESC, id DESC LIMIT 200`)));
  const limit = Math.min(100,Math.max(1,Number(req.query.limit)||50)); const offset = Math.max(0,Number(req.query.offset)||0);
  if (!Number.isInteger(limit) || !Number.isSafeInteger(offset)) return res.status(400).json({error:'Invalid pagination.'});
  // One connection for the three reads instead of one pooled connection each.
  const [items, counts, sources] = await db.transaction(async (tx: typeof db) => [
    await tx.execute(sql`SELECT ${eventFields} FROM (SELECT social_listening_events.*, ${reviewStatus} AS review_status FROM social_listening_events WHERE ${sql.join(predicates, sql` AND `)}) events ORDER BY occurred_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`),
    await tx.execute(sql`SELECT sentiment, COUNT(*)::int AS count FROM social_listening_events WHERE ${sql.join(predicates, sql` AND `)} GROUP BY sentiment`),
    await tx.execute(sql`SELECT ${sourceKind} AS kind, COUNT(*)::int AS count FROM social_listening_events WHERE ${sql.join(sourcePredicates, sql` AND `)} GROUP BY ${sourceKind}`),
  ]);
  const summary = Object.fromEntries(resultRows(counts).map(row=>[String(row.sentiment),Number(row.count)]));
  const sourceSummary = {comments:0,tags:0,manual:0,...Object.fromEntries(resultRows(sources).map(row=>[String(row.kind),Number(row.count)]))};
  const total = Object.values(summary).reduce((sum,count)=>sum+count,0);
  return res.json({items:resultRows(items),total,nextOffset:offset+limit<total?offset+limit:null,summary,sourceSummary});
}

export async function createSocialCompetitor(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const body = asRecord(req.body); const platform = body.platform; const publicHandle = typeof body.publicHandle === 'string' ? body.publicHandle.trim().replace(/^@/, '') : '';
  const publicUrl = typeof body.publicUrl === 'string' ? body.publicUrl.trim() : '';
  if (!validPlatform(platform) || !publicHandle || publicHandle.length > 255 || !validSocialProfileUrl(platform, publicUrl)) return res.status(400).json({ error: 'A platform, public handle, and HTTPS public URL are required.' });
  const result = await db.execute(sql`INSERT INTO social_competitors (user_id, platform, public_handle, display_name, public_url)
    VALUES (${userId}, ${platform}, ${publicHandle}, ${typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 255) : null}, ${publicUrl})
    ON CONFLICT (business_profile_id, user_id, platform, public_handle) DO UPDATE SET display_name=EXCLUDED.display_name, is_active=TRUE
    WHERE social_competitors.public_url=EXCLUDED.public_url
    RETURNING *`);
  const saved=resultRows(result)[0];
  return saved ? res.status(201).json(saved) : res.status(409).json({code:'SOCIAL_COMPETITOR_IDENTITY_CONFLICT',error:'This handle is already saved with a different profile URL. Edit its uncaptured profile or create a different competitor; existing evidence was preserved.'});
}

export async function listSocialCompetitors(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const platform = req.query.platform; if (platform !== undefined && !validPlatform(platform)) return res.status(400).json({ error: 'Unknown platform.' });
  const predicate = platform ? sql`competitor.user_id=${userId} AND competitor.platform=${platform}` : sql`competitor.user_id=${userId}`;
  return res.json(resultRows(await db.execute(sql`SELECT competitor.*, (
    SELECT jsonb_build_object('id',snapshot.id,'metrics',snapshot.metrics,'capturedAt',snapshot.captured_at,'source',snapshot.source,'sourceUrl',snapshot.source_url)
    FROM social_competitor_snapshots snapshot WHERE snapshot.competitor_id=competitor.id AND snapshot.user_id=${userId}
    ORDER BY snapshot.captured_at DESC,snapshot.id DESC LIMIT 1
  ) AS latest_public_snapshot FROM social_competitors competitor WHERE ${predicate} ORDER BY competitor.is_active DESC,competitor.created_at DESC`)));

}

export async function ingestCompetitorSnapshot(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const competitorId = typeof req.params.id === 'string' ? req.params.id : ''; const body = asRecord(req.body);
  const source = String(body.source); const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
  const metrics = normalizeSocialMetrics(body.metrics);
  const capturedAt = body.capturedAt === undefined ? new Date() : new Date(String(body.capturedAt));
  const metricWindowStart = body.metricWindowStart === undefined ? null : new Date(String(body.metricWindowStart));
  const metricWindowEnd = body.metricWindowEnd === undefined ? null : new Date(String(body.metricWindowEnd));
  const invalidWindow = Boolean(metricWindowStart) !== Boolean(metricWindowEnd) || (metricWindowStart && Number.isNaN(metricWindowStart.getTime())) || (metricWindowEnd && Number.isNaN(metricWindowEnd.getTime())) || Boolean(metricWindowStart && metricWindowEnd && metricWindowStart >= metricWindowEnd);
  if (!competitorId || !['official_api', 'public_export'].includes(source) || !/^https:\/\//i.test(sourceUrl) || !metrics || Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > Date.now() + 5 * 60_000 || invalidWindow) return res.status(400).json({ error: 'A supported source, HTTPS sourceUrl, canonical metrics, valid capture time, and ordered reporting window are required.' });
  const sourceSnapshotId = typeof body.sourceSnapshotId === 'string' && body.sourceSnapshotId.trim()
    ? body.sourceSnapshotId.trim().slice(0, 255)
    : `sha256:${crypto.createHash('sha256').update(JSON.stringify({ competitorId, source, sourceUrl, metrics, capturedAt: capturedAt.toISOString() })).digest('hex')}`;
  const result = await db.transaction(async(tx:SocialQueryExecutor)=>{
    const owned=resultRows(await tx.execute(sql`SELECT id FROM social_competitors WHERE id=${competitorId} AND user_id=${userId} FOR UPDATE`))[0];
    if(!owned) return null;
    return tx.execute(sql`INSERT INTO social_competitor_snapshots (competitor_id, user_id, captured_at, source, source_snapshot_id, metrics, source_url, metric_window_start, metric_window_end)
      VALUES (${competitorId}, ${userId}, ${capturedAt}, ${source}, ${sourceSnapshotId}, ${JSON.stringify(metrics)}::jsonb, ${sourceUrl}, ${metricWindowStart}, ${metricWindowEnd})
      ON CONFLICT (competitor_id, source, source_snapshot_id) DO NOTHING RETURNING *`);
  });
  if(!result) return res.status(404).json({error:'Competitor not found.'});
  const inserted = resultRows(result); return res.status(inserted.length ? 201 : 200).json({ snapshot: inserted[0] || null, duplicate: !inserted.length });
}

export async function listCompetitorSnapshots(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const competitorId = String(req.params.id || '');
  return res.json(resultRows(await db.execute(sql`SELECT snapshot.* FROM social_competitor_snapshots snapshot JOIN social_competitors competitor ON competitor.id=snapshot.competitor_id WHERE snapshot.user_id=${userId} AND competitor.user_id=${userId} AND snapshot.competitor_id=${competitorId} ORDER BY snapshot.captured_at DESC LIMIT 200`)));
}

type BenchmarkMetric = { metric: string; workspace: number; competitor: number; delta: number; percentDelta: number | null };

/** Only compares the intersection of normalized metrics; it never invents a benchmark. */
export function compareCompetitorMetrics(workspaceInput: unknown, competitorInput: unknown): BenchmarkMetric[] {
  const workspace = normalizeSocialMetrics(workspaceInput) || {}; const competitor = normalizeSocialMetrics(competitorInput) || {};
  return Object.keys(workspace).filter((metric): metric is keyof CanonicalMetrics => Object.prototype.hasOwnProperty.call(competitor, metric)).map(metric => {
    const own = workspace[metric] || 0; const peer = competitor[metric] || 0;
    return { metric, workspace: own, competitor: peer, delta: own - peer, percentDelta: peer === 0 ? null : Number((((own - peer) / peer) * 100).toFixed(2)) };
  });
}

/** A sum over a partial history cannot be compared with a complete-period total. */
export function metricsWithCompleteCoverage(snapshots: SnapshotRow[], start: Date, end: Date, totals: CanonicalMetrics): CanonicalMetrics {
  const comparable: CanonicalMetrics = {};
  for (const [metric,value] of Object.entries(totals) as Array<[keyof CanonicalMetrics,number]>) {
    const evidence = snapshots.filter(row => Object.prototype.hasOwnProperty.call(asRecord(row.metrics),metric));
    if (metric==='followers') {
      if (evidence.some(row => new Date(String(row.metric_window_end)).toISOString().slice(0,10)===end.toISOString().slice(0,10))) comparable[metric]=value;
      continue;
    }
    const windows=evidence.map(row=>({start:new Date(String(row.metric_window_start)).getTime(),end:new Date(String(row.metric_window_end)).getTime()})).sort((a,b)=>a.start-b.start);
    let coveredUntil=start.getTime()-1;
    for(const window of windows){if(window.start>coveredUntil+1)break;coveredUntil=Math.max(coveredUntil,window.end);}
    if(coveredUntil>=end.getTime())comparable[metric]=value;
  }
  return comparable;
}

export async function getCompetitorBenchmark(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const competitorId = String(req.params.id || '');
  const competitor = resultRows(await db.execute(sql`SELECT * FROM social_competitors WHERE id=${competitorId} AND user_id=${userId} AND is_active=TRUE LIMIT 1`))[0];
  if (!competitor) return res.status(404).json({ error: 'Competitor not found.' });
  const accountIdentifier = typeof req.query.accountIdentifier === 'string' ? req.query.accountIdentifier.trim() : undefined;
  const start = typeof req.query.start === 'string' && validDate(req.query.start) ? new Date(req.query.start) : undefined;
  const end = typeof req.query.end === 'string' && validDate(req.query.end) ? new Date(req.query.end) : undefined;
  if ((req.query.start !== undefined && !start) || (req.query.end !== undefined && !end) || (start && end && start >= end)) return res.status(400).json({ error: 'Invalid benchmark date range.' });
  if (!start || !end || !accountIdentifier) return res.json({benchmark:null,reason:'Select one account and an exact reporting period to compare equivalent evidence.',citations:[]});
  const competitorPredicates=[sql`competitor_id=${competitorId}`,sql`user_id=${userId}`];
  if(start&&end)competitorPredicates.push(sql`metric_window_start=${start} AND metric_window_end=${end}`);
  const competitorSnapshot = resultRows(await db.execute(sql`SELECT * FROM social_competitor_snapshots WHERE ${sql.join(competitorPredicates,sql` AND `)} ORDER BY captured_at DESC, id DESC LIMIT 1`))[0];
  if (!competitorSnapshot) return res.json({ benchmark: null, reason: start && end ? 'No competitor evidence matches the selected reporting period. Add cited metrics for this exact window.' : 'No public or official competitor snapshot has been captured yet.', citations: [] });
  const workspace = selectCurrentSocialSnapshots(await snapshotsFor(userId, { platform: competitor.platform as Platform, accountIdentifier, start, end }, 10000));
  if (!workspace.length) return res.json({ benchmark: null, reason: 'No first-party workspace snapshot exists for this platform and reporting period.', citations: [{ competitorSnapshotId: competitorSnapshot.id, source: competitorSnapshot.source, sourceUrl: competitorSnapshot.source_url, capturedAt: competitorSnapshot.captured_at }] });
  const workspaceMetrics=aggregateSocialSnapshots(workspace).totals;
  const comparableWorkspace = metricsWithCompleteCoverage(workspace, start, end, workspaceMetrics);
  const metrics = compareCompetitorMetrics(comparableWorkspace, competitorSnapshot.metrics);
  const workspaceCitations=workspace.map(snapshot=>({workspaceSnapshotId:snapshot.id,windowStart:snapshot.metric_window_start,windowEnd:snapshot.metric_window_end,source:snapshot.source,sourceSnapshotId:snapshot.source_snapshot_id}));
  if (!metrics.length) return res.json({ benchmark: null, reason: 'The evidence does not have comparable metrics covering the complete reporting period. Import the missing days or select a fully covered window.', citations: [...workspaceCitations, { competitorSnapshotId: competitorSnapshot.id, source: competitorSnapshot.source, sourceUrl: competitorSnapshot.source_url, capturedAt: competitorSnapshot.captured_at }] });
  return res.json({ benchmark: { competitor: { id: competitor.id, platform: competitor.platform, handle: competitor.public_handle }, workspaceSnapshotId: workspace[0].id, workspaceSnapshotIds:workspace.map(snapshot=>snapshot.id), competitorSnapshotId: competitorSnapshot.id, metrics, comparability: `Matched reporting period using ${workspace.length} current first-party snapshot${workspace.length===1?'':'s'} and one cited competitor snapshot. This is an observed comparison, not a causal claim.` }, citations: [...workspaceCitations, { competitorSnapshotId: competitorSnapshot.id, windowStart:competitorSnapshot.metric_window_start, windowEnd:competitorSnapshot.metric_window_end, source: competitorSnapshot.source, sourceUrl: competitorSnapshot.source_url, capturedAt: competitorSnapshot.captured_at, sourceSnapshotId: competitorSnapshot.source_snapshot_id }] });
}

function recommendationCitations(snapshots: SnapshotRow[]) {
  return snapshots.map(snapshot => ({ snapshotId: snapshot.id, platform: snapshot.platform, accountIdentifier: snapshot.account_identifier, windowStart: snapshot.metric_window_start, windowEnd: snapshot.metric_window_end, source: snapshot.source, sourceSnapshotId: snapshot.source_snapshot_id, timezone: snapshot.timezone }));
}

function groundedRecommendation(snapshots: SnapshotRow[]) {
  if (snapshots.length < 3) return { recommendation: null, reason: 'At least three immutable metric snapshots are required before a performance recommendation can be generated.', citations: recommendationCitations(snapshots) };
  const ranked = new Map<string, { platform: string; accountIdentifier: string; engagement: number; snapshots: SnapshotRow[] }>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.platform}:${snapshot.account_identifier}`; const value = ranked.get(key) || { platform: String(snapshot.platform), accountIdentifier: String(snapshot.account_identifier), engagement: 0, snapshots: [] };
    value.engagement += engagementSignal(normalizeSocialMetrics(snapshot.metrics) || {}); value.snapshots.push(snapshot); ranked.set(key, value);
  }
  const leader = [...ranked.values()].sort((a, b) => b.engagement - a.engagement)[0];
  if (!leader || leader.engagement <= 0) return { recommendation: null, reason: 'Snapshots do not yet contain a positive engagement signal, so no performance claim was generated.', citations: recommendationCitations(snapshots) };
  return { recommendation: `Prioritize ${leader.platform}/${leader.accountIdentifier}: its captured engagement signal is ${Math.round(leader.engagement)} across ${leader.snapshots.length} cited snapshots. Re-measure after the next publishing cycle before scaling.`, confidence: Number(Math.min(0.9, leader.snapshots.length / 20).toFixed(2)), citations: recommendationCitations(leader.snapshots) };
}

/** An AI-facing contract: claims stay empty until enough cited first-party measurements exist. */
export async function getGroundedSocialRecommendation(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const snapshots = selectCurrentSocialSnapshots(await snapshotsFor(userId, {}, 10000));
  return res.json(groundedRecommendation(snapshots));
}

/** Select corrections per metric, preserving complementary metrics and distinct videos.
 * Daily evidence takes precedence over overlapping legacy whole-window totals.
 */
export function selectCurrentSocialSnapshots(input: SnapshotRow[]): SnapshotRow[] {
  const windows = new Map<string, Array<{ start: number; end: number; entity: string }>>();
  const duration = (row: SnapshotRow) => new Date(String(row.metric_window_end)).getTime() - new Date(String(row.metric_window_start)).getTime();
  const rows = [...input].sort((a, b) => duration(a) - duration(b)
    || new Date(String(b.captured_at || 0)).getTime() - new Date(String(a.captured_at || 0)).getTime());
  return rows.flatMap<SnapshotRow>(row => {
    const start = new Date(String(row.metric_window_start)).getTime();
    const end = new Date(String(row.metric_window_end)).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    // YouTube emits one row per video/day. Other providers emit account metrics.
    const sourceKey = String(row.source_snapshot_id || '');
    const entity = row.platform === 'youtube' && sourceKey.startsWith('youtube:') ? sourceKey.split(':')[2] : '__channel__';
    const metrics: CanonicalMetrics = {};
    for (const [metric, value] of Object.entries(normalizeSocialMetrics(row.metrics) || {})) {
      const key = `${row.platform}:${row.account_identifier}:${metric}`;
      const accepted = windows.get(key) || [];
      if (accepted.some(window => (entity === '__channel__' || window.entity === '__channel__' || window.entity === entity) && start <= window.end && end >= window.start)) continue;
      accepted.push({ start, end, entity }); windows.set(key, accepted);
      metrics[metric as keyof CanonicalMetrics] = value;
    }
    return Object.keys(metrics).length ? [{ ...row, metrics }] : [];
  }).sort((a, b) => new Date(String(b.metric_window_end)).getTime() - new Date(String(a.metric_window_end)).getTime());
}

export function aggregateSocialSnapshots(snapshots: SnapshotRow[]) {
  const totals: CanonicalMetrics = {};
  const trend = new Map<string, CanonicalMetrics>();
  const followerAccounts = new Set<string>();
  let durationWeighted = 0;
  let durationViews = 0;
  const ordered = [...snapshots].sort((a, b) => new Date(String(b.metric_window_end)).getTime() - new Date(String(a.metric_window_end)).getTime());
  for (const snapshot of ordered) {
    const metrics = normalizeSocialMetrics(snapshot.metrics) || {};
    const date = new Date(String(snapshot.metric_window_start)).toISOString().slice(0, 10);
    const point = trend.get(date) || {};
    for (const [metric, value] of Object.entries(metrics) as Array<[keyof CanonicalMetrics, number]>) {
      if (metric === 'followers') {
        const account = `${snapshot.platform}:${snapshot.account_identifier}`;
        if (!followerAccounts.has(account)) totals.followers = (totals.followers || 0) + value;
        followerAccounts.add(account);
        point.followers = value;
      } else if (metric === 'average_view_duration_seconds') {
        durationWeighted += value * (metrics.views || 0);
        durationViews += metrics.views || 0;
      } else {
        totals[metric] = (totals[metric] || 0) + value;
        // A whole-window total must not masquerade as a spike on its first day.
        if (new Date(String(snapshot.metric_window_end)).getTime() - new Date(String(snapshot.metric_window_start)).getTime() <= 86_400_000) {
          point[metric] = (point[metric] || 0) + value;
        }
      }
    }
    if (Object.keys(point).length) trend.set(date, point);
  }
  if (durationViews > 0) totals.average_view_duration_seconds = durationWeighted / durationViews;
  return { totals, trend: new Map([...trend].sort(([a], [b]) => a.localeCompare(b))) };
}

/** Analytics-first view model. Raw evidence remains available through the snapshot endpoint. */
export async function getSocialAnalyticsDashboard(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const filter = snapshotFilter(req); if (!filter) return res.status(400).json({ error: 'Invalid analytics filter.' });
  const rawSnapshots = await snapshotsFor(userId, filter, 10000);
  const snapshots = selectCurrentSocialSnapshots(rawSnapshots);
  const { totals, trend } = aggregateSocialSnapshots(snapshots);
  const engagement = engagementSignal(totals);
  const denominator = totals.reach || totals.impressions || 0;
  let previousPeriod: { start: string; end: string; summary: CanonicalMetrics & { engagement_rate: number } } | null = null;
  if (filter.start && filter.end) {
    const previousWindow = immediatelyPreviousPeriod(filter.start, filter.end);
    if (previousWindow) {
      const previousSnapshots = selectCurrentSocialSnapshots(await snapshotsFor(userId, {
        platform: filter.platform,
        accountIdentifier: filter.accountIdentifier,
        start: previousWindow.start,
        end: previousWindow.end,
      }, 10000));
      const previousTotals = aggregateSocialSnapshots(previousSnapshots).totals;
      const previousDenominator = previousTotals.reach || previousTotals.impressions || 0;
      previousPeriod = {
        start: previousWindow.start.toISOString(),
        end: previousWindow.end.toISOString(),
        summary: { ...previousTotals, engagement_rate: previousDenominator > 0 ? Number(((engagementSignal(previousTotals) / previousDenominator) * 100).toFixed(2)) : 0 },
      };
    }
  }
  const predicates = [sql`user_id=${userId}`];
  if (filter.platform) predicates.push(sql`platform=${filter.platform}`);
  if (filter.accountIdentifier) predicates.push(sql`account_identifier=${filter.accountIdentifier}`);
  const bestTime = resultRows(await db.execute(sql`SELECT * FROM social_best_time_recommendations WHERE ${sql.join(predicates, sql` AND `)} ORDER BY computed_at DESC LIMIT 1`))[0] || null;
  const latest = snapshots[0];
  const sync = filter.accountIdentifier ? resultRows(await db.execute(sql`
    SELECT state.status, state.last_attempt_at, state.last_succeeded_at, state.next_due_at, state.error_code
    FROM performance_sync_state state
    JOIN channel_credentials credential ON credential.user_id = state.user_id AND credential.id::text = state.resource_key
    WHERE state.user_id = ${userId} AND state.kind = 'social'
      AND credential.account_identifier = ${filter.accountIdentifier} AND credential.is_active = TRUE
      AND credential.platform = ${filter.platform === 'facebook' ? 'facebook_api' : filter.platform === 'youtube' ? 'youtube' : `${filter.platform}_api`}
    ORDER BY state.last_attempt_at DESC LIMIT 1
  `))[0] || null : null;
  return res.json({
    sync,
    summary: { ...totals, engagement_rate: denominator > 0 ? Number(((engagement / denominator) * 100).toFixed(2)) : 0 },
    trends: [...trend.entries()].map(([date, metrics]) => ({ date, ...metrics, engagements: engagementSignal(metrics) })),
    recommendation: groundedRecommendation(snapshots),
    bestTime,
    previousPeriod,
    freshness: { truncated: rawSnapshots.length === 10000, rawSnapshotCount: rawSnapshots.length, latestSnapshotAt: latest?.metric_window_end || null, snapshotCount: snapshots.length, evidenceSourceCount: new Set(snapshots.map(snapshot => `${snapshot.source}:${snapshot.source_snapshot_id}`)).size },
  });
}

function validReportFilters(value: unknown): JsonRecord | null {
  const filters = asRecord(value); const platform = filters.platform; const accountIdentifier = filters.accountIdentifier;
  if (platform !== undefined && !validPlatform(platform)) return null;
  if (accountIdentifier !== undefined && (typeof accountIdentifier !== 'string' || accountIdentifier.length > 255)) return null;
  if (filters.start !== undefined && !validDate(filters.start)) return null;
  if (filters.end !== undefined && !validDate(filters.end)) return null;
  if (accountIdentifier && !platform) return null;
  if (filters.start && filters.end) { const start=new Date(String(filters.start)); const end=new Date(String(filters.end)); if(start>=end || end.getTime()-start.getTime()>366*86_400_000)return null; }
  if (filters.relativeDays !== undefined && (!Number.isInteger(filters.relativeDays) || Number(filters.relativeDays)<1 || Number(filters.relativeDays)>366 || filters.start !== undefined || filters.end !== undefined)) return null;
  if (filters.timezone !== undefined && !isValidIanaTimeZone(filters.timezone)) return null;
  return filters;
}

function parseFriendlyReportSchedule(value: unknown): FriendlyReportSchedule | null {
  const schedule = asRecord(value);
  const frequency = schedule.frequency;
  const localTime = schedule.localTime;
  const timezone = schedule.timezone;
  if (!['daily', 'weekly', 'monthly'].includes(String(frequency)) || typeof localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime) || !isValidIanaTimeZone(timezone)) return null;
  const dayOfWeek = schedule.dayOfWeek === undefined ? undefined : Number(schedule.dayOfWeek);
  const dayOfMonth = schedule.dayOfMonth === undefined ? undefined : Number(schedule.dayOfMonth);
  if (frequency === 'weekly' && (!Number.isInteger(dayOfWeek) || Number(dayOfWeek) < 0 || Number(dayOfWeek) > 6)) return null;
  if (frequency === 'monthly' && (!Number.isInteger(dayOfMonth) || Number(dayOfMonth) < 1 || Number(dayOfMonth) > 28)) return null;
  return { frequency: frequency as FriendlyReportSchedule['frequency'], localTime, timezone, ...(dayOfWeek === undefined ? {} : { dayOfWeek }), ...(dayOfMonth === undefined ? {} : { dayOfMonth }) };
}

export async function createSavedSocialReport(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const body = asRecord(req.body); const name = typeof body.name === 'string' ? body.name.trim() : ''; const filters = validReportFilters(body.filters ?? {});
  const scheduleCron = body.scheduleCron === undefined || body.scheduleCron === null || body.scheduleCron === '' ? null : body.scheduleCron;
  const scheduleDefinition = body.schedule === undefined || body.schedule === null ? null : parseFriendlyReportSchedule(body.schedule);
  const deliveryChannel = body.deliveryChannel === undefined || body.deliveryChannel === null || body.deliveryChannel === '' ? null : body.deliveryChannel;
  const deliveryTarget = body.deliveryTarget === undefined || body.deliveryTarget === null || body.deliveryTarget === '' ? null : body.deliveryTarget;
  if (!name || name.length > 160 || !filters || (scheduleCron !== null && !validCron(scheduleCron)) || (body.schedule !== undefined && body.schedule !== null && !scheduleDefinition) || (scheduleCron && scheduleDefinition) || (deliveryChannel && !['in_app', 'email'].includes(String(deliveryChannel))) || (deliveryChannel === 'email' && (typeof deliveryTarget !== 'string' || !isEmailAddress(deliveryTarget)))) return res.status(400).json({ error: 'Invalid report name, filters, schedule, or delivery target.' });
  if(filters.platform&&filters.accountIdentifier&&!await hasOwnedAnalyticsAccount(userId,filters.platform as Platform,String(filters.accountIdentifier)))return res.status(403).json({error:'The report account is not active in this workspace.'});
  if (body.paused !== undefined && typeof body.paused !== 'boolean') return res.status(400).json({error:'Invalid report pause state.'});
  if ((scheduleCron || scheduleDefinition) && !deliveryChannel) return res.status(400).json({error:'Choose a delivery channel for scheduled reports.'});
  if (filters.relativeDays && filters.timezone === undefined) filters.timezone = scheduleDefinition?.timezone || 'UTC';
  if ((scheduleCron || scheduleDefinition) && !filters.relativeDays) return res.status(400).json({error:'Scheduled reports require a rolling relativeDays window.'});
  const result = await db.execute(sql`INSERT INTO social_saved_reports (user_id, name, filters, schedule_cron, schedule_definition, schedule_timezone, delivery_channel, delivery_target, paused)
    VALUES (${userId}, ${name}, ${JSON.stringify(filters)}::jsonb, ${scheduleCron}, ${scheduleDefinition ? JSON.stringify(scheduleDefinition) : null}::jsonb, ${scheduleDefinition?.timezone || null}, ${deliveryChannel}, ${deliveryTarget}, ${body.paused === true})
    ON CONFLICT(business_profile_id, user_id,name) DO NOTHING RETURNING *`);
  const saved = resultRows(result)[0];
  return saved ? res.status(201).json(saved) : res.status(409).json({error:'A report with this name already exists. Choose another name or edit that report.'});
}

export async function listSavedSocialReports(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  return res.json(resultRows(await db.execute(sql`SELECT * FROM social_saved_reports WHERE user_id=${userId} ORDER BY updated_at DESC`)));
}

export async function listSocialReportDeliveries(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const reportId = String(req.params.id || '');
  if (!validReportId(reportId)) return res.status(400).json({ error: 'Invalid report ID.' });
  const owned = resultRows(await db.execute(sql`SELECT id FROM social_saved_reports WHERE id=${reportId} AND user_id=${userId} LIMIT 1`))[0];
  if (!owned) return res.status(404).json({ error: 'Report not found.' });
  return res.json(resultRows(await db.execute(sql`SELECT delivery.id,delivery.delivery_key,delivery.status,delivery.attempted_at,delivery.error_code,delivery.error_message,delivery.export_id,
    delivery.preparation_version,delivery.dispatch_started_at,delivery.generation_attempts,export.created_at AS exported_at
    FROM social_report_deliveries delivery LEFT JOIN social_report_exports export ON export.id=delivery.export_id AND export.user_id=${userId}
    WHERE delivery.user_id=${userId} AND delivery.report_id=${reportId} ORDER BY delivery.attempted_at DESC LIMIT 100`)));
}

export function reportFilterFromDefinition(filters: JsonRecord, now = new Date()): { platform?: Platform; accountIdentifier?: string; start?: Date; end?: Date } {
  let start = validDate(filters.start) ? new Date(filters.start) : undefined;
  let end = validDate(filters.end) ? new Date(filters.end) : undefined;
  if (Number.isInteger(filters.relativeDays) && Number(filters.relativeDays)>0 && Number(filters.relativeDays)<=366) {
    const timezone = isValidIanaTimeZone(filters.timezone) ? filters.timezone : 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const part = (key: string) => parts.find(item=>item.type===key)!.value;
    // Provider evidence is bucketed by UTC calendar date. Timezone determines
    // which calendar date is complete at execution; also exclude the current
    // UTC provider day so a zone ahead of UTC cannot include partial data.
    const localCalendarDay = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00.000Z`);
    const utcCalendarDay = new Date(`${now.toISOString().slice(0,10)}T00:00:00.000Z`);
    const today = new Date(Math.min(localCalendarDay.getTime(),utcCalendarDay.getTime()));
    end = new Date(today.getTime()-1); start = new Date(today.getTime()-Number(filters.relativeDays)*86_400_000);
  }
  return { platform: validPlatform(filters.platform) ? filters.platform : undefined, accountIdentifier: typeof filters.accountIdentifier === 'string' ? filters.accountIdentifier : undefined, start, end };
}

export async function buildReportExport(userId: number, report: SnapshotRow, format: 'json' | 'csv', now = new Date(), database:SocialQueryExecutor=db) {
  const resolvedWindow = reportFilterFromDefinition(asRecord(report.filters), now);
  const rawSnapshots = await snapshotsFor(userId, resolvedWindow, 10000, database);
  const snapshots = selectCurrentSocialSnapshots(rawSnapshots);
  const generatedAt = now.toISOString();
  const citations = recommendationCitations(snapshots);
  // Spreadsheet applications evaluate cells beginning with formula sigils.
  // Report evidence is provider-derived, so preserve it as literal text when
  // users open a CSV in Excel/Sheets rather than allowing formula execution.
  const csvEscape = (value: unknown) => {
    const text = String(value ?? '');
    const literal = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${literal.replaceAll('"', '""')}"`;
  };
  const csv = format === 'csv'
    ? [
        ['snapshot_id', 'platform', 'account_identifier', 'window_start', 'window_end', 'source', 'source_snapshot_id', 'metrics_json'].join(','),
        ...snapshots.map(snapshot => [snapshot.id, snapshot.platform, snapshot.account_identifier, snapshot.metric_window_start, snapshot.metric_window_end, snapshot.source, snapshot.source_snapshot_id, JSON.stringify(snapshot.metrics)].map(csvEscape).join(',')),
      ].join('\n')
    : null;
  const payload = { generatedAt, reportId: report.id, filters: report.filters, resolvedWindow, metricDateTimezone:'UTC', citations, snapshots, truncated:rawSnapshots.length===10000, ...(csv ? { contentType: 'text/csv', csv } : {}) };
  const result = await database.execute(sql`INSERT INTO social_report_exports (report_id, user_id, format, snapshot_ids, payload)
    VALUES (${report.id}, ${userId}, ${format}, ${JSON.stringify(snapshots.map(snapshot => snapshot.id))}::jsonb, ${JSON.stringify(payload)}::jsonb) RETURNING *`);
  return resultRows(result)[0];
}

export async function exportSavedSocialReport(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const reportId = String(req.params.id || '');
  if (!validReportId(reportId)) return res.status(400).json({ error: 'Invalid report ID.' });
  const report = resultRows(await db.execute(sql`SELECT * FROM social_saved_reports WHERE id=${reportId} AND user_id=${userId} LIMIT 1`))[0];
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  const format = req.body?.format === 'csv' ? 'csv' : 'json'; return res.status(201).json(await buildReportExport(userId, report, format));
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some(raw => {
    const [base, stepText] = raw.split('/'); const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    if (base === '*') return (value - min) % step === 0;
    const range = base.split('-').map(Number);
    if (range.some(item => !Number.isInteger(item))) return false;
    const start = range[0]; const end = range[1] ?? start;
    return start >= min && end <= max && value >= start && value <= end && (value - start) % step === 0;
  });
}

/** Supports the validated five-field cron subset accepted by createSavedSocialReport. */
export function scheduledReportIsDue(scheduleCron: string, date: Date): boolean {
  const parts = scheduleCron.trim().split(/\s+/); if (parts.length !== 5) return false;
  return cronFieldMatches(parts[0], date.getUTCMinutes(), 0, 59)
    && cronFieldMatches(parts[1], date.getUTCHours(), 0, 23)
    && cronFieldMatches(parts[2], date.getUTCDate(), 1, 31)
    && cronFieldMatches(parts[3], date.getUTCMonth() + 1, 1, 12)
    && cronFieldMatches(parts[4], date.getUTCDay(), 0, 6);
}

export function scheduledReportDefinitionIsDue(scheduleInput: unknown, date: Date): boolean {
  const schedule = parseFriendlyReportSchedule(scheduleInput); if (!schedule) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const localTime = `${part('hour') || '00'}:${part('minute') || '00'}`;
  if (localTime !== schedule.localTime) return false;
  if (schedule.frequency === 'weekly') return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday') || '') === schedule.dayOfWeek;
  if (schedule.frequency === 'monthly') return Number(part('day')) === schedule.dayOfMonth;
  return true;
}

function friendlyScheduleDeliveryKey(scheduleInput: unknown, date: Date): string {
  const schedule = parseFriendlyReportSchedule(scheduleInput); if (!schedule) return `cron:${date.toISOString()}`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '00';
  return `schedule:${schedule.timezone}:${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

type SocialReportRunResult={processed:number;sent:number;failed:number;skipped:number};
export class SocialReportPreparationError extends Error {
  readonly code='SOCIAL_REPORT_PREPARATION_FAILED';
  constructor(readonly result:SocialReportRunResult,cause?:unknown) {
    super('One or more report exports could not be prepared. Delivery was not started for those occurrences.',{cause});
    this.name='SocialReportPreparationError';
  }
}

/** Preparation is atomic; the dispatch marker commits before provider calls.
 * Only a version-1 failure known to precede dispatch may be retried. No leases,
 * historical replay, new retry cadence, or missed-run/DST policy are introduced. */
export async function processDueSocialReports(now = new Date()): Promise<{ processed: number; sent: number; failed: number; skipped: number }> {
  const minuteStart = new Date(now); minuteStart.setUTCSeconds(0, 0);
  const reports = resultRows(await db.execute(sql`SELECT * FROM social_saved_reports WHERE (schedule_cron IS NOT NULL OR schedule_definition IS NOT NULL) AND delivery_channel IS NOT NULL AND paused=FALSE`));
  let processed = 0; let sent = 0; let failed = 0; let skipped = 0; let preparationFailures=0; let preparationCause:unknown;
  for (const report of reports) {
    const due = report.schedule_definition ? scheduledReportDefinitionIsDue(report.schedule_definition, minuteStart) : scheduledReportIsDue(String(report.schedule_cron), minuteStart);
    if (!due) { skipped += 1; continue; }
    const deliveryKey = report.schedule_definition ? friendlyScheduleDeliveryKey(report.schedule_definition, minuteStart) : `cron:${minuteStart.toISOString()}`;
    let prepared:{reservation:SnapshotRow;exported:SnapshotRow}|null;
    try {
      prepared=await db.transaction(async(tx:SocialQueryExecutor)=>{
        // Serialize replicas with the report and reject a stale scanned config.
        const current=resultRows(await tx.execute(sql`SELECT * FROM social_saved_reports
          WHERE id=${report.id} AND user_id=${report.user_id} AND paused=FALSE
            AND name=${report.name} AND filters=${JSON.stringify(asRecord(report.filters))}::jsonb
            AND schedule_cron IS NOT DISTINCT FROM ${report.schedule_cron ?? null}
            AND schedule_definition IS NOT DISTINCT FROM ${report.schedule_definition ? JSON.stringify(report.schedule_definition) : null}::jsonb
            AND delivery_channel IS NOT DISTINCT FROM ${report.delivery_channel ?? null}
            AND delivery_target IS NOT DISTINCT FROM ${report.delivery_target ?? null}
          FOR UPDATE SKIP LOCKED`))[0];
        if(!current) return null;
        const previous=resultRows(await tx.execute(sql`SELECT * FROM social_report_deliveries WHERE report_id=${report.id}
          AND user_id=${report.user_id} AND delivery_key=${deliveryKey} FOR UPDATE`))[0];
        if(previous && (Number(previous.preparation_version)!==1 || previous.dispatch_started_at || previous.export_id
          || !['pending','failed'].includes(String(previous.status)))) return null;
        const reservation=previous
          ? resultRows(await tx.execute(sql`UPDATE social_report_deliveries SET status='pending',attempted_at=${now},
              generation_attempts=generation_attempts+1,error_code=NULL,error_message=NULL WHERE id=${previous.id} RETURNING id`))[0]
          : resultRows(await tx.execute(sql`INSERT INTO social_report_deliveries(report_id,user_id,delivery_key,status,attempted_at,preparation_version,generation_attempts)
              VALUES(${report.id},${report.user_id},${deliveryKey},'pending',${now},1,1)
              ON CONFLICT(report_id,delivery_key) DO NOTHING RETURNING id`))[0];
        if(!reservation) return null;
        if(!['email','in_app'].includes(String(report.delivery_channel))) throw new Error('Unsupported report delivery channel.');
        if(report.delivery_channel==='email' && !report.delivery_target) throw new Error('Scheduled email report has no delivery target.');
        const exported=await buildReportExport(Number(report.user_id),current,'json',now,tx);
        if(!exported?.id) throw new Error('The scheduled report export could not be persisted.');
        await tx.execute(sql`UPDATE social_report_deliveries SET export_id=${exported.id},dispatch_started_at=${now} WHERE id=${reservation.id}`);
        return {reservation,exported};
      });
    } catch(error) {
      // This transaction never dispatched. Its ledger/export rolled back, so a
      // same-occurrence retry can safely prepare again under the parent lock.
      await db.execute(sql`INSERT INTO social_report_deliveries(report_id,user_id,delivery_key,status,attempted_at,
          preparation_version,generation_attempts,error_code,error_message)
        SELECT id,user_id,${deliveryKey},'failed',${now},1,1,'SOCIAL_REPORT_GENERATION_FAILED',
          'Report generation could not finish. Delivery was not attempted.'
        FROM social_saved_reports WHERE id=${report.id} AND user_id=${report.user_id}
        ON CONFLICT(report_id,delivery_key) DO UPDATE SET status='failed',attempted_at=EXCLUDED.attempted_at,
          generation_attempts=social_report_deliveries.generation_attempts+1,
          error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message
        WHERE social_report_deliveries.preparation_version=1 AND social_report_deliveries.dispatch_started_at IS NULL
          AND social_report_deliveries.export_id IS NULL AND social_report_deliveries.status IN ('pending','failed')`);
      preparationCause??=error;
      processed++;failed++;preparationFailures++;continue;
    }
    if(!prepared){skipped++;continue;}
    processed++;
    const {reservation,exported}=prepared;
    try {
      const exportPath = `/dashboard/marketing/analytics?tab=reports&report=${encodeURIComponent(String(report.id))}&export=${encodeURIComponent(String(exported?.id))}`;
      const exportUrl = `${process.env.CLIENT_URL || 'https://asksales.ai'}${exportPath}`;
      if (report.delivery_channel === 'email') {
        const target = typeof report.delivery_target === 'string' ? report.delivery_target : '';
        if (!target) throw new Error('Scheduled email report has no delivery target.');
        const { emailService } = await import('../services/emailService.js');
        const reportPayload = asRecord(exported?.payload);
        const citations = Array.isArray(reportPayload.citations) ? reportPayload.citations.length : 0;
        const { withInternalEmailDelivery } = await import('../services/InternalEmailDelivery.js');
        const result = await withInternalEmailDelivery('operator_report', () => emailService.sendEmailWithUserCredentials(Number(report.user_id), {
          to: target,
          subject: `Scheduled social report: ${String(report.name)}`,
          text: `Your scheduled social report is ready. It contains ${citations} immutable metric snapshot citation(s). View your report: ${exportUrl}`,
          html: `<p>Your scheduled social report is ready. It contains ${citations} immutable metric snapshot citation(s).</p><p>View your report: ${exportUrl}</p>`,
        }));
        if (!result.success) throw new Error(result.error || 'The selected email provider did not accept the scheduled report.');
      } else if (report.delivery_channel === 'in_app') {
        const { NotificationService } = await import('../services/NotificationService.js');
        const delivered = await NotificationService.notify(
          Number(report.user_id),
          `Scheduled social report: ${String(report.name)}`,
          `Your cited social analytics export ${String(exported?.id)} is ready.`,
          'success',
          { actionUrl: exportPath },
        );
        if (!delivered) throw new Error('The in-app report notification could not be persisted.');
      }
      await db.execute(sql`UPDATE social_report_deliveries SET status='sent', error_code=NULL, error_message=NULL WHERE id=${reservation.id}`);
      sent += 1;
    } catch (error) {
      await db.execute(sql`UPDATE social_report_deliveries SET status='failed', error_code='SOCIAL_REPORT_DELIVERY_FAILED', error_message=${error instanceof Error ? error.message.slice(0, 2048) : 'Unknown report delivery failure'} WHERE id=${reservation.id}`);
      failed += 1;
    }
  }
  const result={processed,sent,failed,skipped};
  // Reuse the GENERAL queue's existing attempts/backoff. Swallowing generation
  // failure previously marked the job complete and permanently lost this run.
  if(preparationFailures) throw new SocialReportPreparationError(result,preparationCause);
  return result;
}

/** Current totals must never be backfilled into the requested historical period. */
export async function captureSocialFollowerSnapshot(input: {userId: number; platform: Platform; accountIdentifier: string; followers: number; timezone?: string; capturedAt?: Date}) {
  const capturedAt = input.capturedAt || new Date();
  const day = capturedAt.toISOString().slice(0,10);
  return insertSnapshot({ userId:input.userId,platform:input.platform,accountIdentifier:input.accountIdentifier,
    windowStart:new Date(`${day}T00:00:00.000Z`),windowEnd:new Date(`${day}T23:59:59.999Z`),source:'official_api',
    sourceSnapshotId:`${input.platform}:followers:${day}`,metrics:{followers:input.followers},timezone:input.timezone||'UTC',
    dimensions:{measurement:'point_in_time',observedAt:capturedAt.toISOString(),limitation:'Current follower totals are captured from today onward; historical totals are not backfilled.'} });
}

/** Sync channel-owned official data into immutable normalized snapshots. */
export async function syncOfficialSocialAnalytics(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const credentialId = Number(req.body?.credentialId);
  if (!positiveCredentialId(credentialId)) return res.status(400).json({ error: 'A valid owned credentialId is required.' });
  const body = asRecord(req.body);
  if (!validPlatform(body.platform) || !isValidIsoDate(body.startDate) || !isValidIsoDate(body.endDate) || body.startDate > body.endDate || !isValidIanaTimeZone(body.timezone ?? DEFAULT_BUSINESS_TIMEZONE) || body.endDate > new Date().toISOString().slice(0,10) || Date.parse(body.endDate)-Date.parse(body.startDate)>365*86_400_000) return res.status(400).json({ error: 'A valid platform, date range of at most 366 days, and timezone are required.' });
  const credential = (await db.select().from(channelCredentialsTable).where(and(eq(channelCredentialsTable.id,credentialId),eq(channelCredentialsTable.userId,userId),eq(channelCredentialsTable.isActive,true))).limit(1))[0];
  const expectedPlatforms = body.platform === 'facebook' ? ['facebook_api','facebook_page'] : [body.platform === 'youtube' ? 'youtube' : `${body.platform}_api`];
  if (!credential?.accountIdentifier || !expectedPlatforms.includes(credential.platform)) return res.status(404).json({ error: 'The requested social account is not active in this workspace.' });
  const { queueRegistry, QUEUE_NAMES } = await import('../queues/index.js');
  const jobId = await queueRegistry.addJob<import('../queues/index.js').BaseJobPayload & {type:string;platform:string;input:Record<string,unknown>}>(QUEUE_NAMES.PERFORMANCE_SYNC,'social-account-sync',{
    userId,createdAt:new Date().toISOString(),type:'social-account-sync',platform:body.platform,input:{platform:body.platform,credentialId,startDate:body.startDate,endDate:body.endDate,timezone:body.timezone ?? DEFAULT_BUSINESS_TIMEZONE},
  },{ attempts:1,deduplication:{id:`social-account-${userId}-${credentialId}`},removeOnComplete:{age:86400,count:1000},removeOnFail:{age:86400,count:1000} });
  return res.status(202).json({ queued:true,jobId });
}

export async function synchronizeSocialAnalytics(userId: number, input: unknown, options: { incremental?: boolean } = {}) {
  // Shared by the authenticated route and scheduled worker; account ownership
  // and provider readiness are enforced on both paths.
  const res = {
    json: (body: JsonRecord) => ({ status: 200, body }),
    status: (status: number) => ({ json: (body: JsonRecord) => ({ status, body }) }),
  };
  const body = asRecord(input); const platform = body.platform; const credentialId = Number(body.credentialId); const timezone = body.timezone ?? DEFAULT_BUSINESS_TIMEZONE;
  if (!validPlatform(platform) || !positiveCredentialId(credentialId) || !isValidIsoDate(body.startDate) || !isValidIsoDate(body.endDate) || body.startDate > body.endDate || !isValidIanaTimeZone(timezone)) return res.status(400).json({ error: 'platform, owned credentialId, valid ISO calendar date range, and IANA timezone are required.' });
  const startDate = new Date(`${body.startDate}T00:00:00.000Z`);
  const endDate = new Date(`${body.endDate}T23:59:59.999Z`);
  if (String(body.endDate) > new Date().toISOString().slice(0, 10) || endDate.getTime() - startDate.getTime() > 366 * 86_400_000) {
    return res.status(400).json({ error: 'Analytics windows cannot be in the future or exceed 366 days.' });
  }
  const credential = (await db.select().from(channelCredentialsTable).where(and(eq(channelCredentialsTable.id, credentialId), eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.isActive, true))).limit(1))[0];
  const expectedPlatforms = platform === 'facebook' ? ['facebook_api', 'facebook_page'] : platform === 'instagram' ? ['instagram_api'] : ['youtube'];
  if (!credential || !expectedPlatforms.includes(credential.platform) || !credential.accountIdentifier) return res.status(404).json({ error: 'The requested channel account is not active in this workspace.' });
  if (credential.tokenExpiry && credential.tokenExpiry.getTime() <= Date.now()) {
    return res.status(409).json({ error: `Reconnect the selected ${platform} account because its provider authorization has expired.`, code: 'SOCIAL_ANALYTICS_RECONNECT_REQUIRED' });
  }
  if (platform === 'facebook' && (!Array.isArray(credential.grantedScopes) || !credential.grantedScopes.includes('pages_read_engagement'))) {
    return res.status(409).json({ error: 'Reconnect Facebook and grant Page analytics access before Social Insights can synchronize metrics.', code: 'SOCIAL_ANALYTICS_PERMISSION_REQUIRED' });
  }
  if (platform === 'instagram' && !(Array.isArray(credential.grantedScopes) && credential.grantedScopes.includes(isDirectInstagramLogin(credential) ? 'instagram_business_manage_insights' : 'instagram_manage_insights'))) {
    return res.status(409).json({
      error: 'Reconnect Instagram and grant the required analytics permission before Social Insights can synchronize metrics.',
      code: 'SOCIAL_ANALYTICS_PERMISSION_REQUIRED',
    });
  }
  if (platform === 'youtube') {
    const { syncYouTubeAnalytics } = await import('../services/social/YouTubePublishingService.js');
    const synced = await syncYouTubeAnalytics(userId, credentialId, { startDate: String(body.startDate), endDate: String(body.endDate), videoId: typeof body.videoId === 'string' ? body.videoId : undefined });
    const writes = await Promise.all(synced.snapshots.map(snapshot => insertSnapshot({ userId, platform, accountIdentifier: synced.channelId, windowStart: new Date(`${snapshot.metricDate}T00:00:00.000Z`), windowEnd: new Date(`${snapshot.metricDate}T23:59:59.999Z`), source: 'official_api', sourceSnapshotId: `youtube:${credentialId}:${snapshot.videoId}:${snapshot.metricDate}`, metrics: normalizeSocialMetrics(snapshot.metrics) || {}, timezone })));
    return res.json({ platform, accountIdentifier: synced.channelId, inserted: writes.filter(write => !write.duplicate).length, duplicates: writes.filter(write => write.duplicate).length, limitations: synced.limitations });
  }
  let accessToken = decryptMetaSecret(credential.accessToken);
  if (platform === 'facebook') {
    const page = resultRows(await db.execute(sql`SELECT page_access_token FROM meta_page_connections
      WHERE user_id = ${userId} AND page_id = ${credential.accountIdentifier} AND is_active = TRUE LIMIT 1`))[0];
    if (typeof page?.page_access_token === 'string') accessToken = decryptMetaSecret(page.page_access_token);
  }
  if (!accessToken) return res.status(409).json({ error: 'The selected channel has no usable access token.' });
  const version = await getGraphApiVersion();
  const directInstagram = platform === 'instagram' && isDirectInstagramLogin(credential);
  const graphBase = directInstagram ? `https://graph.instagram.com/${version}` : getGraphApiBase(version);
  if (platform === 'instagram' && !directInstagram && options.incremental) {
    const { requestMetaInsights } = await import('../services/social/MetaInsightsClient.js');
    await refreshDueInstagramCompetitors(userId, {
      platform:'instagram',credential:{accountIdentifier:credential.accountIdentifier},
      request:(path,query)=>requestMetaInsights(graphBase,accessToken!,path,query),
    });
  }
  const followerLimitations: string[] = [];
  try {
    const { requestMetaInsights } = await import('../services/social/MetaInsightsClient.js');
    const field = 'followers_count';
    const profile = await requestMetaInsights(graphBase, accessToken!, credential.accountIdentifier, { fields: field });
    if (typeof profile[field] === 'number' && Number.isFinite(profile[field]) && Number(profile[field]) >= 0) {
      await captureSocialFollowerSnapshot({ userId, platform, accountIdentifier: credential.accountIdentifier, followers: Number(profile[field]), timezone });
    } else followerLimitations.push('Meta did not return a current follower total for this account.');
  } catch { followerLimitations.push('Current follower count was unavailable; historical metrics can still synchronize.'); }
  const requestInsights = async (params: Record<string, string>) => {
    const { requestMetaInsights, MetaInsightsError } = await import('../services/social/MetaInsightsClient.js');
    try {
      const payload = await requestMetaInsights(graphBase,accessToken!,`${credential.accountIdentifier}/insights`,params);
      return { response:new globalThis.Response(null,{status:200}),payload };
    } catch(error) {
      if (error instanceof MetaInsightsError && ['SOCIAL_PROVIDER_TIMEOUT','SOCIAL_PROVIDER_RATE_LIMITED','SOCIAL_PROVIDER_UNAVAILABLE'].includes(error.code)) throw error;
      const code = error instanceof MetaInsightsError ? error.code === 'SOCIAL_ANALYTICS_RECONNECT_REQUIRED' ? 190 : error.code === 'SOCIAL_ANALYTICS_PERMISSION_REQUIRED' ? 10 : 100 : 1;
      return {response:new globalThis.Response(null,{status:422}),payload:{error:{code}} as JsonRecord};
    }
  };
  const providerFailure = (response: globalThis.Response, payload: JsonRecord) => {
    const providerError = asRecord(payload.error);
    const providerCode = Number(providerError.code) || null;
    const providerSubcode = Number(providerError.error_subcode) || null;
    const authenticationFailure = response.status === 401 || response.status === 403 || providerCode === 190;
    const permissionFailure = providerCode === 10;
    return res.status(authenticationFailure ? 422 : response.status >= 400 && response.status < 500 ? 422 : 502).json({
      error: authenticationFailure
        ? 'Meta could not authorize analytics for this account. Reconnect the channel, confirm insights permissions, and retry; existing snapshots were not changed.'
        : permissionFailure
          ? 'Meta denied access to analytics for this account. Reconnect the channel with the required analytics permission; existing snapshots were not changed.'
        : providerCode === 100
          ? 'Meta rejected one or more analytics metrics for this account. AskSales retried compatible metrics, but none were available for this date range; existing snapshots were not changed.'
          : 'Meta did not return analytics for this account. Confirm the selected account and date range, then retry; existing snapshots were not changed.',
      code: authenticationFailure ? 'SOCIAL_ANALYTICS_RECONNECT_REQUIRED' : permissionFailure ? 'SOCIAL_ANALYTICS_PERMISSION_REQUIRED' : 'SOCIAL_ANALYTICS_PROVIDER_FAILED',
      providerStatus: response.status, providerCode, providerSubcode,
    });
  };

  if (platform === 'instagram') {
    const writes: Array<{ duplicate: boolean }> = [];
    const historicalDays = new Set<string>();
    if (options.incremental) {
      const existing = await snapshotsFor(userId, { platform, accountIdentifier: credential.accountIdentifier, start: startDate, end: endDate }, 10000);
      for (const snapshot of existing) {
        if (String(snapshot.source_snapshot_id).startsWith(`instagram:${credentialId}:daily:`)) historicalDays.add(new Date(String(snapshot.metric_window_start)).toISOString().slice(0, 10));
      }
    }
    const correctionCutoff = new Date(); correctionCutoff.setUTCDate(correctionCutoff.getUTCDate() - 7);
    const limitations = new Set<string>(followerLimitations);
    let lastFailure: Awaited<ReturnType<typeof requestInsights>> | null = null;
    // Account total_value results span the requested window. Fetch closed days
    // separately so rolling background syncs cannot create overlapping totals.
    for (let day = new Date(startDate); day <= endDate; day.setUTCDate(day.getUTCDate() + 1)) {
      const date = day.toISOString().slice(0, 10);
      if (options.incremental && day < correctionCutoff && historicalDays.has(date)) continue;
      const until = new Date(day); until.setUTCDate(until.getUTCDate() + 1);
      const common = { period: 'day', since: date, until: until.toISOString().slice(0, 10) };
      const metrics: CanonicalMetrics = {};
      const totalMetrics = ['views', 'total_interactions', 'profile_links_taps'];
      const totals = await requestInsights({ ...common, metric_type: 'total_value', metric: totalMetrics.join(',') });
      if (totals.response.ok) Object.assign(metrics, extractMetaTotalMetrics(totals.payload) || {});
      else {
        lastFailure = totals;
        // Authorization and rate limits cannot be repaired by trying each metric.
        if ([10, 190, 4, 17, 32, 613].includes(Number(asRecord(totals.payload.error).code))) break;
        for (const metric of totalMetrics) {
          const result = await requestInsights({ ...common, metric_type: 'total_value', metric });
          if (result.response.ok) Object.assign(metrics, extractMetaTotalMetrics(result.payload) || {});
          else { lastFailure = result; limitations.add(`Meta did not return ${metric} for every requested day.`); }
        }
      }
      // Use the requested day's total: Meta's time-series boundary can fall on the same UTC date.
      const reach = await requestInsights({ ...common, metric_type: 'total_value', metric: 'reach' });
      if (reach.response.ok) Object.assign(metrics, extractMetaTotalMetrics(reach.payload) || {});
      else { lastFailure = reach; limitations.add('Meta did not return daily reach for every requested day.'); }
      if (!Object.keys(metrics).length) continue;
      writes.push(await insertSnapshot({ userId, platform, accountIdentifier: credential.accountIdentifier, windowStart: new Date(`${date}T00:00:00.000Z`), windowEnd: new Date(`${date}T23:59:59.999Z`), source: 'official_api', sourceSnapshotId: `${platform}:${credentialId}:daily:${date}`, metrics, timezone: String(timezone) }));
    }
    if (!writes.length && lastFailure) return providerFailure(lastFailure.response, lastFailure.payload);
    return res.json({ platform, accountIdentifier: credential.accountIdentifier, inserted: writes.filter(write => !write.duplicate).length, duplicates: writes.filter(write => write.duplicate).length, limitations: [...limitations], partialSuccess: Boolean(lastFailure) });
  }

  const until = new Date(endDate); until.setUTCDate(until.getUTCDate() + 1);
  const daily = new Map<string, CanonicalMetrics>();
  const limitations: string[] = [...followerLimitations];
  let lastFailure: Awaited<ReturnType<typeof requestInsights>> | null = null;
  // Unsupported metrics are isolated; one retired field must not blank the page.
  for (const metric of ['page_media_view', 'page_post_engagements', 'page_total_media_view_unique']) {
    const result = await requestInsights({ period: 'day', since: String(body.startDate), until: until.toISOString().slice(0, 10), metric });
    if (!result.response.ok) {
      lastFailure = result;
      limitations.push(`Meta did not return ${metric} for this account.`);
      if ([10, 190, 4, 17, 32, 613].includes(Number(asRecord(result.payload.error).code))) break;
      continue;
    }
    for (const [day, metrics] of extractMetaDailyMetrics(result.payload)) {
      if (day >= String(body.startDate) && day <= String(body.endDate)) daily.set(day, { ...daily.get(day), ...metrics });
    }
  }
  if (!daily.size && lastFailure) return providerFailure(lastFailure.response, lastFailure.payload);
  const writes = await Promise.all([...daily.entries()].map(([day, metrics]) => insertSnapshot({ userId, platform, accountIdentifier: credential.accountIdentifier!, windowStart: new Date(`${day}T00:00:00.000Z`), windowEnd: new Date(`${day}T23:59:59.999Z`), source: 'official_api', sourceSnapshotId: `${platform}:${credentialId}:${day}`, metrics, timezone: String(timezone) })));
  return res.json({ platform, accountIdentifier: credential.accountIdentifier, inserted: writes.filter(write => !write.duplicate).length, duplicates: writes.filter(write => write.duplicate).length, limitations, partialSuccess: Boolean(lastFailure) });
}

export function validSocialProfileUrl(platform: Platform, value: string): boolean {
  try {
    const url = new URL(value);
    const hosts = platform === 'facebook' ? ['facebook.com','www.facebook.com','m.facebook.com'] : platform === 'instagram' ? ['instagram.com','www.instagram.com'] : ['youtube.com','www.youtube.com'];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname) && url.pathname.replace(/\//g,'').length > 0;
  } catch { return false; }
}

export async function updateSavedSocialReport(req: Request, res: Response) {
  const userId = ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id || '');
  if (!validReportId(id)) return res.status(400).json({error:'Invalid report ID.'});
  const existing = resultRows(await db.execute(sql`SELECT * FROM social_saved_reports WHERE id=${id} AND user_id=${userId} LIMIT 1`))[0];
  if (!existing) return res.status(404).json({error:'Report not found.'});
  const body = asRecord(req.body);
  const name = body.name === undefined ? String(existing.name) : typeof body.name === 'string' ? body.name.trim() : '';
  const filters = validReportFilters(body.filters === undefined ? existing.filters : body.filters);
  // An omitted schedule preserves it (for pause/rename). The editor sends both
  // schedule forms, including null for the unused form, on every full save.
  const cronInput = body.scheduleCron === undefined ? (body.schedule === undefined ? existing.schedule_cron : null) : body.scheduleCron;
  const cron = cronInput === undefined || cronInput === null || cronInput === '' ? null : cronInput;
  const schedule = body.schedule === undefined ? (body.scheduleCron !== undefined && cron !== null ? null : existing.schedule_definition) : body.schedule;
  const scheduleDefinition = schedule === null || schedule === undefined ? null : parseFriendlyReportSchedule(schedule);
  const deliveryChannel = body.deliveryChannel === undefined ? existing.delivery_channel : body.deliveryChannel || null;
  const deliveryTarget = body.deliveryTarget === undefined ? existing.delivery_target || null : body.deliveryTarget || null;
  const paused = body.paused === undefined ? Boolean(existing.paused) : body.paused;
  if (!name || name.length>160 || !filters || (cron !== null && !validCron(cron)) || (cron && scheduleDefinition) || (schedule != null && !scheduleDefinition) || typeof paused!=='boolean' || (deliveryChannel && !['in_app','email'].includes(String(deliveryChannel))) || (deliveryChannel==='email' && (typeof deliveryTarget!=='string' || !isEmailAddress(deliveryTarget)))) return res.status(400).json({error:'Invalid report name, filters, schedule, pause state, or delivery.'});
  if ((cron || scheduleDefinition) && !deliveryChannel) return res.status(400).json({error:'Choose a delivery channel for scheduled reports.'});
  if (filters.relativeDays && filters.timezone === undefined) filters.timezone = scheduleDefinition?.timezone || 'UTC';
  if ((cron || scheduleDefinition) && !filters.relativeDays) return res.status(400).json({error:'Scheduled reports require a rolling relativeDays window.'});
  if (filters.platform && filters.accountIdentifier && !await hasOwnedAnalyticsAccount(userId,filters.platform as Platform,String(filters.accountIdentifier))) return res.status(403).json({error:'The report account is not active in this workspace.'});
  const conflict = resultRows(await db.execute(sql`SELECT id FROM social_saved_reports WHERE user_id=${userId} AND name=${name} AND id<>${id} LIMIT 1`))[0];
  if (conflict) return res.status(409).json({error:'A report with this name already exists.'});
  try {
    const saved = resultRows(await db.execute(sql`UPDATE social_saved_reports SET name=${name},filters=${JSON.stringify(filters)}::jsonb,schedule_cron=${cron || null},schedule_definition=${scheduleDefinition?JSON.stringify(scheduleDefinition):null}::jsonb,schedule_timezone=${scheduleDefinition?.timezone || null},delivery_channel=${deliveryChannel},delivery_target=${deliveryTarget},paused=${paused},updated_at=NOW() WHERE id=${id} AND user_id=${userId} RETURNING *`))[0];
    return res.json(saved);
  } catch(error) { if ((error as {code?:string}).code==='23505') return res.status(409).json({error:'A report with this name already exists.'}); throw error; }
}

export async function deleteSavedSocialReport(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id=String(req.params.id||'');
  if (!validReportId(id)) return res.status(400).json({error:'Invalid report ID.'});
  const deleted=resultRows(await db.execute(sql`DELETE FROM social_saved_reports WHERE id=${id} AND user_id=${userId} RETURNING id`))[0];
  return deleted?res.json({deleted:true}):res.status(404).json({error:'Report not found.'});
}

export async function getSavedSocialReportExport(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id=String(req.params.id||''), exportId=String(req.params.exportId||'');
  if (!validReportId(id) || !validReportId(exportId)) return res.status(400).json({error:'Invalid report or export ID.'});
  const exported=resultRows(await db.execute(sql`SELECT exported.* FROM social_report_exports exported JOIN social_saved_reports report ON report.id=exported.report_id AND report.user_id=${userId} WHERE exported.user_id=${userId} AND exported.report_id=${id} AND exported.id=${exportId} LIMIT 1`))[0];
  return exported?res.json(exported):res.status(404).json({error:'Report export not found.'});
}

export async function updateListeningEvent(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id=String(req.params.id||''); const input=asRecord(req.body);
  const existing=resultRows(await db.execute(sql`SELECT * FROM social_listening_events WHERE id=${id} AND user_id=${userId} LIMIT 1`))[0];
  if (!existing) return res.status(404).json({error:'Listening event not found.'});
  const sentiment=input.sentiment===undefined?existing.sentiment:input.sentiment;
  const score=input.sentimentScore===undefined?(input.sentiment===undefined?existing.sentiment_score:null):input.sentimentScore;
  const text=input.body===undefined?String(existing.body):typeof input.body==='string'?input.body.trim():'';
  const publicUrl=input.publicUrl===undefined?existing.public_url:input.publicUrl;
  const status=input.status;
  if (!SENTIMENTS.has(String(sentiment)) || (score!==null && score!==undefined && (typeof score!=='number' || !Number.isFinite(score) || score < -1 || score >1)) || !text || text.length>20000 || (publicUrl && !/^https:\/\//i.test(String(publicUrl))) || (status!==undefined && !['new','reviewed','follow_up','escalated','resolved'].includes(String(status)))) return res.status(400).json({error:'Invalid sentiment, text, source URL, or review status.'});
  const metadata: JsonRecord={...asRecord(existing.metadata),...(input.sentiment!==undefined?{sentimentSource:'manual',sentimentReviewedAt:new Date().toISOString()}:{}),...(status!==undefined?{reviewStatus:status}:{}),...(input.body!==undefined?{originalBody:asRecord(existing.metadata).originalBody||existing.body}: {})};
  const update = sql`UPDATE social_listening_events SET sentiment=${String(sentiment)},sentiment_score=${score??null},body=${text},public_url=${publicUrl||null},metadata=${JSON.stringify(metadata)}::jsonb WHERE id=${id} AND user_id=${userId} RETURNING *`;
  if (status !== undefined && existing.source === 'official_api' && metadata.collection === 'owned_post_comments') {
    const credentialId=Number(metadata.credentialId), postId=String(metadata.contentId || ''), commentId=String(existing.provider_event_id || '');
    if (!positiveCredentialId(credentialId) || !/^[\d_]+$/.test(postId) || !/^[\d_]+$/.test(commentId)) return res.status(404).json({error:'The original post is no longer available in this account.'});
    const ownedPost=resultRows(await db.execute(sql`SELECT provider_id FROM social_content_items WHERE user_id=${userId} AND credential_id=${credentialId} AND provider_id=${postId} AND platform=${existing.platform} LIMIT 1`))[0];
    if (!ownedPost) return res.status(404).json({error:'The original post is no longer available in this account.'});
    const updated=await db.transaction(async (tx: {execute: (query:SQL)=>Promise<{rows:Record<string,unknown>[]} >})=>{
      await tx.execute(sql`INSERT INTO social_comment_workflows(user_id,credential_id,post_id,comment_id,status) VALUES(${userId},${credentialId},${postId},${commentId},${status === 'new' ? 'open' : String(status)}) ON CONFLICT(business_profile_id, user_id,credential_id,comment_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`);
      return resultRows(await tx.execute(update))[0];
    });
    return res.json(updated);
  }
  return res.json(resultRows(await db.execute(update))[0]);
}

export async function deleteListeningEvent(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const deleted=resultRows(await db.execute(sql`DELETE FROM social_listening_events WHERE id=${String(req.params.id||'')} AND user_id=${userId} RETURNING id`))[0];
  return deleted?res.json({deleted:true}):res.status(404).json({error:'Listening event not found.'});
}

export async function updateSocialCompetitor(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id=String(req.params.id||''); const input=asRecord(req.body);
  try {
    const result=await db.transaction(async(tx:SocialQueryExecutor)=>{
      const existing=resultRows(await tx.execute(sql`SELECT * FROM social_competitors WHERE id=${id} AND user_id=${userId} FOR UPDATE`))[0];
      if(!existing) return {status:404,body:{error:'Competitor not found.'}};
      const publicHandle=input.publicHandle===undefined?String(existing.public_handle):typeof input.publicHandle==='string'?input.publicHandle.trim().replace(/^@/,''):'';
      const publicUrl=input.publicUrl===undefined?String(existing.public_url):String(input.publicUrl);
      const displayName=input.displayName===undefined?existing.display_name:typeof input.displayName==='string'?input.displayName.trim().slice(0,255):null;
      const isActive=input.isActive===undefined?Boolean(existing.is_active):input.isActive;
      if(!publicHandle || publicHandle.length>255 || !validSocialProfileUrl(existing.platform as Platform,publicUrl) || typeof isActive!=='boolean') return {status:400,body:{error:'A valid platform profile URL, handle and active state are required.'}};
      const identityChanged=publicHandle!==existing.public_handle || publicUrl!==existing.public_url;
      if(identityChanged) {
        const evidence=resultRows(await tx.execute(sql`SELECT id FROM social_competitor_snapshots WHERE competitor_id=${id} AND user_id=${userId} LIMIT 1`))[0];
        if(evidence) return {status:409,body:{code:'SOCIAL_COMPETITOR_IDENTITY_HAS_EVIDENCE',error:'This profile has captured evidence. Create a new competitor for a different identity; display-name edits and archiving remain available.'}};
        if(existing.last_refresh_status==='pending') return {status:409,body:{code:'SOCIAL_COMPETITOR_REFRESH_IN_PROGRESS',error:'A public refresh is in progress. Wait for it to finish before changing the profile identity.'}};
      }
      const saved=resultRows(await tx.execute(sql`UPDATE social_competitors SET public_handle=${publicHandle},public_url=${publicUrl},display_name=${displayName},is_active=${isActive},
        last_refresh_attempt_at=CASE WHEN ${identityChanged} THEN NULL ELSE last_refresh_attempt_at END,
        last_refreshed_at=CASE WHEN ${identityChanged} THEN NULL ELSE last_refreshed_at END,
        last_refresh_status=CASE WHEN ${identityChanged} THEN NULL ELSE last_refresh_status END,
        last_refresh_error=CASE WHEN ${identityChanged} THEN NULL ELSE last_refresh_error END
        WHERE id=${id} AND user_id=${userId} RETURNING *`))[0];
      return {status:200,body:saved};
    });
    return res.status(result.status).json(result.body);
  } catch(error) {
    const detail=error as {code?:string;cause?:{code?:string}};
    if((detail.code || detail.cause?.code)==='23505') return res.status(409).json({error:'This competitor already exists.'});
    throw error;
  }
}

export async function deleteSocialCompetitor(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id=String(req.params.id||'');
  const result=await db.transaction(async(tx:SocialQueryExecutor)=>{
    // The parent lock serializes this decision with a snapshot's FK lock. A
    // concurrent capture cannot turn a permitted deletion into a cascade 500.
    const existing=resultRows(await tx.execute(sql`SELECT id,last_refresh_status FROM social_competitors WHERE id=${id} AND user_id=${userId} FOR UPDATE`))[0];
    if(!existing) return {status:404,body:{error:'Competitor not found.'}};
    const evidence=resultRows(await tx.execute(sql`SELECT id FROM social_competitor_snapshots WHERE competitor_id=${id} AND user_id=${userId} LIMIT 1`))[0];
    if(evidence) return {status:409,body:{code:'SOCIAL_COMPETITOR_EVIDENCE_IMMUTABLE',error:'Captured competitor evidence is immutable. Archive this competitor to preserve its history and stop tracking.'}};
    if(existing.last_refresh_status==='pending') return {status:409,body:{code:'SOCIAL_COMPETITOR_REFRESH_IN_PROGRESS',error:'A public refresh is in progress. Wait for it to finish before deleting this competitor.'}};
    await tx.execute(sql`DELETE FROM social_competitors WHERE id=${id} AND user_id=${userId}`);
    return {status:200,body:{deleted:true}};
  });
  return res.status(result.status).json(result.body);
}

type PublicDiscoveryClient = { platform: 'facebook' | 'instagram'; credential: { accountIdentifier: string | null }; request: (path: string, query: Record<string,string>) => Promise<JsonRecord> };
const PUBLIC_COMPETITOR_LIMITATIONS = ['Current public follower count only. Meta does not expose competitor reach, private insights, or historic follower windows.'];

/** Shared by an explicit refresh and the bounded background daily refresh. */
export async function refreshPublicCompetitorSnapshot(userId: number, competitor: SnapshotRow, client: PublicDiscoveryClient) {
  const {MetaInsightsError}=await import('../services/social/MetaInsightsClient.js');
  const id=String(competitor.id); const handle=String(competitor.public_handle);
  try {
    if (client.platform!=='instagram' || !client.credential.accountIdentifier) throw new MetaInsightsError('SOCIAL_ACCOUNT_NOT_FOUND','Select a connected Instagram professional account.',400);
    if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) throw new MetaInsightsError('SOCIAL_INVALID_COMPETITOR','A valid Instagram username is required.',400);
    const payload=await client.request(client.credential.accountIdentifier,{fields:`business_discovery.username(${handle}){id,username,name,followers_count,media_count}`});
    const discovery=asRecord(payload.business_discovery); const followers=discovery.followers_count;
    if (typeof followers!=='number' || !Number.isFinite(followers) || followers<0) throw new MetaInsightsError('SOCIAL_PUBLIC_METRICS_UNAVAILABLE','Meta did not return public follower metrics. The competitor must be an accessible professional Instagram account.',422);
    const now=new Date(); const sourceId=`instagram:business_discovery:${String(discovery.id)}:${now.toISOString()}`;
    const snapshot=await db.transaction(async(tx:SocialQueryExecutor)=>{
      const current=resultRows(await tx.execute(sql`SELECT id FROM social_competitors WHERE id=${id} AND user_id=${userId}
        AND public_handle=${handle} AND public_url=${String(competitor.public_url)} FOR UPDATE`))[0];
      if(!current) throw new MetaInsightsError('SOCIAL_COMPETITOR_CHANGED','The competitor identity changed during this refresh. Reload the competitor before retrying.',409);
      const saved=resultRows(await tx.execute(sql`INSERT INTO social_competitor_snapshots(competitor_id,user_id,captured_at,source,source_snapshot_id,metrics,source_url) VALUES(${id},${userId},${now},'official_api',${sourceId},${JSON.stringify({followers})}::jsonb,${String(competitor.public_url)}) RETURNING *`))[0];
      await tx.execute(sql`UPDATE social_competitors SET last_refresh_status='success',last_refresh_error=NULL,last_refreshed_at=${now} WHERE id=${id} AND user_id=${userId}`);
      return saved;
    });
    return {snapshot,limitations:PUBLIC_COMPETITOR_LIMITATIONS};
  } catch(error) {
    const safeMessage=error instanceof MetaInsightsError?error.message:'Public competitor metrics could not be refreshed. Try again later.';
    await db.execute(sql`UPDATE social_competitors SET last_refresh_status='error',last_refresh_error=${safeMessage.slice(0,2048)} WHERE id=${id} AND user_id=${userId}
      AND public_handle=${handle} AND public_url=${String(competitor.public_url)}`);
    throw error;
  }
}

export async function refreshDueInstagramCompetitors(userId: number, client: PublicDiscoveryClient): Promise<{attempted:number;succeeded:number;failed:number}> {
  if(client.platform!=='instagram')return {attempted:0,succeeded:0,failed:0};
  // Claim before calling Meta. Successes, failures and abandoned attempts all
  // receive the same 24-hour cooldown; another account/worker cannot retry them.
  const due=resultRows(await db.execute(sql`UPDATE social_competitors SET last_refresh_attempt_at=NOW(),last_refresh_status='pending',last_refresh_error=NULL
    WHERE user_id=${userId} AND id IN (
      SELECT id FROM social_competitors WHERE user_id=${userId} AND platform='instagram' AND is_active=TRUE
        AND (last_refresh_attempt_at IS NULL OR last_refresh_attempt_at < NOW()-INTERVAL '24 hours')
      ORDER BY last_refresh_attempt_at ASC NULLS FIRST,created_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED
    ) RETURNING *`));
  let succeeded=0;let failed=0;
  for(const competitor of due){try{await refreshPublicCompetitorSnapshot(userId,competitor,client);succeeded++;}catch{failed++;}}
  return {attempted:due.length,succeeded,failed};
}

export async function refreshSocialCompetitor(req: Request, res: Response) {
  const userId=ownerId(req); if (!userId) return res.status(401).json({error:'Unauthorized'});
  const id=String(req.params.id||''); const credentialId=Number(req.body?.credentialId);
  if (!positiveCredentialId(credentialId)) return res.status(400).json({error:'An owned Instagram credentialId is required.'});
  const competitor=resultRows(await db.execute(sql`SELECT * FROM social_competitors WHERE id=${id} AND user_id=${userId} AND is_active=TRUE LIMIT 1`))[0];
  if (!competitor) return res.status(404).json({error:'Competitor not found.'});
  if (competitor.platform!=='instagram') return res.status(422).json({error:'Automatic public refresh is available for Instagram professional profiles. Import cited public metrics for other platforms.'});
  const {createMetaInsightsClient,MetaInsightsError}=await import('../services/social/MetaInsightsClient.js');
  try {
    const client=await createMetaInsightsClient(userId,credentialId);
    if(client.platform!=='instagram')return res.status(400).json({error:'Select a connected Instagram professional account.'});
    const claimed=resultRows(await db.execute(sql`UPDATE social_competitors SET last_refresh_attempt_at=NOW(),last_refresh_status='pending',last_refresh_error=NULL WHERE id=${id} AND user_id=${userId}
      AND public_handle=${String(competitor.public_handle)} AND public_url=${String(competitor.public_url)} AND is_active=TRUE RETURNING *`))[0];
    if(!claimed) return res.status(409).json({code:'SOCIAL_COMPETITOR_CHANGED',error:'The competitor changed before refresh started. Reload it before retrying.'});
    return res.status(201).json(await refreshPublicCompetitorSnapshot(userId,claimed,client));
  } catch(error) { if(error instanceof MetaInsightsError)return res.status(error.status).json({error:error.message,code:error.code});throw error; }
}
