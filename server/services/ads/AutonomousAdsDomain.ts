import { roundMoney as money } from '../../../shared/money.js';
export { money };
export const AD_OBJECTIVES = [
  'awareness',
  'traffic',
  'engagement',
  'leads',
  'sales',
  'app_promotion',
] as const;

export type AdObjective = (typeof AD_OBJECTIVES)[number];
export type AdPlatform = 'meta' | 'google';
export type AdAutonomyMode = 'off' | 'shadow' | 'advisory' | 'live_pause';
export type AdTargetType = 'campaign' | 'ad_set' | 'ad_group' | 'ad';
export type AdEvaluationState =
  | 'learning'
  | 'healthy'
  | 'watch'
  | 'recommendation'
  | 'ai_paused'
  | 'manual_hold'
  | 'insufficient_data';
export type AdActionType =
  | 'publish'
  | 'activate'
  | 'pause'
  | 'resume'
  | 'reallocate'
  | 'create_replacement'
  | 'sync_analytics'
  | 'cleanup';

export interface ObjectiveInference {
  objective: AdObjective;
  confidence: number;
  rationale: string;
  source: 'campaign_brief' | 'content_studio' | 'conversation' | 'combined';
}

export interface AdLocation {
  countryCode: string;
  region?: string;
  city?: string;
  googleGeoTargetId?: string;
  metaLocationKey?: string;
}

export interface CampaignAllocation {
  key: string;
  platform: AdPlatform;
  amount: number;
  spent?: number;
}

export interface CampaignValidationInput {
  objective?: string | null;
  objectiveConfidence?: number | null;
  lifetimeBudget: number;
  currency: string;
  allocations: CampaignAllocation[];
  startDate: Date;
  endDate?: Date | null;
  landingPageUrl?: string | null;
  locations: AdLocation[];
  platforms: AdPlatform[];
  accountReadiness: Partial<Record<AdPlatform, boolean>>;
  creativesCount: Partial<Record<AdPlatform, number>>;
}

export interface NormalizedMetric {
  platform: AdPlatform;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  reach: number;
  conversions: number;
  conversionValue: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  roas: number;
  providerStatus?: string;
  source: unknown;
}

export interface OptimizationInput {
  campaignId: number;
  lifetimeBudget: number;
  totalSpent: number;
  allocations: CampaignAllocation[];
  metrics: Array<NormalizedMetric & { allocationKey: string }>;
  currentStatus: string;
  pauseReason?: 'ai_underperformance' | 'lifetime_cap' | 'user' | null;
  minimumSpendForDecision?: number;
}

export interface OptimizationDecision {
  action: Exclude<AdActionType, 'publish' | 'activate' | 'sync_analytics' | 'cleanup'>;
  targetKey?: string;
  sourceKey?: string;
  amount?: number;
  rationale: string;
  metricsSnapshot: Record<string, unknown>;
  budgetImpact: number;
  idempotencyKey: string;
}

export interface PerformanceThresholds {
  targetCpl?: number;
  targetCpa?: number;
  targetRoas?: number;
  targetCtr?: number;
  targetCpc?: number;
  targetCpm?: number;
  targetCpe?: number;
  targetEngagementRate?: number;
  spendLimit?: number;
}

/**
 * Currency-neutral fallback targets. Cost-based objectives intentionally stay
 * advisory without a user or historical target because a universal CPA/CPC
 * would be unsafe across account currencies and markets.
 */
export function objectiveDefaultThresholds(objective: AdObjective): PerformanceThresholds {
  if (objective === 'traffic') return { targetCtr: 1 };
  if (objective === 'engagement') return { targetEngagementRate: 1 };
  if (objective === 'sales') return { targetRoas: 1 };
  return {};
}

export interface PerformanceAggregate {
  leads?: number | null;
  impressions: number;
  clicks: number;
  spend: number;
  reach: number;
  conversions: number;
  conversionValue: number;
  engagements: number;
  installs: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  roas: number;
  engagementRate: number;
  cpe: number;
}

export interface PerformanceEvaluationInput {
  objective: AdObjective;
  metrics: PerformanceAggregate;
  lifetimeBudget: number;
  thresholds?: PerformanceThresholds;
  baseline?: Partial<PerformanceThresholds & PerformanceAggregate> | null;
  baselineSource: 'campaign_target' | 'historical' | 'sibling_comparison' | 'objective_default' | 'none';
  launchedAt?: Date | null;
  metricsUpdatedAt?: Date | null;
  now?: Date;
  analyticsSyncMinutes: number;
  successfulSyncWindows: number;
  syncHealthy?: boolean;
  providerStatus?: string | null;
  consecutiveFailingWindows: number;
  manualHoldUntil?: Date | null;
  reportingOnlyHistorical?: boolean;
  lifetimeSpend?: number;
}

