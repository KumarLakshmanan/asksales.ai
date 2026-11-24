import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(query: SQL) => Promise<{ rows: Array<Record<string, unknown>> }>>();
jest.unstable_mockModule('../models/db', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));

const addJob = jest.fn<(...args: unknown[]) => Promise<string>>();
const waitForJobResult = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: { PERFORMANCE_SYNC: 'performance-sync' },
  queueRegistry: { addJob, waitForJobResult },
}));

const { AnalyticsIngestionService, CAMPAIGN_SELECTION_TIMEOUT_MS, managedCampaignsQuery } = await import('../services/AnalyticsIngestionService.js');
const { currentStatementTimeoutMs, withStatementTimeout } = await import('../tenancy/statementTimeout.js');
const { fetchMetricsNow } = await import('../controllers/campaignAnalyticsController.js');

const dialect = new PgDialect();
const compile = (query: SQL) => dialect.sqlToQuery(query);
const flat = (text: string) => text.replace(/\s+/g, ' ');

function response() {
  const res = { statusCode: 200, body: undefined as unknown, status: undefined as unknown, json: undefined as unknown };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: unknown) => { res.body = body; return res; });
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('analytics sync campaign selection', () => {
  beforeEach(() => { execute.mockReset(); addJob.mockReset(); waitForJobResult.mockReset(); });

  it('computes the schedule back-off once per campaign instead of once per historical run', () => {
    const { sql } = compile(managedCampaignsQuery(undefined, true));
    const text = flat(sql);
    // The old form compared every run's completed_at against a window that was
    // itself recomputed (failure COUNT + latest success MAX) for that run.
    expect(text).not.toMatch(/sync_run\.completed_at > NOW\(\)/);
    expect(text).not.toMatch(/MAX\(recovered\.completed_at\)/);
    expect(text).toContain('ORDER BY latest.completed_at DESC LIMIT 1');
    expect(text).toContain('ORDER BY recovered.completed_at DESC LIMIT 1');
    // At most seven failures are ever read per campaign.
    expect(text).toMatch(/LIMIT 7 \) recent_failures/);
    // One schedule check per branch, plus the legacy "no provider resource" check.
    expect(text.match(/AND NOT EXISTS \( SELECT 1 FROM \( SELECT/g)).toHaveLength(2);
    expect(text.match(/AND NOT EXISTS/g)).toHaveLength(3);
  });

  it('skips the schedule lookups entirely for a manual refresh and filters the owner in both branches', () => {
    const { sql, params } = compile(managedCampaignsQuery(9, false));
    expect(sql).not.toContain('ad_analytics_sync_runs');
    expect(flat(sql).match(/AND pac\.user_id = \$\d+/g)).toHaveLength(2);
    expect(params.filter(value => value === 9)).toHaveLength(2);
  });

  it('runs the selection under a bound no longer than one minute or the caller\'s', async () => {
    const seen: Array<number | undefined> = [];
    // Like Drizzle: nothing runs (no connection, no bound read) until awaited.
    execute.mockImplementation(() => ({
      then(resolve: (value: { rows: unknown[] }) => void) { seen.push(currentStatementTimeoutMs()); resolve({ rows: [] }); },
    }) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>);
    const service = new AnalyticsIngestionService();
    await service.ingestAllCampaigns('2026-11-10', '2026-11-16', undefined, true);
    await withStatementTimeout(25_000, () => service.ingestAllCampaigns('2026-11-16', '2026-11-16', 9));
    expect(seen).toEqual([CAMPAIGN_SELECTION_TIMEOUT_MS, 25_000]);
  });

  it('does not start a second poll while one is running in this process', async () => {
    let finish!: () => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ rows: [] }); }));
    execute.mockResolvedValue({ rows: [] });
    const first = new AnalyticsIngestionService().pollForMetrics();
    await new Promise(resolve => setImmediate(resolve));
    const second = await new AnalyticsIngestionService().pollForMetrics();
    expect(second).toEqual({ success: true, campaignsUpdated: 0 });
    finish();
    await first;
    expect(execute.mock.calls.filter(([query]) => compile(query).sql.includes('ad_analytics_sync_runs latest')).length).toBe(1);
  });
});

describe('POST /api/campaigns/analytics/fetch-now', () => {
  beforeEach(() => { execute.mockReset(); addJob.mockReset(); waitForJobResult.mockReset(); });

  const request = (body: Record<string, unknown>) => ({ user: { id: 9 }, body } as unknown as Request);

  it('queues the refresh, joins repeated clicks and returns the worker result', async () => {
    addJob.mockResolvedValue('job-1');
    waitForJobResult.mockResolvedValue({ metricsUpdated: 3, errors: [] });
    const res = response();
    await fetchMetricsNow(request({ dateStart: '2026-11-10', dateStop: '2026-11-16' }), res);
    expect(execute).not.toHaveBeenCalled();
    const [queue, name, payload, options] = addJob.mock.calls[0] as [string, string, Record<string, unknown>, Record<string, unknown>];
    expect([queue, name]).toEqual(['performance-sync', 'fetch-campaign-metrics']);
    expect(payload).toMatchObject({ userId: 9, type: 'fetch-campaign-metrics', input: { dateStart: '2026-11-10', dateStop: '2026-11-16' } });
    expect(options).toMatchObject({ attempts: 1, deduplication: { id: 'campaign-metrics-9-2026-11-10-2026-11-16' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, metricsUpdated: 3, partialSuccess: false });
  });

  it('answers 202 instead of holding the request when the worker needs longer', async () => {
    addJob.mockResolvedValue('job-2');
    waitForJobResult.mockRejectedValue(new Error('Job wait fetch-campaign-metrics timed out before finishing, no finish notification arrived after 20000ms (id=job-2)'));
    const res = response();
    await fetchMetricsNow(request({}), res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ success: true, queued: true, jobId: 'job-2' });
  });

  it('reports a refresh where every campaign failed as 502', async () => {
    addJob.mockResolvedValue('job-3');
    waitForJobResult.mockResolvedValue({ metricsUpdated: 0, errors: ['Reconnect Meta Ads'] });
    const res = response();
    await fetchMetricsNow(request({}), res);
    expect(res.statusCode).toBe(502);
  });
});
