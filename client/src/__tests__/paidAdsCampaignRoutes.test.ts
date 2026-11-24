import { describe, expect, it } from 'vitest';
import {
  campaignPageTab,
  managedCampaignHref,
  providerCampaignHref,
} from '@/components/performance-marketing/campaignRoutes';

describe('Paid Ads campaign canonical routes', () => {
  it('maps legacy drawer tabs to dedicated campaign-page tabs', () => {
    expect(campaignPageTab('performance')).toBe('summary');
    expect(campaignPageTab('units')).toBe('delivery');
    expect(campaignPageTab('policy')).toBe('automation');
    expect(campaignPageTab('evidence')).toBe('technical');
  });

  it('creates shareable managed and provider links without drawer parameters', () => {
    expect(managedCampaignHref(42, 'automation')).toBe('/dashboard/ads/campaigns/managed/42?tab=automation');
    expect(providerCampaignHref('meta', 'campaign/7', 'creative', 'ad-1')).toBe('/dashboard/ads/campaigns/provider/meta/campaign%2F7?tab=creative&ad=ad-1');
  });
});
