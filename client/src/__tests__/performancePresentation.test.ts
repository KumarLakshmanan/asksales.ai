import { describe, expect, it } from 'vitest';
import { campaignAttentionReason, campaignIssueGroup, campaignEvidenceState, campaignResult, comparableCampaignGroups, objectiveResultGroups, type PresentedCampaign } from '@/lib/performancePresentation';
const campaign = (objective = 'leads', metrics: PresentedCampaign['metrics'] = {}): PresentedCampaign => ({ id: 1, objective, currency: 'INR', source: 'managed', aiState: 'insufficient_data', metricsUpdatedAt: '2026-09-12T00:00:00Z', metrics: { spend: 200, impressions: 1000, clicks: 20, leads: 4, conversions: 100, ...metrics } });

describe('business performance presentation', () => {
  it('keeps leads, purchases, clicks and currencies separate', () => {
    const groups = objectiveResultGroups([campaign(), campaign('sales'), campaign('traffic'), { ...campaign(), currency: 'USD' }]);
    expect(groups.map(g => [g.label, g.currency, g.result])).toEqual([['Leads', 'INR', 4], ['Purchases', 'INR', 100], ['Clicks', 'INR', 20], ['Leads', 'USD', 4]]);
  });
  it('never uses conversions as missing leads or displays zero cost for zero results', () => {
    expect(campaignResult(campaign('leads', { leads: null })).result).toBeNaN();
    expect(campaignResult(campaign('leads', { leads: 0 })).cost).toBeNaN();
    const group = objectiveResultGroups([campaign(), campaign('leads', { leads: null })])[0];
    expect(group.result).toBe(4); expect(group.missing).toBe(1); expect(group.cost).toBeNaN();
  });
  it('does not claim unique reach across campaigns', () => {
    const group = objectiveResultGroups([campaign('awareness', { reach: 700 }), campaign('awareness', { reach: 500 })])[0];
    expect(group.additive).toBe(false); expect(group.cost).toBe(200);
  });
  it('distinguishes no delivery, unavailable measurement and missing monitoring', () => {
    expect(campaignEvidenceState(campaign('leads', { spend: 0, impressions: 0, clicks: 0, leads: 0 })).label).toBe('No delivery');
    expect(campaignEvidenceState(campaign('leads', { leads: null })).label).toBe('Measurement unavailable');
    expect(campaignEvidenceState({ ...campaign(), source: 'provider_cache' }).label).toBe('Not monitored');
    expect(campaignEvidenceState(campaign()).label).toBe('Collecting evidence');
    expect(campaignEvidenceState({ ...campaign(), aiState: 'ai_paused' }).label).toBe('AI paused');
  });
  it('uses observed costs without inventing targets or comparing unrelated outcomes', () => {
    const groups = comparableCampaignGroups([campaign('leads', { leads: 1 }), campaign('traffic'), campaign()]);
    expect(groups).toHaveLength(2); expect(groups[0].withTargets).toBe(false);
    expect(groups[0].members.map(c => c.metrics.leads)).toEqual([4, 1]);
  });
  it('uses targets only when every compared campaign has a matching measured target', () => {
    const a = { ...campaign(), targetVariance: { metric: 'CPL', percent: 20 } };
    const b = { ...campaign('leads', { leads: 1 }), targetVariance: { metric: 'CPL', percent: -10 } };
    expect(comparableCampaignGroups([a, b])[0].members[0]).toBe(b);
    expect(comparableCampaignGroups([a, b])[0].withTargets).toBe(true);
    expect(comparableCampaignGroups([a, campaign()])[0].withTargets).toBe(false);
  });
  it('reserves action-needed signals for actionable failures and recommendations', () => {
    expect(campaignAttentionReason(campaign())).toBeNull();
    expect(campaignAttentionReason({ ...campaign(), aiState: 'watch' })).toBeNull();
    expect(campaignAttentionReason({ ...campaign(), source: 'provider_cache', metricsUpdatedAt: null })).toBeNull();
    expect(campaignAttentionReason({ ...campaign(), failedSyncs: 2 })).toBe('2 provider sync failures');
    expect(campaignAttentionReason({ ...campaign(), openRecommendations: 1 })).toBe('1 open recommendation');
    expect(campaignAttentionReason({ ...campaign(), aiState: 'ai_paused' })).toContain('pause');
    expect(campaignAttentionReason(campaign(), true)).toBe('Provider reporting is stale');
  });
});

it('warns only for active zero-delivery campaigns, including provider-only reporting', () => {
  const empty = { ...campaign('traffic', {impressions:0,clicks:0,spend:0}), source:'provider_cache', status:'report_only' };
  for (const providerStatus of ['ACTIVE','ENABLED','PUBLISHED']) expect(campaignEvidenceState({...empty,providerStatus})).toMatchObject({label:'Active · no delivery',tone:'warning'});
  for (const providerStatus of ['PAUSED','DRAFT']) expect(campaignEvidenceState({...empty,providerStatus})).toMatchObject({label:'No delivery',tone:'neutral'});
});

it('keeps grouped issue reasons aligned when a recommendation and measurement problem coexist', () => {
  const incomplete={...campaign('leads',{leads:null}),openRecommendations:1};
  expect(campaignIssueGroup(incomplete)).toBe('Measurement issues');
  expect(campaignAttentionReason(incomplete)).toBe('Objective measurement is unavailable');
  expect(campaignIssueGroup(incomplete,true)).toBe('Data connection issues');
  expect(campaignAttentionReason(incomplete,true)).toBe('Provider reporting is stale');
});
