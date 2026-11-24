import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { KnowledgeQuery, KnowledgeRetrievalResult } from '../services/knowledge/types.js';
import { retrievalScopesForPurpose } from '../services/knowledge/KnowledgeRetrievalPolicy.js';
import { contextualKnowledgeQuestion } from '../services/knowledge/KnowledgeFollowup.js';

const grounded: KnowledgeRetrievalResult = { status: 'sufficient', indexVersion: 'test',
  diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 1 },
  evidence: [{ evidenceId: 'member-visible', documentId: 3, versionId: 1, chunkId: '2',
    title: 'Published member guide', excerpt: 'Approved internal support instructions.',
    authority: 'owner', scores: { fused: 1 } }],
};
const retrieve = jest.fn(async (_query: KnowledgeQuery) => grounded);
const formatEvidence = jest.fn(() => 'Approved internal support instructions.');
const getBusinessProfile = jest.fn(async (_userId: number) => ({ id: 77 }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({
  knowledgeGateway: { retrieve, formatEvidence },
}));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({
  getBusinessProfileContextByUserId: getBusinessProfile,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
const { KnowledgeRetrievalStage } = await import('../services/agents/pipeline/stages/KnowledgeRetrievalStage.js');

function context(executionMode: 'customer' | 'preview' | 'advisory' = 'advisory', conversationKind = 'support_member'): PipelineContext {
  return { message: { userId: 9, conversationId: -1, channel: 'web', senderIdentifier: 'member-qa',
    inboundText: 'What is the approved process?', metadata: { executionMode, conversationKind } },
    confidence: 0, policyViolations: [],
    metadata: { businessProfileId: 99,
      agentConfig: { agentType: 'general_service', toolsEnabled: ['answer_from_knowledge_base'] } },
  };
}

beforeEach(() => { jest.clearAllMocks(); });
describe('authenticated member advisory retrieval scope', () => {
  it.each(['general_service', 'hotel_sales'])('uses library visibility for the %s agent without borrowing owner profile access', async (agentType) => {
    const ctx = context();
    ctx.metadata!.agentConfig.agentType = agentType;
    const result = await new KnowledgeRetrievalStage().execute(ctx);
    expect(getBusinessProfile).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 9,
      businessProfileId: null, audience: 'internal', channel: 'support_portal', purpose: 'internal_assist' }));
    expect(retrievalScopesForPurpose(retrieve.mock.calls[0][0].purpose).sort()).toEqual(['internal_assist', 'support_answer']);
    expect(result.metadata?.businessProfileId).toBeNull();
    expect(result.contextLanes?.knowledge).toBe(grounded);
    expect(result.kbContext).toEqual(['Approved internal support instructions.']);
  });

  it.each([
    ['customer', 'support_member', 'customer'],
    ['preview', 'support_member', 'customer'],
    ['advisory', 'owner', 'internal'],
  ] as const)('preserves %s / %s retrieval semantics', async (mode, kind, audience) => {
    const ctx = context(mode, kind);
    ctx.metadata!.agentConfig.agentType = 'hotel_sales';
    const result = await new KnowledgeRetrievalStage().execute(ctx);
    expect(getBusinessProfile).toHaveBeenCalledWith(9);
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 9,
      businessProfileId: 77, audience, channel: 'web', purpose: 'hotel_policy' }));
    expect(result.metadata?.businessProfileId).toBe(77);
  });

  it('uses the resolved playbook knowledge query instead of a numbered menu reply', async () => {
    const ctx = context('customer', 'owner');
    ctx.message.inboundText = '1';
    ctx.nlu = { intent: 'clarify', riskLevel: 'low', entities: {} } as any;
    ctx.message.metadata!.conversationHistory = [{ role: 'user', content: 'Resort details' }];
    ctx.metadata!.playbookDirective = {
      capability: {
        name: 'knowledge.answer',
        args: { query: 'published resort overview, facilities, policies, and approved resort brochure' },
      },
    };

    await new KnowledgeRetrievalStage().execute(ctx);

    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      redactedText: 'published resort overview, facilities, policies, and approved resort brochure',
      redactedHistory: [],
      intent: 'faq',
    }));
  });

  it('preserves latest-turn-only retrieval for a ticket-aware answer', async () => {
    const ctx = context();
    ctx.metadata!.ticketReadOnlyAnswer = true;
    ctx.message.metadata!.conversationHistory = [{ role: 'user', content: 'An unrelated earlier question.' }];
    await new KnowledgeRetrievalStage().execute(ctx);
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ redactedHistory: [], channel: 'support_portal' }));
  });

  it('retains the bounded eight-turn context needed to resolve a follow-up across a topic change', async () => {
    const ctx = context('customer', 'owner');
    ctx.message.inboundText = 'Draft a short customer email using the check-in and check-out times from earlier, with a bold heading and two numbered items.';
    const timingQuestion = 'What are ORO check-in and check-out times?';
    const pricingQuestion = 'List ORO day-out package prices and GST terms.';
    ctx.message.metadata!.conversationHistory = [
      { role: 'user', content: timingQuestion },
      { role: 'assistant', content: 'Check-in 2 PM; check-out 11 AM.' },
      { role: 'user', content: 'Turn those timings into a numbered list.' },
      { role: 'assistant', content: 'Check-in 2 PM; check-out 11 AM.' },
      { role: 'user', content: pricingQuestion },
      { role: 'assistant', content: 'Three day-out prices plus GST.' },
    ];

    await new KnowledgeRetrievalStage().execute(ctx);

    const knowledgeQuery = retrieve.mock.calls[0][0];
    expect(knowledgeQuery.redactedHistory).toHaveLength(6);
    expect(contextualKnowledgeQuestion(knowledgeQuery)).toContain(timingQuestion);
    expect(contextualKnowledgeQuestion(knowledgeQuery)).not.toContain(pricingQuestion);
  });
});
