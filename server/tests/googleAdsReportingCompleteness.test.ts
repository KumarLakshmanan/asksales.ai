import { jest } from '@jest/globals';
import { searchGoogleAds, getCampaignMetricsByDateRange, getAdGroupMetricsByDateRange, getAdMetricsByDateRange } from '../services/ads/GoogleAdsService.js';

const credentials = { clientId: 'pagination', clientSecret: 'test', refreshToken: 'pagination', developerToken: 'test', customerId: '1234567890', managerAccountId: '999-888-7777' };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => jest.restoreAllMocks());

it('reads every page using the identical query and preserves account context', async () => {
  const requests: Array<{ body: { query: string; pageToken?: string }; headers: Record<string, string> }> = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('oauth2')) return ok({ access_token: 'token', expires_in: 3600 });
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers: init?.headers as Record<string, string> });
    return body.pageToken ? ok({ results: [{ id: 'second' }] }) : ok({ results: [{ id: 'first' }], nextPageToken: 'next' });
  });
  await expect(searchGoogleAds(credentials, 'SELECT campaign.id FROM campaign')).resolves.toEqual([{ id: 'first' }, { id: 'second' }]);
  expect(requests.map(r => r.body)).toEqual([{ query: 'SELECT campaign.id FROM campaign' }, { query: 'SELECT campaign.id FROM campaign', pageToken: 'next' }]);
  expect(requests.every(r => r.headers['login-customer-id'] === '9998887777')).toBe(true);
});

it.each([getCampaignMetricsByDateRange, getAdGroupMetricsByDateRange, getAdMetricsByDateRange])('does not return partial evidence when a later page fails', async reader => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('oauth2')) return ok({ access_token: 'token', expires_in: 3600 });
    const body = JSON.parse(String(init?.body));
    return body.pageToken
      ? new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 })
      : ok({ results: [{ metrics: { impressions: '1000', costMicros: '5000000' } }], nextPageToken: 'next' });
  });
  const result = await reader(credentials, 'customers/1234567890/campaigns/1', '2026-09-01', '2026-09-10');
  expect(result).toEqual({ success: false, error: 'Quota exceeded' });
  expect(result).not.toHaveProperty('metrics');
});

it('rejects repeated tokens and page-limit truncation', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('oauth2')
    ? ok({ access_token: 'token', expires_in: 3600 }) : ok({ results: [], nextPageToken: 'same' }));
  await expect(searchGoogleAds(credentials, 'SELECT campaign.id FROM campaign')).rejects.toThrow('repeated');
  await expect(searchGoogleAds(credentials, 'SELECT campaign.id FROM campaign', { maxPages: 1 })).rejects.toThrow('page limit');
});

it('rejects invalid dates before contacting Google', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  const result = await getCampaignMetricsByDateRange(credentials, 'customers/1234567890/campaigns/1', '2026-02-30', '2026-09-10');
  expect(result.success).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
