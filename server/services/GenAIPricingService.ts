/**
 * GenAI Pricing Service
 * Wraps @pydantic/genai-prices to provide LLM model pricing data.
 * Used as the source of truth for LLM model costs instead of manual DB entries.
 *
 * Includes in-memory caching for model prices and context windows to avoid
 * repeated calls to the pricing library on hot paths.
 */

import { calcPrice, findProvider } from '@pydantic/genai-prices';
import { logger } from '../utils/logger.js';
import { LRUCache } from '../utils/lruCache';

export interface ModelPriceInfo {
  id: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
}


// ─── Caching ───────────────────────────────────────────────────────────────────

// Cache model prices for 1 hour (pricing data changes rarely)
const modelPriceCache = new LRUCache<ModelPriceInfo | null>({
  maxSize: 500,
  defaultTTL: 60 * 60 * 1000, // 1 hour
});

// Cache context windows for 24 hours (context windows are static per model)
const contextWindowCache = new LRUCache<number | null>({
  maxSize: 500,
  defaultTTL: 24 * 60 * 60 * 1000, // 24 hours
});

// Cache provider models for 1 hour
const providerModelsCache = new LRUCache<ModelPriceInfo[]>({
  maxSize: 100,
  defaultTTL: 60 * 60 * 1000, // 1 hour
});

/**
 * Clear all pricing caches. Call when admin updates pricing data.
 * Also clears the token counter cache since pricing changes may affect token counting.
 */
export function clearPricingCaches(): void {
  modelPriceCache.clear();
  contextWindowCache.clear();
  providerModelsCache.clear();
  // Also clear token counter cache if available
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearTokenCache } = require('../utils/tokenCounter');
    clearTokenCache();
  } catch {
    // Ignore - tokenCounter may not be available in all contexts
  }
  logger.info('[GenAIPricingService] All pricing caches cleared');
}

function buildModelLookupCandidates(modelId: string): string[] {
  const trimmed = modelId.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>([trimmed]);

  // Gemini APIs sometimes return IDs like "models/gemini-...".
  // Strip only this known-safe prefix for pricing lookup.
  if (trimmed.startsWith('models/')) {
    candidates.add(trimmed.slice('models/'.length));
  }

  // Accept "google/<model>" as alias for Gemini model IDs.
  if (trimmed.startsWith('google/')) {
    candidates.add(trimmed.slice('google/'.length));
  }

  return Array.from(candidates).filter(Boolean);
}

function lookupPriceByCandidates(
  modelId: string,
  usage: { input_tokens: number; output_tokens: number }
) {
  const candidates = buildModelLookupCandidates(modelId);
  for (const candidate of candidates) {
    const result = calcPrice(usage, candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * Get the cost per 1M tokens for a given model.
 * Uses calcPrice with 1M tokens to correctly handle tiered pricing.
 * Results are cached for 1 hour to avoid repeated library calls.
 */
export function getModelPrice(modelId: string): ModelPriceInfo | null {
  // Check cache first
  const cached = modelPriceCache.get(modelId);
  if (cached !== undefined) return cached;

  try {
    const result = lookupPriceByCandidates(
      modelId,
      { input_tokens: 1_000_000, output_tokens: 1_000_000 }
    );
    if (!result) {
      modelPriceCache.set(modelId, null);
      return null;
    }

    const priceInfo: ModelPriceInfo = {
      id: result.model.id,
      name: result.model.name || result.model.id,
      inputPerMillion: result.input_price,
      outputPerMillion: result.output_price,
    };

    modelPriceCache.set(modelId, priceInfo);
    return priceInfo;
  } catch (error) {
    logger.warn({ model: modelId, err: error }, 'Failed to get genai price for model');
    modelPriceCache.set(modelId, null);
    return null;
  }
}

/**
 * Get all models for a given provider.
 * Returns simplified pricing info for each model.
 * Results are cached for 1 hour.
 */
export function getProviderModels(providerId: string): ModelPriceInfo[] {
  // Check cache first
  const cached = providerModelsCache.get(providerId);
  if (cached !== undefined) return cached;

  try {
    const provider = findProvider({ providerId });
    if (!provider) {
      providerModelsCache.set(providerId, []);
      return [];
    }

    const models: ModelPriceInfo[] = [];
    for (const m of provider.models) {
      const result = calcPrice(
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        m.id
      );
      if (result) {
        models.push({
          id: m.id,
          name: m.name || m.id,
          inputPerMillion: result.input_price,
          outputPerMillion: result.output_price,
        });
      }
    }
    providerModelsCache.set(providerId, models);
    return models;
  } catch (error) {
    logger.warn({ providerId, err: error }, 'Failed to get provider models');
    providerModelsCache.set(providerId, []);
    return [];
  }
}

/**
 * Retrieve the context window size (in tokens) for a given model from the
 * @pydantic/genai-prices dataset. Falls back to null if unknown.
 * This allows other code to derive message limits dynamically instead of
 * using hardcoded constants.
 *
 * Results are cached for 24 hours to avoid repeated library calls.
 */
export function getModelContextWindow(modelId: string): number | null {
  // Check cache first
  const cached = contextWindowCache.get(modelId);
  if (cached !== undefined) return cached;

  try {
    for (const candidate of buildModelLookupCandidates(modelId)) {
      const provider = findProvider({ modelId: candidate });
      if (!provider || !provider.models) continue;
      const match = provider.models.find(m => m.id === candidate || m.name === candidate);
      if (match) {
        const window = match.context_window ?? null;
        contextWindowCache.set(modelId, window);
        return window;
      }
    }
    contextWindowCache.set(modelId, null);
    return null;
  } catch (err) {
    logger.warn({ modelId, err }, '[GenAIPricingService] failed to get context window');
    contextWindowCache.set(modelId, null);
    return null;
  }
}

