/**
 * WhatsApp worker contract tests.
 *
 * Privacy, NLU, policy, playbooks, confidence, and delivery are covered by the
 * canonical pipeline suites. This worker is intentionally a thin adapter: it
 * loads the destination, normalizes the provider event, and maps the gateway
 * result without introducing an alternate fallback/send path.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockDbExecute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: mockDbExecute } }));

jest.unstable_mockModule('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

const mockGatewayProcess = jest.fn<any>();
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({
  channelGateway: { process: mockGatewayProcess },
}));

const { processWhatsAppWebhook } = await import('../workers/outreach/whatsappProcessor.js');

function makeJob(data: Record<string, unknown>) {
  return { id: 'job_1', data } as any;
}

const inbound = {
  conversationId: 58,
  userId: 9,
  phoneNumberId: '1095711443622725',
  inboundText: 'I need help',
  messageId: 'wamid.inbound-1',
};

describe('WhatsApp processor canonical gateway adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbExecute.mockResolvedValue({ rows: [{ phone: '919987499179', lead_id: 17, lead_name: 'Mahesh', lead_company: 'OroCircle' }] });
    mockGatewayProcess.mockResolvedValue({ success: true, method: 'auto_sent', messageId: 'wamid.reply-1', sentiment: { sentiment: 'neutral', score: 0 } });
  });

  it('normalizes a provider event and maps auto_sent to the legacy ai_reply result', async () => {
    const result = await processWhatsAppWebhook(makeJob(inbound));

    expect(mockGatewayProcess).toHaveBeenCalledWith({
      userId: 9,
      conversationId: 58,
      channel: 'whatsapp',
      senderIdentifier: '919987499179',
      inboundText: 'I need help',
      rawMessageId: 'wamid.inbound-1',
      phoneNumberId: '1095711443622725',
      leadId: 17,
      leadName: 'Mahesh',
      leadCompany: 'OroCircle',
    });
    expect(result).toEqual({
      success: true,
      method: 'ai_reply',
      messageId: 'wamid.reply-1',
      sentiment: { sentiment: 'neutral', score: 0 },
    });
  });

  it.each(['pending_approval', 'human_handoff', 'blocked', 'no_op'])(
    'preserves the gateway %s outcome without creating a bypass reply',
    async (method) => {
      mockGatewayProcess.mockResolvedValue({ success: true, method, messageId: null });
      const result = await processWhatsAppWebhook(makeJob(inbound));
      expect(result.method).toBe(method);
      expect(result.messageId).toBeNull();
    },
  );

  it('fails before generation when the conversation cannot be resolved', async () => {
    mockDbExecute.mockResolvedValue({ rows: [] });
    await expect(processWhatsAppWebhook(makeJob(inbound))).rejects.toThrow('Conversation not found');
    expect(mockGatewayProcess).not.toHaveBeenCalled();
  });

  it('propagates a fail-closed gateway error so the queue can retry or alert', async () => {
    mockGatewayProcess.mockResolvedValue({ success: false, method: 'error', error: 'PII vault key unavailable' });
    await expect(processWhatsAppWebhook(makeJob(inbound))).rejects.toThrow('PII vault key unavailable');
  });

  it('acknowledges a routing-blocked turn without failing the job for retry', async () => {
    mockGatewayProcess.mockResolvedValue({ success: false, method: 'no_op',
      error: 'No unique live assistant is assigned to this receiving account.',
      context: { metadata: { assistantRoutingBlocked: true } } });

    await expect(processWhatsAppWebhook(makeJob(inbound))).resolves.toMatchObject({
      success: true, method: 'no_reply', note: 'assistant_routing_blocked', messageId: null,
    });
  });

  it('does not regenerate a decision when the durable outbox owns delivery retries', async () => {
    mockGatewayProcess.mockResolvedValue({
      success: false,
      method: 'error',
      error: 'Provider delivery failed',
      sentiment: { sentiment: 'neutral', score: 0 },
      context: {
        metadata: {
          deliveryActionId: 256,
          deliveryStatus: 'failed_retry_scheduled',
        },
      },
    });

    await expect(processWhatsAppWebhook(makeJob(inbound))).resolves.toEqual({
      success: true,
      method: 'delivery_pending',
      deliveryStatus: 'failed_retry_scheduled',
      messageId: null,
      sentiment: { sentiment: 'neutral', score: 0 },
    });
    expect(mockGatewayProcess).toHaveBeenCalledTimes(1);
  });

  it('passes a missing provider ID through as undefined instead of inventing an unstable identifier', async () => {
    await processWhatsAppWebhook(makeJob({ ...inbound, messageId: null }));
    expect(mockGatewayProcess).toHaveBeenCalledWith(expect.objectContaining({ rawMessageId: undefined }));
  });
});
