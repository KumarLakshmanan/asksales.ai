/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { currentAssistant } from '../services/assistants/AssistantContext.js';

const ready = jest.fn<(...args: any[]) => Promise<any>>();
const restorePersona = jest.fn<(...args: any[]) => Promise<any>>();
const supportCurrent = jest.fn<(...args: any[]) => Promise<boolean>>();
const updates: any[] = [];
let action: any;
let deliveryReceipt: any;
class SetupError extends Error { readonly code = 'ASSISTANT_SETUP_REQUIRED'; constructor(readonly reason: string) { super('Assistant setup required'); } }
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  select: () => {
    const chain: any = { then: (resolve: any) => Promise.resolve([action]).then(resolve) };
    for (const key of ['from','where','limit','orderBy']) chain[key] = () => chain;
    return chain;
  },
  update: () => ({ set: (value: any) => { updates.push(value); return { where: async () => [] }; } }),
} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({
  CustomerDeliverySetupError: SetupError, assertCustomerDeliveryReady: ready,
  currentCustomerDeliveryReceipt: () => deliveryReceipt,
  deliverySetupFailure: (error: unknown) => error instanceof SetupError ? { code: error.code, reason: error.reason, error: error.message } : undefined,
  withCustomerDeliveryReceipt: async (receipt: any, work: () => Promise<any>) => {
    const previous = deliveryReceipt; deliveryReceipt = receipt;
    try { return await work(); } finally { deliveryReceipt = previous; }
  },
}));
jest.unstable_mockModule('../services/assistants/ConversationDeliveryGate.js', () => ({ assertConversationDeliveryReady: ready }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({ assistantProvenanceCurrent: supportCurrent, assertAssistantFresh: async () => {}, withPublishedAssistant: restorePersona }));
jest.unstable_mockModule('../services/agents/orchestration/SupportConversationTurn.js', () => ({
  currentSupportTurn: () => undefined, sealSupportTurn: async () => {}, supportTurnDeliveryMetadata: () => ({}),
  supportTurnRetryAllowed: async () => true, withSupportTurnRetryLease: (_metadata: unknown, work: () => unknown) => work(),
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({
  AUTOMATIC_REPLY_DISABLED: 'disabled', automaticSupportReplyAllowed: async () => true, isAutomaticSupportDelivery: () => false, socialDraftChannel: () => false,
}));
const { DeliveryOutboxService } = await import('../services/agents/orchestration/DeliveryOutboxService.js');
const receipt = { assistantId: '11111111-1111-4111-8111-111111111111', revision: 3, bindingId: 4, bindingVersion: 2, businessProfileId: 7, channel: 'email', surface: 'private', accountId: 'sales@example.test' };
beforeEach(() => {
  jest.clearAllMocks(); updates.length = 0; deliveryReceipt = undefined;
  ready.mockReset().mockResolvedValue(receipt); supportCurrent.mockReset().mockImplementation(async p => Boolean(p));
  restorePersona.mockReset().mockImplementation(async () => { throw new Error('A delivery-only receipt must not install a support persona'); });
  action = { id: 15, userId: 9, conversationId: 21, channel: 'email', status: 'pending', payload: { text: 'Campaign facts', recipient: 'customer@example.test', metadata: { dispatchKind: 'pipeline_message', customerDeliveryAssistant: receipt } } };
});
describe('outbox receipt-only retries preserve authorization without a support persona', () => {
  const service = () => new DeliveryOutboxService() as any;
  it('lets a current delivery-only receipt reach its handler with the saved receipt and no persona', async () => {
    const outbox = service();
    const dispatch = jest.spyOn(outbox, 'processOwnedAction').mockImplementation(async () => {
      expect(deliveryReceipt).toEqual(receipt); expect(currentAssistant()).toBeUndefined();
    });
    await outbox.processAction(15);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(updates).toEqual([]);
    expect(restorePersona).not.toHaveBeenCalled(); expect(supportCurrent).not.toHaveBeenCalled();
  });
  it('holds stale receipt-only work instead of selecting a new live assistant', async () => {
    ready.mockRejectedValue(new SetupError('assignment_changed'));
    const outbox = service(); const dispatch = jest.spyOn(outbox, 'processOwnedAction');
    await outbox.processAction(15);
    expect(updates).toContainEqual(expect.objectContaining({ status: 'setup_required', nextAttemptAt: null }));
    expect(dispatch).not.toHaveBeenCalled(); expect(restorePersona).not.toHaveBeenCalled();
  });
  it('holds missing legacy receipts even when some assistant may now be available', async () => {
    delete action.payload.metadata.customerDeliveryAssistant;
    const outbox = service(); const dispatch = jest.spyOn(outbox, 'processOwnedAction');
    await outbox.processAction(15);
    expect(updates).toContainEqual(expect.objectContaining({ status: 'setup_required' }));
    expect(dispatch).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled(); expect(restorePersona).not.toHaveBeenCalled();
  });
  it('routes scheduler-ready delivery receipts through the same receipt-restoring path', async () => {
    const outbox = service(); jest.spyOn(outbox, 'reconcileExpiredLeases').mockResolvedValue(0);
    const dispatch = jest.spyOn(outbox, 'processOwnedAction').mockImplementation(async () => { expect(deliveryReceipt).toEqual(receipt); expect(currentAssistant()).toBeUndefined(); });
    expect(await outbox.processReady()).toEqual({ processed: 1, expired: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(restorePersona).not.toHaveBeenCalled(); expect(updates).toEqual([]);
  });
  it('uses receipt-only setup checks inside final claim suppression too', async () => {
    const outbox = service();
    expect(await outbox.suppressSupersededReply(action)).toBe(false);
    ready.mockRejectedValue(new SetupError('assignment_changed'));
    expect(await outbox.suppressSupersededReply(action)).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({ status: 'setup_required' }));
  });
  it('holds an existing support assignment disabled after queueing with explicit setup status', async () => {
    action.payload.metadata.assistant = receipt;
    ready.mockRejectedValue(new SetupError('runtime_disabled'));
    const outbox = service();
    expect(await outbox.suppressSupersededReply(action)).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({ status: 'setup_required', lastError: expect.stringContaining('runtime_disabled') }));
    expect(restorePersona).not.toHaveBeenCalled();
  });
});