export interface PerformanceEvaluationResult {
  state: AdEvaluationState;
  shouldPause: boolean;
  confidence: number;
  rationale: string;
  ruleResults: Record<string, unknown>;
  category: 'creative' | 'audience' | 'landing_page' | 'budget' | 'placement' | 'tracking';
  expectedDirection: string;
  suggestedNextStep: string;
}

export interface PauseHierarchyUnit {
  targetType: AdTargetType;
  targetKey: string;
  parentTargetKey?: string | null;
  state: string;
  shouldPause: boolean;
}

/** Selects exactly one smallest safe pause target for a campaign cycle. */
export function selectAutonomousPauseTarget<T extends PauseHierarchyUnit>(
  evaluations: T[],
  campaignConfirmedSixHoursApart: boolean,
): T | undefined {
  const ads = evaluations.filter((item) => item.targetType === 'ad');
  const children = evaluations.filter((item) => item.targetType === 'ad_set' || item.targetType === 'ad_group');
  const campaign = evaluations.find((item) => item.targetType === 'campaign');
  const eligibleAds = ads.filter((item) => !['learning', 'manual_hold', 'insufficient_data'].includes(item.state));
  const allAdsFail = eligibleAds.length > 0 && eligibleAds.every((item) => item.shouldPause);
  const allChildrenFail = children.length > 0 && children.every((item) => item.shouldPause);

  if (campaignConfirmedSixHoursApart && campaign?.shouldPause && allChildrenFail && (!ads.length || allAdsFail)) {
    return campaign;
  }
  if (ads.length) {
    const failedChild = children.find((child) => {
      const childAds = eligibleAds.filter((ad) => ad.parentTargetKey === child.targetKey);
      return child.shouldPause && childAds.length > 0 && childAds.every((ad) => ad.shouldPause);
    });
    return failedChild || eligibleAds.find((item) => item.shouldPause);
  }
  return children.find((item) => item.shouldPause);
}

export interface ProviderExecutionStep {
  platform: AdPlatform;
  operation: 'create_campaign_paused' | 'create_children_paused' | 'activate_children' | 'activate_campaign';
  idempotencyKey: string;
}

export interface ProviderExecutionPlan {
  steps: ProviderExecutionStep[];
  rollback: Array<{ platform: AdPlatform; operation: 'archive_or_remove_campaign' }>;
}

const ACTIVE_PROVIDER_STATES = new Set(['ACTIVE', 'ENABLED']);

function thresholdValue(
  thresholds: PerformanceThresholds | undefined,
  baseline: PerformanceEvaluationInput['baseline'],
  key: keyof PerformanceThresholds,
): number | undefined {
  const explicit = thresholds?.[key];
  if (Number.isFinite(explicit) && Number(explicit) > 0) return Number(explicit);
  const historical = baseline?.[key];
  return Number.isFinite(historical) && Number(historical) > 0 ? Number(historical) : undefined;
}

/**
 * Evidence-gated, deterministic v1 policy. The LLM may explain this result but
 * cannot change the state or make a provider action eligible.
 */
