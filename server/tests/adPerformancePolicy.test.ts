import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  evaluateAdPerformance,
  objectiveDefaultThresholds,
  selectAutonomousPauseTarget,
  type PerformanceAggregate,
  type PerformanceEvaluationInput,
} from '../services/ads/AutonomousAdsDomain.js';
import {
  importedAllocationSnapshot,
  normalizeProviderObjective,
  redactUnreadyAdPerformanceConfidence,
} from '../services/ads/AdPerformanceService.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const METRICS: PerformanceAggregate = {
  impressions: 4_000,
  clicks: 20,
  spend: 200,
  reach: 2_000,
  conversions: 2,
  leads: 2,
  conversionValue: 100,
  engagements: 40,
  installs: 2,
  ctr: 0.5,
  cpc: 10,
  cpm: 50,
  cpa: 100,
  roas: 0.5,
  engagementRate: 1,
  cpe: 5,
};

function input(overrides: Partial<PerformanceEvaluationInput> = {}): PerformanceEvaluationInput {
  return {
    objective: 'traffic',
    metrics: METRICS,
    lifetimeBudget: 1_000,
    thresholds: { targetCtr: 2, targetCpc: 3 },
    baseline: null,
    baselineSource: 'campaign_target',
    launchedAt: new Date(NOW.getTime() - 96 * 60 * 60 * 1_000),
    metricsUpdatedAt: new Date(NOW.getTime() - 10 * 60 * 1_000),
    now: NOW,
    analyticsSyncMinutes: 15,
    successfulSyncWindows: 3,
    providerStatus: 'ACTIVE',
    consecutiveFailingWindows: 2,
    ...overrides,
  };
}

