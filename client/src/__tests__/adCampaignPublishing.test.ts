import { describe, expect, it } from 'vitest';
import {
  buildAutonomousCampaignPayload,
  campaignPublishState,
  safeDashboardReturnPath,
} from '@/lib/adCampaignPublishing';

const form = {
  campaignName: 'Reviewed campaign',
  publishPlatforms: ['meta', 'google'] as const,
  lifetimeBudget: '250',
  currency: 'USD',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  countries: ['US'],
  objective: 'traffic',
  objectiveRationale: 'Selected by the client.',
  bidStrategy: 'BID_CAP',
  bidAmount: '2.5',
  optimizationGoal: 'LANDING_PAGE_VIEWS',
  billingEvent: 'IMPRESSIONS',
  ageMin: 25,
  ageMax: 54,
  genders: ['1', '2'],
  placements: ['facebook_feed'],
  specialAdCategories: [],
  callToAction: 'LEARN_MORE',
  linkUrl: 'https://example.com/offer',
  googleBudgetMode: 'CAMPAIGN_TOTAL' as const,
  googleBiddingStrategy: 'MAXIMIZE_CONVERSIONS',
  googleKeywordMatchType: 'PHRASE' as const,
  googleKeywords: ['reviewed keyword'],
  googleNegativeKeywords: ['free'],
  googleLanguageIds: ['languageConstants/1000'],
  googleTrackingTemplate: '{lpurl}?campaign=reviewed',
  googleFinalUrlSuffix: 'source=google',
  googlePath1: 'offer',
  googlePath2: 'review',
  activationConfirmed: true,
};

describe('ad campaign publishing contract', () => {
  it('serializes editable provider fields and selected context once', () => {
    const payload = buildAutonomousCampaignPayload({
      form: {
        ...form,
        publishPlatforms: [...form.publishPlatforms],
      },
      creatives: {
        meta: [{ headline: 'Offer' }],
        google: [{ headlines: ['One', 'Two', 'Three'] }],
      },
      contentStudioContext: 'Creative context',
      conversationContext: 'Conversation context',
      context: {
        businessProfileId: 7,
        brandToolkitId: 8,
        icpId: 9,
        threadId: 10,
        creativeSources: [{ sourceType: 'content_template', sourceId: 11, sourceVersion: 3 }],
        scheduleDates: { startDate: '2026-08-01', endDate: '2026-08-31' },
      },
      locations: [{ countryCode: 'US', googleGeoTargetId: 'geoTargetConstants/2840' }],
      idempotencyKey: 'test-request-123',
      publish: true,
    });

    expect(payload.providerConfig.meta).toMatchObject({
      bidStrategy: 'LOWEST_COST_WITH_BID_CAP',
      bidAmount: 2.5,
      placements: ['facebook_feed'],
    });
    expect(payload.providerConfig.google).toMatchObject({
      budgetMode: 'CAMPAIGN_TOTAL',
      keywordMatchType: 'PHRASE',
      negativeKeywords: ['free'],
      trackingTemplate: '{lpurl}?campaign=reviewed',
    });
    expect(payload.context).toEqual({
      businessProfileId: 7,
      brandToolkitId: 8,
      icpId: 9,
      threadId: 10,
      creativeSources: [{ sourceType: 'content_template', sourceId: 11, sourceVersion: 3 }],
      scheduleDates: { startDate: '2026-08-01', endDate: '2026-08-31' },
    });
    expect(payload.autoActivate).toBe(true);
    expect(payload.activationConfirmation).toMatchObject({
      source: 'direct_review',
      scope: 'live_activation_and_spend',
      campaignName: 'Reviewed campaign',
      platforms: ['meta', 'google'],
      lifetimeBudget: 250,
      currency: 'USD',
    });
  });

  it('prefers validation and explicit server states over optimistic success', () => {
    expect(campaignPublishState({
      id: 1,
      publishState: 'queued',
      validationErrors: ['Missing keyword'],
    })).toBe('validation_failed');
    expect(campaignPublishState({ id: 2, local_status: 'provider_failed' })).toBe('provider_failed');
    expect(campaignPublishState({ id: 3, local_status: 'uncertain' })).toBe('uncertain');
  });

  it('never authorizes activation for a draft or an unchecked review', () => {
    const baseInput = {
      creatives: { meta: undefined, google: [{ headlines: ['One', 'Two', 'Three'] }] },
      contentStudioContext: 'Creative context',
      locations: [{ countryCode: 'US', googleGeoTargetId: 'geoTargetConstants/2840' }],
      idempotencyKey: 'test-request-safe',
    };
    const unchecked = buildAutonomousCampaignPayload({
      ...baseInput,
      form: { ...form, publishPlatforms: ['google'], activationConfirmed: false },
      publish: true,
    });
    const draft = buildAutonomousCampaignPayload({
      ...baseInput,
      form: { ...form, publishPlatforms: ['google'], activationConfirmed: true },
      publish: false,
    });

    expect(unchecked.autoActivate).toBe(false);
    expect(unchecked.activationConfirmation).toBeUndefined();
    expect(draft.autoActivate).toBe(false);
    expect(draft.activationConfirmation).toBeUndefined();
  });

  it('allows only internal dashboard return paths', () => {
    expect(safeDashboardReturnPath('/dashboard/saved-templates/ads?tab=my', '/dashboard/ads'))
      .toBe('/dashboard/saved-templates/ads?tab=my');
    expect(safeDashboardReturnPath('https://attacker.example/dashboard/ads', '/dashboard/ads')).toBe('/dashboard/ads');
    expect(safeDashboardReturnPath('//attacker.example/dashboard/ads', '/dashboard/ads')).toBe('/dashboard/ads');
    expect(safeDashboardReturnPath('/settings', '/dashboard/ads')).toBe('/dashboard/ads');
  });
});