export function evaluateAdPerformance(input: PerformanceEvaluationInput): PerformanceEvaluationResult {
  const now = input.now || new Date();
  const launchedAt = input.launchedAt?.getTime();
  const metricTime = input.metricsUpdatedAt?.getTime();
  const freshnessLimitMs = Math.max(30, input.analyticsSyncMinutes * 2) * 60_000;
  const learningComplete = input.reportingOnlyHistorical || Boolean(launchedAt && now.getTime() - launchedAt >= 72 * 60 * 60 * 1000);
  const metricsFresh = input.reportingOnlyHistorical || Boolean(metricTime && now.getTime() - metricTime <= freshnessLimitMs);
  const providerActive = input.reportingOnlyHistorical || ACTIVE_PROVIDER_STATES.has(String(input.providerStatus || '').toUpperCase());
  const manualHold = Boolean(input.manualHoldUntil && input.manualHoldUntil > now);
  const enoughSyncs = input.reportingOnlyHistorical || input.successfulSyncWindows >= 3;
  const syncHealthy = input.reportingOnlyHistorical || input.syncHealthy !== false;
  const enoughVolume = input.metrics.impressions >= 100 && input.metrics.spend > 0;
  const spendShare = input.lifetimeBudget > 0 ? input.metrics.spend / input.lifetimeBudget : 0;
  const catastrophic = spendShare >= 0.2
    && input.metrics.impressions >= 1_000
    && input.metrics.clicks === 0
    && input.metrics.conversions === 0;
  const leadMeasurement = input.objective !== 'leads' || (input.metrics.leads != null && Number.isFinite(input.metrics.leads) && input.metrics.leads >= 0);
  const spendLimit = thresholdValue(input.thresholds, null, 'spendLimit');
  const spendLimitReached = Boolean(spendLimit && Number(input.lifetimeSpend) >= spendLimit);
  const gates = { leadMeasurement, learningComplete, metricsFresh, providerActive, manualHold, enoughSyncs, syncHealthy, enoughVolume, spendShare, catastrophic, spendLimit, lifetimeSpend: input.lifetimeSpend, spendLimitReached, reportingOnlyHistorical: Boolean(input.reportingOnlyHistorical) };

  if (manualHold) {
    return {
      state: 'manual_hold', shouldPause: false, confidence: 0,
      rationale: `Manual control is active until ${input.manualHoldUntil!.toISOString()}.`,
      ruleResults: gates, category: 'budget', expectedDirection: 'No automated change',
      suggestedNextStep: 'Review performance after the manual hold ends.',
    };
  }
  if (!learningComplete) {
    return {
      state: 'learning', shouldPause: false, confidence: 0,
      rationale: 'The 72-hour learning period is still in progress.',
      ruleResults: gates, category: 'placement', expectedDirection: 'Collect more representative delivery data',
      suggestedNextStep: 'Wait for the learning period to complete before changing delivery.',
    };
  }
  if (!metricsFresh || !enoughSyncs || !syncHealthy || !providerActive || (!enoughVolume && !catastrophic)) {
    const reason = !metricsFresh
      ? 'Performance data is stale.'
      : !enoughSyncs
        ? 'At least three successful metric syncs are required.'
        : !syncHealthy
          ? 'The latest provider metric synchronization failed.'
        : !providerActive
          ? 'The provider unit is not in an active delivery state.'
          : 'The unit does not yet have sufficient impressions and spend for a reliable decision.';
    return {
      state: 'insufficient_data', shouldPause: false, confidence: 0,
      rationale: reason, ruleResults: gates, category: 'tracking',
      expectedDirection: !metricsFresh || !syncHealthy ? 'Restore reliable measurement' : 'Collect sufficient delivery evidence',
      suggestedNextStep: !metricsFresh || !syncHealthy
        ? 'Resolve provider or metric synchronization issues before acting on performance.'
        : !enoughSyncs
          ? 'Allow at least three successful metric syncs before assessing performance.'
          : !providerActive
            ? 'Review the campaign delivery status and schedule. A paused campaign does not indicate a synchronization failure.'
            : 'Review the reporting dates and wait for representative delivery evidence before judging performance.',
    };
  }

  if (!leadMeasurement) return {
    state: 'insufficient_data', shouldPause: false, confidence: 0,
    rationale: 'Lead-specific measurement is unavailable; conversions cannot be used as leads.',
    ruleResults: gates, category: 'tracking', expectedDirection: 'Restore lead measurement',
    suggestedNextStep: 'Synchronize provider lead actions before evaluating cost per lead.',
  };

  if (spendLimitReached) return {
    state: 'recommendation', shouldPause: false, confidence: 1,
    rationale: `Recorded campaign spend has reached the configured ${Number(spendLimit).toFixed(2)} monitoring limit.`,
    ruleResults: gates, category: 'budget', expectedDirection: 'Keep campaign spend within the approved monitoring limit',
    suggestedNextStep: 'Review delivery and either pause the campaign or update the spending limit. AskSales will not raise the limit automatically.',
  };

  let failing = false;
  let rationale = '';
  let category: PerformanceEvaluationResult['category'] = 'creative';
  let expectedDirection = 'Improve the objective-specific result rate';
  let suggestedNextStep = 'Review the creative message and audience fit before publishing a revised version.';
  let hasReliableBaseline = input.baselineSource !== 'none';
  const rules: Record<string, unknown> = { ...gates, baselineSource: input.baselineSource };

  if (input.objective === 'awareness') {
    const targetCpm = thresholdValue(input.thresholds, input.baseline, 'targetCpm')
      || (Number(input.baseline?.cpm) > 0 ? Number(input.baseline?.cpm) : undefined);
    const baselineReachEfficiency = Number(input.baseline?.reach || 0) / Math.max(Number(input.baseline?.spend || 0), 0.01);
    const reachEfficiency = input.metrics.reach / Math.max(input.metrics.spend, 0.01);
    failing = Boolean(targetCpm && baselineReachEfficiency > 0
      && input.metrics.cpm > targetCpm * 2
      && reachEfficiency < baselineReachEfficiency * 0.5);
    hasReliableBaseline = Boolean(targetCpm && baselineReachEfficiency > 0);
    rationale = failing
      ? 'CPM is more than twice the baseline while reach per currency unit is below half of baseline.'
      : 'Awareness delivery remains within the trusted CPM and reach-efficiency range.';
    category = 'placement';
    expectedDirection = 'Lower CPM and improve reach efficiency';
    suggestedNextStep = 'Review placements, frequency, and audience saturation.';
    Object.assign(rules, { targetCpm, baselineReachEfficiency, reachEfficiency });
  } else if (input.objective === 'traffic') {
    const targetCtr = thresholdValue(input.thresholds, input.baseline, 'targetCtr')
      || (Number(input.baseline?.ctr) > 0 ? Number(input.baseline?.ctr) : undefined);
    const targetCpc = thresholdValue(input.thresholds, input.baseline, 'targetCpc')
      || (Number(input.baseline?.cpc) > 0 ? Number(input.baseline?.cpc) : undefined);
    hasReliableBaseline = Boolean(targetCtr || targetCpc);
    failing = Boolean((targetCtr && input.metrics.ctr < targetCtr * 0.5)
      || (targetCpc && input.metrics.cpc > targetCpc * 2));
    const lowCtr = Boolean(targetCtr && input.metrics.ctr < targetCtr * 0.5);
    const highCpc = Boolean(targetCpc && input.metrics.cpc > targetCpc * 2);
    rationale = failing
      ? 'CTR is below half of target or CPC is more than twice the trusted baseline.'
      : 'Traffic efficiency remains within the trusted CTR and CPC range.';
    category = highCpc && !lowCtr ? 'budget' : 'creative';
    expectedDirection = 'Raise qualified CTR and reduce CPC';
    suggestedNextStep = category === 'budget'
      ? 'Review bid strategy and budget allocation before publishing a revised version.'
      : 'Test a clearer promise and stronger message-to-landing-page match.';
    Object.assign(rules, { targetCtr, targetCpc });
  } else if (input.objective === 'engagement') {
    const targetEngagementRate = thresholdValue(input.thresholds, input.baseline, 'targetEngagementRate')
      || (Number(input.baseline?.engagementRate) > 0 ? Number(input.baseline?.engagementRate) : undefined);
    const targetCpe = thresholdValue(input.thresholds, input.baseline, 'targetCpe')
      || (Number(input.baseline?.cpe) > 0 ? Number(input.baseline?.cpe) : undefined);
    hasReliableBaseline = Boolean(targetEngagementRate || targetCpe);
    failing = Boolean((targetEngagementRate && input.metrics.engagementRate < targetEngagementRate * 0.5)
      || (targetCpe && input.metrics.cpe > targetCpe * 2));
    const lowEngagementRate = Boolean(targetEngagementRate && input.metrics.engagementRate < targetEngagementRate * 0.5);
    const highCpe = Boolean(targetCpe && input.metrics.cpe > targetCpe * 2);
    rationale = failing
      ? 'Engagement rate is below half of target or cost per engagement is more than twice baseline.'
      : 'Engagement efficiency remains within the trusted range.';
    expectedDirection = 'Increase meaningful engagement and reduce CPE';
    category = highCpe && !lowEngagementRate ? 'budget' : 'creative';
    suggestedNextStep = category === 'budget'
      ? 'Review bid strategy and placement-level budget allocation.'
      : 'Revise the hook, format, or audience prompt to invite a clearer response.';
    Object.assign(rules, { targetEngagementRate, targetCpe });
  } else if (input.objective === 'sales') {
    const targetCpa = thresholdValue(input.thresholds, input.baseline, 'targetCpa')
      || (Number(input.baseline?.cpa) > 0 ? Number(input.baseline?.cpa) : undefined);
    const targetRoas = thresholdValue(input.thresholds, input.baseline, 'targetRoas')
      || (Number(input.baseline?.roas) > 0 ? Number(input.baseline?.roas) : undefined);
    hasReliableBaseline = Boolean(targetCpa || targetRoas);
    failing = Boolean((targetCpa && input.metrics.spend >= targetCpa * 2 && (input.metrics.conversions === 0 || input.metrics.cpa > targetCpa * 2))
      || (targetRoas && input.metrics.roas < targetRoas * 0.5));
    rationale = failing
      ? 'CPA is more than twice target or ROAS is below half of target.'
      : 'Sales efficiency remains within the trusted CPA and ROAS range.';
    category = input.metrics.clicks > 0 && input.metrics.conversions === 0
      ? 'landing_page'
      : targetCpa && input.metrics.conversions > 0 && input.metrics.cpa > targetCpa * 2
        ? 'budget'
        : 'audience';
    expectedDirection = 'Improve conversion rate and ROAS';
    suggestedNextStep = input.metrics.clicks > 0 && input.metrics.conversions === 0
      ? 'Inspect landing-page relevance, speed, offer, and conversion tracking.'
      : category === 'budget'
        ? 'Review bid strategy and budget allocation against the trusted CPA target.'
        : 'Review audience intent and the conversion offer.';
    Object.assign(rules, { targetCpa, targetRoas });
  } else {
    const targetCpa = thresholdValue(input.thresholds, input.baseline, input.objective === 'leads' ? 'targetCpl' : 'targetCpa')
      || (input.objective === 'leads' ? thresholdValue(input.thresholds, input.baseline, 'targetCpa') : undefined)
      || (Number(input.baseline?.cpa) > 0 ? Number(input.baseline?.cpa) : undefined);
    hasReliableBaseline = Boolean(targetCpa);
    const resultCount = input.objective === 'app_promotion' ? input.metrics.installs : input.metrics.leads!;
    const costPerResult = resultCount > 0 ? input.metrics.spend / resultCount : 0;
    failing = Boolean(targetCpa && input.metrics.spend >= targetCpa * 2
      && (resultCount === 0 || costPerResult > targetCpa * 2));
    rationale = failing
      ? `Spend reached twice the target cost per ${input.objective === 'app_promotion' ? 'install' : 'lead'} without efficient results.`
      : 'Cost per result remains within the trusted range.';
    category = input.metrics.clicks > 0 && resultCount === 0
      ? 'landing_page'
      : targetCpa && resultCount > 0 && costPerResult > targetCpa * 2
        ? 'budget'
        : 'audience';
    expectedDirection = `Reduce cost per ${input.objective === 'app_promotion' ? 'install' : 'lead'}`;
    suggestedNextStep = input.metrics.clicks > 0 && resultCount === 0
      ? 'Check the destination experience and conversion instrumentation.'
      : category === 'budget'
        ? 'Review bid strategy and budget allocation against the trusted cost-per-result target.'
        : 'Tighten the audience and make the result action more explicit.';
    Object.assign(rules, { targetCpa, resultCount, costPerResult });
  }

  if (!hasReliableBaseline && !catastrophic) {
    const state = input.metrics.impressions >= 1_000 ? 'recommendation' : 'insufficient_data';
    return {
      state,
      shouldPause: false,
      confidence: state === 'insufficient_data' ? 0 : 0.55,
      rationale: 'No reliable campaign target or historical baseline is available; the result remains advisory.',
      ruleResults: rules,
      category,
      expectedDirection,
      suggestedNextStep,
    };
  }

  const confirmed = catastrophic || (failing && input.consecutiveFailingWindows >= 2);
  return {
    state: confirmed || (input.reportingOnlyHistorical && failing) ? 'recommendation' : failing ? 'watch' : 'healthy',
    shouldPause: input.reportingOnlyHistorical ? false : confirmed,
    confidence: catastrophic ? 0.92 : confirmed ? 0.88 : failing ? 0.7 : 0.85,
    rationale: catastrophic
      ? 'The unit spent at least 20% of its lifetime allocation after 1,000 impressions without a click or conversion.'
      : rationale,
    ruleResults: { ...rules, failing, consecutiveFailingWindows: failing ? input.consecutiveFailingWindows + 1 : 0 },
    category,
    expectedDirection,
    suggestedNextStep,
  };
}

