/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { syntheticApprovalDb } from './helpers/syntheticApprovalDb.js';
import { toolApprovalsTable as approvals } from '../models/toolApprovals/schema.js';
import { supportToolExecutionsTable as executions } from '../models/supportOrchestration/schema.js';
const dispatch = jest.fn<any>();
const freshness = jest.fn<any>();
const freshCheck = jest.fn<any>();
jest.unstable_mockModule('../services/agents/subagents/index.js', () => ({ subAgentRegistry: { dispatchAny: dispatch } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ decryptRestrictedPayload: (_user: number, _purpose: string, value: any) => value }));
jest.unstable_mockModule('../services/agents/orchestration/SafeToolExecutor.js', () => ({ sanitizeSupportToolData: (value: any) => value, supportToolArgumentDigest: () => 'synthetic-digest' }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({ assistantProvenanceCurrent: freshness,
  assertAssistantFresh: freshCheck, withPublishedAssistant: async (_value: any, work: any) => work() }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAgentRuntime.js', () => ({ supportAgentRuntime: {
  recordToolOutcome: (_name: any, _args: any, result: any) => ({ status: result.toolResults?.[0]?.result?.success ? 'success' : 'failed',
    success: result.toolResults?.[0]?.result?.success === true, confirmedSideEffect: result.toolResults?.[0]?.result?.confirmedSideEffect === true }),
} }));
const { SupportToolResumeService } = await import('../services/agents/orchestration/SupportToolResumeService.js');
const result = { toolResults: [{ name: 'create_booking', result: { success: true, confirmedSideEffect: true } }] };
let database: any;
let service: InstanceType<typeof SupportToolResumeService>;
async function seed(overrides: any = {}) {
  await database.insert(approvals).values({ id: 1, userId: 7, threadId: 42, status: 'approved', resumeStatus: 'ready',
    resumeAvailableAt: new Date(Date.now() - 100), updatedAt: new Date(), toolName: 'create_booking', resumeAttemptCount: 0,
    argumentDigest: 'synthetic-digest', expiresAt: new Date(Date.now() + 60_000), isExpired: false,
    resumePayload: { idempotencyKey: 'synthetic-operation', argumentDigest: 'synthetic-digest', toolName: 'create_booking',
      args: { room_type_id: 1 }, context: { userId: 7, conversationId: 42 } }, ...overrides,
  }).returning();
}
beforeEach(() => {
  jest.clearAllMocks(); database = syntheticApprovalDb([approvals, executions]); service = new SupportToolResumeService(database);
  dispatch.mockResolvedValue(result); freshness.mockResolvedValue(true); freshCheck.mockResolvedValue(undefined);
});
afterEach(() => { database.close(); jest.useRealTimers(); });
describe('support approval recovery with disposable SQL state and mocked actions', () => {
  it('rejects an expired approval before creating or dispatching work', async () => {
    await seed({ expiresAt: new Date(Date.now() - 1) });
    expect(await service.resumeApproval(7, 1)).toBeNull();
    expect(database.rows(approvals)[0].status).toBe('expired');
    expect(database.rows(executions)).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
  });
  it('rolls back the approval claim when execution persistence fails, then retries once', async () => {
    await seed(); database.failNextInsert();
    await expect(service.resumeApproval(7, 1)).rejects.toThrow('SYNTHETIC_EXECUTION_INSERT_FAILURE');
    expect(database.rows(approvals)[0].status).toBe('approved');
    expect(database.rows(approvals)[0].resumeStatus).toBe('ready');
    expect(database.rows(executions)).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
    await service.resumeApproval(7, 1); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('claims concurrent duplicate requests once and retains the saved result', async () => {
    await seed(); await Promise.all([service.resumeApproval(7, 1), service.resumeApproval(7, 1)]);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(database.rows(executions)).toHaveLength(1);
    expect(database.rows(approvals)[0].resumeStatus).toBe('completed');
    expect(await service.resumeApproval(7, 1)).toBeNull(); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('makes an old orphan claim visible for reconciliation without replaying it', async () => {
    await seed({ status: 'executing', resumeStatus: 'running', updatedAt: new Date(Date.now() - 180_000) });
    expect(await service.processReadyReport()).toMatchObject({ selected: 1, completed: 0, requiresReconciliation: 1 });
    expect(database.rows(executions)[0]).toMatchObject({ status: 'failed', reconciliationStatus: 'pending' });
    expect(database.rows(approvals)[0].consumedExecutionId).toBe(database.rows(executions)[0].id);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not access a foreign owner approval', async () => {
    await seed(); expect(await service.resumeApproval(8, 1)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled(); expect(database.rows(executions)).toEqual([]);
  });
  it('expires revoked unstarted work without dispatch', async () => {
    await seed(); freshness.mockResolvedValue(false); await service.resumeApproval(7, 1);
    expect(database.rows(approvals)[0].status).toBe('expired'); expect(dispatch).not.toHaveBeenCalled();
  });
  it('rechecks authorization expiry after a delayed freshness check', async () => {
    jest.useFakeTimers(); await seed();
    freshCheck.mockImplementation(async () => { jest.setSystemTime(Date.now() + 61_000); });
    await service.resumeApproval(7, 1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(database.rows(executions)[0]).toMatchObject({ status: 'failed', reconciliationStatus: 'pending' });
  });
  it('does not recover or replay a fresh in-progress claim', async () => {
    await seed({ status: 'executing', resumeStatus: 'running' });
    expect(await service.processReady()).toBe(0);
    expect(await service.resumeApproval(7, 1)).toBeNull();
    expect(database.rows(executions)).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
  });
  it('fences a late result from an earlier reviewed and retried attempt', async () => {
    jest.useFakeTimers(); await seed();
    let finishOld!: (value: any) => void;
    dispatch.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const first = service.resumeApproval(7, 1);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(15_001); await first;
    await database.update(executions).set({ reconciledAt: new Date(), reconciliationStatus: 'confirmed_not_executed' }).where(eq(executions.id, 1));
    await database.update(approvals).set({ status: 'approved', resumeStatus: 'ready', resumeAvailableAt: new Date() }).where(eq(approvals.id, 1));
    dispatch.mockResolvedValue({ toolResults: [{ name: 'create_booking', result: { success: false } }] });
    await service.resumeApproval(7, 1);
    expect(database.rows(executions)[0].attemptCount).toBe(2);
    finishOld(result); for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(database.rows(executions)[0]).toMatchObject({ attemptCount: 2, status: 'failed', reconciliationStatus: 'pending' });
  });
  it.each([false, true])('records a late result while respecting operator review (%s)', async reviewed => {
    jest.useFakeTimers(); await seed();
    let finish!: (value: any) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.resumeApproval(7, 1);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1); await jest.advanceTimersByTimeAsync(15_001);
    expect(await pending).toBeNull();
    expect(database.rows(executions)[0]).toMatchObject({ status: 'failed', reconciliationStatus: 'pending' });
    if (reviewed) await database.update(executions).set({ reconciledAt: new Date(), reconciliationStatus: 'confirmed_not_executed' }).where(eq(executions.id, 1));
    finish(result); for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(database.rows(executions)[0].status).toBe(reviewed ? 'failed' : 'success');
    expect(database.rows(approvals)[0].resumeStatus).toBe(reviewed ? 'failed' : 'completed');
  });
});
