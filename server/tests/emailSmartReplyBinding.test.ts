import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const returning = jest.fn<(...args: any[]) => Promise<any>>();
const claim = jest.fn<(...args: any[]) => Promise<any>>();
const markFailed = jest.fn<(...args: any[]) => Promise<any>>();
const send = jest.fn<(...args: any[]) => Promise<any>>();
const reserve = jest.fn<(...args: any[]) => Promise<any>>();
const refund = jest.fn<(...args: any[]) => Promise<any>>();
const db = { execute, update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
  transaction: async (callback: any) => callback(db) };
jest.unstable_mockModule('../services/EmailDesignService.js', () => ({ prepareDesignedEmail: async (_userId: number, body: string) => body }));
jest.unstable_mockModule('../models/db.js', () => ({ db }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: { claim, markFailed, markSent: jest.fn(), completeClaimedAction: jest.fn(), holdIfDisabled: async () => false },
}));
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({ withoutAssistantContext: <T>(work: () => T) => work(), currentAssistant: () => ({
  provenance: { accountId: 'owner@example.com' }, preview: false,
}) }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assertAssistantFresh: async () => {}, withPublishedAssistant: async (_value: unknown, work: () => Promise<unknown>) => work(),
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: {} }));
jest.unstable_mockModule('../services/booking/ExternalBookingDelivery.js', () => ({ plainTextEmailFallback: (text: string) => text }));
jest.unstable_mockModule('../utils/emailTemplates.js', () => ({ getBrandInfo: async () => ({}), renderBrandedEmail: ({ body }: any) => body }));
jest.unstable_mockModule('../utils/messageFormatter.js', () => ({ formatMessageForChannel: (text: string) => text }));
jest.unstable_mockModule('../models/outreachConversations/functions.js', () => ({
  getFullReferenceChain: async () => '<customer@example.com>', getLastMessageExternalId: async () => '<customer@example.com>',
}));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { reserveOutreachCredit: reserve, refundDeduction: refund } }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendPersonalizedEmail: send } }));
const { emailReplyService } = await import('../services/EmailReplyService.js');
const { prepareHandoffOffer } = await import('../services/agents/orchestration/HandoffConsent.js');
const handoffOffer = () => {
  const ctx: any = { message: { userId: 9, conversationId: 68, channel: 'email', rawMessageId: 'inbound-1' }, metadata: {} };
  prepareHandoffOffer(ctx);
  return ctx.metadata.handoffChoice;
};
const parse = (value: SQL) => new PgDialect().sqlToQuery(value);
const action = () => ({ id: 201, conversation_id: 68, payload: {
  text: '<!DOCTYPE html>Saved acknowledgment', recipient: 'qa@example.com',
  metadata: { sentMessageId: 91, exactConversationId: 68 },
} });
const run = () => emailReplyService.sendSmartReply(91, 'replacement must not override saved acknowledgment', 9, [], { actionId: 201, conversationId: 68 });

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockReset().mockImplementation(async (value: SQL) => {
    const sql = parse(value).sql;
    if (sql.includes('SELECT sm.*')) return { rows: [{ id: 91, user_id: 9, lead_id: 12, lead_email: 'qa@example.com',
      subject: 'Help', smart_reply: 'draft', smart_reply_approved: false, sender_id: 3, message_id: '<customer@example.com>',
      gmail_thread_id: 'thread-A', reply_context: { kind: 'support', conversationId: 68 }, smart_reply_assistant: { conversationId: 68 } }] };
    if (sql.includes('FROM support_delivery_outbox')) return { rows: [action()] };
    if (sql.includes('FROM outreach_conversations')) return { rows: [{ id: 68, external_thread_id: 'thread-A', subject: 'Help' }] };
    if (sql.includes('FROM email_senders')) return { rows: [{ id: 3 }] };
    if (sql.includes('UPDATE sent_messages') && sql.includes('RETURNING id')) return { rows: [{ id: 91 }] };
    return { rows: [] };
  });
  returning.mockReset().mockResolvedValue([{ id: 201 }]);
  claim.mockReset().mockResolvedValue({ state: 'claimed', action: { id: 201 } });
  markFailed.mockReset().mockResolvedValue(undefined);
  reserve.mockReset().mockResolvedValue({ success: true, transactionId: 30 });
  refund.mockReset().mockResolvedValue(undefined);
  send.mockReset().mockResolvedValue({ success: true, messageId: '<sent@example.com>' });
});

