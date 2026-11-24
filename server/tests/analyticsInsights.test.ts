import { generateAnalyticsInsights } from '../mastra/utils/analyticsInsights.js';
import type { ToolCallResult } from '../mastra/utils/toolCallingLoop.js';

const result = (queryType: string, data: unknown, success = true): ToolCallResult => ({
  toolName: 'analytics_query', toolCallId: 'analytics-1', success,
  result: { success, output: { queryType, data } },
});

describe('performance agent analytics contract', () => {
  it('reads campaign arrays from the canonical executor envelope', () => {
    const text = generateAnalyticsInsights([result('campaign', [{ campaignName: 'Resort traffic', hasPerformanceData: true, impressions: 1000, ctr: 4 }])]);
    expect(text).toContain('Resort traffic');
    expect(text).toContain('4% across 1000 impressions');
    expect(text).toContain('does not establish profitability');
  });

  it.each([
    { hasPerformanceData: false, impressions: 0, ctr: 0 },
    { hasPerformanceData: true, impressions: 0, ctr: 0 },
    { hasPerformanceData: true, impressions: 1000 },
    { hasPerformanceData: true, impressions: 1000, ctr: NaN },
    { hasPerformanceData: true, impressions: 1000, ctr: 150 },
  ])('does not classify campaigns with missing or invalid evidence: %j', campaign => {
    expect(generateAnalyticsInsights([result('campaign', [campaign])])).toBe('');
  });

  it('distinguishes observed zero from missing metrics and empty populations', () => {
    expect(generateAnalyticsInsights([result('lead', { totalLeads: 10, conversionRate: 0, avgLeadScore: 35 })])).toContain('Average lead score is 35');
    expect(generateAnalyticsInsights([result('lead', { totalLeads: 10 })])).toBe('');
    expect(generateAnalyticsInsights([result('outreach', { totalSent: 0, openRate: 0, replyRate: 0 })])).toBe('');
    expect(generateAnalyticsInsights([result('outreach', { totalSent: 20, replyRate: 0 })])).toContain('Recorded reply rate is 0%');
  });

  it('supports overview data and ignores failed results', () => {
    const data = { campaigns: [], leads: { totalLeads: 10, conversionRate: 5 }, outreach: { totalSent: 10, openRate: 10 } };
    expect(generateAnalyticsInsights([result('overview', data)])).toContain('conversion rate is 5%');
    expect(generateAnalyticsInsights([result('overview', data)])).toContain('Recorded open rate is 10%');
    expect(generateAnalyticsInsights([result('overview', data, false)])).toBe('');
  });
});