const OBJECTIVE_SIGNALS: Record<AdObjective, RegExp[]> = {
  awareness: [/\bawareness\b/i, /\breach\b/i, /\bbrand recall\b/i, /\bintroduc(?:e|ing)\b/i],
  traffic: [/\btraffic\b/i, /\bvisits?\b/i, /\bclicks?\b/i, /\bdrive (?:people|users) to\b/i],
  engagement: [/\bengagement\b/i, /\bcomments?\b/i, /\bshares?\b/i, /\bvideo views?\b/i],
  leads: [/\bleads?\b/i, /\bsign[\s-]?ups?\b/i, /\bbook (?:a )?(?:demo|call)\b/i, /\bforms?\b/i],
  sales: [/\bsales?\b/i, /\bpurchases?\b/i, /\bbuy\b/i, /\brevenue\b/i, /\bcheckout\b/i, /\broas\b/i],
  app_promotion: [/\bapp installs?\b/i, /\bdownloads?\b/i, /\bmobile app\b/i],
};

const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN', 'SGD', 'AED']);

function finiteNonNegative(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Infers an objective from campaign-specific evidence. There is deliberately
 * no fallback objective: ambiguous briefs must remain visibly unresolved.
 */
export function inferCampaignObjective(input: {
  brief?: string;
  contentStudioContext?: string;
  conversationContext?: string;
}): ObjectiveInference | null {
  const sources = [
    ['campaign_brief', input.brief || ''],
    ['content_studio', input.contentStudioContext || ''],
    ['conversation', input.conversationContext || ''],
  ] as const;
  const scores = new Map<AdObjective, number>();
  const matchedSources = new Set<string>();
  for (const [source, text] of sources) {
    if (!text.trim()) continue;
    for (const objective of AD_OBJECTIVES) {
      const hits = OBJECTIVE_SIGNALS[objective].reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);
      if (hits > 0) {
        scores.set(objective, (scores.get(objective) || 0) + hits);
        matchedSources.add(source);
      }
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked[1] && ranked[0][1] === ranked[1][1])) return null;
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const confidence = Math.min(0.99, Math.max(0.5, ranked[0][1] / total));
  const source = matchedSources.size > 1
    ? 'combined'
    : (matchedSources.values().next().value || 'campaign_brief') as ObjectiveInference['source'];
  return {
    objective: ranked[0][0],
    confidence,
    source,
    rationale: `Inferred ${ranked[0][0]} from ${ranked[0][1]} campaign-specific intent signal${ranked[0][1] === 1 ? '' : 's'}.`,
  };
}

