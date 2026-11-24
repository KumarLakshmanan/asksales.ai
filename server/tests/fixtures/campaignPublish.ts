import { defaultGoogleProviderConfig, defaultMetaProviderConfig } from '../../services/ads/ProviderCampaignContract.js';
import { buildCampaignPublishReview } from '../../services/ads/CampaignPublishReview.js';
import type { ApprovedCampaignPublishReview } from '../../../shared/adCampaignReview.js';
import type { CampaignAllocation } from '../../services/ads/AutonomousAdsDomain.js';

export function campaignPublishFixture() {
  const allocations: CampaignAllocation[] = [
    { key: 'meta-1', platform: 'meta', amount: 60, spent: 0 },
    { key: 'google-1', platform: 'google', amount: 40, spent: 0 },
  ];
  const accounts = {
    capturedAt: new Date().toISOString(),
    meta: { adAccountId: 'act_12', pageId: '34', instagramAccountId: '56', currency: 'USD', timezone: 'UTC' },
    google: { customerId: '1234567890', managerAccountId: '0987654321', currency: 'USD', timezone: 'UTC' },
  };
  const campaign = {
    id: 19, user_id: 7, version: 3, name: 'Reviewed resort campaign', objective: 'traffic', ad_platform: 'multi',
    budget_type: 'lifetime', budget_amount: '100.00', currency: 'USD', spent_amount: '0',
    landing_page_url: 'https://example.com/reviewed-offer',
    start_date: new Date('2090-01-01T10:00:00Z'), end_date: new Date('2090-01-08T10:00:00Z'),
    locations: [{ countryCode: 'US', googleGeoTargetId: 'geoTargetConstants/2840' }],
    targeting: { age_min: 25 }, auto_activate: true, validation_errors: [] as string[],
    ad_creatives: {
      meta: [{ headline: 'Reviewed retreat', primaryText: 'The exact approved primary text.', description: 'Book a stay.', imageHash: 'saved-image-hash', callToAction: 'BOOK_TRAVEL' }],
      google: [{ headlines: ['Reviewed retreat', 'Plan a quiet stay', 'Explore the reserve'], descriptions: ['Your reviewed first description.', 'Your reviewed second description.'], keywords: ['private resort'], finalUrl: 'https://example.com/reviewed-offer' }],
    },
    settings: {
      platforms: ['meta', 'google'], accountSnapshot: accounts,
      providerConfig: { meta: { ...defaultMetaProviderConfig('traffic'), placements: ['instagram_stream' as const] }, google: defaultGoogleProviderConfig() },
      context: { creativeRevision: 3, creativeSources: [{ sourceType: 'content_asset', sourceId: 88, sourceVersion: 2 }], scheduleDates: {} },
    },
  };
  const review = buildCampaignPublishReview(campaign, allocations);
  const approved: ApprovedCampaignPublishReview = { schemaVersion: 1, revision: review.revision, snapshot: review.snapshot, approvedAt: new Date().toISOString(), scope: 'live_activation_and_spend' };
  return { campaign, allocations, accounts, review, approved };
}
