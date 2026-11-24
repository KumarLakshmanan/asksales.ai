import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_FALLBACK_MODELS,
  OPENROUTER_FALLBACK_MODELS,
  normalizeLLMModelName,
} from '../utils/llmConstants.js';

describe('LLM model lifecycle normalization', () => {
  it('uses the supported Gemini 3.1 Flash-Lite model by default', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.1-flash-lite');
    expect(GEMINI_FALLBACK_MODELS).toContain('gemini-3.1-flash-lite');
    expect(GEMINI_FALLBACK_MODELS).not.toContain('gemini-3.1-flash-lite-preview');
    expect(GEMINI_FALLBACK_MODELS).not.toContain('gemini-2.0-flash');
  });

  it('maps retired stored model IDs without changing unknown models', () => {
    expect(normalizeLLMModelName('gemini', 'gemini-3.1-flash-lite-preview'))
      .toBe('gemini-3.1-flash-lite');
    expect(normalizeLLMModelName('google', 'gemini-2.0-flash'))
      .toBe('gemini-3.1-flash-lite');
    expect(normalizeLLMModelName('openrouter', 'google/gemini-3.1-flash-lite-preview'))
      .toBe('google/gemini-3.1-flash-lite');
    expect(normalizeLLMModelName('custom_ai', 'private/model-v1'))
      .toBe('private/model-v1');
    expect(OPENROUTER_FALLBACK_MODELS).not.toContain('google/gemini-3.1-flash-lite-preview');
  });
});
