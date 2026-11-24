import { EMBEDDING_PROVIDERS, isEmbeddingProvider, isEmbeddingModel } from '../services/embeddings/BaseEmbeddingProvider.js';
/**
 * Admin Embedding Settings Controller
 * Admin endpoints for configuring embedding providers and defaults.
 */

import { Request, Response } from 'express';
import { embeddingService, EMBEDDING_MODELS } from '../services/embeddings/index';
import { logger } from '../utils/logger.js';

/**
 * GET /api/embeddings/admin/settings
 * Get current embedding configuration.
 */
export async function getEmbeddingSettings(_req: Request, res: Response) {
  try {
    const settings = await embeddingService.getSettings();
    return res.json({
      success: true,
      data: {
        settings: settings ?? {
          defaultProvider: null,
          defaultModel: null,
          enabledProviders: EMBEDDING_PROVIDERS,
        },
        availableModels: EMBEDDING_MODELS,
        resolved: await embeddingService.resolveProviderAndModel().catch(() => null),
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminEmbeddings] getEmbeddingSettings failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * PUT /api/embeddings/admin/settings
 * Update embedding default provider/model and enabled providers.
 * Body: { defaultProvider?, defaultModel?, enabledProviders? }
 */
export async function updateEmbeddingSettings(req: Request, res: Response) {
  try {
    const existing = await embeddingService.getSettings();
    const defaultProvider = req.body.defaultProvider ?? existing?.defaultProvider ?? 'openai';
    const defaultModel = req.body.defaultModel
      ?? (existing?.defaultProvider === defaultProvider ? existing.defaultModel : undefined)
      ?? (isEmbeddingProvider(defaultProvider) ? Object.keys(EMBEDDING_MODELS[defaultProvider])[0] : undefined);
    const enabledProviders = req.body.enabledProviders ?? existing?.enabledProviders ?? EMBEDDING_PROVIDERS;
    if (!isEmbeddingProvider(defaultProvider)) return res.status(400).json({ error: 'Choose OpenAI, Gemini, or OpenRouter.' });
    if (!isEmbeddingModel(defaultProvider, defaultModel)) return res.status(400).json({ error: 'Choose a supported embedding model for the selected provider.' });
    if (!Array.isArray(enabledProviders) || enabledProviders.some(provider => !isEmbeddingProvider(provider))
      || new Set(enabledProviders).size !== enabledProviders.length) {
      return res.status(400).json({ error: 'enabledProviders must contain unique supported embedding providers.' });
    }
    if (enabledProviders.length && !enabledProviders.includes(defaultProvider)) {
      return res.status(400).json({ error: 'The default embedding provider must be enabled.' });
    }

    const updated = await embeddingService.updateSettings({ defaultProvider, defaultModel, enabledProviders });
    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminEmbeddings] updateEmbeddingSettings failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * POST /api/embeddings/admin/test
 * Test an embedding provider with a sample text.
 * Body: { provider, model? }
 */
export async function testEmbeddingProvider(req: Request, res: Response) {
  try {
    const { provider, model } = req.body;
    if (!isEmbeddingProvider(provider) || (model !== undefined && !isEmbeddingModel(provider, model))) {
      return res.status(400).json({ error: 'A supported embedding provider and model are required.' });
    }

    const embeddingProvider = await embeddingService.createProvider(provider);
    const credential = await embeddingService.getCredential(provider);
    const configuredModel = credential?.platform.endsWith('_embedding') ? credential.config?.model : undefined;
    const testModel = model ?? configuredModel ?? Object.keys(EMBEDDING_MODELS[provider])[0];

    if (!isEmbeddingModel(provider, testModel)) {
      return res.status(400).json({ error: `Choose a supported embedding model for "${provider}".` });
    }

    const result = await embeddingProvider.generateEmbeddings({ text: 'This is a test embedding.', model: testModel });
    return res.json({
      success: result.success,
      data: {
        dimensions: result.dimensions,
        model: result.model,
        error: result.error,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminEmbeddings] testEmbeddingProvider failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}
