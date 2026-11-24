import { describe, expect, it } from 'vitest';
import { crmContactParams, crmContactQuery, readCrmContactFilters } from '@/lib/crmContactQuery';
import { crmSavedViewKey, parseCrmSavedViews } from '@/lib/crmSavedViews';

describe('CRM collection query contracts', () => {
  it('carries exact server filters into paging, exports and drill-downs', () => {
    const filters = { search: '  Mina & Co  ', pipelineStatus: 'qualified', priority: 'high', ownerUserId: '7', followup: 'overdue', tag: 'customer success', sortBy: 'dealValue' as const, sortOrder: 'asc' as const, platforms: ['email', 'sms'], dateRange: 'custom', from: '2026-09-01', to: '2026-09-30' };
    const url = new URL(crmContactQuery({ ...filters, page: 2, limit: 20 }), 'https://example.test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ page: '2', limit: '20', search: 'Mina & Co', pipelineStatus: 'qualified', ownerUserId: '7', followup: 'overdue', tag: 'customer success', platforms: 'email,sms', sortBy: 'dealValue', sortOrder: 'asc', from: '2026-09-01', to: '2026-09-30' });
    const exportParams = crmContactParams(filters);
    expect(exportParams.has('page')).toBe(false);
    expect(exportParams.get('search')).toBe('Mina & Co');
  });
  it('omits all-platform and all-stage filters while retaining unassigned and numeric contact references', () => {
    const params = crmContactParams({ page: 1, limit: 20, pipelineStatus: 'all', platforms: ['all'], ownerUserId: 'unassigned', threadId: 'campaign-1', dateRange: 'all' });
    expect(params.has('pipelineStatus')).toBe(false);
    expect(params.has('platforms')).toBe(false);
    expect(params.get('ownerUserId')).toBe('unassigned');
    expect(params.get('threadId')).toBe('campaign-1');
    expect(params.get('dateRange')).toBe('all');
  });
  it('retains the exact Gmail report channel separately from Email through restore and export parameters', () => {
    const gmail = readCrmContactFilters({ platforms: 'gmail', dateRange: '30d' });
    expect(gmail.platforms).toEqual(['gmail']);
    expect(crmContactParams(gmail).get('platforms')).toBe('gmail');
    expect(readCrmContactFilters({ platforms: 'email', dateRange: '30d' }).platforms).toEqual(['email']);
    expect(readCrmContactFilters({ platforms: 'gmail,email,gmail' }).platforms).toEqual(['gmail', 'email']);
  });
  it('rejects unsupported persisted filters and preserves report cohorts', () => {
    const filters = readCrmContactFilters({ sortBy: 'DROP TABLE contacts', sortOrder: 'sideways', ownerUserId: '-1', followup: 'send', platforms: ['email', 'javascript:alert(1)', 'email'], from: 'not-a-date', to: '2026-09-30', dateRange: 'custom' });
    expect(filters).toMatchObject({ sortBy: 'lastActivityAt', sortOrder: 'desc', ownerUserId: 'all', followup: 'all', platforms: ['email'], dateRange: 'custom', to: '2026-09-30' });
    expect(filters.from).toBeUndefined();
  });
});

describe('CRM saved views', () => {
  it('keeps account and business storage namespaces separate', () => {
    expect(crmSavedViewKey('1:7')).not.toBe(crmSavedViewKey('1:8'));
    expect(crmSavedViewKey('1:7')).not.toBe(crmSavedViewKey('2:7'));
  });
  it('recovers from malformed storage without applying arbitrary properties', () => {
    expect(parseCrmSavedViews('{oops')).toEqual([]);
    expect(parseCrmSavedViews('{}')).toEqual([]);
    const views = parseCrmSavedViews(JSON.stringify([{ id: 'view-1', name: 'My follow-ups', filters: { ownerUserId: '7', followup: 'overdue', unsafe: 'true' } }, { id: 6, name: 'invalid', filters: {} }]));
    expect(views).toHaveLength(1);
    expect(views[0].filters).toMatchObject({ ownerUserId: '7', followup: 'overdue' });
    expect(views[0].filters).not.toHaveProperty('unsafe');
  });
  it('bounds saved views and names before rendering browser storage', () => {
    const views = parseCrmSavedViews(JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: 'x'.repeat(100), filters: {} }))));
    expect(views).toHaveLength(20);
    expect(views.every(view => view.name.length === 80)).toBe(true);
  });
});
