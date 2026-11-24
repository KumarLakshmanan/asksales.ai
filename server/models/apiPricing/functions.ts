/**
 * API Pricing Functions
 * Query functions for admin-configured API pricing
 */

 
import { eq, asc } from "drizzle-orm";
import { db } from "../db.js";
import { apiPricingTable, type ApiPricingRecord, type InsertApiPricing } from "./schema.js";
import { getModelPrice, clearPricingCaches } from "../../services/GenAIPricingService.js";
import { notifyAllAdmins } from "../adminNotifications/functions.js";
import { logger } from "../../utils/logger.js";
import { getUsdToInrRate } from "../../utils/currency.js";
import { pricingAuditTable } from '../pricingAudit/schema.js';
import { pricingAuditValues } from '../pricingAudit/functions.js';
import { getImageBaseCostUSD, getImageResolutionTier, getVideoBaseCostUSD, GEMINI_IMAGE_PRICING, GEMINI_VIDEO_PRICING, DEFAULT_VIDEO_DURATION_SECONDS, type ImageResolutionTier, type VideoResolutionTier } from "../../utils/geminiMediaPricing.js";

// ── In-memory cache (TTL-based) ──────────────────────────────────────────────
let cache: ApiPricingRecord[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

// Track models that have already triggered a pricing fallback notification (dedup within process lifetime)
const notifiedFallbackModels = new Set<string>();

async function getCachedPricing(): Promise<ApiPricingRecord[]> {
  if (cache && Date.now() < cacheExpiry) return cache;
  const result = await db.select().from(apiPricingTable).orderBy(asc(apiPricingTable.sortOrder));
  cache = Array.isArray(result) ? result : [];
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cache;
}

export function invalidatePricingCache(): void {
  cache = null;
  cacheExpiry = 0;
  // Also clear GenAIPricingService caches since pricing data changed
  clearPricingCaches();
}

// ── Query Functions ──────────────────────────────────────────────────────────

/** Get all pricing records */
export async function getAllApiPricing(): Promise<ApiPricingRecord[]> {
  return getCachedPricing();
}

/** Get pricing by category */
export async function getApiPricingByCategory(category: string): Promise<ApiPricingRecord[]> {
  const all = await getCachedPricing();
  return all.filter(p => p.category === category);
}

/** Get a single pricing record by key */
export async function getApiPricingByKey(pricingKey: string): Promise<ApiPricingRecord | undefined> {
  const all = await getCachedPricing();
  return all.find(p => p.pricingKey === pricingKey);
}

/**
 * Get LLM model cost per 1M tokens using @pydantic/genai-prices + admin margin.
 * Returns { prompt, completion } in USD per 1M tokens with margin applied.
 * Falls back to a default cost if the model is not found in genai-prices.
 */
// Default cost per 1M tokens (USD) for models not found in genai-prices
const DEFAULT_LLM_COST = { prompt: 2.50, completion: 10.0 };

export async function getLLMModelCost(model: string): Promise<{ prompt: number; completion: number }> {
  const genaiPrice = getModelPrice(model);
  const usingFallback = !genaiPrice;
  const baseCost = genaiPrice
    ? { prompt: genaiPrice.inputPerMillion, completion: genaiPrice.outputPerMillion }
    : DEFAULT_LLM_COST;

  // Notify admins when a model is not found in genai-prices (once per model per process)
  if (usingFallback && !notifiedFallbackModels.has(`llm:${model}`)) {
    notifiedFallbackModels.add(`llm:${model}`);
    notifyAllAdmins({
      title: `Unknown LLM model pricing: ${model}`,
      message: `Model "${model}" was not found in the pricing database. Default pricing was applied (prompt: $${DEFAULT_LLM_COST.prompt}/1M, completion: $${DEFAULT_LLM_COST.completion}/1M). Please add proper pricing for this model.`,
      type: "warning",
      category: "pricing",
    }).catch((err) => logger.error({ err }, "[ApiPricing] Failed to send fallback pricing notification"));
  }

  const marginRow = await getApiPricingByKey('llm_margin');
  const marginPct = marginRow?.isActive !== false && marginRow?.marginPercentage
    ? parseFloat(String(marginRow.marginPercentage))
    : 0;
  const multiplier = 1 + marginPct / 100;

  return {
    prompt: baseCost.prompt * multiplier,
    completion: baseCost.completion * multiplier,
  };
}

/**
 * Get original LLM model cost (what the API provider charges) per 1M tokens.
 * Returns raw genai-prices data without margin.
 * Falls back to a default cost if the model is not found in genai-prices.
 */
export async function getOriginalLLMModelCost(model: string): Promise<{ prompt: number; completion: number }> {
  const genaiPrice = getModelPrice(model);
  return genaiPrice
    ? { prompt: genaiPrice.inputPerMillion, completion: genaiPrice.outputPerMillion }
    : DEFAULT_LLM_COST;
}

// ── Image Generation (margin-based, like LLM) ──────────────────────────────

/** Get image generation margin percentage (admin-configured) */
export async function getImageMarginPercentage(): Promise<number> {
  const entry = await getApiPricingByKey('image_margin');
  if (!entry || !entry.isActive) return 0; // default 0% margin
  return parseFloat(String(entry.marginPercentage)) || 0;
}

/**
 * Get the cost in USD for generating one image, with admin margin applied.
 * Uses actual Google model pricing from constants + admin margin %.
 * @param modelId - The image model ID
 * @param opts - Optional resolution or dimensions for tier-based pricing
 */
export async function getImageCostWithMarginUSD(
  modelId: string,
  opts?: { resolution?: ImageResolutionTier; width?: number; height?: number }
): Promise<{ baseCostUSD: number; marginPct: number; totalCostUSD: number; resolution?: ImageResolutionTier;
  source:'catalog'|'admin_override';sourceReference:string }> {
  const override=(await getCachedPricing()).find(row=>row.isActive&&row.category==='image'&&row.provider==='gemini'
    && row.metadata?.model===modelId&&row.metadata?.verified===true);
  const tier=opts?.resolution || (opts?.width&&opts?.height?getImageResolutionTier(opts.width,opts.height):undefined);
  const tierPrices=override?.metadata?.resolutionTiers as Record<string,unknown>|undefined;
  const overrideValue=(tier&&tierPrices?.[tier])??override?.metadata?.unitUsd;
  const overridePrice=Number(overrideValue);
  const hasOverride=Boolean(override&&overrideValue!==null&&overrideValue!==undefined&&Number.isFinite(overridePrice)&&overridePrice>=0);
  const baseCostUSD=hasOverride?overridePrice:getImageBaseCostUSD(modelId,opts);
  const marginPct = await getImageMarginPercentage();
  const multiplier = 1 + marginPct / 100;
  return { baseCostUSD, marginPct, totalCostUSD: baseCostUSD * multiplier, resolution: opts?.resolution,
    source:hasOverride?'admin_override':'catalog',sourceReference:hasOverride?`api_pricing:${override!.id}:${override!.updatedAt.toISOString()}`:'geminiMediaPricing@2025-06' };
}

// ── Video Generation (margin-based, like LLM) ──────────────────────────────

/** Get video generation margin percentage (admin-configured) */
export async function getVideoMarginPercentage(): Promise<number> {
  const entry = await getApiPricingByKey('video_margin');
  if (!entry || !entry.isActive) return 0; // default 0% margin
  return parseFloat(String(entry.marginPercentage)) || 0;
}

/**
 * Get the cost in USD for generating a video, with admin margin applied.
 * Uses actual Google model pricing (per-second) from constants + admin margin %.
 * @param modelId - The video model ID
 * @param durationSeconds - Duration of the generated video in seconds
 * @param resolution - Optional resolution tier for tier-based pricing
 */
export async function getVideoCostWithMarginUSD(
  modelId: string,
  durationSeconds?: number,
  resolution?: VideoResolutionTier
): Promise<{ baseCostUSD: number; marginPct: number; totalCostUSD: number; durationSeconds: number; resolution?: VideoResolutionTier;
  source:'catalog'|'admin_override';sourceReference:string }> {
  const duration = durationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS;
  const override=(await getCachedPricing()).find(row=>row.isActive&&row.category==='video'&&row.provider==='gemini'
    && row.metadata?.model===modelId&&row.metadata?.verified===true);
  const tierPrices=override?.metadata?.resolutionTiers as Record<string,unknown>|undefined;
  const overrideValue=(resolution&&tierPrices?.[resolution])??override?.metadata?.unitUsd;
  const overridePrice=Number(overrideValue);
  const hasOverride=Boolean(override&&overrideValue!==null&&overrideValue!==undefined&&Number.isFinite(overridePrice)&&overridePrice>=0);
  const baseCostUSD=hasOverride?overridePrice*duration:getVideoBaseCostUSD(modelId,duration,resolution);
  const marginPct = await getVideoMarginPercentage();
  const multiplier = 1 + marginPct / 100;
  return { baseCostUSD, marginPct, totalCostUSD: baseCostUSD * multiplier, durationSeconds: duration, resolution,
    source:hasOverride?'admin_override':'catalog',sourceReference:hasOverride?`api_pricing:${override!.id}:${override!.updatedAt.toISOString()}`:'geminiMediaPricing@2025-06' };
}

/**
 * Get all image model pricing with resolution tiers (for admin reference display).
 * Returns model prices in INR using the configured accounting rate, with margin applied per resolution tier.
 */
export async function getImagePricingReference(): Promise<Array<{
  modelId: string; name: string; marginPct: number;
  resolutionTiers: Array<{ resolution: string; label: string; basePriceINR: number; chargedPriceINR: number }>;
}>> {
  const marginPct = await getImageMarginPercentage();
  const multiplier = 1 + marginPct / 100;
  const usdToInrRate = getUsdToInrRate();
  return GEMINI_IMAGE_PRICING.map(m => ({
    modelId: m.modelId,
    name: m.name,
    marginPct,
    resolutionTiers: m.resolutionTiers.map(t => ({
      resolution: t.resolution,
      label: t.label,
      basePriceINR: parseFloat((t.priceUSD * usdToInrRate).toFixed(4)),
      chargedPriceINR: parseFloat((t.priceUSD * multiplier * usdToInrRate).toFixed(4)),
    })),
  }));
}

/**
 * Get all video model pricing with resolution tiers (for admin reference display).
 * Returns model prices in INR using the configured accounting rate, with margin applied per resolution tier.
 */
export async function getVideoPricingReference(): Promise<Array<{
  modelId: string; name: string; marginPct: number;
  resolutionTiers: Array<{ resolution: string; label: string; basePricePerSecondINR: number; chargedPricePerSecondINR: number }>;
}>> {
  const marginPct = await getVideoMarginPercentage();
  const multiplier = 1 + marginPct / 100;
  const usdToInrRate = getUsdToInrRate();
  return GEMINI_VIDEO_PRICING.map(m => ({
    modelId: m.modelId,
    name: m.name,
    marginPct,
    resolutionTiers: m.resolutionTiers.map(t => ({
      resolution: t.resolution,
      label: t.label,
      basePricePerSecondINR: parseFloat((t.priceUSD * usdToInrRate).toFixed(4)),
      chargedPricePerSecondINR: parseFloat((t.priceUSD * multiplier * usdToInrRate).toFixed(4)),
    })),
  }));
}

// ── Legacy fixed-credits functions (kept for backward compatibility) ────────

/** Get Apify margin percentage */
export async function getApifyMarginPercentage(): Promise<number> {
  const entry = await getApiPricingByKey('apify_margin');
  if (!entry || !entry.isActive) return 20; // default 20%
  const configured = Number(entry.marginPercentage);
  return Number.isFinite(configured) ? configured : 20;
}

/** Get ZeroBounce credits per email */
export async function getZerobounceCreditsPerEmail(): Promise<number> {
  const entry = await getApiPricingByKey('zerobounce_validation');
  if (!entry || !entry.isActive) return 1; // default 1 credit
  return parseFloat(entry.creditsPerUnit as string) || 1;
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────

/** Update a single pricing record */
export async function updateApiPricing(id: number, data: Partial<InsertApiPricing>, adminId?: number): Promise<ApiPricingRecord | undefined> {
  const updated = await db.transaction(async (tx: typeof db) => {
    const [before] = await tx.select().from(apiPricingTable).where(eq(apiPricingTable.id, id)).limit(1);
    if (!before) return undefined;
    const [changed] = await tx
      .update(apiPricingTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(apiPricingTable.id, id))
      .returning();
    await tx.insert(pricingAuditTable).values(pricingAuditValues({
      domain: 'api_pricing', recordId: id, pricingKey: before.pricingKey, action: 'update', adminId,
      beforeValue: before, afterValue: changed,
    }));
    return changed;
  });
  invalidatePricingCache();
  return updated;
}

/** Bulk update pricing records (wrapped in a transaction for atomicity) */
export async function bulkUpdateApiPricing(updates: Array<{
  id: number;
  promptCostPerMillion?: string;
  completionCostPerMillion?: string;
  creditsPerUnit?: string;
  marginPercentage?: string;
  isActive?: boolean;
  originalPromptCostPerMillion?: string;
  originalCompletionCostPerMillion?: string;
  originalCreditsPerUnit?: string;
}>, adminId?: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    for (const update of updates) {
      const [before] = await tx.select().from(apiPricingTable).where(eq(apiPricingTable.id, update.id)).limit(1);
      if (!before) throw new Error(`Pricing record ${update.id} was not found`);
      const setData: Record<string, unknown> = { updatedAt: new Date() };
      if (update.promptCostPerMillion !== undefined) setData.promptCostPerMillion = update.promptCostPerMillion;
      if (update.completionCostPerMillion !== undefined) setData.completionCostPerMillion = update.completionCostPerMillion;
      if (update.creditsPerUnit !== undefined) setData.creditsPerUnit = update.creditsPerUnit;
      if (update.marginPercentage !== undefined) setData.marginPercentage = update.marginPercentage;
      if (update.isActive !== undefined) setData.isActive = update.isActive;
      if (update.originalPromptCostPerMillion !== undefined) setData.originalPromptCostPerMillion = update.originalPromptCostPerMillion;
      if (update.originalCompletionCostPerMillion !== undefined) setData.originalCompletionCostPerMillion = update.originalCompletionCostPerMillion;
      if (update.originalCreditsPerUnit !== undefined) setData.originalCreditsPerUnit = update.originalCreditsPerUnit;
      const changed = await tx
        .update(apiPricingTable)
        .set(setData)
        .where(eq(apiPricingTable.id, update.id))
        .returning();
      if (changed.length !== 1) throw new Error(`Pricing record ${update.id} was not found`);
      await tx.insert(pricingAuditTable).values(pricingAuditValues({
        domain: 'api_pricing', recordId: update.id, pricingKey: before.pricingKey, action: 'update', adminId,
        beforeValue: before, afterValue: changed[0],
      }));
    }
  });
  invalidatePricingCache();
}