describe('AI ad performance policy', () => {
  it('imports historical provider spend without violating allocation constraints', () => {
    expect(importedAllocationSnapshot(694.82)).toEqual({ allocatedAmount: 694.82, spentAmount: 694.82 });
    expect(importedAllocationSnapshot('2899.91')).toEqual({ allocatedAmount: 2899.91, spentAmount: 2899.91 });
    expect(importedAllocationSnapshot(-1)).toEqual({ allocatedAmount: 0, spentAmount: 0 });
    expect(importedAllocationSnapshot('invalid')).toEqual({ allocatedAmount: 0, spentAmount: 0 });
  });

  it('maps provider objectives into the deterministic policy vocabulary', () => {
    expect(normalizeProviderObjective('OUTCOME_AWARENESS')).toBe('awareness');
    expect(normalizeProviderObjective('OUTCOME_TRAFFIC')).toBe('traffic');
    expect(normalizeProviderObjective('OUTCOME_ENGAGEMENT')).toBe('engagement');
    expect(normalizeProviderObjective('OUTCOME_LEADS')).toBe('leads');
    expect(normalizeProviderObjective('OUTCOME_SALES')).toBe('sales');
    expect(normalizeProviderObjective('APP_INSTALLS')).toBe('app_promotion');
  });
  it('blocks live action throughout learning, stale data, failed sync evidence, and manual holds', () => {
    expect(evaluateAdPerformance(input({ launchedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000) }))).toEqual(expect.objectContaining({ state: 'learning', confidence: 0 }));
    expect(evaluateAdPerformance(input({ metricsUpdatedAt: new Date(NOW.getTime() - 31 * 60 * 1_000) }))).toEqual(expect.objectContaining({ state: 'insufficient_data', confidence: 0 }));
    expect(evaluateAdPerformance(input({ successfulSyncWindows: 2 })).shouldPause).toBe(false);
    expect(evaluateAdPerformance(input({ syncHealthy: false })).shouldPause).toBe(false);
    expect(evaluateAdPerformance(input({ manualHoldUntil: new Date(NOW.getTime() + 60_000) }))).toEqual(expect.objectContaining({ state: 'manual_hold', confidence: 0 }));
  });

  it('redacts legacy full-confidence values for unready evaluations and their recommendations', () => {
    expect(redactUnreadyAdPerformanceConfidence(
      [{ id: '1', state: 'insufficient_data', confidence: '1.0000' }, { id: '2', state: 'healthy', confidence: '0.8500' }],
      [{ id: '10', evaluation_id: '1', evaluation_state: 'insufficient_data', confidence: '1.0000' }, { id: '11', evaluation_id: '2', confidence: '0.8500' }],
    )).toEqual({
      evaluations: [{ id: '1', state: 'insufficient_data', confidence: null }, { id: '2', state: 'healthy', confidence: '0.8500' }],
      recommendations: [{ id: '10', evaluation_id: '1', evaluation_state: 'insufficient_data', confidence: null }, { id: '11', evaluation_id: '2', confidence: '0.8500' }],
    });
  });

  it('classifies identical metrics differently by campaign objective', () => {
    const traffic = evaluateAdPerformance(input());
    const awareness = evaluateAdPerformance(input({
      objective: 'awareness',
      thresholds: { targetCpm: 30 },
      baseline: { cpm: 30, reach: 1_500, spend: 100 },
      baselineSource: 'historical',
    }));
    expect(traffic.shouldPause).toBe(true);
    expect(awareness.shouldPause).toBe(false);
  });

  it('requires three consecutive failing windows for ordinary underperformance', () => {
    expect(evaluateAdPerformance(input({ consecutiveFailingWindows: 0 })).state).toBe('watch');
    expect(evaluateAdPerformance(input({ consecutiveFailingWindows: 1 })).shouldPause).toBe(false);
    expect(evaluateAdPerformance(input({ consecutiveFailingWindows: 2 })).shouldPause).toBe(true);
  });

  it('allows only the catastrophic zero-result fallback without a baseline', () => {
    const result = evaluateAdPerformance(input({
      thresholds: {},
      baseline: null,
      baselineSource: 'none',
      metrics: { ...METRICS, impressions: 1_000, clicks: 0, conversions: 0, spend: 200 },
    }));
    expect(result.shouldPause).toBe(true);
    expect(result.ruleResults.catastrophic).toBe(true);
  });

  it('keeps low-volume and non-active provider units recommendation-only', () => {
    expect(evaluateAdPerformance(input({ metrics: { ...METRICS, impressions: 50 } })).state).toBe('insufficient_data');
    expect(evaluateAdPerformance(input({ providerStatus: 'LEARNING' })).shouldPause).toBe(false);
    expect(evaluateAdPerformance(input({ providerStatus: 'PAUSED' })).shouldPause).toBe(false);
    expect(evaluateAdPerformance(input({ providerStatus: 'PUBLISHED' })).shouldPause).toBe(false);
  });

  it('distinguishes low delivery from synchronization failures in its next action', () => {
    const lowVolume = evaluateAdPerformance(input({ metrics: { ...METRICS, impressions: 0, spend: 0 } }));
    expect(lowVolume.suggestedNextStep).toContain('representative delivery evidence');
    const pendingSyncs = evaluateAdPerformance(input({ successfulSyncWindows: 1 }));
    expect(pendingSyncs.suggestedNextStep).toContain('three successful metric syncs');
    const failedSync = evaluateAdPerformance(input({ syncHealthy: false }));
    expect(failedSync.suggestedNextStep).toContain('synchronization issues');
  });

  it('requires measured leads and computes CPL independently of other conversions', () => {
    expect(evaluateAdPerformance(input({objective:'leads', thresholds:{targetCpa:50}, metrics:{...METRICS,leads:null,conversions:100}})).state).toBe('insufficient_data');
    const result = evaluateAdPerformance(input({objective:'leads',thresholds:{targetCpa:50},metrics:{...METRICS,spend:200,leads:1,conversions:100,cpa:2}}));
    expect(result.shouldPause).toBe(true);
    expect(result.ruleResults).toMatchObject({resultCount:1,costPerResult:200});
  });

  it('uses a lead-specific CPL target while keeping CPA for sales', () => {
    const leads = evaluateAdPerformance(input({ objective: 'leads', thresholds: { targetCpl: 40, targetCpa: 500 }, metrics: { ...METRICS, spend: 200, leads: 2, conversions: 2, cpa: 100 } }));
    const sales = evaluateAdPerformance(input({ objective: 'sales', thresholds: { targetCpl: 500, targetCpa: 40 }, metrics: { ...METRICS, spend: 200, conversions: 2, cpa: 100 } }));
    expect(leads.ruleResults).toMatchObject({ targetCpa: 40, costPerResult: 100 });
    expect(sales.ruleResults).toMatchObject({ targetCpa: 40 });
  });

  it('raises a read-only recommendation when the campaign spend limit is reached', () => {
    const result = evaluateAdPerformance(input({ thresholds: { spendLimit: 1_000 }, lifetimeSpend: 1_020 }));
    expect(result).toMatchObject({ state: 'recommendation', shouldPause: false, category: 'budget' });
    expect(result.ruleResults).toMatchObject({ spendLimit: 1_000, lifetimeSpend: 1_020, spendLimitReached: true });
    expect(result.suggestedNextStep).toContain('will not raise the limit automatically');
  });

  it('applies lead and sales target rules without relying on an LLM', () => {
    const leads = evaluateAdPerformance(input({ objective: 'leads', thresholds: { targetCpa: 50 }, metrics: { ...METRICS, leads: 0, conversions: 0, cpa: 0 } }));
    const sales = evaluateAdPerformance(input({ objective: 'sales', thresholds: { targetCpa: 40, targetRoas: 2 } }));
    expect(leads.shouldPause).toBe(true);
    expect(sales.shouldPause).toBe(true);
  });

  it('applies engagement-rate/CPE and app-install rules deterministically', () => {
    const engagement = evaluateAdPerformance(input({
      objective: 'engagement',
      thresholds: { targetEngagementRate: 3, targetCpe: 2 },
      metrics: { ...METRICS, engagementRate: 1, cpe: 5 },
    }));
    const appPromotion = evaluateAdPerformance(input({
      objective: 'app_promotion',
      thresholds: { targetCpa: 40 },
      metrics: { ...METRICS, spend: 100, installs: 0, cpa: 0 },
    }));
    expect(engagement.shouldPause).toBe(true);
    expect(appPromotion.shouldPause).toBe(true);
  });

  it('classifies isolated cost inefficiency as a bid/budget recommendation', () => {
    const traffic = evaluateAdPerformance(input({
      metrics: { ...METRICS, ctr: 2, cpc: 10 },
    }));
    expect(traffic.shouldPause).toBe(true);
    expect(traffic.category).toBe('budget');
  });

  it('treats late results as a fresh healthy evaluation and never auto-resumes', () => {
    const lateConversion = evaluateAdPerformance(input({
      objective: 'leads',
      thresholds: { targetCpa: 50 },
      metrics: { ...METRICS, spend: 100, leads: 4, conversions: 4, cpa: 25 },
      consecutiveFailingWindows: 3,
    }));
    expect(lateConversion.state).toBe('healthy');
    expect(lateConversion.shouldPause).toBe(false);
  });

  it('uses only currency-neutral objective defaults', () => {
    expect(objectiveDefaultThresholds('traffic')).toEqual({ targetCtr: 1 });
    expect(objectiveDefaultThresholds('sales')).toEqual({ targetRoas: 1 });
    expect(objectiveDefaultThresholds('leads')).toEqual({});
  });

  it('can produce historical recommendations without current provider sync windows', () => {
    const result = evaluateAdPerformance(input({
      reportingOnlyHistorical: true,
      successfulSyncWindows: 0,
      providerStatus: 'ENDED',
      metricsUpdatedAt: new Date('2025-01-01T00:00:00.000Z'),
    }));
    expect(result.state).toBe('recommendation');
    expect(result.shouldPause).toBe(false);
  });

  it('uses sibling comparisons for advisory evidence without making a pause eligible', () => {
    const result = evaluateAdPerformance(input({
      baselineSource: 'sibling_comparison',
      baseline: { ctr: 2, cpc: 3 },
      thresholds: {},
      reportingOnlyHistorical: true,
      providerStatus: 'ACTIVE',
    }));
    expect(result.state).toBe('recommendation');
    expect(result.shouldPause).toBe(false);
  });
});

