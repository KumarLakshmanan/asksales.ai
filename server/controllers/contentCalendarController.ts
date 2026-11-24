import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { businessCacheKey } from '../tenancy/businessContext.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { AuthenticatedRequest, AuthenticatedRequest as AuthRequest } from '../types/express.js';
/**
 * Content Calendar Controller
 * CRUD operations for content scheduling and calendar management
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../models/db';
import { contentPlansTable } from '../models/contentPlans/schema';
import { eq, and, desc, inArray, sql, or, isNotNull } from 'drizzle-orm';
import { idempotencyService } from '../services/IdempotencyService.js';
import crypto from 'node:crypto';
import { DEFAULT_BUSINESS_TIMEZONE } from '../utils/timezone.js';


interface CalendarItem {
  id?: number;
  title: string;
  description?: string;
  contentType: string;
  channel: string;
  scheduledDate: string;
  scheduledTime?: string;
  status: 'draft' | 'planned' | 'scheduled' | 'processing' | 'published' | 'cancelled';
  contentAssetId?: number;
  contentPlanId?: number;
  metadata?: Record<string, unknown>;
  type?: string;
  platform?: string;
  scheduled_date?: string;
  scheduled_time?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CALENDAR_STATUSES = ['draft', 'planned', 'cancelled'] as const;

type EditorialCalendarWriteResult = { success: true; item?: CalendarItem } | { success: false; error: string };

/** Lock the current plan before reading its JSON. Every editorial write uses
 * the same transaction so concurrent partial changes compose across processes. */
async function mutateEditorialCalendar(
  contentPlanId: number,
  userId: number,
  mutate: (calendar: CalendarItem[]) => { calendar: CalendarItem[]; item?: CalendarItem } | undefined,
): Promise<EditorialCalendarWriteResult> {
  return db.transaction(async (tx: typeof db) => {
    const [plan] = await tx.select().from(contentPlansTable)
      .where(and(eq(contentPlansTable.id, contentPlanId), eq(contentPlansTable.userId, userId)))
      .for('update');
    if (!plan) return { success: false, error: 'Content plan not found' };
    const change = mutate((plan.contentCalendar as CalendarItem[] | null) || []);
    if (!change) return { success: false, error: 'Calendar item not found' };
    await tx.update(contentPlansTable)
      .set({ contentCalendar: change.calendar, updatedAt: new Date() })
      .where(and(eq(contentPlansTable.id, contentPlanId), eq(contentPlansTable.userId, userId)));
    return { success: true, item: change.item };
  });
}

function nextEditorialItemId(calendar: CalendarItem[]): number {
  let id = Date.now();
  for (const item of calendar) {
    if (typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id >= id) id = item.id + 1;
  }
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Unable to allocate a calendar item ID');
  return id;
}

/** Editorial entries never represent a provider delivery, even in older plans. */
export function editorialCalendarStatus(status: unknown): 'draft' | 'planned' | 'cancelled' {
  return status === 'draft' || status === 'cancelled' ? status : 'planned';
}

function validSchedule(date: unknown, time: unknown, timezone: unknown): string | null {
  if (!isValidDateOnly(date) || (time !== undefined && (typeof time !== 'string' || !TIME_PATTERN.test(time)))) return 'scheduledDate and scheduledTime must be valid calendar values';
  if (timezone !== undefined && !isValidTimezone(timezone)) return 'timezone must be a valid IANA timezone';
  return null;
}

/** Keeps a batch from creating an ambiguous same-platform delivery slot. */
export function assertNoBulkScheduleConflicts(
  assets: Array<{ id: number; publishPlatform?: string | null }>,
): void {
  const seen = new Set<string>();
  for (const asset of assets) {
    if (!asset.publishPlatform) continue;
    if (seen.has(asset.publishPlatform)) {
      throw new Error(`Only one ${asset.publishPlatform} item can be moved to the same scheduled time in a bulk action`);
    }
    seen.add(asset.publishPlatform);
  }
}

