import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const readHistory = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/agents/subagents/ChatHistorySubAgent.js', () => ({
  chatHistorySubAgent: { execute: readHistory, metadata: { tools: [{ type: 'function', function: { name: 'get_customer_chat_history' } }] } },
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { createProviderForUser: async () => ({ defaultModel: 'test' }), createChatCompletionWithFallback: complete },
}));
const { recallCustomerHistory } = await import('../services/agents/orchestration/CustomerHistoryRecall.js');
const { CustomerHistoryStage } = await import('../services/agents/pipeline/stages/CustomerHistoryStage.js');
const { PlaybookStage } = await import('../services/agents/pipeline/stages/PlaybookStage.js');
const { playbookEngine } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { ConfidenceGate } = await import('../services/agents/pipeline/stages/ConfidenceGate.js');
const { PostProcessingStage } = await import('../services/agents/pipeline/stages/PostProcessingStage.js');
const { semanticIntent } = await import('./helpers/supportSemanticFixture.js');
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

const input = { userId: 9, conversationId: 700, inboundText: 'What did I ask you yesterday?' };
const toolResult = (payload: Record<string, unknown>) => ({ toolResults: [{ name: 'get_customer_chat_history', result: { success: true, historicalContextOnly: true, ...payload } }] });
const answer = (selection: object) => ({ success: true, completion: { choices: [{ message: { role: 'assistant', content: JSON.stringify(selection) } }] } });
const toolCall = (name = 'get_customer_chat_history', args = { conversation_id: 10 }) => ({ success: true, completion: { choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'read', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
} }] } });
const context = (): PipelineContext => ({
  message: { ...input, channel: 'whatsapp', senderIdentifier: 'test', metadata: { executionMode: 'customer' } },
  nlu: { semanticRequest: semanticIntent('history'), intent: 'faq', secondaryIntents: [], entities: {},
    sentiment: { label: 'neutral', score: 0 }, urgency: 'low', needsHuman: false, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 0.99 },
  confidence: 1, policyViolations: [], metadata: { agentConfig: { toolsEnabled: ['get_customer_chat_history'], agentType: 'hotel_sales' } },
});
beforeEach(() => {
  jest.restoreAllMocks(); readHistory.mockReset(); complete.mockReset();
  readHistory.mockResolvedValueOnce(toolResult({ conversations: [{ id: 10, channel: 'whatsapp', created_at: '2026-09-21T08:00:00Z' }], next_before_id: null }));
});

