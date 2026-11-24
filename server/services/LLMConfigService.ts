/**
 * LLM Configuration Service
 *
 * Resolves LLM provider credentials for a given user.
 * Active admin LLM integrations are selected by their configured priority.
 * User-owned keys remain a fallback when the admin pool is empty.
 */

import { logger } from '../utils/logger.js';
import type { LLMConfig } from '../mastra/state';
import { getActiveApiKeyWithMetadata } from '../controllers/apiCredentialsController';
import { getActiveLLMAdminCredentials } from '../models/adminApiCredentials/functions.js';
import { createVertexOpenAICompatibilityConfig } from '../utils/vertexAuth.js';
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_VERTEX_MODEL,
  PROVIDER_FALLBACK_MODELS,
  normalizeLLMModelName,
} from '../utils/llmConstants';

/**
 * Resolve the best available LLM configuration for a user.
 * Returns null when no credentials are configured anywhere.
 */
export async function getUserLLMConfig(
  userId: number
): Promise<LLMConfig | null> {
  try {
    for (const credential of await getActiveLLMAdminCredentials()) {
      const cfg = credential.config || {};
      const model = normalizeLLMModelName(credential.platform,
        String(cfg.selectedModel || cfg.model || ({ openai: DEFAULT_OPENAI_MODEL, gemini: DEFAULT_GEMINI_MODEL,
          vertex_ai: DEFAULT_VERTEX_MODEL, openrouter: DEFAULT_OPENROUTER_MODEL } as Record<string, string>)[credential.platform] || ''));
      if (!credential.apiKey || !model) continue;
      if (credential.platform === 'vertex_ai') {
        try {
          const compatibility = await createVertexOpenAICompatibilityConfig(credential.apiKey, {
            model, location: typeof cfg.location === 'string' ? cfg.location : undefined,
            projectId: typeof cfg.projectId === 'string' ? cfg.projectId : undefined,
          });
          return { apiKey: compatibility.accessToken, modelName: compatibility.model,
            provider: 'vertex_ai', baseURL: compatibility.baseURL };
        } catch {
          logger.warn({ userId, credentialId: credential.id }, '[LLMConfigService] Vertex AI authentication failed; trying next integration');
          continue;
        }
      }
      if (credential.platform === 'custom_ai') {
        const baseURL = String(cfg.baseUrl || cfg.baseURL || '');
        if (!baseURL) continue;
        return { apiKey: credential.apiKey, modelName: model, provider: 'custom_ai', baseURL };
      }
      logger.info({ userId, credentialId: credential.id, platform: credential.platform, model }, '[LLMConfigService] Selected LLM integration');
      return { apiKey: credential.apiKey, modelName: model, provider: credential.platform as LLMConfig['provider'] };
    }

    // ── 5. User's own OpenAI ──────────────────────────────────────
    const openaiCreds = await getActiveApiKeyWithMetadata(userId, 'openai');
    if (openaiCreds?.apiKey) {
      const model = openaiCreds.metadata?.model as string | undefined;
      if (!model) {
        logger.warn({ userId }, '[LLMConfigService] OpenAI configured but no model specified');
        return null;
      }
      return { apiKey: openaiCreds.apiKey, modelName: model, provider: 'openai' };
    }

    // ── 6. User's own OpenRouter ──────────────────────────────────
    const openrouterCreds = await getActiveApiKeyWithMetadata(userId, 'openrouter');
    if (openrouterCreds?.apiKey) {
      const model = normalizeLLMModelName('openrouter',
        (openrouterCreds.metadata?.selectedModel as string) ||
        (openrouterCreds.metadata?.model as string));
      if (!model) {
        logger.warn({ userId }, '[LLMConfigService] OpenRouter configured but no model specified');
        return null;
      }
      return { apiKey: openrouterCreds.apiKey, modelName: model, provider: 'openrouter' };
    }

    return null;
  } catch (error) {
    logger.error({ err: error }, '[LLMConfigService] Error fetching LLM config');
    return null;
  }
}

/**
 * Get an alternative LLM config by trying fallback models within the current provider.
 * Used for 503 / model-level errors where the API key is valid but the specific model is overloaded.
 *
 * @param currentConfig - The config that just failed
 * @param excludeModels - Models that have already been tried (and failed)
 * @returns A new LLMConfig with a different model, or null if no fallback available
 */
export function getModelFallbackConfig(
  currentConfig: LLMConfig,
  excludeModels: string[]
): LLMConfig | null {
  const provider = currentConfig.provider || 'openai';
  const fallbacks = PROVIDER_FALLBACK_MODELS[provider];

  if (!fallbacks || fallbacks.length === 0) {
    return null;
  }

  // Find first model not in the exclusion list
  const nextModel = fallbacks.find(
    (m) => !excludeModels.includes(m) && m !== currentConfig.modelName
  );

  if (!nextModel) {
    return null;
  }

  logger.info(
    { provider, failedModel: currentConfig.modelName, fallbackModel: nextModel },
    '[LLMConfigService] Using fallback model within same provider'
  );

  return {
    ...currentConfig,
    modelName: nextModel,
  };
}