/** Insert a new pricing entry (for adding new models) */
export async function insertApiPricing(data: InsertApiPricing, adminId?: number): Promise<ApiPricingRecord> {
  const created = await db.transaction(async (tx: typeof db) => {
    const [entry] = await tx.insert(apiPricingTable).values(data).returning();
    await tx.insert(pricingAuditTable).values(pricingAuditValues({
      domain: 'api_pricing', recordId: entry.id, pricingKey: entry.pricingKey, action: 'create', adminId,
      afterValue: entry,
    }));
    return entry;
  });
  invalidatePricingCache();
  return created;
}

/** Delete a pricing entry */
export async function deleteApiPricing(id: number, adminId?: number): Promise<boolean> {
  const deleted = await db.transaction(async (tx: typeof db) => {
    const [before] = await tx.select().from(apiPricingTable).where(eq(apiPricingTable.id, id)).limit(1);
    if (!before) return false;
    await tx.delete(apiPricingTable).where(eq(apiPricingTable.id, id));
    await tx.insert(pricingAuditTable).values(pricingAuditValues({
      domain: 'api_pricing', recordId: id, pricingKey: before.pricingKey, action: 'delete', adminId,
      beforeValue: before,
    }));
    return true;
  });
  invalidatePricingCache();
  return deleted;
}

