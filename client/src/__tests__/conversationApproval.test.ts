import { describe, expect, it } from 'vitest';
import { readDurableApproval, shouldAutoOpenApproval } from '@/lib/conversation-approval';

describe('durable conversation approvals', () => {
  const pendingApproval = {
    executionId: 'lead-input-set:review-2:2', toolName: 'execute_lead_workflow',
    args: { leadInputSetId: 'review-2', leadInputSetRevision: 2 }, message: 'Review saved inputs',
  };
  it('restores the exact pending approval after reload or reconnect', () => {
    expect(readDurableApproval({ requiresApproval: true, pendingApproval })).toEqual({
      requestId: 'lead-input-set:review-2:2', toolName: 'execute_lead_workflow',
      parameters: pendingApproval.args, toolDescription: 'Review saved inputs',
    });
  });
  it('clears approval after completion and rejects malformed state', () => {
    expect(readDurableApproval({ requiresApproval: false, pendingApproval })).toBeNull();
    expect(readDurableApproval({ requiresApproval: true, pendingApproval: { toolName: 'execute_lead_workflow' } })).toBeNull();
    expect(readDurableApproval(null)).toBeNull();
  });
  it('does not cover the reviewed lead parameters with another floating approval', () => {
    expect(shouldAutoOpenApproval(readDurableApproval({ requiresApproval: true, pendingApproval })!)).toBe(false);
    expect(shouldAutoOpenApproval({ toolName: 'execute_lead_workflow' })).toBe(true);
    expect(shouldAutoOpenApproval({ toolName: 'publish_social_post', parameters: { content_asset_id: 123 } })).toBe(true);
  });
  it('restores and opens the exact proposal review after a campaign reload', () => {
    const proposalArgs = {
      proposalId: 44,
      proposalNumber: 'PROP-0044',
      expectedRevision: 3,
      leadId: 101,
      channel: 'email',
      resolvedRecipient: 'asha@example.test',
      providerAccountId: 'seller@example.test',
      expectedTargetFingerprint: 'a'.repeat(64),
      expectedReviewFingerprint: 'b'.repeat(64),
      idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
    };
    const approval = readDurableApproval({
      requiresApproval: true,
      pendingApproval: {
        executionId: 'proposal-review-44-3',
        toolName: 'send_proposal',
        args: proposalArgs,
        message: 'Review this exact proposal delivery.',
      },
    });

    expect(approval).toEqual({
      requestId: 'proposal-review-44-3',
      toolName: 'send_proposal',
      parameters: proposalArgs,
      toolDescription: 'Review this exact proposal delivery.',
    });
    expect(shouldAutoOpenApproval(approval!)).toBe(true);
  });
});
