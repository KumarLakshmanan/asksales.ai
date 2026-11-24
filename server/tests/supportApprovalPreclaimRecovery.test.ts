/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { syntheticApprovalDb } from './helpers/syntheticApprovalDb.js';
import { toolApprovalsTable as approvals } from '../models/toolApprovals/schema.js';
import { supportToolExecutionsTable as executions } from '../models/supportOrchestration/schema.js';
import { APPROVAL_RESUME_BLOCKED_MESSAGE } from '../../shared/supportApprovalRecovery.js';

const dispatch = jest.fn<any>();
jest.unstable_mockModule('../services/agents/subagents/index.js', () => ({ subAgentRegistry: { dispatchAny: dispatch } }));
jest.unstable_mockModule('../services/agents/orchestration/SafeToolExecutor.js', () => ({
  sanitizeSupportToolData: (value: unknown) => value, supportToolArgumentDigest: () => 'synthetic-digest',
}));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assistantProvenanceCurrent: async () => true, assertAssistantFresh: async () => undefined,
  withPublishedAssistant: async (_value: unknown, work: () => unknown) => work(),
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportAgentRuntime.js', () => ({ supportAgentRuntime: {
  recordToolOutcome: () => ({ success: true, status: 'success', confirmedSideEffect: true }),
} }));
// The real encryptor/decryptor exercises configuration failure, not a mock.
const { encryptRestrictedPayload } = await import('../services/agents/orchestration/PrivacyVaultService.js');
const { SupportToolResumeService } = await import('../services/agents/orchestration/SupportToolResumeService.js');
const fixtureKey = 'fixture-only-approval-key-never-used-for-real-data';
let database: any;
let service: InstanceType<typeof SupportToolResumeService>;

async function seed(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}) {
  process.env.SUPPORT_PII_ENCRYPTION_KEY = fixtureKey;
  const payload = encryptRestrictedPayload(7, 'support-tool-resume', {
    idempotencyKey: 'synthetic-preclaim', argumentDigest: 'synthetic-digest', toolName: 'create_booking',
    args: { room_type_id: 1 }, context: { userId: 7, conversationId: 42 }, ...payloadOverrides,
  });
  await database.insert(approvals).values({ id: 1, userId: 7, threadId: 42, status: 'approved', resumeStatus: 'ready',
    resumeAvailableAt: new Date(Date.now() - 100), updatedAt: new Date(), toolName: 'create_booking', resumeAttemptCount: 0,
    argumentDigest: 'synthetic-digest', expiresAt: new Date(Date.now() + 60_000), isExpired: false,
    resumeError: null, resumePayload: payload, ...overrides,
  }).returning();
  delete process.env.SUPPORT_PII_ENCRYPTION_KEY;
}
beforeEach(() => {
  jest.clearAllMocks(); database = syntheticApprovalDb([approvals, executions]); service = new SupportToolResumeService(database);
  dispatch.mockResolvedValue({ toolResults: [{ name: 'create_booking', result: { success: true, confirmedSideEffect: true } }] });
});
afterEach(() => { database.close(); delete process.env.SUPPORT_PII_ENCRYPTION_KEY; });

describe('protected approval pre-claim recovery', () => {
  it('records a redacted durable block without changing authorization or dispatching work', async () => {
    await seed();
    await expect(service.resumeApproval(7, 1)).rejects.toThrow();
    expect(database.rows(approvals)[0]).toMatchObject({ status: 'approved', resumeStatus: 'ready',
      resumeAttemptCount: 0, resumeError: APPROVAL_RESUME_BLOCKED_MESSAGE,
    });
    expect(database.rows(approvals)[0].resumeError).not.toContain(fixtureKey);
    expect(database.rows(executions)).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not report selected blocked approvals as successfully resumed', async () => {
    await seed();
    expect(await service.processReady()).toBe(0);
    expect(await service.processReadyReport()).toMatchObject({ selected: 1, completed: 0, blocked: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(database.rows(executions)).toEqual([]);
  });

  it('recovers exactly once when the original configuration returns', async () => {
    await seed();
    expect(await service.processReady()).toBe(0);
    process.env.SUPPORT_PII_ENCRYPTION_KEY = fixtureKey;
    expect(await service.processReady()).toBe(1);
    expect(database.rows(approvals)[0]).toMatchObject({ status: 'consumed', resumeStatus: 'completed', resumeError: null });
    expect(await service.processReady()).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not expose or change a foreign owner approval', async () => {
    await seed();
    expect(await service.resumeApproval(8, 1)).toBeNull();
    expect(database.rows(approvals)[0].resumeError).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('blocks an immutable-envelope mismatch with the same safe diagnostic', async () => {
    await seed({}, { toolName: 'send_payment_link' });
    process.env.SUPPORT_PII_ENCRYPTION_KEY = fixtureKey;
    await expect(service.resumeApproval(7, 1)).rejects.toThrow();
    expect(database.rows(approvals)[0].resumeError).toBe(APPROVAL_RESUME_BLOCKED_MESSAGE);
    expect(database.rows(executions)).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
  });
});
