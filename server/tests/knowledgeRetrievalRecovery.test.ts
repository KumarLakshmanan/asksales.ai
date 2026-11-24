import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { KnowledgeQuery, KnowledgeRetrievalResult } from '../services/knowledge/types.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

const retrieve = jest.fn<(_query: KnowledgeQuery) => Promise<KnowledgeRetrievalResult>>();
const rewrite = jest.fn<(_userId: number, _params: unknown) => Promise<{ success: boolean; content?: string }>>();
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {
  retrieve, formatEvidence: () => 'Authorized facts',
} }));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({ getBusinessProfileContextByUserId: async () => ({ id: 7 }) }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: rewrite } }));
const { KnowledgeRetrievalStage } = await import('../services/agents/pipeline/stages/KnowledgeRetrievalStage.js');
const result = (status: KnowledgeRetrievalResult['status']): KnowledgeRetrievalResult => ({ status, evidence: [], indexVersion: 'test',
  diagnostics: { queryFingerprint: 'test', candidateCount: 0, reranked: false, latencyMs: 1 } });
const context = () => ({ message: { userId: 9, conversationId: 615, channel: 'whatsapp', inboundText: 'செக்-இன் நேரம் என்ன? தமிழில் சொல்லுங்கள்.', metadata: {} },
  metadata: { agentConfig: { agentType: 'hotel_sales', toolsEnabled: ['answer_from_knowledge_base'] } },
  nlu: { intent: 'faq', riskLevel: 'low', semanticRequest: { action: 'information' }, entities: { locale: 'ta' } }, confidence: 1, policyViolations: [] }) as unknown as PipelineContext;
beforeEach(() => { retrieve.mockReset().mockResolvedValue(result('insufficient')); rewrite.mockReset().mockResolvedValue({ success: true, content: '{"searchText":"What is the check-in time?"}' }); });

describe('bounded knowledge search recovery', () => {
  it('avoids knowledge latency for a verified public search count-only refinement', async () => {
    const ctx=context(); ctx.message.inboundText='Actually, make that 3 adults instead.';
    ctx.metadata!.playbookDirective={publicBookingSearchFollowUp:true,completedJourneyFollowUp:true,readOnlyInformation:true};
    const output=await new KnowledgeRetrievalStage().execute(ctx);
    expect(retrieve).not.toHaveBeenCalled(); expect(rewrite).not.toHaveBeenCalled();
    expect(output.metadata?.knowledgeRetrievalSkipped).toBe('public_search_count_refinement');
    expect(output.agentResult).toBeUndefined();
  });
  it.each(['What is the room capacity?', '3 adults and refund me', '0 adults'])('retains knowledge checks for %s', async text=>{
    const ctx=context(); ctx.message.inboundText=text;
    ctx.metadata!.playbookDirective={publicBookingSearchFollowUp:true,completedJourneyFollowUp:true,readOnlyInformation:true};
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(retrieve).toHaveBeenCalled();
  });
  it('does not skip knowledge for an ordinary unverified guest-count message', async()=>{
    const ctx=context(); ctx.message.inboundText='3 adults';
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(retrieve).toHaveBeenCalled();
  });
  it('recovers a missing translated NLU hint while retaining the original language and source permissions', async () => {
    retrieve.mockResolvedValueOnce(result('insufficient')).mockResolvedValueOnce(result('sufficient'));
    const output = await new KnowledgeRetrievalStage().execute(context());
    expect(retrieve).toHaveBeenCalledTimes(2);
    const query = retrieve.mock.calls[1]?.[0];
    expect(query).toMatchObject({ tenantId: 9, businessProfileId: 7, audience: 'customer', channel: 'whatsapp', risk: 'low', retrievalText: 'What is the check-in time?' });
    expect(query?.redactedText).toContain('தமிழில்');
    expect(query?.entities?.locale).toBeUndefined();
    expect(output.contextLanes?.knowledge?.status).toBe('sufficient');
    expect(output.metadata?.knowledgeQueryRewritten).toBe(true);
  });
  it.each(['sufficient', 'access_denied', 'conflict_detected', 'stale_only', 'unavailable'] as const)('does not rewrite %s retrieval', async status => {
    retrieve.mockResolvedValue(result(status));
    await new KnowledgeRetrievalStage().execute(context());
    expect(rewrite).not.toHaveBeenCalled(); expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it('never retries indefinitely when a rewrite still has no evidence', async () => {
    const output = await new KnowledgeRetrievalStage().execute(context());
    expect(retrieve).toHaveBeenCalledTimes(2); expect(rewrite).toHaveBeenCalledTimes(1);
    expect(output.contextLanes?.knowledge?.status).toBe('insufficient');
  });
  it.each(['not json', '{}', '{"searchText":3}', '{"searchText":""}'])('keeps insufficient evidence on malformed rewrite %s', async content => {
    rewrite.mockResolvedValue({ success: true, content });
    const output = await new KnowledgeRetrievalStage().execute(context());
    expect(retrieve).toHaveBeenCalledTimes(1); expect(output.contextLanes?.knowledge?.status).toBe('insufficient');
  });
  it('retains the original result during a provider failure', async () => {
    rewrite.mockRejectedValue(new Error('offline'));
    expect((await new KnowledgeRetrievalStage().execute(context())).contextLanes?.knowledge?.status).toBe('insufficient');
  });
  it('does not translate again when NLU already supplied an English search text', async () => {
    const ctx = context(); ctx.nlu = { ...ctx.nlu!, entities: { knowledgeSearchText: 'What is the check-in time?' } };
    const output = await new KnowledgeRetrievalStage().execute(ctx);
    expect(rewrite).not.toHaveBeenCalled(); expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0]?.[0].retrievalText).toBe('What is the check-in time?');
    expect(output.contextLanes?.knowledge?.status).toBe('insufficient');
  });
  it('does not reinterpret server-configured playbook knowledge queries', async () => {
    const ctx = context(); ctx.metadata = { ...ctx.metadata, playbookDirective: { capability: { name: 'knowledge.answer', args: { query: 'Approved policy question' } } } };
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(rewrite).not.toHaveBeenCalled(); expect(retrieve.mock.calls[0]?.[0].redactedText).toBe('Approved policy question');
  });
  it('does not turn a transactional request into a low-risk knowledge rewrite', async () => {
    const ctx = context(); ctx.nlu = { ...ctx.nlu!, intent: 'refund_request', semanticRequest: { action: 'refund', service: 'stay', explicit: true, topicSwitch: false, pricingRequested: false, media: 'none', confidence: 1 } };
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(rewrite).not.toHaveBeenCalled(); expect(retrieve.mock.calls[0]?.[0].risk).toBe('transactional');
  });
});