describe('autonomous pause hierarchy', () => {
  const campaign = { targetType: 'campaign' as const, targetKey: 'campaign', state: 'recommendation', shouldPause: true };
  const setOne = { targetType: 'ad_set' as const, targetKey: 'set-1', state: 'recommendation', shouldPause: true };
  const setTwo = { targetType: 'ad_set' as const, targetKey: 'set-2', state: 'healthy', shouldPause: false };
  const adOne = { targetType: 'ad' as const, targetKey: 'ad-1', parentTargetKey: 'set-1', state: 'recommendation', shouldPause: true };
  const adTwo = { targetType: 'ad' as const, targetKey: 'ad-2', parentTargetKey: 'set-1', state: 'healthy', shouldPause: false };

  it('pauses only the failing ad when a sibling is healthy', () => {
    expect(selectAutonomousPauseTarget([campaign, setOne, adOne, adTwo], false)?.targetKey).toBe('ad-1');
  });

  it('pauses a child only when all of its eligible ads fail', () => {
    const secondFailure = { ...adTwo, state: 'recommendation', shouldPause: true };
    expect(selectAutonomousPauseTarget([campaign, setOne, setTwo, adOne, secondFailure], false)?.targetKey).toBe('set-1');
  });

  it('requires the six-hour confirmation before selecting the whole campaign', () => {
    const failingSetTwo = { ...setTwo, state: 'recommendation', shouldPause: true };
    const setTwoAd = { targetType: 'ad' as const, targetKey: 'ad-3', parentTargetKey: 'set-2', state: 'recommendation', shouldPause: true };
    const allFail = [campaign, setOne, failingSetTwo, adOne, { ...adTwo, state: 'recommendation', shouldPause: true }, setTwoAd];
    expect(selectAutonomousPauseTarget(allFail, false)?.targetKey).toBe('set-1');
    expect(selectAutonomousPauseTarget(allFail, true)?.targetKey).toBe('campaign');
  });
});