export function validateCampaignForActivation(input: CampaignValidationInput): string[] {
  const errors: string[] = [];
  if (!input.objective || !AD_OBJECTIVES.includes(input.objective as AdObjective)) {
    errors.push('A supported, visible campaign objective is required.');
  }
  if (input.objectiveConfidence != null && (input.objectiveConfidence < 0 || input.objectiveConfidence > 1)) {
    errors.push('Objective confidence must be between 0 and 1.');
  }
  if (!Number.isFinite(input.lifetimeBudget) || input.lifetimeBudget <= 0) {
    errors.push('Lifetime budget must be greater than zero.');
  }
  if (!SUPPORTED_CURRENCIES.has(input.currency.toUpperCase())) {
    errors.push(`Unsupported campaign currency: ${input.currency}.`);
  }
  if (!(input.startDate instanceof Date) || Number.isNaN(input.startDate.getTime())) {
    errors.push('A valid campaign start date is required.');
  }
  if (input.endDate && input.endDate <= input.startDate) {
    errors.push('Campaign end date must be after its start date.');
  }
  if (!input.landingPageUrl) {
    errors.push('A landing page URL is required.');
  } else {
    try {
      const url = new URL(input.landingPageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) errors.push('Landing page URL must use HTTP or HTTPS.');
    } catch {
      errors.push('Landing page URL is invalid.');
    }
  }
  if (input.locations.length === 0) errors.push('At least one location target is required.');
  for (const location of input.locations) {
    if (!/^[A-Z]{2}$/.test(location.countryCode)) {
      errors.push(`Invalid ISO country code: ${location.countryCode || '(empty)'}.`);
    }
  }
  if (input.platforms.includes('google') && input.locations.some((location) => !location.googleGeoTargetId)) {
    errors.push('Every Google location requires an explicit geoTargetConstants resource name.');
  }
  if (input.platforms.length === 0) errors.push('At least one advertising platform is required.');
  for (const platform of input.platforms) {
    if (!input.accountReadiness[platform]) errors.push(`${platform} advertising account is not ready.`);
    if ((input.creativesCount[platform] || 0) < 1) errors.push(`${platform} requires at least one platform-ready creative.`);
  }
  errors.push(...validateBudgetCap(input.lifetimeBudget, input.allocations));
  return [...new Set(errors)];
}

