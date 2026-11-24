import { describe, expect, it } from 'vitest';
import { AI_SETUP_UNAVAILABLE, aiSetupErrorDisplay } from '../../../shared/aiSetupMessage';
describe('historical AI setup guidance', () => {
  it('replaces retired integration routing without changing unrelated failures', () => {
    expect(aiSetupErrorDisplay('LLM not configured. Please add your API key and model name in Settings > Integrations.')).toBe(AI_SETUP_UNAVAILABLE);
    expect(aiSetupErrorDisplay('No LLM provider configured. Please configure OpenAI or OpenRouter in Settings > Integrations.')).toBe(AI_SETUP_UNAVAILABLE);
    expect(aiSetupErrorDisplay('Insufficient wallet credits.')).toBe('Insufficient wallet credits.');
    expect(aiSetupErrorDisplay('Apify rate limit exceeded.')).toBe('Apify rate limit exceeded.');
  });
});
