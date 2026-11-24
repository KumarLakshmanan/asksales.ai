import type { AdObjective, PerformanceAggregate } from './AutonomousAdsDomain.js';

/** A factual review of provider evidence; it never confers monitoring or pause consent. */
export function providerCampaignReview(input: {
  objective: AdObjective;
  metrics: PerformanceAggregate;
  currency: string;
  providerStatus: string;
  metricsUpdatedAt: string | null;
  now?: number;
}) {
  const { metrics, objective } = input;
  const stale = !input.metricsUpdatedAt || !Number.isFinite(Date.parse(input.metricsUpdatedAt))
    || (input.now ?? Date.now()) - Date.parse(input.metricsUpdatedAt) > 60 * 60_000;
  const result = objective === 'awareness' ? metrics.reach
    : objective === 'traffic' ? metrics.clicks
      : objective === 'engagement' ? metrics.engagements || metrics.conversions
        : objective === 'leads' ? metrics.leads
          : objective === 'app_promotion' ? metrics.installs : metrics.conversions;
  const resultName = objective === 'awareness' ? 'reach'
    : objective === 'traffic' ? 'clicks'
      : objective === 'engagement' ? 'engagements'
        : objective === 'leads' ? 'leads'
          : objective === 'app_promotion' ? 'installs' : 'purchases';
  const spend = `${input.currency} ${Number(metrics.spend || 0).toFixed(2)}`;
  const hasDelivery = metrics.impressions > 0 || metrics.spend > 0 || (result ?? 0) > 0;
  const blockers = stale ? [{ code: 'staleEvidence', message: 'Refresh provider data before making a campaign decision.' }] : [];
  let rationale: string;
  let suggestedNextStep: string;
  if (!hasDelivery) {
    rationale = `No delivery or spend was recorded in this reporting window. Provider status is ${input.providerStatus.toLowerCase().replaceAll('_', ' ')}.`;
    suggestedNextStep = 'Check the campaign schedule, delivery status, and reporting dates. Zero delivery is not evidence of poor performance.';
  } else if (result == null || !Number.isFinite(result)) {
    rationale = `The provider recorded ${spend} spend, but ${resultName} measurement is unavailable in this window.`;
    suggestedNextStep = 'Refresh provider data and verify result tracking before comparing performance.';
  } else if (result > 0) {
    rationale = `The provider recorded ${Number(result).toLocaleString('en-US')} ${resultName} on ${spend} spend${objective === 'awareness' ? '.' : ` (${input.currency} ${(metrics.spend / result).toFixed(2)} per result).`} A target or comparable baseline is needed before calling this good or poor performance.`;
    suggestedNextStep = 'Compare the result cost with your business target and review the ads and creative. Import for ongoing advisory recommendations.';
  } else {
    rationale = `The provider recorded ${spend} spend and ${metrics.impressions.toLocaleString('en-US')} impressions, with no ${resultName} in this window.`;
    suggestedNextStep = 'Check result tracking and attribution delay, then review the offer and creative before changing delivery.';
  }
  return {
    blockers,
    rationale,
    expectedDirection: 'Read-only provider evidence review; performance direction is not established without a baseline.',
    suggestedNextStep: stale ? 'Sync provider data, then review the refreshed campaign evidence.' : suggestedNextStep,
  };
}