// ── Embedding API (margin-based, like LLM) ─────────────────────────────────

/** Base cost per 1M input tokens for embedding models (official published pricing) */
const EMBEDDING_BASE_COSTS: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'openai/text-embedding-3-small': 0.02,
  'openai/text-embedding-3-large': 0.13,
  'google/gemini-embedding-001': 0.15,
  'gemini-embedding-001': 0.15,
  'text-embedding-004': 0.025,
  'text-embedding-005': 0.025,
  'gemini-embedding-exp-03-07': 0.0, // free preview
};
const DEFAULT_EMBEDDING_COST_PER_MILLION = 0.05;

/**
 * Get embedding model cost per 1M input tokens with admin margin applied.
 */
export async function getEmbeddingModelCost(model: string): Promise<{ inputPerMillion: number; inputPerMillionOriginal: number }> {
  const knownModel = model in EMBEDDING_BASE_COSTS;
  const baseCost = knownModel ? EMBEDDING_BASE_COSTS[model] : DEFAULT_EMBEDDING_COST_PER_MILLION;

  // Notify admins when an embedding model is not in the known list (once per model per process)
  if (!knownModel && !notifiedFallbackModels.has(`emb:${model}`)) {
    notifiedFallbackModels.add(`emb:${model}`);
    notifyAllAdmins({
      title: `Unknown embedding model pricing: ${model}`,
      message: `Embedding model "${model}" is not in the pricing list. Default pricing was applied ($${DEFAULT_EMBEDDING_COST_PER_MILLION}/1M tokens). Please add proper pricing for this model.`,
      type: "warning",
      category: "pricing",
    }).catch((err) => logger.error({ err }, "[ApiPricing] Failed to send embedding fallback pricing notification"));
  }

  const marginRow = await getApiPricingByKey('embedding_margin');
  const marginPct = marginRow?.isActive !== false && marginRow?.marginPercentage
    ? parseFloat(String(marginRow.marginPercentage))
    : 0;
  const multiplier = 1 + marginPct / 100;
  return {
    inputPerMillion: baseCost * multiplier,
    inputPerMillionOriginal: baseCost,
  };
}
