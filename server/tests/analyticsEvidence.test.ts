import { describe, expect, it } from '@jest/globals';
import { projectAnalyticsEvidence, describeAnalyticsEvidence } from '../mastra/utils/analyticsEvidence.js';

describe('typed analytics response evidence', () => {
  it('preserves exact current-campaign empty results without inventing zero spend', () => {
    const evidence = projectAnalyticsEvidence({ queryType: 'campaign', scope: 'current_campaign', threadId: 210, data: [] })!;
    expect(evidence).toEqual({ queryType: 'campaign', scope: 'current_campaign', threadId: 210, returnedCampaignCount: 0, campaigns: [] });
    expect(describeAnalyticsEvidence(evidence)).toContain('Current conversation #210');
    expect(describeAnalyticsEvidence(evidence)).toContain('not evidence of zero spend');
  });
  it('keeps recorded metrics per campaign and currency without promoting nested or prose fields', () => {
    const evidence = projectAnalyticsEvidence({ queryType: 'campaign', scope: 'all_owned', summary: 'SECRET_SUMMARY', data: [
      { campaignId: 1, campaignName: 'SECRET_NAME', hasPerformanceData: true, currency: 'INR', spend: 500, impressions: 100, nested: { spend: 9000 } },
      { campaignId: 2, hasPerformanceData: true, currency: 'USD', spend: 10, clicks: 2 },
      { campaignId: 3, hasPerformanceData: false, spend: 0, impressions: 0 },
    ] })!;
    const text = describeAnalyticsEvidence(evidence);
    expect(text).toContain('spend: INR 500'); expect(text).toContain('spend: USD 10');
    expect(text).toContain('Campaign #3: measurements unavailable');
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
    expect(text).not.toContain('9000'); expect(text).not.toContain('510');
  });
  it('rejects invalid numbers and never guesses a scope from a free-text label', () => {
    const evidence = projectAnalyticsEvidence({ queryType: 'lead', scopeLabel: 'Current conversation #999', data: {
      totalLeads: 5, qualifiedLeads: '3', convertedLeads: -1, avgLeadScore: Infinity, conversionRate: NaN,
    } })!;
    expect(evidence.leads).toEqual({ totalLeads: 5 });
    expect(evidence.scope).toBeUndefined();
    expect(describeAnalyticsEvidence(evidence)).toContain('Scope not verified');
  });
  it('does not promote unrecognized IDs/currencies or missing measured flags', () => {
    const evidence = projectAnalyticsEvidence({ queryType: 'campaign', data: [
      { campaignId: 'FAKE', hasPerformanceData: true, spend: 100 },
      { campaignId: '1', currency: 'SECRET', spend: 100 },
    ] })!;
    expect(evidence.campaigns).toEqual([{ id: '1', measured: false, metrics: {} }]);
  });
  it('keeps missing overview sections unavailable and does not infer delivery from sent', () => {
    const evidence = projectAnalyticsEvidence({ queryType: 'overview', data: { campaigns: [], outreach: { totalSent: 10 } } })!;
    expect(evidence.outreach).toEqual({ totalSent: 10 });
    expect(evidence.leads).toEqual({});
    expect(describeAnalyticsEvidence(evidence)).toContain('Leads: measurements unavailable');
    expect(describeAnalyticsEvidence(evidence)).not.toContain('delivered:');
  });
  it('bounds campaign rows and rejects unknown query types', () => {
    expect(projectAnalyticsEvidence({ queryType: 'fake', data: {} })).toBeUndefined();
    const evidence = projectAnalyticsEvidence({ queryType: 'campaign', data: Array.from({ length: 60 }, (_, i) => ({ campaignId: i + 1 })) })!;
    expect(evidence.returnedCampaignCount).toBe(60); expect(evidence.campaigns).toHaveLength(50);
  });
});