export function validateBudgetCap(lifetimeBudget: number, allocations: CampaignAllocation[]): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  let totalAllocated = 0;
  let totalSpent = 0;
  for (const allocation of allocations) {
    if (keys.has(`${allocation.platform}:${allocation.key}`)) {
      errors.push(`Duplicate allocation key: ${allocation.platform}:${allocation.key}.`);
    }
    keys.add(`${allocation.platform}:${allocation.key}`);
    if (!Number.isFinite(allocation.amount) || allocation.amount < 0) errors.push(`Allocation ${allocation.key} is invalid.`);
    const spent = allocation.spent || 0;
    if (!Number.isFinite(spent) || spent < 0) errors.push(`Spend for ${allocation.key} is invalid.`);
    if (spent > allocation.amount) errors.push(`Spend for ${allocation.key} exceeds its allocation.`);
    totalAllocated = money(totalAllocated + finiteNonNegative(allocation.amount));
    totalSpent = money(totalSpent + finiteNonNegative(spent));
  }
  if (totalAllocated > money(lifetimeBudget)) {
    errors.push(`Allocated budget ${totalAllocated.toFixed(2)} exceeds campaign lifetime cap ${money(lifetimeBudget).toFixed(2)}.`);
  }
  if (totalSpent > money(lifetimeBudget)) {
    errors.push(`Recorded spend ${totalSpent.toFixed(2)} exceeds campaign lifetime cap ${money(lifetimeBudget).toFixed(2)}.`);
  }
  return errors;
}

