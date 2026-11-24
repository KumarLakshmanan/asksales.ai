import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const assignment = { assistantId: 'published-assistant', bindingId: 1 };
let decision: any;
let notificationAssistant: any;
const execute = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ rows: [{ id: 2, session_id: 1, deferred_commit: {}, automation_mode: 'ai_active' }] });
const db: any = { execute, transaction: async (work: any) => work(db) };
const deliveryCurrent = jest.fn<(...args: any[]) => Promise<boolean>>().mockImplementation(async value => value === assignment);
jest.unstable_mockModule('../models/db.js', () => ({ db }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { commitDeferredDelivery: async (result: any) => { delete result.deferredEffectContext; } } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  decryptRestrictedPayload: () => ({ sessionId: 1, userMessageIds: [1], inboundId: 'qa', ownership: 'current', decision, assistantProvenance: notificationAssistant }),
  encryptRestrictedPayload: jest.fn(),
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportConversationTurn.js', () => ({ currentSupportTurn: () => undefined, supportOwnershipSnapshot: async () => 'current' }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assistantProvenanceCurrent: async (value: unknown) => value === assignment,
  assistantDeliveryCurrent: deliveryCurrent,
  withPublishedAssistant: async (_value: unknown, work: () => Promise<unknown>) => work(),
}));
const { finishWidgetCommit } = await import('../services/agents/orchestration/WidgetCommitRecovery.js');

describe('widget delivery freshness', () => {
  beforeEach(() => {
    decision = { provenance: {}, deferredEffectContext: { userId: 1, conversationId: -1, assistantProvenance: assignment } };
    notificationAssistant = undefined;
    deliveryCurrent.mockClear();
  });
  it('retains the published assignment after deferred effects consume their context', async () => {
    expect(await finishWidgetCommit(1, 2)).toBe(true);
    expect(decision.deferredEffectContext).toBeUndefined();
    expect(deliveryCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(deliveryCurrent.mock.calls.every(call => call[0] === assignment)).toBe(true);
  });
  it('delivers a review notice only while its published assignment remains available', async () => {
    decision = null;
    notificationAssistant = assignment;
    expect(await finishWidgetCommit(1, 2)).toBe(true);
    expect(deliveryCurrent.mock.calls.every(call => call[0] === assignment)).toBe(true);
  });
  it('does not deliver a review notice without an assistant assignment', async () => {
    decision = null;
    expect(await finishWidgetCommit(1, 2)).toBe(false);
    expect(deliveryCurrent).not.toHaveBeenCalled();
  });
});
