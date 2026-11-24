/** Presentation rules only: these never grant or change automation eligibility. */
export interface PresentedCampaign {
  id: string | number;
  source?: string;
  status?: string;
  providerStatus?: string | null;
  objective: string;
  currency: string;
  aiState?: string;
  failedSyncs?: number;
  openRecommendations?: number;
  metricsUpdatedAt?: string | null;
  metrics: Partial<Record<'impressions' | 'clicks' | 'spend' | 'reach' | 'conversions' | 'leads' | 'engagements' | 'installs' | 'conversations' | 'purchases' | 'cpm', number | null>>;
  targetVariance?: { metric: string; percent: number } | null;
}

export function campaignAttentionReason(campaign: PresentedCampaign, stale = false): string | null {
  if (campaign.failedSyncs) return `${campaign.failedSyncs} provider sync failure${campaign.failedSyncs === 1 ? '' : 's'}`;
  if (stale) return 'Provider reporting is stale';
  if (campaign.aiState === 'ai_paused') return 'An AI pause was recorded and needs review';
  const evidence = campaignEvidenceState(campaign).label;
  if (evidence === 'Active · no delivery') return 'Active campaign has no delivery in this window';
  if (evidence === 'Measurement unavailable') return 'Objective measurement is unavailable';
  if ((campaign.openRecommendations || 0) > 0) return `${campaign.openRecommendations} open recommendation${campaign.openRecommendations === 1 ? '' : 's'}`;
  if (campaign.aiState === 'recommendation') return 'A performance improvement is ready to review';
  return null;
}

const number = (value: unknown): number => value == null || value === '' || !Number.isFinite(Number(value)) ? Number.NaN : Number(value);

export function campaignResult(campaign: Pick<PresentedCampaign, 'objective' | 'metrics'>) {
  const objective = campaign.objective.toLowerCase();
  const m = campaign.metrics;
  const spend = number(m.spend);
  const cost = (result: number) => result > 0 && Number.isFinite(spend) ? spend / result : Number.NaN;
  if (/awareness|reach/.test(objective)) {
    const impressions = number(m.impressions);
    return { result: number(m.reach), resultLabel: 'Reach', cost: impressions > 0 ? spend * 1000 / impressions : Number.NaN, costLabel: 'CPM', additive: false };
  }
  if (/message|conversation/.test(objective)) {
    const result = number(m.conversations ?? m.conversions);
    return { result, resultLabel: 'Conversations', cost: cost(result), costLabel: 'Cost / conversation', additive: true };
  }
  const spec = /lead/.test(objective) ? ['leads', 'Leads', 'CPL']
    : /traffic|click/.test(objective) ? ['clicks', 'Clicks', 'CPC']
    : /engagement/.test(objective) ? ['engagements', 'Engagements', 'CPE']
    : /app|install/.test(objective) ? ['installs', 'Installs', 'CPI']
    : /sale|purchase/.test(objective) ? ['conversions', 'Purchases', 'CPA']
    : ['conversions', 'Conversions', 'CPA'];
  const result = number(m[spec[0] as keyof typeof m]);
  return { result, resultLabel: spec[1], cost: cost(result), costLabel: spec[2], additive: true };
}