/** Return selected assets plus any cross-post children exactly once. */
export function expandCalendarAssetFamily<T extends { id: number; parentAssetId?: number | null; publishPlatform?: string | null }>(
  selectedIds: number[],
  ownedAssets: T[],
): T[] {
  const selected = new Set(selectedIds);
  const expanded = new Set(selectedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const asset of ownedAssets) {
      if (asset.parentAssetId && expanded.has(asset.parentAssetId) && !expanded.has(asset.id)) {
        expanded.add(asset.id); changed = true;
      }
    }
  }
  return ownedAssets.filter(asset => expanded.has(asset.id) || selected.has(asset.id));
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function timezoneParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function formatDateForTimezone(date: Date, timezone: string): string {
  const parts = timezoneParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimeForTimezone(date: Date, timezone: string): string {
  const parts = timezoneParts(date, timezone);
  return `${parts.hour}:${parts.minute}`;
}

function formatDateForOffset(date: Date, offsetMinutes: number): string {
  return new Date(date.getTime() - offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function formatTimeForOffset(date: Date, offsetMinutes: number): string {
  return new Date(date.getTime() - offsetMinutes * 60_000).toISOString().slice(11, 16);
}

function timezoneOffsetMinutes(date: Date, timezone: string): number {
  const parts = timezoneParts(date, timezone);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return Math.round((date.getTime() - representedAsUtc) / 60_000);
}

function zonedStartOfDay(dateOnly: string, timezone: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const reference = Date.parse(`${dateOnly}T00:00:00.000Z`);
  const requestedDay = year * 10_000 + month * 100 + day;
  let lower = reference - 36 * 3_600_000;
  let upper = reference + 36 * 3_600_000;
  // Find the first instant on or after this local date. Midnight itself can
  // be skipped or repeated, and a skipped date shares the next date's bound.
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const parts = timezoneParts(new Date(middle), timezone);
    const representedDay = Number(parts.year) * 10_000 + Number(parts.month) * 100 + Number(parts.day);
    if (representedDay < requestedDay) lower = middle + 1;
    else upper = middle;
  }
  return new Date(lower);
}

function zonedLocalDateTime(dateOnly: string, time: string, timezone: string): { instant: Date } | { error: string } {
  const reference = Date.parse(`${dateOnly}T${time}:00.000Z`);
  const offsets = new Set<number>();
  // Sample both sides of a transition, including half-hour DST. A valid local
  // schedule must identify exactly one UTC instant, as the editor requires.
  for (let hour = -36; hour <= 36; hour += 6) {
    offsets.add(timezoneOffsetMinutes(new Date(reference + hour * 3_600_000), timezone));
  }
  const matches = [...offsets]
    .map(offset => new Date(reference + offset * 60_000))
    .filter(instant => formatDateForTimezone(instant, timezone) === dateOnly && formatTimeForTimezone(instant, timezone) === time);
  if (!matches.length) return { error: 'The requested local time does not exist in this timezone' };
  if (matches.length > 1) return { error: 'The requested local time occurs twice in this timezone. Choose an unambiguous time.' };
  return { instant: matches[0] };
}

function normalizeDisplayType(value: unknown): 'post' | 'story' | 'reel' | 'carousel' | 'video' | 'short' | 'ad' {
  if (value === 'story' || value === 'carousel' || value === 'ad') return value;
  if (value === 'reel') return 'reel';
  if (value === 'video') return 'video';
  if (value === 'short' || value === 'shorts') return 'short';
  return 'post';
}

/**
 * Get calendar items for a date range
 * GET /api/content-calendar
 */
export async function getCalendarItems(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { startDate, endDate, channel, status } = req.query;
    if ((startDate && !isValidDateOnly(startDate)) || (endDate && !isValidDateOnly(endDate))) {
      return res.status(400).json({ success: false, error: 'startDate and endDate must use YYYY-MM-DD' });
    }
    if (startDate && endDate) {
      const start = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T00:00:00.000Z`);
      if (start > end) return res.status(400).json({ success: false, error: 'startDate must be before endDate' });
      if (end.getTime() - start.getTime() > 370 * 86_400_000) {
        return res.status(400).json({ success: false, error: 'Calendar range cannot exceed 370 days' });
      }
    }
    const requestedTimezone = req.query.timezone;
    if (requestedTimezone !== undefined && !isValidTimezone(requestedTimezone)) {
      return res.status(400).json({ success: false, error: 'timezone must be a valid IANA timezone' });
    }
    const parsedOffset = Number(req.query.timezoneOffsetMinutes);
    const legacyOffset = Number.isFinite(parsedOffset)
      ? Math.min(840, Math.max(-840, Math.trunc(parsedOffset)))
      : 0;
    const timezone = typeof requestedTimezone === 'string' ? requestedTimezone : null;

    // Build query conditions
    const conditions = [eq(contentPlansTable.userId, userId)];

    // Get content plans with calendar items
    const plans = await db
      .select()
      .from(contentPlansTable)
      .where(and(...conditions))
      .orderBy(desc(contentPlansTable.updatedAt));

    // Extract and filter calendar items
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let calendarItems: any[] = [];

    for (const plan of plans) {
      const calendar = (plan.contentCalendar as CalendarItem[] | null) || [];
      const filteredItems = calendar
        .map((item, index) => {
          const type = item.type || item.contentType || 'post';
          const platform = item.platform || item.channel || 'instagram';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const date = item.scheduledDate || (item as any).scheduled_date || new Date().toISOString().split('T')[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const time = item.scheduledTime || (item as any).scheduled_time || '12:00';
          return {
            ...item,
            contentAssetId: undefined,
            providerBacked: false,
            content: item.description || '',
            id: item.id || index + 1,
            sourceKey: `plan-${plan.id}-${item.id || index + 1}`,
            contentPlanId: plan.id,
            plan_id: plan.id,
            planName: plan.name,
            scheduledDate: date,
            scheduled_date: date,
            scheduledTime: time,
            scheduled_time: time,
            contentType: item.contentType || 'social',
            type: type,
            channel: platform,
            platform: platform,
            status: editorialCalendarStatus(item.status),
          };
        })
        .filter(item => {
          // Filter by date range
          if (startDate && item.scheduledDate < (startDate as string)) return false;
          if (endDate && item.scheduledDate > (endDate as string)) return false;
          
          // Filter by channel
          if (channel && item.channel !== channel) return false;
          
          // Filter by status
          if (status && item.status !== status) return false;
          
          return true;
        });

      calendarItems = [...calendarItems, ...filteredItems];
    }

    // Fetch content assets for social posts
    try {
      const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
      const calendarInstant = sql`CASE WHEN ${contentAssetsTable.status} = 'published' THEN COALESCE(${contentAssetsTable.publishedAt}, ${contentAssetsTable.scheduledPublishAt}, ${contentAssetsTable.createdAt}) ELSE COALESCE(${contentAssetsTable.scheduledPublishAt}, ${contentAssetsTable.publishedAt}, ${contentAssetsTable.createdAt}) END`;
      const assetConditions = [
        eq(contentAssetsTable.userId, userId),
        or(eq(contentAssetsTable.type, 'social_post'), isNotNull(contentAssetsTable.publishPlatform)),
        inArray(contentAssetsTable.status, ['scheduled', 'processing', 'published', 'failed', 'cancelled']),
      ];
      if (startDate) {
        const startUtc = timezone
          ? zonedStartOfDay(String(startDate), timezone)
          : new Date(new Date(`${startDate}T00:00:00.000Z`).getTime() + legacyOffset * 60_000);
        assetConditions.push(sql`${calendarInstant} >= ${startUtc}`);
      }
      if (endDate) {
        const endDateObject = new Date(`${endDate}T00:00:00.000Z`);
        endDateObject.setUTCDate(endDateObject.getUTCDate() + 1);
        const endExclusiveUtc = timezone
          ? zonedStartOfDay(endDateObject.toISOString().split('T')[0], timezone)
          : new Date(endDateObject.getTime() + legacyOffset * 60_000);
        assetConditions.push(sql`${calendarInstant} < ${endExclusiveUtc}`);
      }
      const assets = await db
        .select()
        .from(contentAssetsTable)
        .where(and(...assetConditions));

      // One bounded query supplies all drawer history; do not issue one request per card.
      const { socialPublishAttemptsTable } = await import('../models/socialPublishAttempts/schema.js');
      const attempts = assets.length ? await db.select({
        id: socialPublishAttemptsTable.id, assetId: socialPublishAttemptsTable.assetId,
        platform: socialPublishAttemptsTable.platform, status: socialPublishAttemptsTable.status,
        attemptCount: socialPublishAttemptsTable.attemptCount, maxAttempts: socialPublishAttemptsTable.maxAttempts,
        nextAttemptAt: socialPublishAttemptsTable.nextAttemptAt, errorCode: socialPublishAttemptsTable.errorCode,
        errorMessage: socialPublishAttemptsTable.errorMessage, providerPostUrl: socialPublishAttemptsTable.providerPostUrl,
        updatedAt: socialPublishAttemptsTable.updatedAt, completedAt: socialPublishAttemptsTable.completedAt,
        providerPostId: socialPublishAttemptsTable.providerPostId, providerSucceededAt: socialPublishAttemptsTable.providerSucceededAt,
        reviewedPayload: socialPublishAttemptsTable.reviewedPayload,
      }).from(socialPublishAttemptsTable).where(and(eq(socialPublishAttemptsTable.userId, userId), inArray(socialPublishAttemptsTable.assetId, assets.map((asset: { id: number }) => asset.id)))).orderBy(socialPublishAttemptsTable.id) : [];
      const { publishAttemptCapabilities } = await import('../services/social/OrganicPublishLifecycleService.js');
      const attemptsByAsset = new Map<number, Array<Omit<(typeof attempts)[number], 'reviewedPayload'> & { reviewedPayload: { privacyStatus?: string }; capabilities: ReturnType<typeof publishAttemptCapabilities> }>>();
      for (const attempt of attempts) {
        if (attempt.assetId) attemptsByAsset.set(attempt.assetId, [...(attemptsByAsset.get(attempt.assetId) || []), { ...attempt, reviewedPayload: { privacyStatus: attempt.reviewedPayload.privacyStatus }, capabilities: publishAttemptCapabilities(attempt) }]);
      }

      const assetItems = assets
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((asset: any) => {
          const dateObj = asset.status === 'published' ? (asset.publishedAt || asset.scheduledPublishAt || asset.createdAt) : (asset.scheduledPublishAt || asset.publishedAt || asset.createdAt);
          const scheduledDate = dateObj ? new Date(dateObj) : new Date();
          const scheduled_date = timezone
            ? formatDateForTimezone(scheduledDate, timezone)
            : formatDateForOffset(scheduledDate, legacyOffset);
          const scheduled_time = timezone
            ? formatTimeForTimezone(scheduledDate, timezone)
            : formatTimeForOffset(scheduledDate, legacyOffset);
          
          let postText = asset.content;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let parsedJson: Record<string, any> = {};
          try {
            parsedJson = JSON.parse(asset.content);
            postText = parsedJson.caption || parsedJson.content || parsedJson.message || parsedJson.body || asset.content;
          } catch {
            // Not JSON
          }

          const metadata = (asset.metadata || {}) as Record<string, unknown>;
          const reviewed = (metadata.reviewedPublishSnapshot || {}) as Record<string, unknown>;
          const rawPostType = reviewed.postType || metadata.postType || parsedJson.postType || parsedJson.post_type;
          const postType = (asset.imageUrls && asset.imageUrls.length > 1)
            ? 'carousel'
            : normalizeDisplayType(rawPostType);

          const platform = asset.publishPlatform || asset.channel || 'instagram';
          const assetAttempts = attemptsByAsset.get(asset.id) || [];
          const latestAttempt = assetAttempts.at(-1);

          return {
            id: asset.id,
            sourceKey: `asset-${asset.id}`,
            title: asset.title || 'Social Post',
            description: postText,
            content: postText,
            contentType: 'social',
            type: postType,
            channel: platform,
            platform: platform,
            scheduledDate: scheduled_date,
            scheduled_date: scheduled_date,
            scheduledTime: scheduled_time,
            scheduled_time: scheduled_time,
            scheduledAt: dateObj ? new Date(dateObj).toISOString() : undefined,
            status: latestAttempt?.status === 'ambiguous' ? 'ambiguous' : asset.status,
            providerBacked: true,
            publishAttempts: assetAttempts,
            contentAssetId: asset.id,
            version: asset.version,
            metadata: {
              ...metadata,
              ...(platform === 'youtube' ? { privacyStatus: reviewed.privacyStatus || 'private', youtubeOptions: reviewed.youtubeOptions, scheduleMode: 'upload_at_scheduled_time' } : {}),
              imageUrls: asset.imageUrls || (asset.imageUrl ? [asset.imageUrl] : []),
              videoUrls: asset.videoUrls || (asset.videoUrl ? [asset.videoUrl] : []),
              publishedUrl: asset.publishedUrl,
              publishedPostId: asset.publishedPostId,
              retryCount: asset.retryCount,
              lastError: asset.lastError,
            }
          };
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((item: any) => {
          // Filter by date range
          if (startDate && item.scheduled_date < (startDate as string)) return false;
          if (endDate && item.scheduled_date > (endDate as string)) return false;
          
          // Filter by channel
          if (channel && item.channel !== channel) return false;
          
          // Filter by status
          if (status && item.status !== status) return false;
          
          return true;
        });

      calendarItems = [...calendarItems, ...assetItems];
    } catch (assetErr) {
      logger.error({ err: assetErr }, '[ContentCalendar] Error fetching content assets for calendar');
      throw assetErr;
    }

    // Sort by scheduled date
    calendarItems.sort((a, b) => `${a.scheduled_date}T${a.scheduled_time}`.localeCompare(`${b.scheduled_date}T${b.scheduled_time}`));

    res.json({
      success: true,
      items: calendarItems,
      total: calendarItems.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentCalendar] Error getting calendar items');
    res.status(500).json({ success: false, error: 'Unable to load the content calendar. Please try again.' });
  }
}

/**
 * Create a new calendar item
 * POST /api/content-calendar
 */
export async function createCalendarItem(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { 
      title, 
      description, 
      contentType, 
      channel, 
      scheduledDate, 
      scheduledTime,
      contentAssetId,
      contentPlanId,
      metadata,
    } = req.body;

    if (!title || !contentType || !channel || !scheduledDate) {
      return res.status(400).json({
        success: false,
        error: 'title, contentType, channel, and scheduledDate are required',
      });
    }
    const scheduleError = validSchedule(scheduledDate, scheduledTime, req.body.timezone);
    if (scheduleError) return res.status(400).json({ success: false, error: scheduleError });

    const newItem: CalendarItem = {
      id: Date.now(), // Unique ID
      title: title.trim(),
      description,
      contentType,
      channel,
      scheduledDate,
      scheduledTime,
      status: 'planned',
      contentAssetId,
      metadata,
    };

    // If contentPlanId provided, add to existing plan's calendar
    if (contentPlanId) {
      const result = await mutateEditorialCalendar(contentPlanId, userId, calendar => {
        const item = { ...newItem, id: nextEditorialItemId(calendar) };
        return { calendar: [...calendar, item], item };
      });
      if (!result.success) return res.status(404).json(result);

      res.json({
        success: true,
        item: { ...result.item, contentPlanId },
      });
    } else {
      // Create a new standalone calendar plan
      const [newPlan] = await db
        .insert(contentPlansTable)
        .values({
          userId,
          name: `Calendar - ${title}`,
          contentType,
          status: 'draft',
          contentCalendar: [newItem],
        })
        .returning();

      res.json({
        success: true,
        item: { ...newItem, contentPlanId: newPlan.id },
      });
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentCalendar] Error creating calendar item');
    res.status(500).json({ success: false, error: 'Unable to add the calendar item. Please try again.' });
  }
}

/**
 * Update a calendar item
 * PUT /api/content-calendar/:itemId
 */
export async function updateCalendarItem(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const itemId = parseInt(req.params.itemId);
    const { contentPlanId, ...updates } = req.body;

    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid calendar item ID' });
    }
    if (!Number.isSafeInteger(contentPlanId) || contentPlanId <= 0) {
      return res.status(400).json({ success: false, error: 'contentPlanId is required' });
    }
    const allowedUpdates: Partial<CalendarItem> = {};
    if (updates.title !== undefined) {
      if (typeof updates.title !== 'string' || !updates.title.trim() || updates.title.length > 500) {
        return res.status(400).json({ success: false, error: 'title must contain 1–500 characters' });
      }
      allowedUpdates.title = updates.title.trim();
    }
    if (updates.description !== undefined) {
      if (typeof updates.description !== 'string' || updates.description.length > 50_000) {
        return res.status(400).json({ success: false, error: 'description is too long' });
      }
      allowedUpdates.description = updates.description;
    }
    if (updates.scheduledDate !== undefined) {
      if (!isValidDateOnly(updates.scheduledDate)) {
        return res.status(400).json({ success: false, error: 'scheduledDate must use YYYY-MM-DD' });
      }
      allowedUpdates.scheduledDate = updates.scheduledDate;
    }
    if (updates.scheduledTime !== undefined) {
      if (typeof updates.scheduledTime !== 'string' || !TIME_PATTERN.test(updates.scheduledTime)) {
        return res.status(400).json({ success: false, error: 'scheduledTime must use HH:mm' });
      }
      allowedUpdates.scheduledTime = updates.scheduledTime;
    }
    if (updates.contentType !== undefined && typeof updates.contentType === 'string' && updates.contentType.length <= 100) {
      allowedUpdates.contentType = updates.contentType;
    }
    if (updates.channel !== undefined && typeof updates.channel === 'string' && updates.channel.length <= 100) {
      allowedUpdates.channel = updates.channel;
    }
    if (updates.metadata !== undefined && updates.metadata && typeof updates.metadata === 'object' && !Array.isArray(updates.metadata)) {
      allowedUpdates.metadata = updates.metadata;
    }

    const result = await mutateEditorialCalendar(contentPlanId, userId, calendar => {
      const itemIndex = calendar.findIndex(item => item.id === itemId);
      if (itemIndex === -1) return undefined;
      const item = { ...calendar[itemIndex], ...allowedUpdates };
      return { calendar: calendar.map((previous, index) => index === itemIndex ? item : previous), item };
    });
    if (!result.success) return res.status(404).json(result);

    res.json({
      success: true,
      item: result.item,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentCalendar] Error updating calendar item');
    res.status(500).json({ success: false, error: 'Unable to update the calendar item. Please try again.' });
  }
}

/** Batch reschedule/cancel is bounded and idempotent. It only mutates assets the
 * current tenant owns, never calendar rows from another tenant. */
export async function bulkCalendarAction(req: AuthenticatedRequest, res: Response) {
  let claimedKey: string | undefined;
  try {
    const userId = businessOwnerUserId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const action = req.body?.action;
    const scope = req.body?.scope || 'single';
    if (!['single', 'group'].includes(scope)) return res.status(400).json({ error: 'scope must be single or group' });
    const assetIds: number[] = Array.isArray(req.body?.assetIds)
      ? [...new Set<number>(req.body.assetIds.map((value: unknown) => Number(value)))]
      : [];
    if (!['reschedule', 'cancel'].includes(action) || !assetIds.length || assetIds.length > 100 || assetIds.some(value => !Number.isSafeInteger(value) || value <= 0)) return res.status(400).json({ error: 'Provide 1–100 asset IDs and a supported action' });
    const expectedVersions = req.body?.expectedVersions as Record<number, number> | undefined;
    const expectedScheduledFor = req.body?.expectedScheduledFor as Record<number, string> | undefined;
    for (const [field, value] of Object.entries({ expectedVersions, expectedScheduledFor })) {
      if (value === undefined) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100 || Object.entries(value).some(([id, expected]) => !assetIds.includes(Number(id)) || (field === 'expectedVersions' ? !Number.isSafeInteger(expected) || Number(expected) < 1 : typeof expected !== 'string' || !Number.isFinite(new Date(expected).getTime())))) {
        return res.status(400).json({ error: `${field} must contain valid values for the selected assets` });
      }
    }
    const idem = typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key') : undefined;
    if (idem && (idem.length < 8 || idem.length > 200)) return res.status(400).json({ error: 'Invalid Idempotency-Key' });
    const key = idem ? businessCacheKey(`calendar-bulk:${userId}:${idem}`) : undefined;
    let scheduledFor: Date | undefined;
    if (action === 'reschedule') {
      const validation = validSchedule(req.body?.scheduledDate, req.body?.scheduledTime || '12:00', req.body?.timezone);
      if (validation) return res.status(400).json({ error: validation });
      const timezone = req.body.timezone || DEFAULT_BUSINESS_TIMEZONE;
      const resolved = zonedLocalDateTime(req.body.scheduledDate, String(req.body.scheduledTime || '12:00'), timezone);
      if ('error' in resolved) return res.status(400).json({ error: resolved.error });
      scheduledFor = resolved.instant;
      if (scheduledFor.getTime() <= Date.now() + 60_000) return res.status(400).json({ error: 'Schedule must be at least one minute in the future' });
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ action, scope, assetIds: [...assetIds].sort((a, b) => a - b), scheduledFor, expectedVersions, expectedScheduledFor })).digest('hex');
    if (key) {
      const claimed = await idempotencyService.checkAndStore(key, { ttlSeconds: 24 * 60 * 60, failClosed: true, cachedResponse: JSON.stringify({ fingerprint }) });
      if (claimed.status === 'error') return res.status(503).json({ error: 'Idempotency service unavailable; no changes made' });
      if (claimed.status === 'duplicate') {
        const previous = claimed.previousResponse ? JSON.parse(claimed.previousResponse) : null;
        if (previous?.fingerprint !== fingerprint) return res.status(409).json({ error: 'Idempotency key was used for a different calendar action' });
        return previous.body ? res.status(previous.statusCode).json(previous.body) : res.status(202).json({ success: false, inProgress: true });
      }
      claimedKey = key;
    }
    const { changeOrganicPublishSchedule } = await import('../services/social/OrganicPublishLifecycleService.js');
    const changed = await changeOrganicPublishSchedule(Number(userId), assetIds, scheduledFor, { exactAssetOnly: scope === 'single', expectedVersions, expectedScheduledFor });
    const response = { success: true, affected: changed.affected, action, scheduledFor: scheduledFor?.toISOString() };
    if (key) await idempotencyService.storeResponse(key, JSON.stringify({ fingerprint, statusCode: 200, body: response }));
    return res.json(response);
  } catch (error) {
    if (claimedKey) await idempotencyService.forget(claimedKey);
    return res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to update calendar' });
  }
}

/** Imports plan-only calendar entries. Publishing assets still go through the
 * explicit publishing endpoint so provider credentials and compliance checks run. */
export async function importCalendarItems(req: AuthenticatedRequest, res: Response) {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 100) return res.status(400).json({ error: 'items must contain 1–100 records' });
  const timezone = req.body?.timezone || DEFAULT_BUSINESS_TIMEZONE; if (!isValidTimezone(timezone)) return res.status(400).json({ error: 'timezone must be a valid IANA timezone' });
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500 || typeof item.channel !== 'string' || item.channel.length > 100 || validSchedule(item.scheduledDate, item.scheduledTime || '12:00', timezone)) return res.status(400).json({ error: 'An imported item is invalid' });
  }
  req.body = { ...req.body, title: 'Imported calendar', contentType: 'social', channel: 'calendar', scheduledDate: items[0].scheduledDate, scheduledTime: items[0].scheduledTime, contentPlanId: undefined };
  // Create the plan once then append normalized entries atomically in the existing storage shape.
  const userId = businessOwnerUserId(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const normalized = items.map((item: CalendarItem, index: number) => ({ ...item, id: Date.now() + index, title: item.title.trim(), contentType: item.contentType || 'social', scheduledTime: item.scheduledTime || '12:00', status: 'planned' as const }));
  const [plan] = await db.insert(contentPlansTable).values({ userId, name: `Calendar import ${new Date().toISOString()}`, contentType: 'social', status: 'draft', contentCalendar: normalized }).returning();
  return res.status(201).json({ success: true, imported: normalized.length, contentPlanId: plan.id });
}

/**
 * Delete a calendar item
 * DELETE /api/content-calendar/:itemId
 */
export async function deleteCalendarItem(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const itemId = parseInt(req.params.itemId);
    const { contentPlanId } = req.query;

    const parsedPlanId = Number(contentPlanId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid calendar item ID' });
    }
    if (!Number.isSafeInteger(parsedPlanId) || parsedPlanId <= 0) {
      return res.status(400).json({ success: false, error: 'contentPlanId is required' });
    }

    const result = await mutateEditorialCalendar(parsedPlanId, userId, calendar => ({ calendar: calendar.filter(item => item.id !== itemId) }));
    if (!result.success) return res.status(404).json(result);

    res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentCalendar] Error deleting calendar item');
    res.status(500).json({ success: false, error: 'Unable to delete the calendar item. Please try again.' });
  }
}

/**
 * Update item status (publish, cancel, etc.)
 * PATCH /api/content-calendar/:itemId/status
 */
export async function updateCalendarItemStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const itemId = parseInt(req.params.itemId);
    const { contentPlanId, status } = req.body;

    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid calendar item ID' });
    }
    if (!Number.isSafeInteger(contentPlanId) || contentPlanId <= 0 || !status) {
      return res.status(400).json({ success: false, error: 'contentPlanId and status are required' });
    }

    if (!CALENDAR_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Editorial entries can be draft, planned, or cancelled. Publish through the publishing review to track provider delivery.' });
    }

    const result = await mutateEditorialCalendar(contentPlanId, userId, calendar => {
      const itemIndex = calendar.findIndex(item => item.id === itemId);
      if (itemIndex === -1) return undefined;
      const item = { ...calendar[itemIndex], status };
      return { calendar: calendar.map((previous, index) => index === itemIndex ? item : previous), item };
    });
    if (!result.success) return res.status(404).json(result);

    res.json({
      success: true,
      item: result.item,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentCalendar] Error updating status');
    res.status(500).json({ success: false, error: 'Unable to update the item status. Please try again.' });
  }
}

/**
 * Get calendar summary/stats
 * GET /api/content-calendar/summary
 */
export async function getCalendarSummary(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const requestedTimezone = req.query.timezone;
    if (requestedTimezone !== undefined && !isValidTimezone(requestedTimezone)) return res.status(400).json({ success: false, error: 'timezone must be a valid IANA timezone' });
    const timezone = typeof requestedTimezone === 'string' ? requestedTimezone : DEFAULT_BUSINESS_TIMEZONE;
    const plans = await db
      .select()
      .from(contentPlansTable)
      .where(eq(contentPlansTable.userId, userId));

    let totalItems = 0;
    let draft = 0;
    let scheduled = 0;
    let published = 0;
    let cancelled = 0;
    let planned = 0;
    let failed = 0;
    let processing = 0;
    const channelCounts: Record<string, number> = {};
    const upcomingItems: CalendarItem[] = [];

    const today = formatDateForTimezone(new Date(), timezone);
    const nextWeek = formatDateForTimezone(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), timezone);

    for (const plan of plans) {
      const calendar = (plan.contentCalendar as CalendarItem[] | null) || [];
      
      for (const item of calendar) {
        totalItems++;
        
        const editorialStatus = editorialCalendarStatus(item.status);
        if (editorialStatus === 'draft') draft++;
        else if (editorialStatus === 'cancelled') cancelled++;
        else planned++;

        channelCounts[item.channel] = (channelCounts[item.channel] || 0) + 1;

        // Collect upcoming items for next week
        if (item.scheduledDate >= today && item.scheduledDate <= nextWeek && editorialStatus === 'planned') {
          upcomingItems.push({ ...item, status: 'planned', contentPlanId: plan.id });
        }
      }
    }

    // Fetch and aggregate content assets for social posts
    try {
      const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
      const assets = await db
        .select()
        .from(contentAssetsTable)
        .where(and(
          eq(contentAssetsTable.userId, userId),
          or(eq(contentAssetsTable.type, 'social_post'), isNotNull(contentAssetsTable.publishPlatform))
        ));

      for (const asset of assets) {
        totalItems++;
        
        if (asset.status === 'draft') draft++;
        else if (asset.status === 'scheduled') scheduled++;
        else if (asset.status === 'published') published++;
        else if (asset.status === 'cancelled') cancelled++;
        else if (asset.status === 'failed') failed++;
        else if (asset.status === 'processing') processing++;

        const platform = asset.publishPlatform || asset.channel || 'instagram';
        channelCounts[platform] = (channelCounts[platform] || 0) + 1;

        const dateObj = asset.scheduledPublishAt || asset.publishedAt || asset.createdAt;
        const scheduled_date = formatDateForTimezone(dateObj ? new Date(dateObj) : new Date(), timezone);

        if (scheduled_date >= today && scheduled_date <= nextWeek && (asset.status === 'scheduled' || asset.status === 'processing')) {
          upcomingItems.push({
            id: asset.id,
            title: asset.title || 'Social Post',
            contentType: 'social',
            channel: platform,
            scheduledDate: scheduled_date,
            scheduledTime: formatTimeForTimezone(dateObj ? new Date(dateObj) : new Date(), timezone),
            status: asset.status,
            contentAssetId: asset.id,
            ...(platform === 'youtube' ? { metadata: {
              privacyStatus: (asset.metadata?.reviewedPublishSnapshot as Record<string, unknown> | undefined)?.privacyStatus || 'private',
              youtubeOptions: (asset.metadata?.reviewedPublishSnapshot as Record<string, unknown> | undefined)?.youtubeOptions,
              scheduleMode: 'upload_at_scheduled_time',
            } } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
        }
      }
    } catch (assetErr) {
      logger.error({ err: assetErr }, '[ContentCalendar] Error getting content assets for summary');
      throw assetErr;
    }

    // Sort upcoming items by date
    upcomingItems.sort((a, b) => 
      new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
    );

    res.json({
      success: true,
      summary: {
        totalItems,
        byStatus: { draft, planned, scheduled, processing, published, failed, cancelled },
        byChannel: channelCounts,
        upcomingThisWeek: upcomingItems.slice(0, 10),
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentCalendar] Error getting summary');
    res.status(500).json({ success: false, error: 'Unable to load the calendar summary. Please try again.' });
  }
}
