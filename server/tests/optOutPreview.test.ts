import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { NLUResult } from '../services/agents/NLUService.js';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: { id: number }[] }>>();
const transaction = jest.fn(async (work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
const sendText = jest.fn();
const claim = jest.fn();
const draft = jest.fn();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { sendText } }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: { claim, draft }, createDeliveryDecisionKey: jest.fn(),
}));
const { OptOutStage, SemanticOptOutStage, isNormalizedOptOutRequest } = await import('../services/agents/pipeline/stages/OptOutStage.js');
const { CanAIHandleGate } = await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const { DeliveryStage } = await import('../services/agents/pipeline/stages/DeliveryStage.js');
const { PipelineHalt } = await import('../services/agents/pipeline/PipelineStage.js');
const { prepareNonHandoffFallback } = await import('../services/agents/orchestration/RestrictedHandoffPolicy.js');

const synthetic = 'QA simulation: Please stop emailing me and remove me from your outreach.';
function context(channel: PipelineContext['message']['channel'] = 'email', inboundText = 'STOP', nlu: Partial<NLUResult> = {}): PipelineContext {
  return {
    message: { userId: 1, conversationId: -1709404692, channel, senderIdentifier: 'synthetic-preview', inboundText,
      metadata: { executionMode: 'preview', dryRun: true, conversationKind: 'owner_simulator' },
    },
    confidence: 0, policyViolations: [], metadata: {},
    nlu: { intent: 'clarify', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 },
      urgency: 'medium', needsHuman: true, summary: 'Synthetic classification', riskLevel: 'low',
      riskFactors: ['classification_unavailable'], classificationConfidence: 0, ...nlu,
    },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [{ id: 22 }] });
});

describe('nonpersistent opt-out preview acknowledgement', () => {
  it.each(['web', 'email', 'whatsapp', 'instagram', 'facebook'] as const)(
    'recognizes an exact STOP in %s without changing preferences or dispatching', async channel => {
      const ctx = await new OptOutStage().execute(context(channel));
      expect(ctx.agentResult?.replyText).toBe('Opt-out recognized in this test. No contact preferences were changed.');
      expect(ctx.metadata).toMatchObject({ skipAgentGeneration: true, suppressBusinessEffects: true, systemDirective: 'opt_out_confirmation' });
      await expect(new CanAIHandleGate().execute(ctx)).resolves.toBe(ctx);
      await new DeliveryStage().execute(ctx);
      expect(ctx.metadata?.deliveryStatus).toBe('simulated');
      expect(transaction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(draft).not.toHaveBeenCalled();
    },
  );

  it.each(['web', 'email', 'whatsapp', 'instagram', 'facebook'] as const)(
    'acknowledges a verified semantic withdrawal in %s without durable effects', async channel => {
      const ctx = context(channel, synthetic, { contactPreference: 'opt_out', contactPreferenceVerified: true, classificationConfidence: 0.99 });
      await new OptOutStage().execute(ctx);
      expect(ctx.agentResult).toBeUndefined();
      await new SemanticOptOutStage().execute(ctx);
      await expect(new CanAIHandleGate().execute(ctx)).resolves.toBe(ctx);
      await new DeliveryStage().execute(ctx);
      expect(ctx.agentResult?.replyText).toContain('Opt-out recognized in this test.');
      expect(ctx.agentResult?.replyText).not.toContain('You have been unsubscribed');
      expect(transaction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(draft).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it.each([
    { contactPreference: 'opt_out' as const, contactPreferenceVerified: false, classificationConfidence: 0.99 },
    { contactPreference: 'opt_out' as const, contactPreferenceVerified: true, classificationConfidence: 0.9 },
    { contactPreference: 'uncertain' as const, contactPreferenceVerified: false, classificationConfidence: 0.99 },
    { contactPreference: 'unchanged' as const, contactPreferenceVerified: false, classificationConfidence: 0.99 },
  ])('does not claim recognition solely because the stages completed (%j)', async nlu => {
    const ctx = context('email', synthetic, nlu);
    await new OptOutStage().execute(ctx);
    await new SemanticOptOutStage().execute(ctx);
    expect(ctx.agentResult).toBeUndefined();
    expect(ctx.metadata?.systemDirective).toBeUndefined();
    await expect(new CanAIHandleGate().execute(ctx)).rejects.toBeInstanceOf(PipelineHalt);
    prepareNonHandoffFallback(ctx, 'Intent and risk classification is unavailable.');
    expect(ctx.agentResult?.replyText).toContain('trouble completing that request');
    expect(transaction).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('preserves the customer-mode acknowledgement after its mocked ownership transaction', async () => {
    const ctx = context();
    ctx.message.conversationId = 22;
    ctx.message.metadata = { executionMode: 'customer' };
    await new OptOutStage().execute(ctx);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(ctx.agentResult?.replyText).toContain('You have been unsubscribed from automated messages.');
  });

  it('keeps QA-prefixed and quoted examples outside the exact protocol-command recognizer', () => {
    expect(isNormalizedOptOutRequest(synthetic)).toBe(false);
    expect(isNormalizedOptOutRequest('What happens when someone says STOP?')).toBe(false);
    expect(isNormalizedOptOutRequest('Please stop the error messages in the app')).toBe(false);
    expect(isNormalizedOptOutRequest('STOP')).toBe(true);
  });
});