export function campaignEvidenceState(campaign: PresentedCampaign): { label: string; reason: string; tone: 'neutral' | 'warning' | 'positive' | 'critical' } {
  if (campaign.failedSyncs) return { label: 'Sync needs attention', reason: 'The latest refresh failed. Saved evidence remains available.', tone: 'warning' };
  if (campaign.aiState === 'ai_paused') return { label: 'AI paused', reason: 'Review the recorded pause and provider response.', tone: 'critical' };
  if (campaign.aiState === 'manual_hold') return { label: 'Manual hold', reason: 'Automatic actions are on hold.', tone: 'neutral' };
  if (!campaign.metricsUpdatedAt) return { label: 'Awaiting data', reason: 'No successful measurement timestamp is available.', tone: 'neutral' };
  const m = campaign.metrics;
  if (number(m.impressions) === 0 && number(m.spend) === 0 && number(m.clicks) === 0 && /^(active|enabled|published)$/i.test(campaign.providerStatus || campaign.status || '')) return { label: 'Active · no delivery', reason: 'Check the schedule, approval, budget, and selected reporting dates. Active status alone does not confirm delivery.', tone: 'warning' };
  if (number(m.impressions) === 0 && number(m.spend) === 0 && number(m.clicks) === 0) return { label: 'No delivery', reason: 'No impressions, clicks or spend were recorded in this window.', tone: 'neutral' };
  if (!Number.isFinite(campaignResult(campaign).result)) return { label: 'Measurement unavailable', reason: 'The provider has not supplied the objective result metric. Check tracking and reporting access.', tone: 'warning' };
  if (campaign.source === 'provider_cache') return { label: 'Not monitored', reason: 'Provider reporting is available. Add monitoring for saved recommendations.', tone: 'neutral' };
  if (campaign.aiState === 'healthy') return { label: 'Healthy', reason: 'The stored evaluation met its performance checks.', tone: 'positive' };
  if (campaign.aiState === 'recommendation') return { label: 'Improvement recommended', reason: 'Review the evidence and suggested change.', tone: 'warning' };
  if (campaign.aiState === 'watch') return { label: 'Watch performance', reason: 'A performance signal needs more evidence before an action.', tone: 'warning' };
  return { label: 'Collecting evidence', reason: 'Delivery is measured, but evaluation requirements are not yet met.', tone: 'neutral' };
}

export function objectiveResultGroups<T extends PresentedCampaign>(campaigns: T[]) {
  const groups = new Map<string, { key: string; label: string; costLabel: string; currency: string; result: number; spend: number; missing: number; count: number; additive: boolean; impressions: number }>();
  for (const campaign of campaigns) {
    const metric = campaignResult(campaign);
    const key = `${campaign.currency}:${metric.resultLabel}`;
    const group = groups.get(key) || { key, label: metric.resultLabel, costLabel: metric.costLabel, currency: campaign.currency, result: 0, spend: 0, missing: 0, count: 0, additive: metric.additive, impressions: 0 };
    if (Number.isFinite(metric.result)) group.result += metric.result; else group.missing++;
    group.spend += number(campaign.metrics.spend) || 0;
    group.impressions += number(campaign.metrics.impressions) || 0;
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group,
    cost: group.costLabel === 'CPM' ? group.impressions > 0 ? group.spend * 1000 / group.impressions : Number.NaN
      : !group.missing && group.result > 0 ? group.spend / group.result : Number.NaN,
  }));
}

/** Compare like objectives and currencies, never raw costs across unlike outcomes. */
export function comparableCampaignGroups<T extends PresentedCampaign>(campaigns: T[]) {
  const groups = new Map<string, T[]>();
  for (const campaign of campaigns) {
    const metric = campaignResult(campaign);
    if (!Number.isFinite(metric.cost) || !(Number(campaign.metrics.impressions) > 0 || Number(campaign.metrics.spend) > 0)) continue;
    const key = `${campaign.currency}:${metric.resultLabel}`;
    groups.set(key, [...(groups.get(key) || []), campaign]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const withTargets = members.every(campaign => campaign.targetVariance && Number.isFinite(campaign.targetVariance.percent)
      && campaign.targetVariance.metric.toLowerCase() === campaignResult(campaign).costLabel.toLowerCase());
    const ranked = [...members].sort((a, b) => withTargets ? a.targetVariance!.percent - b.targetVariance!.percent : campaignResult(a).cost - campaignResult(b).cost);
    return { key, members: ranked, costLabel: campaignResult(ranked[0]).costLabel, label: campaignResult(ranked[0]).resultLabel, withTargets };
  });
}

export function objectiveMetricKey(objective: string): 'reach' | 'clicks' | 'leads' | 'engagements' | 'installs' | 'conversions' {
  return /awareness|reach/i.test(objective) ? 'reach' : /traffic|click/i.test(objective) ? 'clicks'
    : /lead/i.test(objective) ? 'leads' : /engagement/i.test(objective) ? 'engagements'
    : /app|install/i.test(objective) ? 'installs' : 'conversions';
}

export function campaignIssueGroup(campaign: PresentedCampaign, stale = false) {
  if (campaign.failedSyncs || stale) return 'Data connection issues';
  if (campaign.aiState === 'ai_paused' || campaignEvidenceState(campaign).label === 'Active · no delivery') return 'Delivery issues';
  if (campaignEvidenceState(campaign).label === 'Measurement unavailable') return 'Measurement issues';
  return 'Decisions waiting';
}
