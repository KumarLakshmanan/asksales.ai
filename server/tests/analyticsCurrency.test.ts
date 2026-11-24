import { describe, expect, it } from '@jest/globals';
import { generateCampaignSummary } from '../mastra/tools/executors/analyticsExecutor.js';

const campaign = (currency: string, spend: number) => ({
  campaignId: currency, campaignName: `${currency} campaign`, status: 'active',
  localStatus: 'draft', lastRecordedProviderStatus: 'active', providerVerifiedLive: false as const,
  impressions: 100, clicks: 10, conversions: 1, ctr: 10, cpc: spend / 10,
  spend, currency, roi: 1, hasPerformanceData: true as const,
  performanceClassification: 'measured' as const,
});

describe('campaign analytics currency', () => {
  it('reports each recorded currency without a false dollar total or mixed-currency sum', () => {
    const summary = generateCampaignSummary([campaign('INR', 1250), campaign('USD', 25)]);
    expect(summary).toContain('INR 1250.00');
    expect(summary).toContain('USD 25.00');
    expect(summary).not.toContain('$1275');
    expect(summary).not.toContain('$1250');
    expect(summary).toContain('not a live provider check');
  });
});
