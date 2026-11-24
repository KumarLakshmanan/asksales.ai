import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn() } }));
jest.unstable_mockModule('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../utils/messageFormatter.js', () => ({
  formatMessageForChannel: (text: string) => text,
}));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: { sendText: jest.fn() },
}));
const allowed = jest.fn<any>().mockResolvedValue(true);
const draft = jest.fn<any>().mockResolvedValue({ id: 91, status: 'drafted' });
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({
  automaticSupportReplyAllowed: allowed, socialDraftChannel: (channel: string) => ['whatsapp','instagram','facebook'].includes(channel.replace('_comment','')),
}));
const mockOutboxClaim = jest.fn<any>();
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: { draft, claim: mockOutboxClaim, markSent: jest.fn(), markFailed: jest.fn() },
}));
const mockVoiceDeliver = jest.fn<any>();
jest.unstable_mockModule('../services/OutreachVoiceReplyDeliveryService.js', () => ({
  outreachVoiceReplyDeliveryService: { deliver: mockVoiceDeliver },
}));

const { DeliveryStage } = await import('../services/agents/pipeline/stages/DeliveryStage.js');

describe('voice-aware canonical delivery stage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allowed.mockResolvedValue(true);
    mockVoiceDeliver.mockResolvedValue({
      externalMessageId: 'voice-provider-id',
      deliveryActionId: 91,
      sentAsVoice: true,
      persistedNew: false,
    });
  });

  it('keeps email replies text-only even when the inbound email contains audio', async () => {
    const ctx = {
      message: {
        userId: 4,
        conversationId: 17,
        channel: 'email',
        senderIdentifier: 'customer@example.com',
        inboundText: 'Grounded transcription context',
        rawMessageId: '<email-message@example.com>',
        metadata: { voiceReplyRequested: true },
      },
      agentResult: { replyText: 'Approved text email reply' },
      confidence: 1,
      policyViolations: [],
      metadata: {},
    } as any;

    const result = await new DeliveryStage().execute(ctx);

    expect(result.metadata?.deliveryDeferred).toBe(true);
    expect(mockVoiceDeliver).not.toHaveBeenCalled();
    expect(mockOutboxClaim).not.toHaveBeenCalled();
  });

  it('routes approved WhatsApp voice responses through the idempotent voice delivery service', async () => {
    const ctx = {
      message: {
        userId: 4,
        conversationId: 17,
        channel: 'whatsapp',
        senderIdentifier: '919999999999',
        inboundText: 'Grounded transcription context',
        rawMessageId: 'wamid.inbound',
        messageId: 22,
        phoneNumberId: 'phone-id',
        metadata: { voiceReplyRequested: true },
      },
      agentResult: { replyText: 'Approved voice reply' },
      confidence: 1,
      policyViolations: [],
      metadata: {},
    } as any;

    const result = await new DeliveryStage().execute(ctx);

    expect(mockVoiceDeliver).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'whatsapp',
      inboundMessageId: 22,
      replyText: 'Approved voice reply',
    }));
    expect(result.metadata?.voiceReplyDelivered).toBe(true);
    expect(mockOutboxClaim).not.toHaveBeenCalled();
  });
});

it.each(['whatsapp','instagram','facebook','instagram_comment','facebook_comment'])('persists approved %s output without sending or synthesizing when disabled', async channel => {
  jest.clearAllMocks(); allowed.mockResolvedValue(false);
  const ctx = { message:{userId:4,conversationId:17,channel,senderIdentifier:'customer',rawMessageId:'turn:one',messageId:22,
      metadata:{voiceReplyRequested:true,commentId:'public-target',providerAccountId:'account'}},
    agentResult:{replyText:'Approved response'},confidence:1,policyViolations:[],metadata:{} } as any;
  const result=await new DeliveryStage().execute(ctx);
  expect(result.metadata?.deliveryStatus).toBe('drafted');
  expect(draft).toHaveBeenCalledWith(expect.objectContaining({inboundProviderMessageId:'turn:one'}),expect.objectContaining({
    text:'Approved response',recipient:channel.endsWith('_comment')?'public-target':'customer',metadata:expect.objectContaining({sourceMessageIds:[22]})}));
  expect(mockVoiceDeliver).not.toHaveBeenCalled();expect(mockOutboxClaim).not.toHaveBeenCalled();
});
