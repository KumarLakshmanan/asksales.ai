import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
jest.unstable_mockModule('../events/EventBus.js', () => ({
  eventBus: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publish: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

const {
  APPROVAL_TIMEOUT_MS,
  isPendingApprovalExpired,
  expireStaleApprovals,
  stampPendingApproval,
} = await import('../mastra/approvalExpiry.js');
import type { AgentState, PendingApproval } from '../mastra/state';

function makeState(approval: PendingApproval | null): AgentState {
  return {
    userId: 1,
    threadId: 100,
    workflowId: 'wf-1',
    messages: [],
    currentAgent: 'orchestrator',
    nextAgent: null,
    pendingApproval: approval,
  } as unknown as AgentState;
}

describe('approvalExpiry (Phase 7.11 / MASTRA-002)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('APPROVAL_TIMEOUT_MS is a positive number', () => {
    expect(APPROVAL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('isPendingApprovalExpired returns false when createdAt is missing (backward compat)', () => {
    const approval: PendingApproval = { toolName: 't', args: {}, executionId: 'x', message: 'm' };
    expect(isPendingApprovalExpired(approval)).toBe(false);
  });

  it('isPendingApprovalExpired returns false within timeout', () => {
    const approval = stampPendingApproval({ toolName: 't', args: {}, executionId: 'x', message: 'm' });
    jest.advanceTimersByTime(APPROVAL_TIMEOUT_MS - 1);
    expect(isPendingApprovalExpired(approval)).toBe(false);
  });

  it('isPendingApprovalExpired returns true at/after timeout', () => {
    const approval = stampPendingApproval({ toolName: 't', args: {}, executionId: 'x', message: 'm' });
    jest.advanceTimersByTime(APPROVAL_TIMEOUT_MS);
    expect(isPendingApprovalExpired(approval)).toBe(true);
  });

  it('expireStaleApprovals counts only expired entries', () => {
    const old = stampPendingApproval({ toolName: 'old', args: {}, executionId: 'b', message: 'm' });
    jest.advanceTimersByTime(APPROVAL_TIMEOUT_MS / 2);
    const fresh = stampPendingApproval({ toolName: 'fresh', args: {}, executionId: 'a', message: 'm' });

    const states = new Map<number, AgentState>([
      [100, makeState(fresh)],
      [101, makeState(old)],
    ]);
    jest.advanceTimersByTime(APPROVAL_TIMEOUT_MS / 2 + 1);
    const result = expireStaleApprovals(states);
    expect(result.expiredCount).toBe(1);
    expect(result.expiredToolNames).toEqual(['old']);
  });
});
