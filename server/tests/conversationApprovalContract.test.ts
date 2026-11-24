import { describe, expect, it } from '@jest/globals';
import { agentApproveSchema } from '../middleware/schemas.js';
import {
  mergePendingApprovalArguments,
  pendingApprovalMatchesRequest,
  validatePendingApprovalArguments,
} from '../mastra/approvalRequest.js';
import { isRetrySafeExecutionResult } from '../models/conversationToolApprovals/functions.js';

describe('Conversation Builder approval contract', () => {
  it('accepts the client request-bound contract and normalizes numeric IDs', () => {
    const parsed = agentApproveSchema.parse({
      threadId: '42',
      approved: true,
      requestId: 99,
      toolName: 'execute_lead_workflow',
      overrides: { platforms: ['linkedin'] },
    });

    expect(parsed).toEqual({
      threadId: 42,
      approved: true,
      requestId: '99',
      toolName: 'execute_lead_workflow',
      overrides: { platforms: ['linkedin'] },
    });
  });

  it('rejects the obsolete unrelated approvalId/decision request shape', () => {
    expect(() => agentApproveSchema.parse({
      approvalId: 'approval-1',
      decision: 'approve',
    })).toThrow();
  });

  it('requires both request identity and tool identity to match', () => {
    const pending = {
      toolName: 'publish_google_ads',
      args: { campaign_id: 'campaign-1' },
      executionId: 'perf-google-123',
      message: 'Approve?',
    };

    expect(pendingApprovalMatchesRequest(pending, 'perf-google-123', 'publish_google_ads')).toBe(true);
    expect(pendingApprovalMatchesRequest(pending, 'perf-google-999', 'publish_google_ads')).toBe(false);
    expect(pendingApprovalMatchesRequest(pending, 'perf-google-123', 'publish_meta_ads')).toBe(false);
  });

  it('schema-validates overrides before an approval can be claimed', () => {
    expect(validatePendingApprovalArguments('publish_google_ads', {
      campaign_id: 'campaign-1',
      budget: 500,
      injected_provider_payload: { bypass: true },
    })).toEqual({
      campaign_id: 'campaign-1',
      budget: 500,
      objective: 'traffic',
      currency: 'USD',
      budget_type: 'lifetime',
      placements: ['Automatic'],
    });

    expect(() => validatePendingApprovalArguments('publish_google_ads', {
      campaign_id: 'campaign-1',
      budget: 'not-a-number',
    })).toThrow();
  });

  it('keeps proposal delivery approvals immutable', () => {
    const frozen = {
      proposalId: 44,
      expectedRevision: 3,
      expectedTargetFingerprint: 'a'.repeat(64),
      expectedReviewFingerprint: 'b'.repeat(64),
      idempotencyKey: 'campaign-proposal-send-90-turn-1',
    };

    expect(mergePendingApprovalArguments('send_proposal', frozen)).toEqual(frozen);
    expect(() => mergePendingApprovalArguments('send_proposal', frozen, {
      idempotencyKey: 'different-send-key',
    })).toThrow('cannot be modified');
    expect(mergePendingApprovalArguments('publish_google_ads', { budget: 500 }, {
      budget: 750,
    })).toEqual({ budget: 750 });
  });

  it('allows replay only for an explicit definite pre-side-effect failure', () => {
    expect(isRetrySafeExecutionResult({
      success: false,
      output: { status: 'failed_before_side_effect', retrySafe: true },
    })).toBe(true);
    expect(isRetrySafeExecutionResult({
      ambiguous: true,
      retrySafe: false,
    })).toBe(false);
    expect(isRetrySafeExecutionResult({
      success: false,
      error: 'provider timeout',
    })).toBe(false);
  });
});
