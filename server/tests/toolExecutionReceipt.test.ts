import { describe, expect, it } from '@jest/globals';
import { canDeleteWidgetReview, isRetrySafeExecutionResult } from '../../shared/toolExecutionReceipt.js';

describe('shared receipt decisions', () => {
  it.each(['provider_succeeded', 'scheduled', 'claimed', 'retryable_failed', 'uncertain', 'ambiguous', 'reconciliation_required'])(
    'does not treat an existing %s operation as a new pre-effect retry', status => {
      expect(isRetrySafeExecutionResult({ retrySafe: true, output: { status } })).toBe(false);
    },
  );
  it.each(['outcomeUncertain', 'reconciliationRequired'])(
    'keeps the structured %s flag authoritative over a retry hint', key => {
      expect(isRetrySafeExecutionResult({ retrySafe: true, output: { [key]: true } })).toBe(false);
    },
  );
  it('does not authorize discard from a revision marker with contradictory outcome evidence', () => {
    const marker = { executed: false, reason: 'review_revised', supersededByWidgetId: 2 };
    expect(canDeleteWidgetReview({ status: 'cancelled', executionAttemptCount: 0, executionResult: marker })).toBe(true);
    expect(canDeleteWidgetReview({ status: 'cancelled', executionAttemptCount: 0, executionResult: { ...marker, ambiguous: true } })).toBe(false);
    expect(canDeleteWidgetReview({ status: 'cancelled', executionAttemptCount: 1, executionResult: marker })).toBe(false);
  });
  it('ignores unrelated generated prose while retaining receipt flags', () => {
    expect(isRetrySafeExecutionResult({ retrySafe: true, output: { status: 'failed_before_side_effect',
      content: { status: 'succeeded', success: true } } })).toBe(true);
  });
});
