import { jest } from '@jest/globals';
import {
  GOOGLE_ADS_API_VERSION,
  buildGoogleProviderCampaignName,
  createGoogleAdsSearchCampaign,
  formatGoogleAdsDate,
  getAdGroupMetricsByDateRange,
  getAdMetricsByDateRange,
  getCampaignMetricsByDateRange,
} from '../services/ads/GoogleAdsService.js';

const credentials = {
  clientId: 'not-used',
  clientSecret: 'not-used',
  developerToken: 'not-used',
  customerId: '1234567890',
  refreshToken: 'not-used',
};

describe('GoogleAdsService contract', () => {
  it('targets the supported v25 endpoint contract', () => {
    expect(GOOGLE_ADS_API_VERSION).toBe('v25');
  });

  it('fails preflight without making a provider request', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await createGoogleAdsSearchCampaign(credentials, {
      name: 'Campaign',
      budgetMode: 'CAMPAIGN_TOTAL',
      totalBudgetAmount: 100,
      finalUrl: 'https://example.com',
      headlines: ['One', 'Two', 'Three'],
      descriptions: ['First description', 'Second description'],
      keywords: [],
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('at least one keyword required'),
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('preserves reviewed date-only values and maps instants in the customer timezone', () => {
    expect(formatGoogleAdsDate('2026-08-01', 'America/Los_Angeles')).toBe('20260801');
    expect(formatGoogleAdsDate('2026-08-01T00:30:00.000Z', 'America/Los_Angeles')).toBe('20260731');
    expect(formatGoogleAdsDate('2026-08-01T00:30:00.000Z', 'Asia/Kolkata')).toBe('20260801');
  });

  it('builds a stable provider identity without exceeding Google name limits', () => {
    const name = buildGoogleProviderCampaignName('A'.repeat(300), 'conversation:42:widget:9:google');
    expect(name).toHaveLength(255);
    expect(name).toContain('[conversation-42-widget-9-google]');
    expect(buildGoogleProviderCampaignName('Campaign', 'stable-key')).toBe('Campaign [stable-key]');
  });

  it('rejects duplicate RSA assets before provider access', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await createGoogleAdsSearchCampaign(credentials, {
      name: 'Campaign',
      budgetMode: 'CAMPAIGN_TOTAL',
      totalBudgetAmount: 100,
      finalUrl: 'https://example.com',
      headlines: ['Same', 'same', 'Other'],
      descriptions: ['First description', 'Second description'],
      keywords: ['reviewed keyword'],
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    });

    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('headlines must be unique') }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('maps Google campaign, ad-group, and individual-ad performance evidence', async () => {
    const analyticsCredentials = {
      ...credentials,
      clientId: 'analytics-contract',
      refreshToken: 'analytics-contract-refresh',
    };
    const queries: string[] = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'analytics-token', expires_in: 3600 }), { status: 200 });
      }
      const query = String(JSON.parse(String(init?.body || '{}')).query || '');
      queries.push(query);
      return new Response(JSON.stringify({ results: [{
        segments: { date: '2026-08-29' },
        metrics: {
          impressions: '1000',
          clicks: '40',
          engagements: '75',
          costMicros: '20000000',
          conversions: '6',
          conversionsValue: '120',
        },
        campaign: { status: 'ENABLED' },
        adGroup: { resourceName: 'customers/1234567890/adGroups/10', status: 'PAUSED' },
        adGroupAd: { resourceName: 'customers/1234567890/adGroupAds/10~20', status: 'ENABLED' },
      }] }), { status: 200 });
    });

    try {
      const [campaign, adGroup, ad] = await Promise.all([
        getCampaignMetricsByDateRange(analyticsCredentials, 'customers/1234567890/campaigns/1', '2026-08-01', '2026-08-29'),
        getAdGroupMetricsByDateRange(analyticsCredentials, 'customers/1234567890/campaigns/1', '2026-08-01', '2026-08-29'),
        getAdMetricsByDateRange(analyticsCredentials, 'customers/1234567890/campaigns/1', '2026-08-01', '2026-08-29'),
      ]);

      expect(campaign).toEqual({
        success: true,
        metrics: [{
          date: '2026-08-29', impressions: 1000, clicks: 40, engagements: 75,
          costMicros: 20_000_000, conversions: 6, conversionsValue: 120, status: 'ENABLED',
        }],
      });
      expect(adGroup.metrics?.[0]).toEqual(expect.objectContaining({
        adGroupResourceName: 'customers/1234567890/adGroups/10',
        costMicros: 20_000_000,
        status: 'PAUSED',
      }));
      expect(ad.metrics?.[0]).toEqual(expect.objectContaining({
        adGroupResourceName: 'customers/1234567890/adGroups/10',
        adResourceName: 'customers/1234567890/adGroupAds/10~20',
        conversions: 6,
        conversionsValue: 120,
        status: 'ENABLED',
      }));
      expect(queries).toHaveLength(3);
      expect(queries).toEqual(expect.arrayContaining([
        expect.stringContaining('FROM campaign'),
        expect.stringContaining('FROM ad_group'),
        expect.stringContaining('FROM ad_group_ad'),
      ]));
      expect(queries.every((query) => query.includes('campaign.id = 1'))).toBe(true);
      expect(queries.every((query) => query.includes("segments.date BETWEEN '2026-08-01' AND '2026-08-29'"))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