describe('customer historical recall is evidence-backed and read-only', () => {
  it('lists then reads and quotes only returned messages, rejecting invented selections', async () => {
    readHistory.mockResolvedValueOnce(toolResult({ messages: [{ id: 101, direction: 'inbound', content: 'Does the room have a balcony?', created_at: '2026-09-21T08:01:00Z' }], next_before_id: null }));
    complete.mockResolvedValueOnce(toolCall()).mockResolvedValueOnce(answer({ messageIds: [999, 101], conversationIds: [] }));
    const result = await recallCustomerHistory(input);
    expect(readHistory.mock.calls.map(call => call[1])).toEqual([{}, { conversation_id: 10 }]);
    expect(result.replyText).toContain('Does the room have a balcony?');
    expect(result.replyText).toContain('2026-09-21');
    expect(result.replyText).not.toContain('999');
    expect(result.effectProposals).toEqual([]);
    expect(result.escalated).toBe(false);
    expect(result.toolCallsExecuted).toHaveLength(2);
  });
  it('lists authorized chats without pretending to have read them', async () => {
    complete.mockResolvedValueOnce(answer({ messageIds: [], conversationIds: [10, 777] }));
    const result = await recallCustomerHistory(input);
    expect(result.replyText).toContain('2026-09-21 · whatsapp · chat 10');
    expect(result.replyText).not.toContain('777');
    expect(readHistory).toHaveBeenCalledTimes(1);
  });
  it('accepts provider nulls only for omitted optional history fields', async () => {
    complete.mockResolvedValueOnce(toolCall('get_customer_chat_history', { conversation_id: 10, before_id: null } as any))
      .mockResolvedValueOnce(answer({ messageIds: [101] }));
    readHistory.mockResolvedValueOnce(toolResult({ messages: [{ id: 101, direction: 'inbound', content: 'Earlier question', created_at: '2026-09-21' }] }));
    const result = await recallCustomerHistory(input);
    expect(readHistory.mock.calls[1][1]).toEqual({ conversation_id: 10 });
    expect(result.replyText).toContain('Earlier question');
  });
  it('accepts the provider first-page cursor 0 without weakening conversation authorization', async () => {
    complete.mockResolvedValueOnce(toolCall('get_customer_chat_history', { conversation_id: 10, before_id: 0 } as any))
      .mockResolvedValueOnce(answer({ messageIds: [101] }));
    readHistory.mockResolvedValueOnce(toolResult({ messages: [{ id: 101, direction: 'inbound', content: 'Earlier question', created_at: '2026-09-21' }] }));
    const result = await recallCustomerHistory(input);
    expect(readHistory.mock.calls[1][1]).toEqual({ conversation_id: 10, before_id: 0 });
    expect(result.replyText).toContain('Earlier question');
  });
  it('rejects an unlisted conversation before reading it', async () => {
    complete.mockResolvedValueOnce(toolCall('get_customer_chat_history', { conversation_id: 999 }));
    const result = await recallCustomerHistory(input);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain('couldn’t retrieve');
    expect(result.escalated).toBe(false);
  });
  it('does not execute a business tool requested by the model or old chat content', async () => {
    complete.mockResolvedValueOnce(toolCall('create_booking'));
    const result = await recallCustomerHistory(input);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(result.effectProposals).toEqual([]);
    expect(result.replyText).toContain('couldn’t retrieve');
  });
  it('reports lookup failure without handoff or fabricated history', async () => {
    readHistory.mockReset().mockRejectedValueOnce(new Error('unavailable'));
    const result = await recallCustomerHistory(input);
    expect(result.escalated).toBe(false);
    expect(result.replyText).toContain('couldn’t retrieve');
    expect(complete).not.toHaveBeenCalled();
  });
  it('does not expose or reuse old conversation identity tokens', async () => {
    complete.mockResolvedValueOnce(toolCall()).mockResolvedValueOnce(answer({ messageIds: [101] }));
    readHistory.mockResolvedValueOnce(toolResult({ messages: [{ id: 101, direction: 'inbound', content: 'My email is [EMAIL_1]', created_at: '2026-09-21' }] }));
    const result = await recallCustomerHistory(input);
    expect(result.replyText).toContain('[private detail omitted]');
    expect(result.replyText).not.toContain('[EMAIL_1]');
  });
  it('follows pagination only through authorized results', async () => {
    complete.mockResolvedValueOnce(toolCall('get_customer_chat_history', { before_id: 10 } as any))
      .mockResolvedValueOnce(toolCall('get_customer_chat_history', { conversation_id: 5 }))
      .mockResolvedValueOnce(answer({ messageIds: [50] }));
    readHistory.mockResolvedValueOnce(toolResult({ conversations: [{ id: 5, channel: 'instagram', created_at: '2026-09-20' }] }))
      .mockResolvedValueOnce(toolResult({ messages: [{ id: 50, direction: 'inbound', content: 'Spa opening hours?', created_at: '2026-09-20T08:00:00Z' }] }));
    const result = await recallCustomerHistory(input);
    expect(result.replyText).toContain('Spa opening hours?');
    expect(result.replyText).toContain('instagram');
  });
  it('pauses intake and side effects while retaining normal approval gates', async () => {
    complete.mockResolvedValueOnce(answer({ conversationIds: [10] }));
    const ctx = context();
    const resolve = jest.spyOn(playbookEngine, 'resolve');
    const commit = jest.spyOn(playbookEngine, 'commitProposedTransition');
    await new CustomerHistoryStage().execute(ctx);
    await new PlaybookStage().execute(ctx);
    await new PostProcessingStage().execute(ctx);
    expect(resolve).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
    ctx.message.metadata!.forceApproval = true;
    await expect(new ConfidenceGate().execute(ctx)).rejects.toMatchObject({ outcome: 'pending_approval' });
  });
  it.each(['public', 'preview', 'disabled', 'human_owned'])('does not access private history for %s', async mode => {
    const ctx = context();
    if (mode === 'public') ctx.message.metadata!.publicReply = true;
    if (mode === 'preview') ctx.message.metadata!.executionMode = 'preview';
    if (mode === 'disabled') ctx.metadata!.agentConfig.toolsEnabled = [];
    if (mode === 'human_owned') ctx.metadata!.skipAgentGeneration = true;
    await new CustomerHistoryStage().execute(ctx);
    expect(readHistory).not.toHaveBeenCalled();
  });
  it.each(['continue', 'human', 'refund'] as const)('does not intercept %s or advance its journey', async action => {
    const ctx = context(); ctx.nlu!.semanticRequest = semanticIntent(action);
    await new CustomerHistoryStage().execute(ctx);
    expect(readHistory).not.toHaveBeenCalled();
    expect(ctx.metadata?.skipAgentGeneration).toBeUndefined();
  });
});
