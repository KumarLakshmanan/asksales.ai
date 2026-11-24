import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PlaybookStage } from '../services/agents/pipeline/stages/PlaybookStage.js';
import { playbookEngine } from '../services/agents/orchestration/PlaybookEngine.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

afterEach(() => { jest.restoreAllMocks(); });
describe('internal knowledge assistance does not start customer intake', () => {
  it.each(['support_member', 'owner_support'])('keeps %s questions on the evidence answer path', async conversationKind => {
    const resolve = jest.spyOn(playbookEngine, 'resolve');
    const ctx: PipelineContext = {
      message: { userId: 9, conversationId: -1000000001, channel: 'web', senderIdentifier: 'staff',
        inboundText: 'What is the return policy?', metadata: { executionMode: 'advisory', conversationKind } },
      confidence: 1, policyViolations: [], metadata: { agentConfig: { agentType: 'general_service' } },
    };
    expect(await new PlaybookStage().execute(ctx)).toBe(ctx);
    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.metadata?.playbookDirective).toBeUndefined();
  });
  it('still resolves the customer journey for an owner simulator', async () => {
    const resolve = jest.spyOn(playbookEngine, 'resolve').mockResolvedValue(null);
    const ctx: PipelineContext = {
      message: { userId: 9, conversationId: -1, channel: 'web', senderIdentifier: 'simulator',
        inboundText: 'Hello', metadata: { executionMode: 'preview', conversationKind: 'owner_simulator', dryRun: true } },
      confidence: 1, policyViolations: [], metadata: { agentConfig: { agentType: 'general_service' } },
    };
    await new PlaybookStage().execute(ctx);
    expect(resolve).toHaveBeenCalled();
  });
});
