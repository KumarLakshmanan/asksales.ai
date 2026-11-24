import { describe, expect, it, jest } from '@jest/globals';
import { groupMetaReportingRows, MetaReportingError, readMetaReportingRows, readMetaReportingSnapshot } from '../services/ads/MetaReportingReader.js';

const input = { root: 'act_123', apiVersion: 'v25.0', accessToken: 'qa-token', reportingQuery: 'time_range=%7B%22since%22%3A%222026-10-01%22%2C%22until%22%3A%222026-10-30%22%7D', insightFields: 'impressions,spend', adsetFields: 'id,campaign_id', adFields: 'id,campaign_id,adset_id' };
const response = (data: unknown) => new Response(JSON.stringify({ data }));
describe('bounded read-only Meta reporting', () => {
  it('reads each account level once instead of once for every campaign or ad set', async () => {
    const fetcher = jest.fn<typeof fetch>(async request => {
      const url = new URL(String(request));
      const level = url.searchParams.get('level');
      if (level === 'campaign') return response([{ campaign_id: 'c1', spend: '10' }, { campaign_id: 'c2', spend: '20' }]);
      if (level === 'adset') return response([{ campaign_id: 'c1', adset_id: 's1', spend: '10' }]);
      if (level === 'ad') return response([{ campaign_id: 'c1', adset_id: 's1', ad_id: 'a1', spend: '10' }]);
      if (url.pathname.endsWith('/adsets')) return response(Array.from({ length: 100 }, (_, id) => ({ id: `s${id}`, campaign_id: 'c1' })));
      return response([{ id: 'a1', campaign_id: 'c1', adset_id: 's1' }]);
    });
    const result = await readMetaReportingSnapshot(input, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(result.errors).toEqual([]);
    expect(result.adsets).toHaveLength(100);
    expect(groupMetaReportingRows(result.campaignDaily, 'campaign_id').get('c2')).toEqual([{ campaign_id: 'c2', spend: '20' }]);
    expect(groupMetaReportingRows(result.adDaily, 'ad_id').get('a1')?.[0].adset_id).toBe('s1');
    for (const [request, init] of fetcher.mock.calls) {
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ Authorization: 'Bearer qa-token' });
      expect(String(request)).not.toContain('qa-token');
    }
  });
  it('stops immediately on a provider throttle while preserving the completed campaign report', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValueOnce(response([{ campaign_id: 'c1', spend: '10' }]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 17, message: 'private token=not-for-output' } }), { status: 400, headers: { 'retry-after': '120' } }));
    const result = await readMetaReportingSnapshot(input, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.campaignDaily).toHaveLength(1);
    expect(result.adsets).toBeUndefined();
    expect(result.adDaily).toBeUndefined();
    expect(result.errors[0]).toMatchObject({ code: 'META_REPORTING_RATE_LIMITED', retryAfterSeconds: 120 });
    expect(JSON.stringify(result.errors)).not.toContain('not-for-output');
  });
  it('stops all reads when the reporting grant has expired', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 }));
    const result = await readMetaReportingSnapshot(input, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.campaignDaily).toBeUndefined();
    expect(result.errors[0].code).toBe('META_REPORTING_RECONNECT_REQUIRED');
  });
  it('follows same-host pagination and removes token query parameters', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 1 }], paging: { next: 'https://graph.facebook.com/v25.0/act_123/insights?after=2&access_token=private' } })))
      .mockResolvedValueOnce(response([{ id: 2 }]));
    await expect(readMetaReportingRows('https://graph.facebook.com/v25.0/act_123/insights', 'qa-token', fetcher)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(String(fetcher.mock.calls[1][0])).not.toContain('private');
  });
  it('refuses an off-site pagination URL before sending credentials', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [], paging: { next: 'https://other.example/steal' } })));
    await expect(readMetaReportingRows('https://graph.facebook.com/v25.0/act_123/insights', 'qa-token', fetcher)).rejects.toThrow('invalid insights page URL');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('treats HTTP 429 as a throttle even without a Graph error body', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(readMetaReportingRows('https://graph.facebook.com/v25.0/act_123/insights', 'qa-token', fetcher)).rejects.toBeInstanceOf(MetaReportingError);
  });
});
