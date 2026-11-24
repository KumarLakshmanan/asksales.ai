import { z } from 'zod';
import { CRM_REPORT_PLATFORMS, crmSelectedPlatforms, isCrmCalendarDate, type CrmConfiguration } from '../../shared/crmConfiguration.js';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isCrmCalendarDate, 'Choose a valid calendar date');
const dateInput = z.union([calendarDate, z.string().datetime({ offset: true })]);
const owner = z.union([z.literal('unassigned'), z.coerce.number().int().positive()]);
const booleanQuery = z.enum(['true', 'false', '1', '0']).transform(value => value === 'true' || value === '1');
const platforms = z.preprocess(value => typeof value === 'string' ? value.split(',') : value,
  z.array(z.enum(CRM_REPORT_PLATFORMS.map(item => item.value) as [string, ...string[]])).min(1).max(9)
    .refine(values => new Set(values).size === values.length, 'Choose each platform once')
    .refine(values => values.length === 1 || !values.includes('all'), 'All platforms cannot be combined with individual platforms'));

export const crmReportQuerySchema = z.object({
  platforms: platforms.optional(), platform: platforms.optional(),
  dateRange: z.enum(['7d', '30d', '90d', 'all', 'custom']).optional(),
  from: calendarDate.optional(), to: calendarDate.optional(),
  dateStart: calendarDate.optional(), dateEnd: calendarDate.optional(),
}).passthrough().refine(query => !(query.from || query.dateStart) || !(query.to || query.dateEnd)
  || (query.from || query.dateStart)! <= (query.to || query.dateEnd)!, 'Start date must be before end date');

export const crmContactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  search: z.string().trim().max(200).optional(),
  status: z.string().max(50).optional(), pipelineStatus: z.string().max(50).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(), tag: z.string().trim().max(50).optional(),
  assignedTo: owner.optional(), ownerUserId: owner.optional(),
  followup: z.enum(['overdue', 'upcoming', 'none']).optional(), needsFollowUp: booleanQuery.optional(),
  sortBy: z.enum(['lastActivityAt', 'createdAt', 'name', 'dealValue', 'priority', 'nextFollowUpAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(), threadId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).merge(crmReportQuerySchema).refine(query => !(query.from || query.dateStart) || !(query.to || query.dateEnd)
  || (query.from || query.dateStart)! <= (query.to || query.dateEnd)!, 'Start date must be before end date');

export const crmHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(), type: z.string().max(100).optional(),
  channel: z.string().max(50).optional(), unread: booleanQuery.optional(),
  from: dateInput.optional(), to: dateInput.optional(), status: z.string().max(50).optional(),
  sentPage: z.coerce.number().int().min(1).max(1_000_000).default(1),
  sentLimit: z.coerce.number().int().min(1).max(100).default(20),
  messageLimit: z.coerce.number().int().min(1).max(50).default(20),
  beforeMessageId: z.coerce.number().int().positive().optional(),
  view: z.enum(['all', 'conversations', 'sent']).default('all'),
}).refine(query => !query.from || !query.to || new Date(query.from) <= new Date(query.to), 'Start date must be before end date')
  .refine(query => !query.beforeMessageId || query.page === 1, 'Use the message cursor without a page offset');

export const crmBulkContactSchema = z.object({
  contactIds: z.array(z.number().int().refine(value => value !== 0)).min(1).max(100)
    .refine(values => new Set(values).size === values.length, 'Choose each contact once'),
  addTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  removeTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  pipelineStatus: z.string().trim().min(1).max(50).optional(),
  assignedTo: z.number().int().positive().nullable().optional(), ownerUserId: z.number().int().positive().nullable().optional(),
}).strict().refine(value => value.addTags?.length || value.removeTags?.length || value.pipelineStatus
  || value.assignedTo !== undefined || value.ownerUserId !== undefined, 'Choose a bulk action');

export const crmWorkQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['all', 'reminder', 'conversation', 'stuck_contact', 'ticket']).default('all'),
  assignedTo: owner.optional(), ownerUserId: owner.optional(), search: z.string().trim().max(200).optional(),
});

export type CrmHistoryQuery = z.infer<typeof crmHistoryQuerySchema>;
export type CrmContactFilters = z.infer<typeof crmContactsQuerySchema> & { offset?: number };
export type CrmBulkContactUpdate = z.infer<typeof crmBulkContactSchema>;
export type CrmWorkQuery = z.infer<typeof crmWorkQuerySchema>;

export function crmDateBounds(preferences: CrmConfiguration['preferences'], input: Record<string, unknown> = {}) {
  const range = String(input.dateRange ?? preferences.dateRange);
  const saved = preferences as typeof preferences & { dateStart?: string; dateEnd?: string };
  const from = String(input.from ?? input.dateStart ?? (range === 'custom' ? saved.dateStart ?? '' : ''));
  const to = String(input.to ?? input.dateEnd ?? (range === 'custom' ? saved.dateEnd ?? '' : ''));
  if (range === 'custom' && (!from || !to)) throw new z.ZodError([{ code: z.ZodIssueCode.custom,path: ['dateRange'],message: 'Choose both dates for a custom date range.' }]);
  if (from) calendarDate.parse(from);
  if (to) calendarDate.parse(to);
  if (from && to && from > to) throw new z.ZodError([{ code: z.ZodIssueCode.custom,path: ['from'],message: 'Start date must be before end date.' }]);
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null;
  return { from: from ? new Date(`${from}T00:00:00Z`) : days ? new Date(Date.now() - days * 86_400_000) : null,
    to: to ? new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000) : null,
    dateRange: range, dateStart: from || null, dateEnd: to || null };
}

export function crmReportPlatforms(configuration: CrmConfiguration, query: Record<string, unknown>) {
  const values = query.platforms ?? query.platform;
  return values === undefined ? crmSelectedPlatforms(configuration.preferences) : platforms.parse(values);
}

export function crmHistoryDateBounds(query: Pick<CrmHistoryQuery, 'from' | 'to'>) {
  return { from: query.from ? new Date(query.from) : null,
    to: query.to ? new Date(new Date(query.to).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? 86_400_000 : 0)) : null };
}

export function crmPagination(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total };
}

export function crmCsvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  const firstContentCharacter = Array.from(text).find(character => character.charCodeAt(0) > 0x1f && !/\s/.test(character));
  const protectedText = firstContentCharacter && '=+-@'.includes(firstContentCharacter) ? `'${text}` : text;
  return `"${protectedText.replace(/"/g, '""')}"`;
}
