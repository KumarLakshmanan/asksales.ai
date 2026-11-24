import { describe, expect, it, jest } from '@jest/globals';
const processMessage = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({ channelGateway: { process: processMessage } }));
const { agentRouter } = await import('../services/agents/AgentRouter.js');
describe('canonical sentiment in deferred channels', () => {
  it('returns only the server-owned opt-out receipt for a static acknowledgement', async () => {
    processMessage.mockResolvedValueOnce({ method: 'ready_for_channel_delivery', context: {
      agentResult: { replyText: 'You have been unsubscribed.', escalated: false },
      metadata: { systemDirective: 'opt_out_confirmation', suppressBusinessEffects: true },
    } });
    const result = await agentRouter.handle({ userId: 8, conversationId: 19, channel: 'email', inboundText: 'STOP' });
    expect(result?.optOutApplied).toBe(true);
    expect(result?.classifiedSentiment).toBeUndefined();
    expect(result?.deferredEffectContext?.suppressBusinessEffects).toBe(true);
  });
  it('returns and commits canonical sentiment instead of an earlier standalone classification', async () => {
    const sentiment = { sentiment: 'negative', score: -0.8, keywords: [] };
    processMessage.mockResolvedValueOnce({ method: 'ready_for_channel_delivery', context: {
      sentiment, agentResult: { replyText: 'Prepared for review', escalated: false }, metadata: {},
    } });
    const result = await agentRouter.handle({ userId: 8, conversationId: 19, channel: 'email', inboundText: 'Unhappy with this',
      sentiment: { sentiment: 'positive', score: 0.8, keywords: [] } });
    expect(result?.classifiedSentiment).toEqual(sentiment);
    expect(result?.deferredEffectContext?.sentiment).toEqual(sentiment);
  });
  it('does not manufacture sentiment or delivery authority when the pipeline halted early', async () => {
    processMessage.mockResolvedValueOnce({ method: 'blocked', context: {} });
    const result = await agentRouter.handle({ userId: 8, conversationId: 19, channel: 'email', inboundText: 'unknown' });
    expect(result?.classifiedSentiment).toBeUndefined();
    expect(result?.replyText).toBe('');
    expect(result?.deliveryOutcome).toBe('blocked');
    expect(result?.deferredEffectContext).toBeUndefined();
  });
});
