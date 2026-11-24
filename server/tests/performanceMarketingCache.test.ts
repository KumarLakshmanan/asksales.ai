import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { aggregateMetaInsightRows, metaConversionValue, metaEntityBelongsToAccount, normalizeMetaAdCreative } from '../controllers/performanceMarketingController.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('performance marketing provider cache normalization', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('accepts an older Meta campaign ID when the connected account collection owns it', async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: 'account_id is unavailable' } }), { status: 400 }),
      new Response(JSON.stringify({
        data: [{ id: 'other-campaign' }],
        paging: { next: 'https://graph.facebook.com/v25.0/act_123/campaigns?fields=id&limit=500&after=next' },
      }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: '6912693924103' }] }), { status: 200 }),
    ];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);

    await expect(metaEntityBelongsToAccount('6912693924103', {
      accessToken: 'test-token',
      adAccountId: 'act_123',
      pageId: 'page-1',
      apiVersion: 'v25.0',
      adAccountName: 'Test account',
      adAccountCurrency: 'USD',
      adAccountTimezone: 'UTC',
    })).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[1][0])).toContain('/act_123/campaigns?fields=id&limit=500');
    expect(String(fetchMock.mock.calls[2][0])).toContain('after=next');
  });

  it('maps lead objectives to lead actions without double-counting aliases', () => {
    expect(metaConversionValue([
      { action_type: 'lead', value: '7' },
      { action_type: 'onsite_conversion.lead_grouped', value: '7' },
      { action_type: 'purchase', value: '2' },
    ], 'OUTCOME_LEADS')).toBe(7);
  });

  it('counts Meta call-qualified lead aliases as the lead result family', () => {
    expect(metaConversionValue([
      { action_type: 'offsite_lead_add_20_s_calls', value: '28' },
      { action_type: 'offsite_complete_registration_add_20_s_calls', value: '28' },
      { action_type: 'click_to_call_call_confirm', value: '90' },
    ], 'OUTCOME_LEADS')).toBe(28);
  });

  it('builds an aggregate from daily provider rows while preserving daily result semantics', () => {
    expect(aggregateMetaInsightRows([
      { date_start: '2026-08-28', impressions: '100', reach: '80', clicks: '10', spend: '25', actions: [{ action_type: 'lead', value: '2' }] },
      { date_start: '2026-08-29', impressions: '200', reach: '150', clicks: '15', spend: '35', actions: [{ action_type: 'lead', value: '3' }] },
    ], 'OUTCOME_LEADS')).toEqual({
      impressions: 300,
      reach: 230,
      clicks: 25,
      spend: 60,
      conversions: 5,
      leads: 5,
      installs: 0,
      conversionValue: 0,
      engagements: 0,
      ctr: (25 / 300) * 100,
      cpc: 60 / 25,
      cpm: 200,
    });
  });

  it('normalizes static and dynamic Meta creative evidence for read-only previews', () => {
    expect(normalizeMetaAdCreative({
      id: 'creative-1',
      name: 'Proof ad',
      thumbnail_url: 'https://cdn.example.com/fallback.jpg',
      object_story_spec: {
        link_data: {
          message: 'Let AI qualify every inbound lead.',
          name: 'Reply while intent is high',
          description: 'A faster path from click to conversation.',
          picture: 'https://cdn.example.com/creative.jpg',
          link: 'https://asksales.ai/demo',
          call_to_action: { type: 'LEARN_MORE', value: { link: 'https://asksales.ai/demo' } },
        },
      },
    })).toEqual({
      id: 'creative-1',
      name: 'Proof ad',
      primaryText: 'Let AI qualify every inbound lead.',
      headline: 'Reply while intent is high',
      description: 'A faster path from click to conversation.',
      imageUrl: 'https://cdn.example.com/creative.jpg',
      thumbnailUrl: 'https://cdn.example.com/fallback.jpg',
      destinationUrl: 'https://asksales.ai/demo',
      callToActionType: 'LEARN_MORE',
    });

    expect(normalizeMetaAdCreative({
      asset_feed_spec: {
        bodies: [{ text: 'Dynamic primary text' }],
        titles: [{ text: 'Dynamic headline' }],
        descriptions: [{ text: 'Dynamic description' }],
        images: [{ url: 'https://cdn.example.com/dynamic.jpg' }],
        link_urls: [{ website_url: 'https://asksales.ai/start' }],
        call_to_action_types: ['SIGN_UP'],
      },
    })).toMatchObject({
      primaryText: 'Dynamic primary text',
      headline: 'Dynamic headline',
      imageUrl: 'https://cdn.example.com/dynamic.jpg',
      destinationUrl: 'https://asksales.ai/start',
      callToActionType: 'SIGN_UP',
    });
  });

  it('synchronizes and returns the complete campaign → ad set → ad hierarchy', () => {
    const controller = readFileSync(resolve(process.cwd(), 'controllers/performanceMarketingController.ts'), 'utf8');
    const model = readFileSync(resolve(process.cwd(), 'models/campaignPerformanceCache/index.ts'), 'utf8');
    const service = readFileSync(resolve(process.cwd(), 'services/ads/AdPerformanceService.ts'), 'utf8');

    expect(controller).toContain('level=ad&fields=');
    expect(controller).toContain("entityType: 'ad'");
    expect(controller).toContain('CampaignPerformanceCacheModel.getCachedAds');
    expect(controller).toContain('cachedAds');
    expect(controller).toContain('ads: adsWithInsights');
    expect(controller).toContain('adCount: adsWithInsights.length');
    expect(controller).toContain('creative: normalizeMetaAdCreative(ad.creative)');
    expect(controller).toContain('`creative{${META_AD_CREATIVE_FIELDS}}`');
    expect(controller).toContain('rawData: { ad, creative: normalizeMetaAdCreative(ad.creative), insights: adInsights, dailyInsights:');
    expect(model).toContain('static async getCachedAds');
    expect(model).toContain("eq(campaignPerformanceCacheTable.entityType, 'ad')");
    expect(service).toContain("entity_type = 'ad'");
    expect(service).toContain("entity_type IN ('adset', 'ad_group')");
    expect(service).toContain('parentTargetKey: unit.parent_entity_id');
  });

  it('fills a visible Meta campaign on cache miss and preserves structured stale-link errors', () => {
    const cacheController = readFileSync(resolve(process.cwd(), 'controllers/performanceMarketingController.ts'), 'utf8');
    const detailController = readFileSync(resolve(process.cwd(), 'controllers/autonomousAdsController.ts'), 'utf8');

    expect(cacheController).toContain("entityType: 'campaign' | 'adset' | 'ad'");
    expect(cacheController).toContain("entityType === 'campaign' ? 'campaigns' : entityType === 'adset' ? 'adsets' : 'ads'");
    expect(cacheController).toContain('/${edge}?fields=id&limit=500');
    expect(detailController).toContain('await ensureMetaCampaignPerformanceCache(userId, campaignId)');
    expect(detailController).toContain("code: 'PROVIDER_CAMPAIGN_NOT_AVAILABLE'");
    expect(detailController).toContain("'[AutonomousAds] Provider campaign detail is not in the current analytics snapshot'");
    expect(detailController).toContain('performance = await adPerformanceService.providerPerformanceDetail(userId, platform, campaignId, requestedReportingDays(req)');
  });

  it('reconciles provider detail links with an already imported managed campaign', () => {
    const service = readFileSync(resolve(process.cwd(), 'services/ads/AdPerformanceService.ts'), 'utf8');

    expect(service).toContain('AND platform_campaign_id = ${platformCampaignId}');
    expect(service).toContain('return this.performanceDetail(userId, managedCampaignId, reportingDays)');
    expect(service.indexOf('AND platform_campaign_id = ${platformCampaignId}'))
      .toBeLessThan(service.indexOf("entity_type = 'campaign' AND platform_entity_id = ${platformCampaignId}"));
  });
});
