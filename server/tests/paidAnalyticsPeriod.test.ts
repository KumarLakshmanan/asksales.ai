/** Paid campaign analytics by reporting period (Meta vs Google "this month"). */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
import type { ToolContext } from '../mastra/tools/toolRegistry.js';

const execute = jest.fn<any>();
const emit = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, select: jest.fn() } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({ webSocketEmitter: { emit } }));
const { executeAnalyticsQuery } = await import('../mastra/tools/executors/analyticsExecutor.js');
const { resolvePaidAnalyticsDateRange } = await import('../mastra/tools/executors/paidAnalyticsPeriod.js');
const { projectAnalyticsEvidence, describeAnalyticsEvidence } = await import('../mastra/utils/analyticsEvidence.js');
const { analyticsQueryTool } = await import('../mastra/tools/analyticsTools.js');

const now = new Date('2026-11-18T09:30:00Z');
const run = (filters: Record<string, unknown> | undefined) => withBusinessScope({ userId: 7, businessProfileId: 1 }, () =>
  executeAnalyticsQuery({ query_type: 'campaign', scope: 'all_owned', question: 'How are my ads doing?', filters } as never, { userId: 7, threadId: 235 } as ToolContext));

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [
    { id: 11, name: 'New Leads Campaign', platform: 'meta', currency: 'INR', impressions: 1000, clicks: 20, conversions: 2, spend: 300, conversion_value: 0, metric_rows: 5 },
    { id: 12, name: 'Search Campaign', platform: 'google', currency: 'INR', impressions: 0, clicks: 0, conversions: 0, spend: 0, conversion_value: 0, metric_rows: 0 },
  ] });
});

describe('reporting periods resolve to inclusive UTC dates', () => {
  it.each([
    ['today', '2026-11-18', '2026-11-18'],
    ['yesterday', '2026-11-17', '2026-11-17'],
    ['last_7_days', '2026-11-12', '2026-11-18'],
    ['last_30_days', '2026-10-20', '2026-11-18'],
    ['this_month', '2026-11-01', '2026-11-18'],
    ['last_month', '2026-10-01', '2026-10-31'],
    ['this_year', '2026-01-01', '2026-11-18'],
  ])('%s', (period, start, end) => {
    expect(resolvePaidAnalyticsDateRange({ period }, now)).toEqual({ start, end, period });
  });
  it('handles January for last month', () => {
    expect(resolvePaidAnalyticsDateRange({ period: 'last_month' }, new Date('2027-01-05T00:00:00Z'))).toMatchObject({ start: '2026-12-01', end: '2026-12-31' });
  });
  it('accepts explicit dates and rejects impossible or reversed ones', () => {
    expect(resolvePaidAnalyticsDateRange({ date_range: { start: '2026-11-01', end: '2026-11-15' } }, now)).toEqual({ start: '2026-11-01', end: '2026-11-15' });
    expect(() => resolvePaidAnalyticsDateRange({ date_range: { start: '2026-02-30', end: '2026-03-01' } }, now)).toThrow('real calendar dates');
    expect(() => resolvePaidAnalyticsDateRange({ date_range: { start: '2026-11-15', end: '2026-11-01' } }, now)).toThrow('starts after it ends');
  });
  it('means lifetime totals when nothing is requested', () => {
    expect(resolvePaidAnalyticsDateRange(undefined, now)).toBeNull();
    expect(resolvePaidAnalyticsDateRange({}, now)).toBeNull();
  });
});

describe('paid campaign analytics within a period', () => {
  it('counts only daily rows inside the period, with no lifetime fallback', async () => {
    const result = await run({ date_range: { start: '2026-11-01', end: '2026-11-18' } });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('pm.date >= $');
    expect(query.sql).toContain('pm.date <= $');
    expect(query.sql).not.toContain('pac.impressions');
    expect(query.sql).not.toContain('pac.spent_amount');
    expect(query.params).toEqual(expect.arrayContaining(['2026-11-01', '2026-11-18']));
    expect(result).toMatchObject({ success: true, output: { dateRange: { start: '2026-11-01', end: '2026-11-18' }, scopeLabel: 'Account-wide saved data · 2026-11-01 to 2026-11-18' } });
  });

  it('keeps lifetime totals and says so when no period is given', async () => {
    const result = await run(undefined);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('pac.impressions');
    expect(query.sql).not.toContain('pm.date >=');
    expect(result.output.dateRange).toBeUndefined();
    const text = describeAnalyticsEvidence(projectAnalyticsEvidence(result.output)!);
    expect(text).toContain('lifetime totals');
  });

  it('grounds a Meta vs Google comparison with platform and period', async () => {
    const result = await run({ period: 'this_month' });
    const evidence = projectAnalyticsEvidence(result.output)!;
    expect(evidence.dateRange).toMatchObject({ start: expect.stringMatching(/^\d{4}-\d{2}-01$/) });
    const text = describeAnalyticsEvidence(evidence);
    expect(text).toContain('Paid campaign period:');
    expect(text).toContain('Campaign #11 (meta)');
    expect(text).toContain('Campaign #12 (google)');
  });

  it('returns a clear error for impossible dates instead of querying', async () => {
    const result = await run({ date_range: { start: '2026-11-31', end: '2026-12-01' } });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('real calendar dates') });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets the agent pass a named period through the tool schema', () => {
    const schema = (analyticsQueryTool as unknown as { inputSchema: { parse: (value: unknown) => unknown } }).inputSchema;
    expect(() => schema.parse({ question: 'q', query_type: 'campaign', filters: { period: 'this_month' } })).not.toThrow();
    expect(() => schema.parse({ question: 'q', query_type: 'campaign', filters: { date_range: { start: '2026-11-01', end: '2026-11-18' } } })).not.toThrow();
    expect(() => schema.parse({ question: 'q', query_type: 'campaign', filters: { period: 'forever' } })).toThrow();
  });
});
