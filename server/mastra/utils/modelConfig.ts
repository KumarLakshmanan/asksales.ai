/**
 * Model Configuration Helper
 * Converts the existing LLMConfig into Mastra-compatible model configuration.
 */

import type { LLMConfig } from '../state.js';

/**
 * Mastra-compatible model config type.
 * Matches OpenAICompatibleConfig from @mastra/core/llm.
 */
export type MastraModelConfig = {
  id: `${string}/${string}`;
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
} | {
  providerId: string;
  modelId: string;
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

/**
 * Convert our LLMConfig to a Mastra model config.
 *
 * Provider mapping:
 *   openai      → { id: 'openai/<model>', apiKey }
 *   openrouter  → { id: 'openai/<model>', url: openrouter endpoint, apiKey }
 *   gemini      → { id: 'google/<model>', apiKey }
 *   vertex_ai   → OpenAI-compatible Vertex endpoint with a short-lived OAuth token
 *   custom_ai   → { id: 'openai/<model>', url: custom baseURL, apiKey }
 */
export function toMastraModel(llmConfig: LLMConfig | null | undefined): MastraModelConfig {
  if (!llmConfig) {
    return { id: 'openai/gpt-4o' as `${string}/${string}` };
  }

  const { provider, modelName: model, apiKey, baseURL } = llmConfig;

  switch (provider) {
    case 'openai':
      return {
        id: `openai/${model}` as `${string}/${string}`,
        apiKey,
      };

    case 'openrouter':
      return {
        id: `openai/${model}` as `${string}/${string}`,
        url: 'https://openrouter.ai/api/v1',
        apiKey,
        headers: {
          'HTTP-Referer': 'https://asksales.ai',
          'X-Title': 'AskSales',
        },
      };

    case 'gemini':
      return {
        id: `google/${model}` as `${string}/${string}`,
        apiKey,
      };

    case 'vertex_ai':
      return {
        providerId: 'vertex-ai',
        modelId: model.startsWith('google/') ? model : `google/${model}`,
        url: baseURL,
        apiKey,
      };

    case 'custom_ai':
      return {
        id: `openai/${model}` as `${string}/${string}`,
        url: baseURL,
        apiKey,
      };

    default:
      return {
        id: `openai/${model || 'gpt-4o'}` as `${string}/${string}`,
        apiKey,
      };
  }
}
