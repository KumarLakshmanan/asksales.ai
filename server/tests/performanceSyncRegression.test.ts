import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { aggregateSocialSnapshots, createSourceSnapshotId, immediatelyPreviousPeriod, selectCurrentSocialSnapshots } from '../controllers/socialAnalyticsController.js';
import { describeMetaGraphFailure, fetchMetaInsightRows } from '../controllers/performanceMarketingController.js';
import { aggregateProviderReportingWindow, providerReportingWindow } from '../services/ads/ProviderReportingWindow.js';
import { runProviderSync } from '../services/PerformanceProviderSyncService.js';
import { db } from '../models/db.js';

const snapshot = (id: string, metrics: Record<string, number>, overrides: Record<string, unknown> = {}) => ({
  id, platform: 'instagram', account_identifier: 'owned-account', source: 'official_api', source_snapshot_id: id,
  metric_window_start: '2026-09-01T00:00:00Z', metric_window_end: '2026-09-01T23:59:59Z',
  captured_at: '2026-09-02T00:00:00Z', metrics, ...overrides,
});

describe('performance sync regression coverage', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('keeps the newest correction and complementary metrics for a measurement day', () => {
    const rows = selectCurrentSocialSnapshots([
      snapshot('old', { views: 10, engagements: 2 }),
      snapshot('new', { views: 15 }, { captured_at: '2026-09-03T00:00:00Z' }),
      snapshot('reach', { reach: 8 }),
    ]);
    expect(aggregateSocialSnapshots(rows).totals).toEqual({ views: 15, engagements: 2, reach: 8 });
  });

  it('does not sum overlapping monthly totals with daily evidence or plot monthly spikes', () => {
    const monthly = snapshot('month', { views: 100 }, { metric_window_end: '2026-09-30T23:59:59Z' });
    expect(aggregateSocialSnapshots(selectCurrentSocialSnapshots([monthly, snapshot('day', { views: 10 })])).totals.views).toBe(10);
    expect(aggregateSocialSnapshots([monthly]).trend.size).toBe(0);
  });

  it('retains distinct YouTube videos while replacing only their own revisions', () => {
    const rows = selectCurrentSocialSnapshots([
      snapshot('youtube:1:a:2026-09-01', { views: 10, average_view_duration_seconds: 30 }, { platform: 'youtube' }),
      snapshot('youtube:1:b:2026-09-01', { views: 30, average_view_duration_seconds: 10 }, { platform: 'youtube' }),
    ]);
    const totals = aggregateSocialSnapshots(rows).totals;
    expect(totals.views).toBe(40);
    expect(totals.average_view_duration_seconds).toBe(15);
  });

  it('treats follower count as a latest balance rather than accumulating daily balances', () => {
    const totals = aggregateSocialSnapshots([
      snapshot('first', { followers: 100 }),
      snapshot('second', { followers: 110 }, { metric_window_start: '2026-09-02T00:00:00Z', metric_window_end: '2026-09-02T23:59:59Z' }),
    ]).totals;
    expect(totals.followers).toBe(110);
  });

  it('compares social growth with the immediately preceding equal-length period', () => {
    expect(immediatelyPreviousPeriod(new Date('2026-09-08T00:00:00Z'), new Date('2026-09-15T00:00:00Z'))).toEqual({
      start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-09-08T00:00:00Z'),
    });
  });

  it('versions corrected official metrics without depending on JSON key order', () => {
    const input = { userId: 1, platform: 'instagram' as const, accountIdentifier: 'owned', source: 'official_api', sourceSnapshotId: 'day', windowStart: new Date('2026-09-01'), windowEnd: new Date('2026-09-02'), metrics: { views: 10, reach: 5 } };
    expect(createSourceSnapshotId(input)).toBe(createSourceSnapshotId({ ...input, metrics: { reach: 5, views: 10 } }));
    expect(createSourceSnapshotId(input)).not.toBe(createSourceSnapshotId({ ...input, metrics: { views: 11, reach: 5 } }));
  });

  it('filters provider KPIs by the selected window and weights ratio metrics', () => {
    const raw = { dailyInsights: [
      { date: '2026-08-31', spend: 100, clicks: 100, impressions: 1000 },
      { date: '2026-09-01', spend: 20, clicks: 4, impressions: 100, conversions: 2 },
      { date: '2026-09-02', spend: 10, clicks: 2, impressions: 50, conversions: 1 },
    ] };
    const result = aggregateProviderReportingWindow(raw, '2026-09-01', '2026-09-02');
    expect(result).toMatchObject({ spend: 30, clicks: 6, impressions: 150, conversions: 3, cpc: 5, ctr: 4 });
    expect(providerReportingWindow('last_7d', new Date('2026-09-09T20:00:00Z'))).toEqual({ start: '2026-09-03', end: '2026-09-09' });
  });

  it('reads later provider pages and refuses to send authorization outside Meta', async () => {
    const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'one' }], paging: { next: 'https://graph.facebook.com/v25.0/account/campaigns?after=2' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'two' }] })));
    await expect(fetchMetaInsightRows('https://graph.facebook.com/v25.0/account/campaigns', 'test-token')).resolves.toEqual([{ id: 'one' }, { id: 'two' }]);
    await expect(fetchMetaInsightRows('https://untrusted.example/campaigns', 'test-token')).rejects.toThrow('invalid insights page URL');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('translates Meta access errors into safe, actionable campaign diagnostics', () => {
    const inaccessible = describeMetaGraphFailure(400, {
      code: 100,
      error_subcode: 33,
      message: 'Unsupported get request for private campaign token=do-not-leak',
    }, 'campaign ad sets');
    expect(inaccessible).toContain('reconnect the Meta account that owns them');
    expect(inaccessible).toContain('Meta code 100, subcode 33');
    expect(inaccessible).not.toContain('private campaign');
    expect(inaccessible).not.toContain('do-not-leak');

    expect(describeMetaGraphFailure(400, { code: 190 }, 'campaign insights'))
      .toContain('authorization needs to be renewed');
    expect(describeMetaGraphFailure(403, {}, 'campaign ads'))
      .toContain('Check Ads Management permissions');
  });

  it('does not run a provider sync when another worker owns its lease', async () => {
    jest.spyOn(db, 'execute').mockResolvedValueOnce({ rows: [] });
    const sync = jest.fn<() => Promise<{ status: number; body: Record<string, unknown> }>>();
    expect(await runProviderSync(1, 'social', '22', 30, sync)).toBeNull();
    expect(sync).not.toHaveBeenCalled();
  });

  it('keeps a forced reporting refresh inside the provider cooldown without making another API call', async () => {
    jest.spyOn(db, 'execute').mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ retry_after: '120' }] });
    const sync = jest.fn<() => Promise<{ status: number; body: Record<string, unknown> }>>();
    await expect(runProviderSync(9, 'paid_meta', 'account:2', 30, sync, true)).resolves.toMatchObject({ status: 429, body: { code: 'META_REPORTING_RATE_LIMITED', retryAfterSeconds: 120 } });
    expect(sync).not.toHaveBeenCalled();
  });

  it('releases failed leases with a safe retry outcome, without exposing provider secrets', async () => {
    const execute = jest.spyOn(db, 'execute').mockResolvedValueOnce({ rows: [{ user_id: 1 }] }).mockResolvedValueOnce({ rows: [] });
    const result = await runProviderSync(1, 'social', '22', 30, async () => { throw new Error('access_token=private'); });
    expect(result).toEqual({ status: 502, body: { error: 'Provider data could not be synchronized. Try again shortly.', code: 'PROVIDER_SYNC_FAILED' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
