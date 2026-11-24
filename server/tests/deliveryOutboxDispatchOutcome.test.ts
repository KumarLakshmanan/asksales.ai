import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SupportDeliveryOutboxRecord } from '../models/supportOrchestration/schema.js';

const sendInstagramDM = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const sendFacebookDM = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/instagramService.js', () => ({ sendInstagramDM }));
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({ sendFacebookDM }));
const { deliveryOutboxService } = await import('../services/agents/orchestration/DeliveryOutboxService.js');

function claimed(channel: string): SupportDeliveryOutboxRecord {
  return {
    id: 31, businessProfileId: 2, userId: 42, conversationId: 11, channel, decisionKey: 'synthetic-escalation',
    inboundProviderMessageId: 'synthetic-inbound', playbookRunId: null, responseVersion: 1, status: 'sending',
    payload: { text: 'A team member will reply here.', recipient: 'synthetic-recipient',
      metadata: { dispatchKind: 'pipeline_message', isEscalationNotification: true, providerAccountId: 'acct' } },
    attemptCount: 1, maxAttempts: 5, providerMessageId: null, lastError: null, availableAt: new Date(),
    nextAttemptAt: null, leaseExpiresAt: new Date(), sendingAt: new Date(), sentAt: null,
    reconciledBy: null, reconciledAt: null, reconciliationNote: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('claimed pipeline message dispatch outcome', () => {
  let markFailed: jest.SpiedFunction<typeof deliveryOutboxService.markFailed>;
  let complete: jest.SpiedFunction<typeof deliveryOutboxService.completeClaimedAction>;
  beforeEach(() => {
    jest.clearAllMocks();
    markFailed = jest.spyOn(deliveryOutboxService, 'markFailed').mockResolvedValue(undefined);
    complete = jest.spyOn(deliveryOutboxService, 'completeClaimedAction').mockResolvedValue(undefined as never);
  });

  it.each([['instagram', sendInstagramDM], ['facebook', sendFacebookDM]] as const)(
    'records an ambiguous %s rejection as uncertain so it is never retried', async (channel, send) => {
      send.mockResolvedValue({ success: false, error: 'timeout', deliveryAttempted: true, outcomeUnknown: true });
      await expect(deliveryOutboxService.sendClaimedPipelineMessage(claimed(channel))).resolves.toEqual({ sent: false, providerMessageId: null });
      expect(markFailed).toHaveBeenCalledWith(31, 'timeout', true, true);
      expect(complete).not.toHaveBeenCalled();
    });

  it('keeps a definite rejection retryable', async () => {
    sendInstagramDM.mockResolvedValue({ success: false, error: 'rate limited', deliveryAttempted: false, outcomeUnknown: false });
    await deliveryOutboxService.sendClaimedPipelineMessage(claimed('instagram'));
    expect(markFailed).toHaveBeenCalledWith(31, 'rate limited', false, true);
  });

  it('completes the action with the provider id on success', async () => {
    sendFacebookDM.mockResolvedValue({ success: true, externalMessageId: 'mid.1' });
    await expect(deliveryOutboxService.sendClaimedPipelineMessage(claimed('facebook'))).resolves.toEqual({ sent: true, providerMessageId: 'mid.1' });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: 31 }), 'mid.1');
  });
});
