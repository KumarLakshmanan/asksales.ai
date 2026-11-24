import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AgentType } from '../mastra/state.js';

const loop = jest.fn<any>();
const completion = jest.fn<any>();
const emitChunk = jest.fn();
jest.unstable_mockModule('../mastra/utils/toolCallingLoop.js', () => ({ runToolCallingLoop: loop }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: completion }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitChatResponseChunk: emitChunk,
} }));
const { BaseAgent } = await import('../mastra/agents/BaseAgent.js');

class TestAgent extends BaseAgent {
  readonly thinkingMessage = 'Thinking';
  constructor(readonly agentType: AgentType) { super(); }
  buildSystemPrompt() { return 'Test specialist'; }
  getTools() { return {}; }
}
const state = { userId: 7, threadId: 42, messages: [{ role: 'user', content: 'Prepare only the review. Do not run it.' }] } as any;

beforeEach(() => {
  jest.clearAllMocks();
  loop.mockResolvedValue({ text: 'I prepared your review card.', responseSource: 'model', toolResults: [] });
  completion.mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: true, claims: [] }) });
});

describe('specialist final-response grounding boundary', () => {
  it.each([
    ['lead_generation', 'A boutique hotel in Bengaluru.'],
    ['performance_marketing', 'Review CTR.'],
  ] as const)('streams and returns only the %s answer for a coordinated question', async (agentType, answer) => {
    loop.mockResolvedValue({ text: '**Marcus:** A boutique hotel in Bengaluru.\n**Sarah:** Review CTR.', toolResults: [] });
    completion.mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    const result = await new TestAgent(agentType).run({ ...state, currentAgent: agentType,
      intentAnalysis: { action: 'question', hiredAgents: ['lead_generation', 'performance_marketing'] },
    });
    expect(result.messages?.[0]?.content).toBe(answer);
    expect(JSON.stringify(emitChunk.mock.calls)).toContain(answer);
    expect(JSON.stringify(emitChunk.mock.calls)).not.toMatch(/Marcus:|Sarah:/);
    expect((loop.mock.calls[0][0] as { systemPrompt: string }).systemPrompt).toContain('Other specialists produce their own messages');
  });

  it('removes a single redundant speaker prefix before streaming and persistence', async () => {
    loop.mockResolvedValue({ text: '**Marcus:** Sarah can review CTR.', toolResults: [] });
    const result = await new TestAgent('lead_generation').run(state);
    expect(result.messages?.[0]?.content).toBe('Sarah can review CTR.');
    expect(JSON.stringify(emitChunk.mock.calls)).not.toContain('Marcus:');
  });

  it('passes the owned saved review snapshot and unfiltered state history into the tool loop', async () => {
    const savedToolActions = [{ widgetId: 21, toolName: 'generate_ad', status: 'active', formValues: { number_of_variations: 3 } }];
    await new TestAgent('content_studio').run({ ...state, savedToolActions });
    expect(loop).toHaveBeenCalledWith(expect.objectContaining({ toolContext: expect.objectContaining({
      userId: 7, threadId: 42, savedToolActions, conversationHistory: state.messages,
    }) }));
  });
  it('streams a useful blocked campaign checklist after a read-only specialist suggestion when verification fails', async () => {
    const brief = 'Draft only. Fictional Example Analytics for SaaS operations managers. Destination https://example.com. No ad spend authorized.';
    const toolResults = [
      { toolName: 'query_content_assets', success: true, result: { success: true, output: { assets: [] } } },
      { toolName: 'check_integration_status', success: true, result: { success: true, output: { platform: 'meta_ads', connected: true } } },
      { toolName: 'suggest_switch_agents', success: true, result: { success: true, output: {
        primary_agent: 'content_studio', message: 'UNTRUSTED: Campaign is live.',
      } } },
    ];
    loop.mockResolvedValue({ text: 'Your campaign is live.', responseSource: 'model', toolResults });
    completion.mockRejectedValue(new Error('unavailable'));
    const runState = { ...state, currentAgent: 'performance_marketing', pipelineRequest: brief,
      messages: [{ role: 'user', content: brief }] };
    const result = await new TestAgent('performance_marketing').run(runState);
    const text = result.messages?.[0]?.content ?? '';
    expect(text).toContain('numeric budget and currency');
    expect(text).toContain('No matching saved creative');
    expect(text).toContain('draft-only restrictions');
    expect(text).not.toMatch(/campaign is live|UNTRUSTED|could not verify|Recorded current action statuses/);
    expect(JSON.stringify(emitChunk.mock.calls)).toContain('numeric budget and currency');
    expect(JSON.stringify(emitChunk.mock.calls)).not.toContain('campaign is live');
    expect(result.toolResults).toEqual(toolResults);
    expect(runState.pipelineRequest).toBe(brief);
    expect(loop).toHaveBeenCalledTimes(1);
  });
  it.each(['performance_marketing', 'outreach', 'content_studio'] as const)('does not stream or return an invented %s review', async agentType => {
    const result = await new TestAgent(agentType).run({ ...state, currentAgent: agentType });
    const text = result.messages?.[0]?.content ?? '';
    expect(text).toContain('No new review card');
    expect(text).not.toContain('I prepared your review card');
    expect(JSON.stringify(emitChunk.mock.calls)).not.toContain('I prepared your review card');
    expect(completion).not.toHaveBeenCalled();
  });

  it('still checks unsupported claims after a failed enrichment hook', async () => {
    const agent = new TestAgent('performance_marketing') as any;
    agent.postProcess = async () => { throw new Error('enrichment failed'); };
    completion.mockRejectedValue(new Error('verifier unavailable'));
    const result = await agent.run(state);
    expect(result.messages[0].content).toContain('No new review card');
    expect(JSON.stringify(emitChunk.mock.calls)).not.toContain('I prepared your review card');
  });

  it('keeps read-only questions behind the same factual boundary', async () => {
    const result = await new TestAgent('performance_marketing').run({ ...state, intentAnalysis: { action: 'question' } });
    expect(result.messages?.[0]?.content).toContain('No new review card');
    expect(JSON.stringify(emitChunk.mock.calls)).not.toContain('I prepared your review card');
  });

  it('does not add verification latency to an unchanged server receipt', async () => {
    loop.mockResolvedValue({ text: 'Review the saved settings before approval.', responseSource: 'server', toolResults: [] });
    const result = await new TestAgent('performance_marketing').run(state);
    expect(result.messages?.[0]?.content).toBe('Review the saved settings before approval.');
    expect(completion).not.toHaveBeenCalled();
  });

  it('checks model prose appended to a server receipt', async () => {
    loop.mockResolvedValue({ text: 'Review the saved settings before approval.', responseSource: 'server', toolResults: [] });
    const agent = new TestAgent('performance_marketing') as any;
    agent.postProcess = async (_state: unknown, result: any) => ({ ...result, text: result.text + ' Your ads are live.' });
    const result = await agent.run(state);
    expect(result.messages[0].content).not.toContain('Your ads are live');
    // No tool ran, so a flagged draft gets one checked rewrite (audit, rewrite, re-audit).
    expect(completion.mock.calls.map((call: any) => call[1].loggingContext.purpose))
      .toEqual(['response_grounding', 'response_grounding_repair', 'response_grounding']);
  });
});
