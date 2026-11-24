import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isProviderResponseError } from '../services/agents/LLMProviderErrors.js';
import { semanticRequest } from './helpers/semanticIntent.js';

let candidates: ReturnType<typeof provider>[] = [];
const fallback = jest.fn<any>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { executeProviderCallWithFallback: fallback } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn() } }));
const { runUnifiedRouter } = await import('../mastra/unifiedRouter.js');
const { routerOutputSchema } = await import('../mastra/routerSchema.js');
const valid = JSON.stringify(routerOutputSchema.parse({ intent: 'task', action: 'revise', hiredAgents: ['lead_generation'],
  mode: 'hire_agent', nextAgent: 'lead_generation', isAffirmative: false, isDomainMatch: true, navigationTarget: null,
  response: 'Prepare settings for review.', suggestAgents: false, recommendedAgents: [], leadSettingsRequested: true, semanticRequest: semanticRequest() }));
function provider(name: string, response: object) {
  return { defaultModel: 'test', getProviderName: () => name, createChatCompletion: jest.fn<any>().mockResolvedValue(response) };
}
let thread = 9100;
const state = () => ({ userId: 1, threadId: ++thread, currentAgent: 'lead_generation', selectedWorkflows: ['linkedin'],
  messages: [{ role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' }] } as any);
beforeEach(() => {
  candidates = [];
  fallback.mockReset().mockImplementation(async (_userId: number, call: (candidate: ReturnType<typeof provider>) => Promise<unknown>) => {
    let lastError;
    for (const candidate of candidates) {
      try { return await call(candidate); }
      catch (error) { if (!isProviderResponseError(error)) throw error; lastError = error; }
    }
    throw lastError;
  });
});

describe('LG-03 structured provider fallback', () => {
  it('accepts fenced JSON after an upstream failure without rejecting the valid search request', async () => {
    candidates = [provider('gemini', { success: false, error: 'Upstream unavailable' }),
      provider('openrouter', { success: true, content: '```json\n' + valid + '\n```' })];
    expect(await runUnifiedRouter(state())).toMatchObject({ nextAgent: 'lead_generation', leadSettingsRequested: true });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(candidates[1].createChatCompletion).toHaveBeenCalledTimes(1);
  });
  it('tries the next provider for HTTP-success invalid JSON before accepting a decision', async () => {
    candidates = [provider('openrouter', { success: true, content: 'Here is a search plan, not routing JSON.' }),
      provider('openai', { success: true, content: valid })];
    const input = state();
    expect(await runUnifiedRouter(input)).toMatchObject({ nextAgent: 'lead_generation', isAffirmative: false });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(candidates.every(candidate => candidate.createChatCompletion.mock.calls.length === 1)).toBe(true);
    expect(input.selectedWorkflows).toEqual(['linkedin']);
    expect(input.pendingApproval).toBeUndefined();
  });
  it('bounds exhausted formatting repair and preserves the saved strategy for a later recovery', async () => {
    candidates = [provider('openrouter', { success: true, content: '{"intent":' })];
    const input = state();
    expect(await runUnifiedRouter(input)).toMatchObject({ nextAgent: null, needsClarification: true });
    expect(candidates[0].createChatCompletion).toHaveBeenCalledTimes(2);
    const secondCall = candidates[0].createChatCompletion.mock.calls[1][0] as { messages: Array<{ content: string }> };
    expect(secondCall.messages.at(-1)!.content).toContain('invalid JSON');
    candidates[0].createChatCompletion.mockResolvedValue({ success: true, content: valid });
    expect(await runUnifiedRouter(input)).toMatchObject({ nextAgent: 'lead_generation', leadSettingsRequested: true });
    expect(input.selectedWorkflows).toEqual(['linkedin']);
  });
});
