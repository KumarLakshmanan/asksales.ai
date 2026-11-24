import { describe, expect, it } from '@jest/globals';
import {
  classifyLLMProviderFailure,
  parseOpenRouterAffordableOutputCap,
  safeLLMProviderFailureMessage,
} from '../services/agents/LLMProviderErrors.js';

describe('LLM provider error classification', () => {
  it('extracts a smaller affordable output cap only from an exact 402 token-budget response', () => {
    const error = {
      status: 402,
      message: 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 4000 tokens.',
    };
    expect(parseOpenRouterAffordableOutputCap(error, 8192)).toBe(3600);
    expect(classifyLLMProviderFailure(error)).toMatchObject({ category: 'output_budget', affordableOutputTokens: 4000 });
  });

  it.each([
    [{ status: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1000 tokens.' }, 8192],
    [{ status: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 0 tokens.' }, 8192],
    [{ status: 402, message: 'Payment required; can only afford 4000 tokens.' }, 8192],
    [{ status: 429, message: 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 4000 tokens.' }, 8192],
  ])('rejects ambiguous, zero-budget, mismatched, or non-402 caps %#', (error, requestedTokens) => {
    expect(parseOpenRouterAffordableOutputCap(error, requestedTokens)).toBeNull();
  });

  it('classifies durable billing failures separately from temporary rate limits', () => {
    expect(classifyLLMProviderFailure({ status: 402, message: 'Payment required; insufficient account balance.' }).category)
      .toBe('insufficient_credits');
    expect(classifyLLMProviderFailure({ status: 429, message: 'Too many requests.' }).category)
      .toBe('rate_limited');
  });

  it('preserves the billing category when a sanitized 429 message is classified again', () => {
    const original = { status: 429, message: 'OpenRouter HTTP 429 reports insufficient credits for this account.' };
    const safeMessage = safeLLMProviderFailureMessage(original, 'openrouter');
    expect(safeMessage).toContain('insufficient provider credits');
    expect(classifyLLMProviderFailure(safeMessage)).toMatchObject({
      category: 'insufficient_credits',
      status: 429,
    });
  });

  it('maps provider errors to actionable messages without echoing upstream secrets or customer data', () => {
    const error = {
      status: 402,
      message: 'Payment required; authorization=Bearer secret-provider-token customer=private-customer-id',
    };
    const message = safeLLMProviderFailureMessage(error, 'openrouter');
    expect(message).toContain('insufficient provider credits');
    expect(message).not.toContain('secret-provider-token');
    expect(message).not.toContain('private-customer-id');
  });

  it('returns a bounded message for empty completions', () => {
    expect(safeLLMProviderFailureMessage('No message content returned', 'openrouter'))
      .toContain('no visible completion content');
  });
});
