import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
const send = jest.fn<(...args: any[]) => Promise<any>>();
const claim = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn() } }));
jest.unstable_mockModule('drizzle-orm', () => ({ sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) }));
jest.unstable_mockModule('../utils/messageFormatter.js', () => ({ formatMessageForChannel: (text: string) => text }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { sendText: send } }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({ deliveryOutboxService: {
  holdIfDisabled: jest.fn<any>().mockResolvedValue(false), claim, completeClaimedAction: complete, markFailed: jest.fn(),
} }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({ automaticSupportReplyAllowed: jest.fn<any>().mockResolvedValue(true), socialDraftChannel: () => true }));
const { DeliveryStage } = await import('../services/agents/pipeline/stages/DeliveryStage.js');
const context = (replyText: string, reason = 'verified_natural_knowledge_answer') => ({
  message: { userId: 9, conversationId: 41, channel: 'whatsapp', senderIdentifier: 'qa-recipient',
    inboundText: 'where is this located ?', rawMessageId: 'qa-inbound', phoneNumberId: 'qa-phone' },
  metadata: {}, confidence: 1, policyViolations: [], agentResult: { replyText, escalated: false,
    answerVerification: { reason, mayDeliver: true, answerGrounding: 'grounded', claims: [], unsupportedClaims: [] } },
}) as PipelineContext;
beforeEach(() => {
  jest.clearAllMocks();
  send.mockResolvedValue({ success: true, messages: [{ id: 'qa-outbound' }] });
  claim.mockResolvedValue({ state: 'claimed', action: { id: 1 } });
  complete.mockResolvedValue(undefined);
});
describe('cohesive WhatsApp knowledge replies', () => {
  it.each(['verified_natural_knowledge_answer', 'verbatim_published_evidence'])('keeps a short %s response together', async reason => {
    const text = 'We’re about 30 minutes from Kempegowda International Airport.\n\nPlease choose an option.';
    const ctx = await new DeliveryStage().execute(context(text, reason));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text, contextMessageId: 'qa-inbound' }));
    expect(claim.mock.calls[0][1].metadata.totalParts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(ctx.metadata?.deliveryStatus).toBe('sent');
  });
  it('preserves explicit message separators', async () => {
    await new DeliveryStage().execute(context('First fact.|||Second fact.', 'verbatim_published_evidence'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[0].text)).toEqual(['First fact.', 'Second fact.']);
  });
  it('does not resend an already delivered reply', async () => {
    claim.mockResolvedValue({ state: 'sent', action: { id: 1, providerMessageId: 'already-sent' } });
    const ctx = await new DeliveryStage().execute(context('We’re about 30 minutes from the airport.'));
    expect(send).not.toHaveBeenCalled();
    expect(ctx.metadata?.sentMessageIds).toEqual(['already-sent']);
  });
});
