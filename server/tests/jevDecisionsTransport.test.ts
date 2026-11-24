import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { choice } from '../services/agents/intent/decisionContract.js';
const usage = jest.fn<any>().mockResolvedValue(undefined);
const billing = jest.fn<any>().mockResolvedValue(undefined);
const pricing = jest.fn<any>();
jest.unstable_mockModule('../models/llmUsages/functions.js', () => ({ createLLMUsage: usage }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({ getApiPricingByKey: jest.fn<() => Promise<null>>().mockResolvedValue(null), getAllApiPricing: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]), getLLMModelCost: pricing, getOriginalLLMModelCost: pricing }));
jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({ deductCreditsForLLMUsage: billing }));
const { OpenRouterProvider } = await import('../services/agents/OpenRouterProvider.js');
const questions = { action: choice('Classify', ['question']) };
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
describe('Jev Decisions transport', () => {
  it('uses the dedicated endpoint, existing key, abort deadline, and exact reported cost', async () => {
    const result = { model: 'typesafe/jev-1.13-20260917', answers: { action: { type: 'choice', choice: 'question', confidence: 0.99 } },
      usage: { input_tokens: 1000, output_tokens: 0, cost: 0.000042 } };
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    expect(await new OpenRouterProvider('existing-test-key', 'typesafe/jev-1.13').createIntentDecisions({ latest: 'Why?' }, questions,
      { userId: 9, service: 'test', purpose: 'intent_classification' })).toEqual(result);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer existing-test-key' });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request?.body))).toEqual({ model: 'typesafe/jev-1.13', state: { latest: 'Why?' }, questions });
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ model: result.model, promptTokens: 1000, metadata: expect.objectContaining({ classifierCostUsd: 0.000042 }) }));
    expect(billing).toHaveBeenCalledWith(9, expect.objectContaining({ estimatedCostCents: 0.0042, originalCostCents: 0.0042 }));
    expect(pricing).not.toHaveBeenCalled();
  });
  it.each([401, 402, 429, 500])('does not expose upstream bodies or retry indefinitely on HTTP %s', async status => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private upstream content', { status }));
    await expect(new OpenRouterProvider('key', 'typesafe/jev-1.13').createIntentDecisions({}, questions, undefined))
      .rejects.toThrow(`Intent classifier HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('propagates timeout for the shared full-model fallback', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('deadline', 'TimeoutError'));
    await expect(new OpenRouterProvider('key', 'typesafe/jev-1.13').createIntentDecisions({}, questions, undefined)).rejects.toThrow('deadline');
  });
});
