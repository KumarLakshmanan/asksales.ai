import { describe, expect, it, jest } from '@jest/globals';
import { routerOutputSchema } from '../mastra/routerSchema.js';

// These are pure contract checks; explicitly prevent importing a live database.
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
const { isRetrySafeExecutionResult } = await import('../models/conversationToolApprovals/functions.js');

describe('campaign QA controlled fault boundaries', () => {
  it.each([
    { retrySafe: true, ambiguous: true },
    { retrySafe: true, sideEffectsMayHaveOccurred: true },
    { retrySafe: true, output: { retrySafe: false, sideEffectsMayHaveOccurred: true } },
    { success: false, output: { retrySafe: true, status: 'needs_attention', sideEffectsMayHaveOccurred: true } },
    { success: false, output: { retrySafe: true, status: 'queued', acknowledgedQueueCount: 1 } },
    { success: true, retrySafe: true },
    { retrySafe: false, output: { retrySafe: true } },
    { retrySafe: true, output: { deliveryProgress: { sent: 1 } } },
    { retrySafe: true, output: { results: [{ success: true, leadId: 7 }] } },
    { retrySafe: true, output: { platforms: { meta: { status: 'active' }, google: { status: 'gated' } } } },
    { retrySafe: true, output: { platforms: [{ status: 'QUEUED' }] } },
    { retrySafe: true, output: { acknowledgedQueueCount: '2' } },
    { retrySafe: true, output: { results: [{ retrySafe: false }] } },
    { retrySafe: true, output: { manualReviewRequired: true } },
  ])('denies blind retry when a safe-retry hint conflicts with side-effect evidence: %j', result => {
    expect(isRetrySafeExecutionResult(result)).toBe(false);
  });

  it('retains explicitly safe pre-side-effect retries', () => {
    expect(isRetrySafeExecutionResult({ success: false, output: {
      status: 'failed_before_side_effect', retrySafe: true, sideEffectsMayHaveOccurred: false,
    } })).toBe(true);
  });

  it.each([
    { success: false, retrySafe: true },
    { success: false, output: { retrySafe: true, reason: 'provider_temporarily_unavailable' } },
    { success: false, output: { retrySafe: true, status: 'gated', reason: 'provider_not_ready' } },
    { success: false, output: { retrySafe: true, status: 'failed_before_side_effect', successCount: 0,
      results: [{ success: false, error: 'Rejected before acceptance' }] } },
    { success: false, output: { retrySafe: true, content: { status: 'published', success: true } } },
  ])('preserves safe hints without treating generated content as execution evidence: %j', result => {
    expect(isRetrySafeExecutionResult(result)).toBe(true);
  });

  it('fails closed on circular structured receipts', () => {
    const result: Record<string, unknown> = { retrySafe: true };
    result.output = result;
    expect(isRetrySafeExecutionResult(result)).toBe(false);
  });

  it('fails closed on unbounded structured receipt collections', () => {
    expect(isRetrySafeExecutionResult({ retrySafe: true, output: { results: Array(1001).fill(null) } })).toBe(false);
  });

  it.each([null, [], 'not JSON', { intent: 'task', hiredAgents: ['invented_sender'] }, {
    intent: 'navigation', hiredAgents: [], mode: 'none', isAffirmative: false,
    isDomainMatch: false, navigationTarget: { tabType: 'execute_payment', tabLabel: 'Unsafe' },
    response: 'Ready', nextAgent: null, suggestAgents: false, recommendedAgents: [],
  }])('rejects malformed or unknown routing data without inferring a task: %j', candidate => {
    expect(routerOutputSchema.safeParse(candidate).success).toBe(false);
  });
});
