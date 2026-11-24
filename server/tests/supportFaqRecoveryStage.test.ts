import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AgentDispatchStage } from '../services/agents/pipeline/stages/AgentDispatchStage.js';
import { agentRouter } from '../services/agents/AgentRouter.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { AgentResult } from '../services/agents/BaseOutreachAgent.js';

const supported = 'The standard room accommodates 2 adults with an optional extra bed.';
const question = 'Which service would you like?';
function context(channel: PipelineContext['message']['channel'] = 'web'): PipelineContext {
  return {
    message: { userId: 9, conversationId: -1, channel, senderIdentifier: 'qa',
      inboundText: 'Can nine adults stay in the standard room?', metadata: { executionMode: 'customer' } },
    confidence: 0, policyViolations: [],
    nlu: { intent: 'faq', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 },
      urgency: 'low', needsHuman: false, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 1 },
    metadata: { agentConfig: { agentType: 'general_service' }, playbookDirective: {
      nodeType: 'knowledge', instruction: 'Answer the factual question.', resumeQuestion: question,
    } },
    contextLanes: { knowledge: { status: 'sufficient', indexVersion: 'test',
      diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 1 },
      evidence: [{ evidenceId: 'authorized', documentId: 1, versionId: 1, chunkId: '1',
        title: 'Published guide', excerpt: supported, authority: 'owner', scores: { fused: 1 } }],
    } },
  };
}
const draft = (): AgentResult => ({ replyText: `${supported} The room is 690 square feet.`, escalated: false });
afterEach(() => { jest.restoreAllMocks(); });

describe('shared dispatch FAQ recovery boundary', () => {
  it.each(['web', 'whatsapp', 'instagram', 'facebook', 'email'] as const)(
    'reverifies the final %s reply and preserves the configured resume question', async (channel) => {
      jest.spyOn(agentRouter, 'dispatch').mockResolvedValue(draft());
      const result = await new AgentDispatchStage().execute(context(channel));
      expect(result.agentResult?.replyText).toBe(`${supported}\n\n${question}`);
      expect(result.agentResult?.answerVerification?.mayDeliver).toBe(true);
      expect(result.agentResult?.claimEvidence).toHaveLength(1);
      expect(result.agentResult?.escalated).toBe(false);
      expect(result.metadata?.knowledgeAnswerRepair).toEqual({
        strategy: 'verified_facts_only', removedClaimIds: ['customer-answer-2'],
      });
    });

  it('does not recover a draft proposing a booking effect', async () => {
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ ...draft(),
      effectProposals: [{ type: 'booking', payload: {} }],
    });
    const result = await new AgentDispatchStage().execute(context());
    expect(result.agentResult?.answerVerification?.mayDeliver).toBe(false);
    expect(result.agentResult?.escalated).toBe(true);
    expect(result.metadata?.knowledgeAnswerRepair).toBeUndefined();
  });

  it('does not conceal a failed tool', async () => {
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({ ...draft(), toolCallsExecuted: [{
      name: 'lookup', args: {}, result: null, status: 'failed', success: false, confirmedSideEffect: false,
    }] });
    const result = await new AgentDispatchStage().execute(context());
    expect(result.agentResult?.answerVerification?.mayDeliver).toBe(false);
    expect(result.metadata?.knowledgeAnswerRepair).toBeUndefined();
  });

  it('verifies an answer followed by a model question even without a journey resume prompt', async () => {
    const ctx = context('whatsapp');
    delete ctx.metadata!.playbookDirective;
    jest.spyOn(agentRouter, 'dispatch').mockResolvedValue({
      replyText: `${supported} The room is 690 square feet. Would you like to book?`, escalated: false,
    });
    const result = await new AgentDispatchStage().execute(ctx);
    expect(result.agentResult?.answerVerification?.mayDeliver).toBe(true);
    expect(result.agentResult?.replyText).toBe(supported);
    expect(result.agentResult?.claimEvidence).toHaveLength(1);
  });
});
