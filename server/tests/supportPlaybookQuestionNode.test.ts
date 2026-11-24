import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { AgentResult } from '../services/agents/BaseOutreachAgent.js';

// A published playbook "question" node asks for diagnostic details. Those
// questions make no business claim, so missing knowledge must not turn them
// into an uncertainty reply or a pending approval.
const dispatch = jest.fn<(agentType: string, input: unknown) => Promise<AgentResult>>();
const recover = jest.fn<(input: unknown) => Promise<unknown>>();
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { dispatch } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeExtractiveAnswer.js', () => ({ recoverExtractiveKnowledgeAnswer: recover }));
const { AgentDispatchStage, playbookQuestionsOnly } = await import('../services/agents/pipeline/stages/AgentDispatchStage.js');
const { ConfidenceGate } = await import('../services/agents/pipeline/stages/ConfidenceGate.js');

function context(overrides: { intent?: string; riskLevel?: string; nodeType?: string } = {}): PipelineContext {
  return {
    message: { userId: 9, conversationId: -10, channel: 'web', inboundText: 'My router keeps dropping Wi-Fi since yesterday.',
      metadata: { executionMode: 'preview', dryRun: true } },
    nlu: { intent: overrides.intent || 'support_request', riskLevel: overrides.riskLevel || 'low', classificationConfidence: 0.9 },
    confidence: 1, policyViolations: [],
    metadata: {
      documentRetrieval: { status: 'none' }, agentConfig: { agentType: 'tech_support', escalationRules: { rules: [{ id: 'c', enabled: true, type: 'escalation_threshold', config: { threshold: 0.75 } }] } },
      knowledgeQuery: { tenantId: 9, risk: 'low', audience: 'customer' }, activePlaybookSelection: true,
      playbookDirective: { nodeId: 'collect-diagnostics', nodeType: overrides.nodeType || 'question', runId: 1,
        instruction: 'Ask only for missing, non-sensitive details needed for the next diagnostic step.' },
    },
    contextLanes: { knowledge: { status: 'insufficient', indexVersion: 'test', evidence: [],
      diagnostics: { queryFingerprint: 'q', candidateCount: 0, reranked: false, latencyMs: 1 } } },
  } as unknown as PipelineContext;
}
const reply = (replyText: string): AgentResult => ({ replyText, confidence: 0.8, escalated: false } as AgentResult);

beforeEach(() => { jest.clearAllMocks(); recover.mockResolvedValue(null); });

describe('playbook question nodes', () => {
  it('delivers only the diagnostic questions when the draft mixes in unverified tips', async () => {
    dispatch.mockResolvedValue(reply('Sorry to hear that. Try restarting the router and moving it closer to your devices. When did the drops start? Which devices are affected?'));
    const ctx = context();
    await new AgentDispatchStage().execute(ctx);
    expect(ctx.agentResult?.replyText).toBe('When did the drops start? Which devices are affected?');
    await expect(new ConfidenceGate().execute(ctx)).resolves.toBeDefined();
  });
  it('delivers a questions-only draft', async () => {
    dispatch.mockResolvedValue(reply('When did the drops start, and which devices are affected? What have you already tried?'));
    const ctx = context();
    await new AgentDispatchStage().execute(ctx);
    expect(ctx.agentResult?.replyText).toBe('When did the drops start, and which devices are affected? What have you already tried?');
    await expect(new ConfidenceGate().execute(ctx)).resolves.toBeDefined();
  });
  it('keeps the evidence block for questions that assert offers, numbers or commitments', async () => {
    dispatch.mockResolvedValue(reply('Would you like our free replacement router? Is it older than 2 years?'));
    const ctx = context();
    await new AgentDispatchStage().execute(ctx);
    expect(ctx.agentResult?.replyText).toMatch(/don’t have enough confirmed information/);
  });
  it.each([
    ['a refund intent', { intent: 'refund_request' }],
    ['a high-risk message', { riskLevel: 'high' }],
    ['a message node', { nodeType: 'message' }],
  ])('does not relax evidence checks for %s', async (_label, overrides) => {
    dispatch.mockResolvedValue(reply('Sorry to hear that. Try restarting the router. When did the drops start?'));
    const ctx = context(overrides);
    await new AgentDispatchStage().execute(ctx);
    expect(ctx.agentResult?.replyText).not.toBe('When did the drops start?');
  });
  it('accepts only plain information requests', () => {
    expect(playbookQuestionsOnly('Thanks! When did it start? Which browser do you use?')).toBe('When did it start? Which browser do you use?');
    expect(playbookQuestionsOnly('Restart it now.')).toBeNull();
    expect(playbookQuestionsOnly('Can you share your password or OTP?')).toBeNull();
    expect(playbookQuestionsOnly('Is your refund confirmed?')).toBeNull();
    expect(playbookQuestionsOnly('Did you pay ₹500?')).toBeNull();
  });
});
