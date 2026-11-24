import { describe, expect, it } from '@jest/globals';
import {
  buildOptimizationDecisions,
  buildProviderExecutionPlan,
  inferCampaignObjective,
  normalizeGoogleMetric,
  normalizeMetaMetric,
  reallocateWithinCap,
  validateBudgetCap,
  validateCampaignForActivation,
} from '../services/ads/AutonomousAdsDomain.js';

describe('autonomous ads financial and activation guardrails', () => {
  it('does not apply a global objective when campaign evidence is ambiguous', () => {
    expect(inferCampaignObjective({ brief: 'Create a campaign for our summer launch.' })).toBeNull();
    expect(inferCampaignObjective({
      brief: 'Drive qualified demo bookings and collect leads.',
      contentStudioContext: 'Sign up for a product demo.',
    })).toEqual(expect.objectContaining({
      objective: 'leads',
      source: 'combined',
    }));
  });

  it('blocks aggregate allocation and spend above the lifetime cap', () => {
    expect(validateBudgetCap(100, [
      { key: 'meta-a', platform: 'meta', amount: 60, spent: 20 },
      { key: 'google-a', platform: 'google', amount: 40, spent: 10 },
    ])).toEqual([]);
    expect(validateBudgetCap(100, [
      { key: 'meta-a', platform: 'meta', amount: 60 },
      { key: 'google-a', platform: 'google', amount: 40.01 },
    ])).toContain('Allocated budget 100.01 exceeds campaign lifetime cap 100.00.');
    expect(validateBudgetCap(100, [
      { key: 'meta-a', platform: 'meta', amount: 50, spent: 51 },
    ])).toContain('Spend for meta-a exceeds its allocation.');
  });

  it('only reallocates unspent money and preserves the campaign cap', () => {
    const allocations = reallocateWithinCap(100, [
      { key: 'weak', platform: 'meta', amount: 60, spent: 50 },
      { key: 'strong', platform: 'meta', amount: 40, spent: 10 },
    ], 'weak', 'strong', 10);
    expect(allocations).toEqual([
      { key: 'weak', platform: 'meta', amount: 50, spent: 50 },
      { key: 'strong', platform: 'meta', amount: 50, spent: 10 },
    ]);
    expect(() => reallocateWithinCap(100, allocations, 'weak', 'strong', 0.01))
      .toThrow('already-spent or unavailable');
  });

  it('requires objective, dates, landing page, locations, creatives, accounts, currency, and budget before activation', () => {
    const errors = validateCampaignForActivation({
      objective: null,
      lifetimeBudget: 100,
      currency: 'USD',
      allocations: [{ key: 'meta-a', platform: 'meta', amount: 100 }],
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-07-31T00:00:00Z'),
      landingPageUrl: '',
      locations: [],
      platforms: ['meta', 'google'],
      accountReadiness: { meta: false, google: false },
      creativesCount: { meta: 0, google: 0 },
    });
    expect(errors).toEqual(expect.arrayContaining([
      'A supported, visible campaign objective is required.',
      'Campaign end date must be after its start date.',
      'A landing page URL is required.',
      'At least one location target is required.',
      'meta advertising account is not ready.',
      'google advertising account is not ready.',
    ]));
  });

  it('builds idempotent Meta and Google provider routing with rollback and automatic activation', () => {
    const plan = buildProviderExecutionPlan({
      platforms: ['meta', 'google'],
      autoActivate: true,
      idempotencyKey: 'campaign-123',
      validationErrors: [],
    });
    expect(plan.steps.map((step) => `${step.platform}:${step.operation}`)).toEqual([
      'meta:create_campaign_paused',
      'meta:create_children_paused',
      'meta:activate_children',
      'meta:activate_campaign',
      'google:create_campaign_paused',
      'google:create_children_paused',
      'google:activate_children',
      'google:activate_campaign',
    ]);
    expect(new Set(plan.steps.map((step) => step.idempotencyKey)).size).toBe(plan.steps.length);
    expect(plan.rollback).toEqual([
      { platform: 'google', operation: 'archive_or_remove_campaign' },
      { platform: 'meta', operation: 'archive_or_remove_campaign' },
    ]);
    expect(() => buildProviderExecutionPlan({
      platforms: ['meta'],
      autoActivate: true,
      idempotencyKey: 'blocked',
      validationErrors: ['account not ready'],
    })).toThrow('Provider execution blocked');
  });

  it('normalizes Meta and Google metrics into the same units', () => {
    const meta = normalizeMetaMetric({
      impressions: '1000',
      clicks: '50',
      spend: '25',
      conversions: '5',
      conversionValue: '100',
      status: 'ACTIVE',
    }, '2026-07-27');
    const google = normalizeGoogleMetric({
      metrics: {
        impressions: '1000',
        clicks: '50',
        costMicros: '25000000',
        conversions: '5',
        conversionsValue: '100',
      },
      status: 'ENABLED',
    }, '2026-07-27');
    expect(meta).toEqual(expect.objectContaining({ spend: 25, ctr: 5, cpc: 0.5, cpa: 5, roas: 4 }));
    expect(google).toEqual(expect.objectContaining({ spend: 25, ctr: 5, cpc: 0.5, cpa: 5, roas: 4 }));
  });

  it('pauses at the cap and makes deterministic zero-impact optimization decisions', () => {
    expect(buildOptimizationDecisions({
      campaignId: 7,
      lifetimeBudget: 100,
      totalSpent: 100,
      allocations: [{ key: 'meta-a', platform: 'meta', amount: 100, spent: 100 }],
      metrics: [],
      currentStatus: 'active',
    })).toEqual([expect.objectContaining({ action: 'pause', budgetImpact: 0 })]);

    const decisions = buildOptimizationDecisions({
      campaignId: 8,
      lifetimeBudget: 100,
      totalSpent: 40,
      allocations: [
        { key: 'weak', platform: 'meta', amount: 50, spent: 20 },
        { key: 'strong', platform: 'meta', amount: 50, spent: 20 },
      ],
      metrics: [
        { allocationKey: 'weak', ...normalizeMetaMetric({ impressions: 1000, clicks: 10, spend: 20 }, '2026-07-27') },
        { allocationKey: 'strong', ...normalizeMetaMetric({ impressions: 1000, clicks: 100, spend: 20 }, '2026-07-27') },
      ],
      currentStatus: 'active',
    });
    expect(decisions).toEqual([
      expect.objectContaining({
        action: 'create_replacement',
        targetKey: 'weak',
        budgetImpact: 0,
      }),
      expect.objectContaining({
        action: 'reallocate',
        sourceKey: 'weak',
        targetKey: 'strong',
        amount: 7.5,
        budgetImpact: 0,
      }),
    ]);
  });

  it('pauses deterministic underperformance and only resumes an AI pause after late conversions', () => {
    const weakMetric = {
      allocationKey: 'meta-a',
      ...normalizeMetaMetric({ impressions: 1500, clicks: 0, spend: 25 }, '2026-07-27'),
    };
    expect(buildOptimizationDecisions({
      campaignId: 9,
      lifetimeBudget: 100,
      totalSpent: 25,
      allocations: [{ key: 'meta-a', platform: 'meta', amount: 100, spent: 25 }],
      metrics: [weakMetric],
      currentStatus: 'active',
      minimumSpendForDecision: 10,
    })).toEqual([expect.objectContaining({ action: 'pause' })]);

    expect(buildOptimizationDecisions({
      campaignId: 9,
      lifetimeBudget: 100,
      totalSpent: 25,
      allocations: [{ key: 'meta-a', platform: 'meta', amount: 100, spent: 25 }],
      metrics: [{
        allocationKey: 'meta-a',
        ...normalizeMetaMetric({ impressions: 1500, clicks: 0, spend: 25, conversions: 1 }, '2026-07-28'),
      }],
      currentStatus: 'paused',
      pauseReason: 'ai_underperformance',
    })).toEqual([expect.objectContaining({ action: 'resume' })]);

    expect(buildOptimizationDecisions({
      campaignId: 9,
      lifetimeBudget: 100,
      totalSpent: 25,
      allocations: [{ key: 'meta-a', platform: 'meta', amount: 100, spent: 25 }],
      metrics: [weakMetric],
      currentStatus: 'paused',
      pauseReason: 'user',
    })).toEqual([]);
  });
});