export function reallocateWithinCap(
  lifetimeBudget: number,
  allocations: CampaignAllocation[],
  fromKey: string,
  toKey: string,
  amount: number,
): CampaignAllocation[] {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Reallocation amount must be greater than zero.');
  const next = allocations.map((allocation) => ({ ...allocation }));
  const from = next.find((allocation) => allocation.key === fromKey);
  const to = next.find((allocation) => allocation.key === toKey);
  if (!from || !to) throw new Error('Both source and destination allocations are required.');
  const available = money(from.amount - (from.spent || 0));
  if (money(amount) > available) throw new Error('Reallocation would move already-spent or unavailable budget.');
  from.amount = money(from.amount - amount);
  to.amount = money(to.amount + amount);
  const errors = validateBudgetCap(lifetimeBudget, next);
  if (errors.length) throw new Error(errors.join(' '));
  return next;
}

export function normalizeMetaMetric(raw: Record<string, unknown>, date: string): NormalizedMetric {
  const impressions = finiteNonNegative(raw.impressions);
  const clicks = finiteNonNegative(raw.clicks);
  const spend = finiteNonNegative(raw.spend);
  const conversions = finiteNonNegative(raw.conversions);
  const conversionValue = finiteNonNegative(raw.conversionValue);
  return calculateNormalized('meta', date, impressions, clicks, spend, finiteNonNegative(raw.reach), conversions, conversionValue, raw);
}

export function normalizeGoogleMetric(raw: Record<string, unknown>, date: string): NormalizedMetric {
  const metrics = (raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : raw) as Record<string, unknown>;
  const spend = finiteNonNegative(metrics.costMicros) / 1_000_000;
  return calculateNormalized(
    'google',
    date,
    finiteNonNegative(metrics.impressions),
    finiteNonNegative(metrics.clicks),
    spend,
    finiteNonNegative(metrics.reach),
    finiteNonNegative(metrics.conversions),
    finiteNonNegative(metrics.conversionsValue),
    raw,
  );
}

function calculateNormalized(
  platform: AdPlatform,
  date: string,
  impressions: number,
  clicks: number,
  spend: number,
  reach: number,
  conversions: number,
  conversionValue: number,
  source: unknown,
): NormalizedMetric {
  return {
    platform,
    date,
    impressions,
    clicks,
    spend: money(spend),
    reach,
    conversions,
    conversionValue: money(conversionValue),
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? conversionValue / spend : 0,
    providerStatus: typeof (source as Record<string, unknown>)?.status === 'string'
      ? String((source as Record<string, unknown>).status)
      : undefined,
    source,
  };
}

/**
 * Deterministic optimizer. It never increases the campaign cap and only moves
 * unspent allocation from a materially worse child to a better child.
 */
