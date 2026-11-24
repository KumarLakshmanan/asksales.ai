import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { LLMProviderFactory } from '../services/agents/LLMProviderFactory.js';
import { resolveMediaProviderSelection, isMediaProviderConfigured, getImageModelCapabilities } from '../services/media/MediaProviderRegistry.js';
import { getLLMModelCost, getImageCostWithMarginUSD, getVideoCostWithMarginUSD } from '../models/apiPricing/functions.js';
import { getUsageRate, getCreditCost } from '../models/creditPricing/functions.js';
import { meteredCreditsFromUsd } from '../utils/currency.js';
import { getModelPrice } from '../services/GenAIPricingService.js';

/** Ratios and resolutions the configured image model accepts, so the UI offers only those. */
export async function getImageGenerationOptions(req: Request, res: Response) {
  const userId = Number(businessOwnerUserId(req));
  try {
    const selection = await resolveMediaProviderSelection('image', userId);
    const capabilities = await getImageModelCapabilities(selection);
    return res.json({ ...selection, aspectRatios: capabilities.aspectRatios ?? null, resolutions: capabilities.resolutions ?? null });
  } catch {
    return res.status(503).json({ error: 'Image model options are unavailable. Check the image provider settings.' });
  }
}

export async function getContentEstimate(req: Request, res: Response) {
  const userId = Number(businessOwnerUserId(req));
  try {
    const duration = [4, 6, 8].includes(Number(req.query.duration)) ? Number(req.query.duration) : 8;
    const imageSize = ['1K', '2K', '4K'].includes(String(req.query.imageSize)) ? String(req.query.imageSize) as '1K' | '2K' | '4K' : '1K';
    const resolution = req.query.resolution === '480p' ? '480p' : '720p';
    const usageRate = await getUsageRate();
    const credits = (usd: number) => meteredCreditsFromUsd(usd, usageRate);
    const text = await (async () => {
      try {
        const model = await LLMProviderFactory.getDefaultModelForUser(userId);
        if (!model?.trim()) return { ready: false, credits: null, basis: 'No configured text provider could be resolved' };
        if (!getModelPrice(model)) return { model, ready: true, credits: null, basis: 'Configured model has no verified price estimate' };
        const price = await getLLMModelCost(model);
        return { model, ready: true, credits: credits((4000 * price.prompt + 2000 * price.completion) / 1_000_000), basis: '4,000 input + 2,000 output tokens; brand context, retries and fallback providers can change the total' };
      } catch { return { ready: false, credits: null, basis: 'No configured text provider could be resolved' }; }
    })();
    const media = async (kind: 'image' | 'video') => {
      const selected = await resolveMediaProviderSelection(kind, userId);
      const ready = await isMediaProviderConfigured(kind, selected.provider);
      if (selected.provider !== 'google') return { ...selected, ready, credits: null, basis: 'Provider usage pricing; estimate unavailable' };
      if (kind === 'video' && resolution === '480p') return { ...selected, ready, credits: null, basis: '480p pricing is not available for the configured video model' };
      const price = kind === 'image' ? await getImageCostWithMarginUSD(selected.model, { resolution: imageSize }) : await getVideoCostWithMarginUSD(selected.model, duration, '720p_1080p');
      return { ...selected, ready, credits: credits(price.totalCostUSD), basis: kind === 'image' ? `One ${imageSize} image` : `One ${duration}-second, ${resolution} video` };
    };
    const [image, video] = await Promise.all([media('image'), media('video')]);
    const sms = { creditsPerMessage: await getCreditCost('outreach_sms'), providerCost: null, basis: 'Configured AskSales outreach fee per message. Carrier/provider charges depend on destination, sender, encoding and final segments and are not quoted here.' };
    return res.json({ text, image, video, sms, estimated: true });
  } catch { return res.status(503).json({ error: 'Credit estimates are unavailable. Check provider settings and pricing before generation.' }); }
}
