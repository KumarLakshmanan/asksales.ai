import { describe, expect, it } from '@jest/globals';
import { measuredLeads } from '../services/ads/AdLeadMetrics.js';
describe('measured ad leads', () => {
  it('does not turn conversions or purchases into leads', () => {
    expect(measuredLeads({conversions:40})).toBeNull();
    expect(measuredLeads({actions:[{action_type:'purchase',value:'12'}]})).toBe(0);
    expect(measuredLeads({leads:0,conversions:40})).toBe(0);
  });
  it('reads normalized provider evidence and avoids overlapping lead aliases', () => {
    expect(measuredLeads({raw_data:{insights:{leads:8}}})).toBe(8);
    expect(measuredLeads({source:{actions:[{action_type:'lead',value:'8'},{action_type:'onsite_conversion.lead_grouped',value:'8'}]}})).toBe(8);
    expect(measuredLeads({leads:'invalid'})).toBeNull();
  });
});

import { providerCampaignReview } from '../services/ads/ProviderCampaignReview.js';
import { aggregateProviderReportingWindow } from '../services/ads/ProviderReportingWindow.js';
it('keeps provider reviews and date-window totals tied to leads, including missing measurement', () => {
  const metrics = { spend:3594.73, impressions:38900, clicks:851, reach:30000, conversions:67, leads:28 } as any;
  const review = providerCampaignReview({ objective:'leads',metrics,currency:'INR',providerStatus:'PAUSED',metricsUpdatedAt:new Date().toISOString() });
  expect(review.rationale).toContain('28 leads'); expect(review.rationale).toContain('128.38');
  expect(providerCampaignReview({objective:'leads',metrics:{...metrics,leads:null},currency:'INR',providerStatus:'PAUSED',metricsUpdatedAt:new Date().toISOString()}).rationale).toContain('measurement is unavailable');
  const raw = {dailyInsights:[{date:'2026-09-01',leads:0,conversions:7},{date:'2026-09-02',leads:28,conversions:60}]};
  expect(aggregateProviderReportingWindow(raw,'2026-09-01','2026-09-02').leads).toBe(28);
  expect(aggregateProviderReportingWindow(raw,'2026-09-01','2026-09-01').leads).toBe(0);
  expect(aggregateProviderReportingWindow({dailyInsights:[{date:'2026-09-01',conversions:67}]},'2026-09-01','2026-09-02').leads).toBeNull();
});