describe('durable assigned-assistant email reply binding', () => {
  it.each([
    { customReply: undefined, edited: false, formatted: false, authorizedOffer: true },
    { customReply: undefined, edited: false, formatted: true, authorizedOffer: true },
    { customReply: 'A manual replacement', edited: false, formatted: false, authorizedOffer: false },
    { customReply: undefined, edited: true, formatted: false, authorizedOffer: false },
  ])('binds only the unchanged generated handoff offer to the provider send: %j', async scenario => {
    const choice = handoffOffer();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (value: SQL) => {
      const query = parse(value).sql;
      if (query.includes('SELECT sm.*')) return { rows: [{ id: 91, user_id: 9, lead_id: 12, lead_email: 'qa@example.com', sender_id: 3,
        subject: 'Help', smart_reply: scenario.edited ? 'An edited reply' : scenario.formatted ? choice.fallbackText.replace(/\n/g,'<br />') : choice.prompt,
        reply_context: { kind: 'support', conversationId: 68, handoffChoice: choice }, smart_reply_assistant: { conversationId: 68 } }] };
      if (query.includes('FROM support_delivery_outbox')) return { rows: [] };
      return original(value);
    });
    expect(await emailReplyService.sendSmartReply(91, scenario.customReply, 9)).toMatchObject({ success: true });
    expect(claim.mock.calls[0][1].choice).toEqual(scenario.authorizedOffer ? choice : undefined);
    expect(send.mock.calls[0][2]).toBe(scenario.authorizedOffer ? choice.fallbackText : scenario.customReply || 'An edited reply');
  });
  it('retains the immutable offer metadata and body on a durable retry', async () => {
    const choice = handoffOffer();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (value: SQL) => parse(value).sql.includes('FROM support_delivery_outbox')
      ? { rows: [{ ...action(), payload: { ...action().payload, text: choice.fallbackText, choice } }] } : original(value));
    expect(await run()).toMatchObject({ success: true });
    expect(claim.mock.calls[0][1].choice).toEqual(choice);
    expect(send.mock.calls[0][2]).toBe(choice.fallbackText);
  });
  it('blocks recipient changes on every bound email action, including non-ticket smart replies', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 91, user_id: 9, lead_id: 12, lead_email: 'changed@example.com', smart_reply: 'draft',
      reply_context: { kind: 'support', conversationId: 68 }, smart_reply_assistant: { conversationId: 68 } }] })
      .mockResolvedValueOnce({ rows: [{ ...action(), payload: { ...action().payload, metadata: { sentMessageId: 91 } } }] });
    expect(await run()).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('recipient changed') }));
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects pre-context and unresolved queued replies before claiming or contacting the provider', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 91, user_id: 9, lead_id: 12, smart_reply: 'Oro Circle Reservations' }] });
    expect(await run()).toMatchObject({ success: false });
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the stored action, draft content, exact conversation and Gmail sender on retry', async () => {
    expect(await run()).toEqual({ success: true, mediaSent: 0 });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, conversationId: 68,
      inboundProviderMessageId: 'email-smart-reply:91' }), expect.anything());
    expect(send).toHaveBeenCalledWith(12, expect.any(String), '<!DOCTYPE html>Saved acknowledgment', undefined, 1, 9,
      expect.objectContaining({ senderId: 3, threadId: 'thread-A', inReplyTo: '<customer@example.com>' }));
    const conversations = execute.mock.calls.map((call) => parse(call[0])).filter((query) => query.sql.includes('FROM outreach_conversations'));
    expect(conversations).toHaveLength(2);
    expect(conversations.every((query) => query.params.includes(68))).toBe(true);
  });

  it('never calls the provider when the existing action is uncertain', async () => {
    claim.mockResolvedValueOnce({ state: 'uncertain', action: { id: 201 } });
    expect(await run()).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('uncertain') }));
    expect(send).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('repairs an already-sent local receipt without sending again', async () => {
    claim.mockResolvedValueOnce({ state: 'already_sent', action: { id: 201 } });
    expect(await run()).toEqual({ success: true, mediaSent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a different conversation context before claiming or sending', async () => {
    expect(await emailReplyService.sendSmartReply(91, undefined, 9, [], { actionId: 201, conversationId: 99 }))
      .toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('does not match') }));
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('marks a thrown provider attempt uncertain and never resets it to automatically resendable', async () => {
    send.mockRejectedValueOnce(new Error('network outcome unknown'));
    expect(await run()).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('uncertain') }));
    expect(markFailed).toHaveBeenCalledWith(201, 'network outcome unknown', true);
    expect(refund).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports provider rejection as failure and releases the draft for a governed retry', async () => {
    send.mockResolvedValueOnce({ success: false, error: 'Rejected' });
    expect(await run()).toEqual({ success: false, error: 'Rejected' });
    expect(markFailed).toHaveBeenCalledWith(201, 'Rejected', false);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.some((call) => parse(call[0]).sql.includes('smart_reply_approved = false'))).toBe(true);
  });
});
