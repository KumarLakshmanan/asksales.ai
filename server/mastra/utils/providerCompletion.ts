import { assertContextFits } from './contextBudget.js';
import { LLMProviderFactory } from '../../services/agents/LLMProviderFactory.js';
import { LLMProviderResponseError } from '../../services/agents/LLMProviderErrors.js';
import type { LLMChatOptions, LLMResponse } from '../../services/agents/LLMProvider.js';

/**
 * Run a chat completion through every configured provider candidate. Callers
 * should use this instead of retaining one provider for an entire agent turn:
 * a credential can become unavailable between the router and specialist calls.
 */
export async function createCompletionWithProviderFallback(
  userId: number,
  options: Omit<LLMChatOptions, 'model'>,
  validateResponse?: (response: LLMResponse) => boolean,
): Promise<LLMResponse> {
  return LLMProviderFactory.executeProviderCallWithFallback(
    userId,
    async (provider) => {
      assertContextFits(provider.defaultModel, options.messages, options.tools, options.max_tokens);
      const response = await provider.createChatCompletion({
        ...options,
        model: provider.defaultModel,
      } as LLMChatOptions);
      if (!response.success) {
        throw new LLMProviderResponseError(
          response.error || 'The provider could not process the request.',
          provider.getProviderName(),
          provider.defaultModel,
        );
      }
      // HTTP success is insufficient for structured callers. Validate before
      // accepting a provider so malformed output can use the same fallback
      // boundary; this callback performs no tools or campaign mutations.
      if (validateResponse && !validateResponse(response)) {
        throw new LLMProviderResponseError(
          'The provider returned an invalid structured response.',
          provider.getProviderName(),
          provider.defaultModel,
        );
      }
      return response;
    },
  );
}
