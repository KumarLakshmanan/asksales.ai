import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { choice, parseDecisions } from '../services/agents/intent/decisionContract.js';
const credentials = jest.fn<any>();
const used = jest.fn<any>();
const selection = jest.fn<any>();
const decisions = jest.fn<any>();
const chat = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/intentClassifierCredentials/functions.js', () => ({ getActiveClassifierCredentials: credentials, markClassifierCredentialUsed: used }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createClassifierProvider: selection } }));
const { classifyIntent, classificationMessages, matchesClassification } = await import('../services/agents/intent/IntentClassifierService.js');
const questions = { action: choice('Actual speech act?', ['question', 'revise']) };
const answer = (extra = {}) => ({ answers: { action: { type: 'choice', choice: 'question', confidence: 0.99, ...extra } } });
const input = { userId: 9, messages: [{ role: 'system', content: 'Application contract' },
  { role: 'assistant', content: 'Shall I prepare the campaign?' }, { role: 'user', content: 'Explain it, do not proceed.' }],
  questions, loggingContext: { userId: 9, purpose: 'intent_classification', service: 'test' } };
beforeEach(() => {
  jest.resetAllMocks();
  credentials.mockResolvedValue([{ id: 27, platform: 'openrouter', apiKey: 'classifier-key', isActive: true, config: { model: 'typesafe/jev-1.13' } }]);
  used.mockResolvedValue(undefined);
  selection.mockReturnValue({ defaultModel: 'typesafe/jev-1.13', createIntentDecisions: decisions, createChatCompletion: chat });
  decisions.mockResolvedValue(answer());
});
describe('strict classifier decisions', () => {
  it.each([
    { confidence: undefined }, { confidence: NaN }, { confidence: Infinity }, { confidence: -1 },
    { confidence: 1.1 }, { confidence: 0.89 }, { choice: 'uncertain' }, { choice: 'send_now' },
    { type: 'noul' }, { probabilities: { question: 0.1, revise: 0.9 } },
    { probabilities: { question: 0.99, injected: 0.01 } }, { probabilities: { question: '0.99' } },
  ])('rejects malformed or uncertain decisions: %j', extra => expect(parseDecisions(answer(extra), questions)).toBeNull());
  it('rejects missing questions and accepts valid probability-only answers', () => {
    expect(parseDecisions({ answers: {} }, questions)).toBeNull();
    expect(parseDecisions(answer({ confidence: undefined, probabilities: { question: 0.99, revise: 0.01 } }), questions))
      .toEqual({ choices: { action: 'question' }, confidence: 0.99 });
  });
  it('uses Jev Decisions with the active classifier credential and complete multi-turn context', async () => {
    expect(await classifyIntent(input)).toMatchObject({ provider: 'openrouter', model: 'typesafe/jev-1.13', choices: { action: 'question' } });
    expect(selection).toHaveBeenCalledWith(9, expect.objectContaining({ id: 27, platform: 'openrouter' }));
    expect(decisions).toHaveBeenCalledWith({ contract: input.messages[0].content, conversation: input.messages.slice(1) }, questions, input.loggingContext);
    expect(chat).not.toHaveBeenCalled();
  });
  it.each(['openai', 'gemini', 'vertex_ai', 'openrouter', 'custom_ai'])('uses selected %s chat model instead of Jev endpoint', async provider => {
    credentials.mockResolvedValue([{ id: 28, platform: provider, apiKey: 'classifier-key', isActive: true, config: { model: 'selected-model' } }]);
    selection.mockReturnValue({ defaultModel: 'selected-model', createChatCompletion: chat });
    chat.mockResolvedValue({ success: true, content: JSON.stringify(answer()) });
    expect(await classifyIntent(input)).toMatchObject({ provider, model: 'selected-model' });
    expect(chat.mock.calls[0][0].model).toBe('selected-model');
    expect(decisions).not.toHaveBeenCalled();
  });
  it('uses full-model fallback on missing credential, API failure, invalid output or oversized context', async () => {
    credentials.mockResolvedValueOnce([]);
    expect(await classifyIntent(input)).toBeNull();
    decisions.mockRejectedValueOnce(new Error('HTTP 429'));
    expect(await classifyIntent(input)).toBeNull();
    decisions.mockResolvedValueOnce({ answers: {} });
    expect(await classifyIntent(input)).toBeNull();
    decisions.mockClear();
    expect(await classifyIntent({ ...input, messages: [...input.messages, { role: 'user', content: 'a'.repeat(31_000) }] })).toBeNull();
    expect(decisions).not.toHaveBeenCalled();
  });
  it('tries the next active classifier on provider failure and keeps the general credential pool unused', async () => {
    credentials.mockResolvedValue([
      { id: 1, platform: 'openrouter', apiKey: 'first', isActive: true, config: { model: 'typesafe/jev-1.13' } },
      { id: 2, platform: 'openai', apiKey: 'second', isActive: true, config: { model: 'gpt-test' } },
    ]);
    decisions.mockRejectedValueOnce(new Error('provider offline'));
    selection.mockImplementation((_userId: number, credential: { platform: string }) => credential.platform === 'openrouter'
      ? { defaultModel: 'typesafe/jev-1.13', createIntentDecisions: decisions }
      : { defaultModel: 'gpt-test', createChatCompletion: chat });
    chat.mockResolvedValue({ success: true, content: JSON.stringify(answer()) });
    expect(await classifyIntent(input)).toMatchObject({ provider: 'openai', choices: { action: 'question' } });
    expect(used).toHaveBeenCalledWith(1);
    expect(used).toHaveBeenCalledWith(2);
  });
  it('keeps reliable independent labels while deferring uncertain fields', async () => {
    decisions.mockResolvedValue({ answers: { action: { type: 'choice', choice: 'question', confidence: 0.99 },
      service: { type: 'choice', choice: 'other', confidence: 0.4 } } });
    const result = await classifyIntent({ ...input, questions: { ...questions, service: choice('Service?', ['spa', 'other']) } });
    expect(result?.choices).toEqual({ action: 'question' });
    expect(result?.confidence).toBe(0.99);
  });
  it('preserves latest message position and verifies every bounded field including agent membership', () => {
    const classification = { provider: 'openrouter', model: 'jev', confidence: 0.99,
      choices: { action: 'revise', 'semanticRequest.contentOperation': 'generate', 'hiredAgents.outreach': 'true', 'hiredAgents.content_studio': 'false' } };
    expect(classificationMessages(input.messages, classification).at(-1)).toEqual(input.messages.at(-1));
    const result = { action: 'revise', semanticRequest: { contentOperation: 'generate' }, hiredAgents: ['outreach'] };
    expect(matchesClassification(result, classification)).toBe(true);
    expect(matchesClassification({ ...result, hiredAgents: ['outreach', 'content_studio'] }, classification)).toBe(false);
    expect(matchesClassification({}, classification)).toBe(false);
  });
});
