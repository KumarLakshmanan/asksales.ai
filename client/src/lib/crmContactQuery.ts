import { CRM_REPORT_PLATFORMS } from '@/lib/crm-configuration';

export type CrmContactSort = 'lastActivityAt' | 'createdAt' | 'name' | 'dealValue' | 'priority' | 'nextFollowUpAt';
export interface CrmContactFilters {
  search?: string;
  pipelineStatus?: string;
  priority?: string;
  tag?: string;
  ownerUserId?: string;
  followup?: string;
  sortBy?: CrmContactSort;
  sortOrder?: 'asc' | 'desc';
  platforms?: string[];
  dateRange?: string;
  from?: string;
  to?: string;
}
export interface CrmContactQuery extends CrmContactFilters {
  page: number;
  limit: number;
  threadId?: string;
}
/** Lists, stage columns, CSV exports and report drill-downs share server filters. */
export function crmContactParams(filters: Partial<CrmContactQuery>) {
  const query = new URLSearchParams();
  for (const field of ['page', 'limit', 'search', 'pipelineStatus', 'threadId', 'priority', 'tag', 'ownerUserId', 'followup', 'sortBy', 'sortOrder', 'dateRange', 'from', 'to'] as const) {
    const value = filters[field];
    if (value === undefined || value === null || value === '' || (value === 'all' && field !== 'dateRange')) continue;
    query.set(field, typeof value === 'string' ? value.trim() : String(value));
  }
  if (filters.platforms?.length && !filters.platforms.includes('all')) query.set('platforms', filters.platforms.join(','));
  return query;
}
export function crmContactQuery(filters: CrmContactQuery) {
  return `/api/crm/contacts?${crmContactParams(filters)}`;
}
export const DEFAULT_CONTACT_FILTERS: CrmContactFilters = { search: '', pipelineStatus: 'all', priority: 'all', tag: '', ownerUserId: 'all', followup: 'all', sortBy: 'lastActivityAt', sortOrder: 'desc' };

/** Only supported fields can be restored from a URL or a saved local view. */
export function readCrmContactFilters(values: Record<string, unknown>): CrmContactFilters {
  const filters = { ...DEFAULT_CONTACT_FILTERS };
  for (const field of ['search', 'pipelineStatus', 'tag'] as const) if (typeof values[field] === 'string') filters[field] = (values[field] as string).slice(0, 200);
  if (['all', 'low', 'medium', 'high'].includes(String(values.priority))) filters.priority = String(values.priority);
  if (['all', 'overdue', 'upcoming', 'none'].includes(String(values.followup))) filters.followup = String(values.followup);
  if (values.ownerUserId === 'unassigned' || /^\d+$/.test(String(values.ownerUserId))) filters.ownerUserId = String(values.ownerUserId);
  if (['lastActivityAt', 'createdAt', 'name', 'dealValue', 'priority', 'nextFollowUpAt'].includes(String(values.sortBy))) filters.sortBy = values.sortBy as CrmContactSort;
  if (values.sortOrder === 'asc' || values.sortOrder === 'desc') filters.sortOrder = values.sortOrder;
  const channels = typeof values.platforms === 'string' ? values.platforms.split(',') : Array.isArray(values.platforms) ? values.platforms : [];
  const platforms = channels.filter((value): value is string => typeof value === 'string' && CRM_REPORT_PLATFORMS.some(platform => platform.value !== 'all' && platform.value === value));
  if (platforms.length) filters.platforms = [...new Set(platforms)];
  if (['7d', '30d', '90d', 'all', 'custom'].includes(String(values.dateRange))) filters.dateRange = String(values.dateRange);
  for (const field of ['from', 'to'] as const) if (typeof values[field] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(values[field] as string)) filters[field] = values[field] as string;
  return filters;
}