export function buildOptimizationDecisions(input: OptimizationInput): OptimizationDecision[] {
  if (validateBudgetCap(input.lifetimeBudget, input.allocations).length) {
    throw new Error('Campaign budget invariant is already violated; autonomous actions are blocked.');
  }
  if (input.totalSpent >= input.lifetimeBudget) {
    return [{
      action: 'pause',
      rationale: 'Lifetime budget cap has been reached.',
      metricsSnapshot: { totalSpent: input.totalSpent, lifetimeBudget: input.lifetimeBudget },
      budgetImpact: 0,
      idempotencyKey: `campaign:${input.campaignId}:pause:cap:${money(input.totalSpent)}`,
    }];
  }
  const minimumSpend = input.minimumSpendForDecision ?? 10;
  const latestMetricDate = input.metrics.reduce(
    (latest, metric) => metric.date > latest ? metric.date : latest,
    '',
  );
  if (input.currentStatus === 'paused') {
    if (
      input.pauseReason === 'ai_underperformance'
      && input.metrics.some((metric) => metric.conversions > 0)
    ) {
      return [{
        action: 'resume',
        rationale: 'Late normalized conversion data invalidated the autonomous underperformance pause.',
        metricsSnapshot: { metrics: input.metrics, totalSpent: input.totalSpent, lifetimeBudget: input.lifetimeBudget },
        budgetImpact: 0,
        idempotencyKey: `campaign:${input.campaignId}:resume:recovered:${latestMetricDate}`,
      }];
    }
    return [];
  }
  const sufficientlyObserved = input.metrics.length > 0
    && input.metrics.every((metric) => metric.spend >= minimumSpend * 2)
    && input.metrics.reduce((total, metric) => total + metric.impressions, 0) >= 1_000;
  if (
    sufficientlyObserved
    && input.metrics.every((metric) => metric.clicks === 0 && metric.conversions === 0)
  ) {
    return [{
      action: 'pause',
      rationale: 'Autonomous underperformance pause: every allocation spent at least twice the decision threshold without a click or conversion.',
      metricsSnapshot: { metrics: input.metrics, totalSpent: input.totalSpent, lifetimeBudget: input.lifetimeBudget },
      budgetImpact: 0,
      idempotencyKey: `campaign:${input.campaignId}:pause:underperformance:${latestMetricDate}`,
    }];
  }
  const scored = input.metrics
    .filter((metric) => metric.spend >= minimumSpend)
    .map((metric) => ({ metric, score: metric.roas > 0 ? metric.roas : (metric.conversions * 1000 + metric.clicks) / Math.max(metric.spend, 0.01) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length < 2 || scored[0].score <= scored[scored.length - 1].score * 1.2) return [];
  const best = scored[0].metric;
  const worst = scored[scored.length - 1].metric;
  const source = input.allocations.find((allocation) => allocation.key === worst.allocationKey);
  if (!source) return [];
  const decisions: OptimizationDecision[] = [];
  if (worst.conversions === 0 && worst.clicks >= 3) {
    decisions.push({
      action: 'create_replacement',
      targetKey: worst.allocationKey,
      rationale: `Create a replacement creative because ${worst.allocationKey} generated clicks but no conversions while ${best.allocationKey} materially outperformed it.`,
      metricsSnapshot: { best, worst, totalSpent: input.totalSpent, lifetimeBudget: input.lifetimeBudget },
      budgetImpact: 0,
      idempotencyKey: `campaign:${input.campaignId}:replacement:${worst.allocationKey}:${worst.date}`,
    });
  }
  const movable = money(Math.max(0, source.amount - (source.spent || 0)));
  const amount = money(Math.min(movable * 0.25, Math.max(0, input.lifetimeBudget - input.totalSpent)));
  if (amount <= 0) return decisions;
  decisions.push({
    action: 'reallocate',
    sourceKey: worst.allocationKey,
    targetKey: best.allocationKey,
    amount,
    rationale: `Reallocate 25% of unspent budget because ${best.allocationKey} outperforms ${worst.allocationKey} by at least 20%.`,
    metricsSnapshot: { best, worst, totalSpent: input.totalSpent, lifetimeBudget: input.lifetimeBudget },
    budgetImpact: 0,
    idempotencyKey: `campaign:${input.campaignId}:reallocate:${worst.allocationKey}:${best.allocationKey}:${amount}:${best.date}`,
  });
  return decisions;
}

export function buildProviderExecutionPlan(input: {
  platforms: AdPlatform[];
  autoActivate: boolean;
  idempotencyKey: string;
  validationErrors: string[];
}): ProviderExecutionPlan {
  if (input.validationErrors.length) {
    throw new Error(`Provider execution blocked by validation: ${input.validationErrors.join(' ')}`);
  }
  const platforms = [...new Set(input.platforms)];
  if (platforms.length === 0) throw new Error('At least one provider is required.');
  const steps = platforms.flatMap((platform): ProviderExecutionStep[] => {
    const prefix = `${input.idempotencyKey}:${platform}`;
    const creation: ProviderExecutionStep[] = [
      { platform, operation: 'create_campaign_paused', idempotencyKey: `${prefix}:campaign` },
      { platform, operation: 'create_children_paused', idempotencyKey: `${prefix}:children` },
    ];
    return input.autoActivate
      ? [
        ...creation,
        { platform, operation: 'activate_children', idempotencyKey: `${prefix}:activate-children` },
        { platform, operation: 'activate_campaign', idempotencyKey: `${prefix}:activate-campaign` },
      ]
      : creation;
  });
  return {
    steps,
    // Campaign removal/archive is provider-safe and makes all descendants
    // ineligible to serve after any partial failure.
    rollback: [...platforms].reverse().map((platform) => ({ platform, operation: 'archive_or_remove_campaign' })),
  };
}
