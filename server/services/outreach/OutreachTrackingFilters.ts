import { z } from 'zod';
import { outreachReportChannels } from '../../../shared/campaignReporting.js';
import { MAX_DAILY_RANGE_DAYS, recipientFilters } from '../../../shared/outreachTracking.js';
import { canonicalTimeZone } from '../../../shared/timeZones.js';

const text = (max: number) => z.string().trim().min(1).max(max);

export const batchIdSchema = z.string().uuid();


export const messageKindSchema = z.enum(['outreach', 'follow_up', 'all']).default('outreach');

export const recipientListSchema = z.object({
  status: z.enum(recipientFilters).default('all'),
  kind: messageKindSchema,
  q: text(200).optional(),
  cursor: z.coerce.number().int().positive().max(2147483647).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type RecipientListFilters = z.infer<typeof recipientListSchema>;

export const failureListSchema = z.object({ kind: messageKindSchema }).strict();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Enter a real date.');
/** An IANA zone name. It is only ever bound as a query parameter, never interpolated. */
export const timezoneSchema = z.string().trim().min(1).max(64).default('UTC').refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Choose a valid timezone.').transform(value => canonicalTimeZone(value));
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** `from` and `to` pick outreaches by the local day they started on; both are included and either may be left out. */
export const batchListSchema = z.object({
  channel: z.enum(outreachReportChannels).optional(),
  state: z.enum(['all', 'active', 'finished']).default('all'),
  q: text(200).optional(),
  templateName: text(512).optional(),
  from: day.optional(),
  to: day.optional(),
  tz: timezoneSchema,
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && dayCount(value.from, value.to) < 1)
    context.addIssue({ code: 'custom', path: ['to'], message: 'The end date must not be before the start date.' });
});
export type BatchListFilters = z.infer<typeof batchListSchema>;

/** Both dates are included. */
export const dailyActivitySchema = z.object({
  from: day, to: day, tz: timezoneSchema, kind: messageKindSchema,
  channel: z.enum(outreachReportChannels).optional(),
  templateName: text(512).optional(),
}).strict().superRefine((value, context) => {
  const days = dayCount(value.from, value.to);
  if (days < 1) context.addIssue({ code: 'custom', path: ['to'], message: 'The end date must not be before the start date.' });
  if (days > MAX_DAILY_RANGE_DAYS) context.addIssue({ code: 'custom', path: ['to'], message: `Choose ${MAX_DAILY_RANGE_DAYS} days or fewer.` });
});
export type DailyActivityFilters = z.infer<typeof dailyActivitySchema>;

export const recipientExportSchema = z.object({
  status: z.enum(recipientFilters).default('all'), kind: messageKindSchema, tz: timezoneSchema,
}).strict();

export const templatePerformanceSchema = z.object({
  from: day, to: day, tz: timezoneSchema, channel: z.enum(outreachReportChannels).optional(), q: text(200).optional(),
}).strict().superRefine((value, context) => {
  const days = dayCount(value.from, value.to);
  if (days < 1) context.addIssue({ code: 'custom', path: ['to'], message: 'The end date must not be before the start date.' });
  if (days > MAX_DAILY_RANGE_DAYS) context.addIssue({ code: 'custom', path: ['to'], message: `Choose ${MAX_DAILY_RANGE_DAYS} days or fewer.` });
});

/** `until` is the last local day to show; the service clamps it to today and the furthest day allowed. */
export const upcomingSchema = z.object({
  until: day.optional(), tz: timezoneSchema, channel: z.enum(outreachReportChannels).optional(),
}).strict();

export const batchRenameSchema = z.object({ name: z.string().trim().min(1, 'Enter a name.').max(200) }).strict();
