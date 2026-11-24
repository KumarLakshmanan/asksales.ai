import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { AgentResult } from '../services/agents/BaseOutreachAgent.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
import type { CrmStageDecision } from '../../shared/crmPipeline.js';

const stageDecision: CrmStageDecision = { stageKey: 'contract_signed', outcome: 'won', evidence: 'explicit_acceptance', confidence: 0.99 };
const dialect = new PgDialect();
const execute = jest.fn<(query: SQL) => Promise<{ rows: Record<string, unknown>[] }>>();
const apply = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const gateway = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const publishedAssistant = jest.fn(async (_provenance: unknown, work: () => Promise<void>) => work());
const receipts = new Set<string>();
const ledger = jest.fn(async (identity: { effectType: string }, action: () => Promise<void>) => {
  if (receipts.has(identity.effectType)) return 'skipped';
  await action(); receipts.add(identity.effectType); return 'executed';
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
// This suite isolates CRM effects; assignment freshness has its own boundary tests.
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  withPublishedAssistant: publishedAssistant, assertAssistantFresh: async () => {}, assistantProvenanceCurrent: async () => true,
  assistantDeliveryCurrent: async () => true, withPrivateAssistantForPublicDelivery: publishedAssistant,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({ channelGateway: { process: gateway } }));
jest.unstable_mockModule('../services/agents/pipeline/stages/HandoffPolicyStage.js', () => ({ HandoffPolicyStage: class {
  async execute(ctx: PipelineContext) { ctx.metadata = { ...ctx.metadata, ownerHandoffPolicy: null }; return ctx; }
} }));
jest.unstable_mockModule('../services/agents/orchestration/SupportEffectLedgerService.js', () => ({
  supportEffectLedgerService: { runOnce: ledger, getStatus: async () => 'success' },
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportCRMPipeline.js', () => ({
  applySupportCrmStage: apply,
  supportCrmPipelineContext: async () => ({ currentStageKey: 'contract_signed',
    stages: [{ key: 'contract_signed', label: 'Contract signed', type: 'won' }] }),
}));
const { PostProcessingStage } = await import('../services/agents/pipeline/stages/PostProcessingStage.js');
const { agentRouter } = await import('../services/agents/AgentRouter.js');

const context = (leadId?: number): PipelineContext => ({
  message: { userId: 9, conversationId: 21, channel: 'email', senderIdentifier: 'customer',
    inboundText: 'I accept the deal.', leadId, rawMessageId: 'inbound:1', metadata: { executionMode: 'customer' } },
  nlu: { intent: 'purchase_intent', secondaryIntents: [], entities: {},
    sentiment: { label: 'positive', score: 0.8 }, urgency: 'low', needsHuman: false,
    riskLevel: 'low', riskFactors: [], summary: 'Customer accepts the quote.', classificationConfidence: 0.99,
    semanticRequest: semanticIntent('other'), crmStageDecision: stageDecision },
  agentResult: { replyText: 'Your acceptance is recorded.', escalated: false, crmPipelineStatus: 'won', confidence: 0.99 },
  confidence: 0.99, policyViolations: [], metadata: { deliveryStatus: 'sent', ownerHandoffPolicy: null },
});

beforeEach(() => {
  jest.resetAllMocks(); receipts.clear();
  publishedAssistant.mockImplementation(async (_provenance, work) => work());
  execute.mockImplementation(async query => ({ rows: dialect.sqlToQuery(query).sql.includes('SELECT c.id') ? [{ id: 12 }] : [] }));
  apply.mockResolvedValue({ contact: { id: 12, pipelineStatus: 'contract_signed' },
    stage: { key: 'contract_signed', label: 'Contract signed', type: 'won' }, changed: true });
  ledger.mockImplementation(async (identity, action) => {
    if (receipts.has(identity.effectType)) return 'skipped';
    await action(); receipts.add(identity.effectType); return 'executed';
  });
});

describe('support CRM delivery and retry boundaries', () => {
  it('updates an explicitly associated CRM contact without requiring a lead', async () => {
    const ctx = context();
    await new PostProcessingStage().execute(ctx);
    expect(apply).toHaveBeenCalledWith(9, 12, expect.objectContaining({ decision: stageDecision, legacyStage: 'won', tools: undefined }));
    expect(ctx.agentResult?.crmPipelineStatus).toBe('contract_signed');
    expect(ctx.metadata?.crmStage).toMatchObject({ name: 'Contract signed', type: 'won' });
    expect(execute.mock.calls.map(([query]) => dialect.sqlToQuery(query).sql).some(query => query.includes('UPDATE leads'))).toBe(false);
  });

  it('does not repeat a CRM transition or score write when a delivered event is replayed', async () => {
    const ctx = context(7);
    await new PostProcessingStage().execute(ctx);
    await new PostProcessingStage().execute(context(7));
    expect(apply).toHaveBeenCalledTimes(1);
    const scoring = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query)).filter(query => query.sql.includes('UPDATE leads'));
    expect(scoring).toHaveLength(1);
    expect(scoring[0].sql).toContain("status IN ('converted', 'won', 'lost', 'rejected')");
    expect(scoring[0].params[0]).toBeNull();
    expect(scoring[0].sql).toContain('AND user_id =');
  });

  it.each(['preview', 'advisory'] as const)('never updates CRM in %s mode', async executionMode => {
    const ctx = context(7); ctx.message.metadata = { executionMode };
    await new PostProcessingStage().execute(ctx);
    expect(apply).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it.each(['uncertain', 'failed_retry_scheduled', 'failed', 'pending_approval', 'blocked'])('does not commit CRM for delivery status %s', async deliveryStatus => {
    const ctx = context(7); ctx.metadata = { ...ctx.metadata, deliveryStatus };
    await new PostProcessingStage().execute(ctx);
    expect(apply).not.toHaveBeenCalled(); expect(ledger).not.toHaveBeenCalled();
  });

  it('waits for actual deferred delivery and carries the server NLU decision into that commit', async () => {
    const ctx = context(); ctx.metadata = { ...ctx.metadata, deliveryDeferred: true, deliveryStatus: 'ready_for_channel_delivery' };
    await new PostProcessingStage().execute(ctx);
    expect(apply).not.toHaveBeenCalled();
    gateway.mockResolvedValueOnce({ method: 'ready_for_channel_delivery', success: true, context: ctx });
    const drafted = await agentRouter.handle({ userId: 9, conversationId: 21, channel: 'email', inboundText: 'I accept.', rawMessageId: 'inbound:1' });
    expect(drafted?.crmStageDecision).toEqual(stageDecision);
    const recovered = JSON.parse(JSON.stringify(drafted)) as AgentResult;
    await agentRouter.commitDeferredDelivery(recovered);
    expect(publishedAssistant).toHaveBeenCalledWith(recovered.deferredEffectContext?.assistantProvenance, expect.any(Function));
    expect(apply).toHaveBeenCalledWith(9, 12, expect.objectContaining({ decision: stageDecision, legacyStage: 'won', tools: undefined }));
    expect(recovered.deliveryOutcome).toBe('auto_sent');
    expect(recovered.crmPipelineStatus).toBe('contract_signed');
  });

  it('stops scoring and requires reconciliation when the CRM update fails', async () => {
    apply.mockRejectedValueOnce(new Error('Stage changed before commit.'));
    const ctx = context(7);
    await new PostProcessingStage().execute(ctx);
    expect(ctx.metadata?.effectReconciliationRequired).toBe(true);
    expect(execute.mock.calls.map(([query]) => dialect.sqlToQuery(query).sql).some(query => query.includes('UPDATE leads'))).toBe(false);
  });
});
