import { readCrmContactFilters, type CrmContactFilters } from './crmContactQuery';

export interface CrmSavedView { id: string; name: string; filters: CrmContactFilters }
export const crmSavedViewKey = (scope: string) => `crm-contact-views:${scope}`;
export function parseCrmSavedViews(raw: string | null): CrmSavedView[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && typeof value.id === 'string' && typeof value.name === 'string' && Boolean(value.filters) && typeof value.filters === 'object')
      .slice(0, 20).map(value => ({ id: String(value.id).slice(0, 100), name: String(value.name).slice(0, 80), filters: readCrmContactFilters(value.filters as Record<string, unknown>) }));
  } catch { return []; }
}
