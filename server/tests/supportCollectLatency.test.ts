import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

const retrieve = jest.fn<(...args: any[]) => Promise<any>>();
const analyze = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {
  retrieve, formatEvidence: () => 'Approved evidence',
} }));
jest.unstable_mockModule('../services/agents/NLUService.js', () => ({ nluService: { analyze } }));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({ getBusinessProfileContextByUserId: async () => ({ id: 7 }) }));
jest.unstable_mockModule('../services/agents/orchestration/SupportCRMPipeline.js', () => ({ supportCrmPipelineContext: async () => undefined }));
const { KnowledgeRetrievalStage } = await import('../services/agents/pipeline/stages/KnowledgeRetrievalStage.js');
const { IntentRiskClassifierStage } = await import('../services/agents/pipeline/stages/IntentRiskClassifierStage.js');
const { CanAIHandleGate } = await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const context = (text = 'Leisure stay'): PipelineContext => ({
  message: { userId: 9, conversationId: 1326, channel: 'whatsapp', senderIdentifier: 'test', inboundText: text, metadata: { executionMode: 'customer' } },
  confidence: 0, policyViolations: [], metadata: { agentConfig: { agentType: 'hotel_sales', toolsEnabled: ['answer_from_knowledge_base'] },
    activePlaybookSelection: { runId: 424, fieldKey: 'journey.type', value: 'leisure', label: 'Leisure stay' },
    playbookDirective: { nodeType: 'collect', instruction: 'What date would you like to check in?', journey: { missingFields: ['stay.checkIn'], fields: {} } } },
});
beforeEach(() => {
  jest.clearAllMocks();
  retrieve.mockResolvedValue({ status: 'sufficient', evidence: [] });
  analyze.mockResolvedValue({ intent: 'faq', secondaryIntents: [], entities: {}, needsHuman: false, sentiment: { label: 'neutral', score: 0 },
    urgency: 'low', riskLevel: 'low', riskFactors: [], classificationConfidence: 1 });
});

describe('published collection avoids unused model work', () => {
  it.each([['Leisure stay', 'journey.type', 'leisure'], ['No preference', 'stay.roomPreference', 'no_preference']])('answers the verified %s choice without classification or knowledge retrieval', async (text, fieldKey, value) => {
    const ctx = context(text);
    ctx.metadata!.activePlaybookSelection = { runId: 424, fieldKey, value, label: text };
    await new IntentRiskClassifierStage().execute(ctx);
    await new CanAIHandleGate().execute(ctx);
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(analyze).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(ctx.nlu).toMatchObject({ intent: 'clarify', needsHuman: false, semanticRequest: { action: 'other', explicit: false } });
    expect(ctx.metadata?.knowledgeRetrievalSkipped).toBe('published_field_collection');
    expect(ctx.metadata?.verifiedHandoffConsent).toBeUndefined();
    expect(ctx.metadata?.skipAgentGeneration).toBeUndefined();
  });
  it.each(['No preference and refund me', 'What is the address?'])('does not reuse a choice marker for different input: %s', async text => {
    const ctx = context(text);
    await new IntentRiskClassifierStage().execute(ctx);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'human', 'public', 'other_field', 'history_unavailable'])('retains classification for %s choice context', async mode => {
    const ctx = context();
    if (mode === 'missing') delete ctx.metadata!.activePlaybookSelection;
    if (mode === 'human') ctx.metadata!.suspendPlaybookForHandoff = true;
    if (mode === 'public') ctx.message.metadata!.publicReply = true;
    if (mode === 'other_field') ctx.metadata!.activePlaybookSelection.fieldKey = 'booking.cancel';
    if (mode === 'history_unavailable') ctx.metadata!.historyStatus = 'unavailable';
    await new IntentRiskClassifierStage().execute(ctx);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it.each(['faq', 'pricing_question', 'mixed_pricing', 'knowledge_capability', 'read_only', 'incomplete_collect'])('retains grounding for %s', async mode => {
    const ctx = context('Is breakfast included?');
    ctx.nlu = { intent: 'clarify', secondaryIntents: [], entities: {}, needsHuman: false, sentiment: { label: 'neutral', score: 0 },
      summary: 'The customer answered a collection question.', urgency: 'low', riskLevel: 'low', riskFactors: [], classificationConfidence: 1 };
    if (mode === 'faq' || mode === 'pricing_question') ctx.nlu.intent = mode;
    if (mode === 'mixed_pricing') ctx.nlu.semanticRequest = { action: 'information', service: 'stay', explicit: true, topicSwitch: false, pricingRequested: true, media: 'none', confidence: 1 };
    if (mode === 'knowledge_capability') ctx.metadata!.playbookDirective.capability = { name: 'knowledge.answer', args: { query: 'Breakfast' } };
    if (mode === 'read_only') ctx.metadata!.playbookDirective.readOnlyInformation = true;
    if (mode === 'incomplete_collect') delete ctx.metadata!.playbookDirective.instruction;
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(ctx.metadata?.knowledgeRetrievalSkipped).toBeUndefined();
  });
});