describe('ad performance architecture contract', () => {
  const root = path.resolve(process.cwd());
  const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

  it('defaults and migrates every existing account to autonomy off', () => {
    const migration = read('migrations/224_add_ai_controlled_ad_performance.js');
    expect(migration).toContain('ALTER COLUMN autonomous_optimization_enabled SET DEFAULT FALSE');
    expect(migration).toContain("autonomy_mode = 'off'");
    expect(migration).toContain('consented_at = NULL');
    expect(migration).toContain("action_type IN ('resume', 'reallocate', 'create_replacement')");
    expect(migration).toContain('performance_ad_campaigns_default_autonomy_policy');
    expect(migration).toContain('SELECT campaign.id, campaign.user_id, FALSE');
  });

  it('exposes dual-consent, evidence, recommendation, and resume interfaces', () => {
    const campaigns = read('routes/campaigns.routes.ts');
    const settings = read('routes/settings.routes.ts');
    expect(settings).toContain("router.get('/ads/autonomy'");
    expect(settings).toContain("router.put('/ads/autonomy'");
    expect(campaigns).toContain("router.get('/autonomous/:id/policy'");
    expect(campaigns).toContain("router.get('/autonomous/:id/performance'");
    expect(campaigns).toContain("recommendations/:recommendationId'");
    expect(campaigns).toContain("targets/:targetType/:targetId/resume'");
    expect(campaigns).toContain("router.post('/autonomous/import-provider'");
    expect(campaigns).toContain("router.get('/analytics/provider/:platform/:campaignId'");
    expect(campaigns).not.toContain("router.post('/autonomous/:id/optimize'");
  });

  it('revalidates consent, policy version, freshness, hold, and target status before a pause', () => {
    const performance = read('services/ads/AdPerformanceService.ts');
    const processor = read('services/ads/AutonomousAdsActionProcessor.ts');
    expect(processor).toContain('revalidateAutonomousPause(action)');
    expect(processor).toContain('This v1 action is approval-only');
    expect(performance).toContain('Consent was revoked or renewed');
    expect(performance).toContain('manual 72-hour hold');
    expect(performance).toContain('underlying provider metrics are stale');
    expect(performance).toContain('provider target is no longer active');
    expect(performance).toContain('newer performance evaluation superseded this pause decision');
  });

  it('reads provider currency only from current credential tables', () => {
    const performance = read('services/ads/AdPerformanceService.ts');
    const dashboard = read('controllers/campaignAnalyticsController.ts');
    expect(performance).not.toContain('ad_platform_credentials');
    expect(dashboard).not.toContain('ad_platform_credentials');
    expect(performance).toContain("service_name = 'google_ads'");
    expect(dashboard).toContain("service_name = 'google_ads'");
  });

  it('keeps post-pause notification delivery outside provider-success persistence', () => {
    const processor = read('services/ads/AutonomousAdsActionProcessor.ts');
    expect(processor).toContain('Notification scheduling is deliberately outside the provider-success');
    expect(processor).toContain("status IN ('pending', 'failed')");
    expect(processor).toContain('attempts < delivery.max_attempts');
    expect(processor).toContain('/dashboard/ads/campaigns/managed/');
    expect(processor).toContain('?tab=automation&action=');
    expect(processor).toContain('AI action #${Number(row.action_id)}');
    expect(processor).toContain('&action=${Number(row.action_id)}');
  });

  it('persists deterministic rationale and next-step fields on every evaluation', () => {
    const migration = read('migrations/239_add_ad_evaluation_explanations.js');
    const performance = read('services/ads/AdPerformanceService.ts');
    expect(migration).toContain('rationale TEXT');
    expect(migration).toContain('expected_direction TEXT');
    expect(migration).toContain('suggested_next_step TEXT');
    expect(performance).toContain('${result.rationale}');
    expect(performance).toContain("'sibling_comparison'");
    expect(performance).not.toContain('INSERT INTO ad_unit_metrics');
    expect(performance).toContain("COALESCE(provider_payload->>'importedFromProviderCache', 'false') <> 'true'");
    expect(performance).toContain('importedFromProviderCache: true');
    expect(performance).toContain('providerMutation: false');
    expect(performance).toContain('!forcedAdvisory && settings.mode');
    const controller = read('controllers/autonomousAdsController.ts');
    expect(controller).toContain('{ advisoryOnly: true }');
  });

  it('applies paid ads workspace platform, objective, and status filters to managed and provider-only rows', () => {
    const dashboard = read('controllers/campaignAnalyticsController.ts');
    expect(dashboard).toContain("req.query.platform === 'string'");
    expect(dashboard).toContain("req.query.objective === 'string'");
    expect(dashboard).toContain("req.query.status === 'string'");
    expect(dashboard).toContain("pac.ad_platform = ${platform}");
    expect(dashboard).toContain("ELSE pac.objective END) = ${objective}");
    expect(dashboard).toContain('providerOnlyRows');
    expect(dashboard).toContain('req.query.status');
  });

  it('records provider outcomes as append-only evaluations and snapshots provider resource targets', () => {
    const processor = read('services/ads/AutonomousAdsActionProcessor.ts');
    const performance = read('services/ads/AdPerformanceService.ts');
    expect(processor).not.toContain("UPDATE ad_performance_evaluations\n          SET state = 'ai_paused'");
    expect(processor).toContain("confidence, 'ai_paused', hypothetical_action");
    expect(performance).toContain('target_resource');
    expect(performance).toContain("hypothetical_action = 'pause'");
    const migration = read('migrations/224_add_ai_controlled_ad_performance.js');
    expect(migration).toContain('ad_performance_evaluations_immutable');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON ad_performance_evaluations');
  });

  it('normalizes Google engagement and app-install signals at every hierarchy level', () => {
    const google = read('services/ads/GoogleAdsService.ts');
    const ingestion = read('services/AnalyticsIngestionService.ts');
    expect((google.match(/metrics\.engagements/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(ingestion).toContain('engagements: child.engagements');
    expect(ingestion).toContain('engagements: ad.engagements');
    expect(ingestion).toContain('installs: isAppPromotion ? child.conversions : 0');
    expect(ingestion).toContain('installs: isAppPromotion ? ad.conversions : 0');
  });

  it('retires the normal-user direct optimization endpoint', () => {
    const campaigns = read('routes/campaigns.routes.ts');
    expect(campaigns).toContain('STORED_AD_PERFORMANCE_ONLY');
    expect(campaigns).not.toContain("validateBody(campaignOptimizeSchema), optimizeCampaign");
  });
});
