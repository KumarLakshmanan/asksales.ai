/**
 * Admin API Pricing Controller
 * Manage API cost configuration for LLM models, image/video generation, Apify, ZeroBounce
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  getAllApiPricing,
  getApiPricingByCategory,
  updateApiPricing,
  bulkUpdateApiPricing,
  insertApiPricing,
  deleteApiPricing,
  getApiPricingByKey,
  getImagePricingReference,
  getVideoPricingReference,
} from '../models/apiPricing/functions.js';
import { getModelPrice, getProviderModels } from '../services/GenAIPricingService.js';
import { getUsdToInrRate } from '../utils/currency.js';
import { parseApiPricingUpdate, parsePricingNumber } from '../utils/pricingValidation.js';
import { adminActorId as getAdminActorId } from '../utils/requestUserIds.js';

// GET /api/admin/api-pricing - Get all API pricing configs
export async function getApiPricing(req: Request, res: Response) {
  try {
    const { category } = req.query;
    const pricing = category
      ? await getApiPricingByCategory(category as string)
      : await getAllApiPricing();
    return res.json({ success: true, data: pricing });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get API pricing');
    return res.status(500).json({ error: 'Unable to retrieve API pricing.' });
  }
}

// PUT /api/admin/api-pricing/:id - Update single pricing record
export async function updateApiPricingSingle(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
    const update = parseApiPricingUpdate(req.body, false);
    const updated = await updateApiPricing(id, update as Parameters<typeof updateApiPricing>[1], getAdminActorId(req));
    if (!updated) return res.status(404).json({ error: 'Pricing entry not found' });

    return res.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof Error && error.message.includes('was not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof Error && /must|required|unsupported|At least/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, 'Failed to update API pricing');
    return res.status(500).json({ error: 'Unable to update API pricing.' });
  }
}

// PUT /api/admin/api-pricing/bulk - Bulk update pricing records
export async function bulkUpdateApiPricingHandler(req: Request, res: Response) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'A pricing update object is required' });
    }
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > 200) {
      return res.status(400).json({ error: 'Updates must contain between 1 and 200 records' });
    }
    const parsed = updates.map((update) => parseApiPricingUpdate(update, true));
    const ids = parsed.map((update) => update.id as number);
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'Pricing IDs must be unique' });
    await bulkUpdateApiPricing(parsed as Parameters<typeof bulkUpdateApiPricing>[0], getAdminActorId(req));
    return res.json({ success: true, message: `Updated ${parsed.length} records` });
  } catch (error) {
    if (error instanceof Error && error.message.includes('was not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof Error && /must|required|unsupported|At least/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, 'Failed to bulk update API pricing');
    return res.status(500).json({ error: 'Unable to bulk update API pricing.' });
  }
}

// POST /api/admin/api-pricing - Add a new pricing entry (e.g., new LLM model)
export async function createApiPricingEntry(req: Request, res: Response) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'A pricing object is required' });
    }
    const { category, pricingKey, name, promptCostPerMillion, completionCostPerMillion, creditsPerUnit, marginPercentage } = req.body;

    if (typeof category !== 'string' || !/^[a-z][a-z0-9_]{1,49}$/.test(category)
      || typeof pricingKey !== 'string' || !/^[a-zA-Z0-9_.:-]{2,150}$/.test(pricingKey)
      || typeof name !== 'string' || !name.trim() || name.trim().length > 255) {
      return res.status(400).json({ error: 'category, pricingKey, and name are required' });
    }

    const created = await insertApiPricing({
      category,
      pricingKey,
      name: name.trim(),
      promptCostPerMillion: promptCostPerMillion !== undefined ? parsePricingNumber(promptCostPerMillion, 'promptCostPerMillion') : null,
      completionCostPerMillion: completionCostPerMillion !== undefined ? parsePricingNumber(completionCostPerMillion, 'completionCostPerMillion') : null,
      creditsPerUnit: creditsPerUnit !== undefined ? parsePricingNumber(creditsPerUnit, 'creditsPerUnit') : null,
      marginPercentage: marginPercentage !== undefined ? parsePricingNumber(marginPercentage, 'marginPercentage') : null,
    }, getAdminActorId(req));

    return res.status(201).json({ success: true, data: created });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Pricing key already exists' });
    if (error instanceof Error && error.message.includes('must be between')) return res.status(400).json({ error: error.message });
    logger.error({ err: error }, 'Failed to create API pricing entry');
    return res.status(500).json({ error: 'Unable to create API pricing entry.' });
  }
}

// DELETE /api/admin/api-pricing/:id - Delete a pricing entry
export async function deleteApiPricingEntry(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

    const deleted = await deleteApiPricing(id, getAdminActorId(req));
    if (!deleted) return res.status(404).json({ error: 'Pricing entry not found' });
    return res.json({ success: true, message: 'Pricing entry deleted' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete API pricing entry');
    return res.status(500).json({ error: 'Unable to delete API pricing entry.' });
  }
}

// GET /api/admin/api-pricing/genai-model-price?model=gpt-4o - Get genai-prices for a specific model
export async function getGenaiModelPrice(req: Request, res: Response) {
  try {
    const model = req.query.model as string;
    if (!model) return res.status(400).json({ error: 'model query param is required' });

    const price = getModelPrice(model);
    if (!price) return res.json({ success: true, data: null });

    // Get LLM margin
    const marginRow = await getApiPricingByKey('llm_margin');
    const margin = marginRow?.isActive !== false && marginRow?.marginPercentage
      ? parseFloat(String(marginRow.marginPercentage))
      : 0;
    const multiplier = 1 + margin / 100;

    const usdToInrRate = getUsdToInrRate();
    return res.json({
      success: true,
      data: {
        model: price.id,
        name: price.name,
        inputPerMillion: parseFloat((price.inputPerMillion * usdToInrRate).toFixed(4)),
        outputPerMillion: parseFloat((price.outputPerMillion * usdToInrRate).toFixed(4)),
        margin,
        adjustedInputPerMillion: parseFloat((price.inputPerMillion * multiplier * usdToInrRate).toFixed(4)),
        adjustedOutputPerMillion: parseFloat((price.outputPerMillion * multiplier * usdToInrRate).toFixed(4)),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get genai model price');
    return res.status(500).json({ error: 'Unable to get model price.' });
  }
}

// Filter model lists to only show relevant models per provider
// Google Vertex AI includes Claude models — filter to Gemini/Gemma only
const PROVIDER_MODEL_FILTERS: Record<string, (id: string) => boolean> = {
  google: (id) => /^gemini|^gemma/i.test(id),
};

// GET /api/admin/api-pricing/genai-provider-models?provider=openai - Get all models for a provider
export async function getGenaiProviderModels(req: Request, res: Response) {
  try {
    const provider = req.query.provider as string;
    if (!provider) return res.status(400).json({ error: 'provider query param is required' });

    const allModels = getProviderModels(provider);
    const filter = PROVIDER_MODEL_FILTERS[provider];
    const filtered = filter ? allModels.filter(m => filter(m.id)) : allModels;
    const usdToInrRate = getUsdToInrRate();
    const models = filtered.map(m => ({
      ...m,
      inputPerMillion: parseFloat((m.inputPerMillion * usdToInrRate).toFixed(4)),
      outputPerMillion: parseFloat((m.outputPerMillion * usdToInrRate).toFixed(4)),
    }));
    return res.json({ success: true, data: { provider, models } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get genai provider models');
    return res.status(500).json({ error: 'Unable to get provider models.' });
  }
}

// GET /api/admin/api-pricing/image-pricing-reference - Get image model pricing with margin
export async function getImagePricingReferenceHandler(req: Request, res: Response) {
  try {
    const data = await getImagePricingReference();
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get image pricing reference');
    return res.status(500).json({ error: 'Unable to get image pricing reference.' });
  }
}

// GET /api/admin/api-pricing/video-pricing-reference - Get video model pricing with margin
export async function getVideoPricingReferenceHandler(req: Request, res: Response) {
  try {
    const data = await getVideoPricingReference();
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get video pricing reference');
    return res.status(500).json({ error: 'Unable to get video pricing reference.' });
  }
}
