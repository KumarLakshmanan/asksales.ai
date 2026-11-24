import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AgentDispatchStage } from '../services/agents/pipeline/stages/AgentDispatchStage.js';
import { agentRouter } from '../services/agents/AgentRouter.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import { LLMProviderFactory } from '../services/agents/LLMProviderFactory.js';
import { knowledgeGateway } from '../services/knowledge/KnowledgeGateway.js';

const approvedFact = 'The standard room accommodates 2 adults with an optional extra bed.';
const inventedPolicy = 'Harbour check-in is at 3 PM and checkout is at 11 AM. Policy HTL-POL-2024 uses manual version 2.1.';
const safeFallback = 'I do not have enough approved information to verify that. Please check an authorized source before advising the customer.';

function context(): PipelineContext {
  return {
    message: { userId: 9, conversationId: -1, channel: 'web', senderIdentifier: 'member-qa',
      inboundText: 'What are the check-in and checkout policies?', metadata: { executionMode: 'advisory' } },
    confidence: 0, policyViolations: [],
    nlu: { intent: 'faq', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 },
      urgency: 'low', needsHuman: false, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 1 },
    metadata: { agentConfig: { agentType: 'general_service' } },
    contextLanes: { knowledge: { status: 'insufficient', indexVersion: 'test', evidence: [],
      diagnostics: { queryFingerprint: 'test', candidateCount: 0, reranked: false, latencyMs: 1 },
    } },
  };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('member advisory dispatch grounding boundary', () => {
  it.each(['clarify', 'pricing_question', 'support_request'] as const)('recovers an owner published-information request classified as %s', async intent => {
    const ctx = context();
    ctx.message.metadata!.conversationKind = 'owner_support';
    ctx.nlu!.intent = intent;
    const excerpt = 'Published package: Rs. 4,299 + GST.\nBreakfast, lunch and hi-tea.';
    ctx.contextLanes!.knowledge = { ...ctx.contextLanes!.knowledge!, status: 'sufficient', evidence: [{
      evidenceId: 'approved-catalog', documentId: 7, versionId: 2, chunkId: '4',
      title: 'Approved catalog', excerpt, authority: 'owner', scores: { fused: 1 },
    }] };
    ctx.metadata!.knowledgeQuery = { tenantId: 9, redactedText: 'What are the published package options?',
      purpose: 'support_answer', channel: 'web', audience: 'internal', risk: 'low' };
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ replyText: 'Published package costs Rs. 4,299 per person.', escalated: false });
    jest.spyOn(LLMProviderFactory, 'createChatCompletionWithFallback').mockResolvedValue({
      success: true, content: '{"paragraphIds":["approved-catalog:published:0"]}',
    });
    jest.spyOn(knowledgeGateway, 'revalidateEvidence').mockResolvedValue(ctx.contextLanes!.knowledge!.evidence);
    const result = (await new AgentDispatchStage().execute(ctx)).agentResult!;
    expect(result.replyText).toContain(excerpt);
    expect(result.answerVerification).toMatchObject({ mayDeliver: true, reason: 'verbatim_published_evidence' });
  });
  it('recovers a multiline published FAQ as an exact quote, without accepting the failed paraphrase', async () => {
    const ctx = context();
    const excerpt = 'Check-In / Check-Out Timings\nCheck-In: 2:00 PM\nCheck-Out: 11:00 AM';
    ctx.contextLanes!.knowledge = { ...ctx.contextLanes!.knowledge!, status: 'sufficient', evidence: [{
      evidenceId: 'approved-times', documentId: 7, versionId: 2, chunkId: '4',
      title: 'Approved guide', excerpt, authority: 'owner', scores: { fused: 1 },
    }] };
    ctx.metadata!.knowledgeQuery = { tenantId: 9, redactedText: ctx.message.inboundText,
      purpose: 'support_answer', channel: 'web', audience: 'internal', risk: 'low' };
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({
      // Wrong times fail verification (a correct paraphrase now verifies on its own),
      // so the reply must be repaired from the exact published block.
      replyText: 'Check-in is at 3:00 PM and check-out is at 12:00 PM.', escalated: false,
    });
    jest.spyOn(LLMProviderFactory, 'createChatCompletionWithFallback').mockResolvedValue({
      success: true, content: '{"paragraphIds":["approved-times:published:0","approved-times:published:1","approved-times:published:2"]}',
    });
    jest.spyOn(knowledgeGateway, 'revalidateEvidence').mockResolvedValue(ctx.contextLanes!.knowledge!.evidence);
    const result = (await new AgentDispatchStage().execute(ctx)).agentResult!;
    expect(result.replyText).toBe(`From the published knowledge base:\n\n${excerpt.split('\n').join('\n\n')}`);
    expect(result.answerVerification).toMatchObject({ mayDeliver: true, reason: 'verbatim_published_evidence' });
    expect(ctx.metadata!.knowledgeAnswerRepair.strategy).toBe('verbatim_published_evidence');
  });
  it.each(['faq', 'unknown', undefined])('blocks fabricated policies with intent %s and no evidence', async (intent) => {
    const ctx = context();
    if (intent === undefined) delete ctx.nlu;
    else ctx.nlu!.intent = intent as NonNullable<PipelineContext['nlu']>['intent'];
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({
      replyText: inventedPolicy, escalated: true, escalationType: 'support', escalationReason: 'model suggestion',
      handoff: { required: true, type: 'support' }, confidence: 0.99,
      kbSourcesUsed: [{ sourceId: 99, title: 'Invented manual', excerpt: inventedPolicy, similarity: 1, citation: 'invented' }],
    });
    const result = (await new AgentDispatchStage().execute(ctx)).agentResult!;
    expect(result.replyText).toBe(safeFallback);
    expect(result.answerVerification).toMatchObject({ mayDeliver: false, answerGrounding: 'blocked',
      reason: 'unsupported_internal_factual_claim' });
    expect(result.answerVerification!.unsupportedClaims.length).toBeGreaterThan(0);
    expect(result.kbSourcesUsed).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.escalated).toBe(false);
    expect(result.handoff).toEqual({ required: false });
    expect(result.escalationReason).toBeUndefined();
    expect(result.escalationType).toBeUndefined();
  });

  it('delivers a fully supported fact from the authorized internal retrieval lane', async () => {
    const ctx = context();
    delete ctx.nlu;
    ctx.contextLanes!.knowledge = { ...ctx.contextLanes!.knowledge!, status: 'sufficient', evidence: [{
      evidenceId: 'internal-approved', documentId: 7, versionId: 2, chunkId: '4',
      title: 'Approved internal guide', excerpt: approvedFact, authority: 'owner', scores: { fused: 1 },
    }] };
    const dispatch = jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ replyText: approvedFact, escalated: false });
    const result = (await new AgentDispatchStage().execute(ctx)).agentResult!;
    expect(dispatch.mock.calls[0][1].executionMode).toBe('advisory');
    expect(result.replyText).toBe(approvedFact);
    expect(result.answerVerification).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded', unsupportedClaims: [] });
    expect(result.claimEvidence).toEqual([expect.objectContaining({ evidenceIds: ['internal-approved'], verdict: 'supported' })]);
    expect(result.kbSourcesUsed).toEqual([expect.objectContaining({ sourceId: 7, citation: 'internal-approved' })]);
  });

  it('keeps customer access-denied evidence out even when the model cites an internal source', async () => {
    const ctx = context();
    ctx.message.metadata!.executionMode = 'customer';
    ctx.contextLanes!.knowledge!.status = 'access_denied';
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ replyText: approvedFact, escalated: false,
      claimEvidence: [{ claimId: 'fake', claim: approvedFact, origin: 'knowledge', evidenceIds: ['internal-approved'], verdict: 'supported' }],
      kbSourcesUsed: [{ sourceId: 7, title: 'Internal-only guide', excerpt: approvedFact, similarity: 1, citation: 'internal-approved' }],
    });
    const out = await new AgentDispatchStage().execute(ctx);
    const result = out.agentResult!;
    // A rejected FAQ becomes a fixed handoff offer; its verification stays in audit metadata.
    expect((result.answerVerification ?? out.metadata?.rejectedKnowledgeVerification)?.mayDeliver).toBe(false);
    expect(result.replyText).not.toContain(approvedFact);
    expect(result.kbSourcesUsed ?? []).toEqual([]);
    expect(result.claimEvidence?.every((claim) => claim.evidenceIds.length === 0)).toBe(true);
  });

  it('preserves a standalone clarification without requiring evidence', async () => {
    const replyText = 'Could you please share more details?';
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ replyText, escalated: false });
    const result = (await new AgentDispatchStage().execute(context())).agentResult!;
    expect(result.replyText).toBe(replyText);
    expect(result.answerVerification).toBeUndefined();
    expect(result.escalated).toBe(false);
  });

  it('permits a safe general greeting without factual evidence', async () => {
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ replyText: 'Happy to help.', escalated: false });
    const result = (await new AgentDispatchStage().execute(context())).agentResult!;
    expect(result.replyText).toBe('Happy to help.');
    expect(result.answerVerification).toMatchObject({ mayDeliver: true, answerGrounding: 'not_required', unsupportedClaims: [] });
  });

  it('does not let a clarification prefix conceal an unsupported policy', async () => {
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ replyText: `Could you please share more details? ${inventedPolicy}`, escalated: false });
    const result = (await new AgentDispatchStage().execute(context())).agentResult!;
    expect(result.replyText).toBe(safeFallback);
    expect(result.answerVerification?.mayDeliver).toBe(false);
  });
});
