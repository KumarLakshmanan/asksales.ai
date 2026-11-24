import { saveBase64File } from '../utils/fileStorage.js';
import { getImageDimensionsFromBase64 } from '../utils/geminiMediaPricing.js';
import { getAdminOpenRouterKey, updateAdminCredentialUsage } from '../services/adminCredentialsService.js';
import { createGeminiUsage } from '../models/geminiUsages/functions.js';
import { getImageMarginPercentage } from '../models/apiPricing/functions.js';
import { getRechargeRate, getUsageRate } from '../models/creditPricing/functions.js';
import { getUsdToInrRate, meteredCreditsFromUsd } from '../utils/currency.js';
import { logger } from '../utils/logger.js';
import type { ImageGenerationRequest, ImageGenerationResult } from './imageGenerationWorker.js';

interface OpenRouterImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  error?: { message?: string } | string;
}

function dataUrl(base64Data: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64Data}`;
}

export class OpenRouterImageGenerationWorker {
  constructor(
    private readonly userId: number | undefined,
    private readonly threadId: number | undefined,
    private readonly modelName: string,
  ) {}

  private async credential() {
    const credential = await getAdminOpenRouterKey();
    if (credential) {
      await updateAdminCredentialUsage(credential.id);
      return credential;
    }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) return { id: 0, apiKey, config: {} as Record<string, unknown> };
    throw new Error('OpenRouter is not configured. Ask an administrator to add an OpenRouter API key.');
  }

  private async request(payload: Record<string, unknown>): Promise<OpenRouterImageResponse> {
    await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'openrouter','image');
    const credential = await this.credential();
    const baseUrl = 'https://openrouter.ai/api/v1';
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${baseUrl}/images`, {
        method: 'POST',
        signal: AbortSignal.timeout(180_000),
        headers: {
          Authorization: `Bearer ${credential.apiKey}`,
          'Content-Type': 'application/json',
          ...(process.env.APP_URL ? { 'HTTP-Referer': process.env.APP_URL } : {}),
          'X-Title': 'SalesMarketing Content Studio',
        },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let parsed: OpenRouterImageResponse = {};
      try { parsed = text ? JSON.parse(text) as OpenRouterImageResponse : {}; } catch { /* handled below */ }
      if (response.ok) return parsed;
      const providerMessage = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      lastError = new Error(providerMessage || `OpenRouter image generation failed (${response.status})`);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    }
    throw lastError || new Error('OpenRouter image generation failed');
  }

  private async trackUsage(prompt: string, result: ImageGenerationResult, usage?: OpenRouterImageResponse['usage']) {
    try {
      const baseCostUSD = Number(usage?.cost) > 0 ? Number(usage?.cost) : 0;
      const marginPct = await getImageMarginPercentage();
      const totalCostUSD = baseCostUSD * (1 + marginPct / 100);
      // rechargeRate values the credits (purchase rate); usageRate converts provider cost into credits.
      const [rechargeRate, usageRate] = await Promise.all([getRechargeRate(), getUsageRate()]);
      const totalCredits = meteredCreditsFromUsd(totalCostUSD, usageRate);
      const usageRecord = await createGeminiUsage({
        userId: this.userId ?? null,
        operationType: 'image_generation',
        model: this.modelName.slice(0, 100),
        prompt: prompt.slice(0, 500),
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        imagesGenerated: 1,
        costCents: (baseCostUSD * 100).toFixed(8),
        threadId: this.threadId ?? null,
        service: 'openrouter_image_worker',
        purpose: 'image_generation',
        status: baseCostUSD>0?'success':'partial',
        metadata: { provider: 'openrouter', model: this.modelName, baseCostUSD, marginPct, totalCostUSD, totalCredits },
      });
      if (this.userId && totalCredits > 0) {
        const { creditService } = await import('../services/CreditService.js');
        const deduction = await creditService.deductOnceForResource({
          userId: this.userId,
          eventKey: 'api_openrouter',
          description: `OpenRouter image generation (${this.modelName})`,
          service: 'OpenRouterImageGenerationWorker',
          apiProvider: 'openrouter',
          apiCostCents: baseCostUSD * 100,
          overrideAmount: totalCredits,
          // The media was generated: bill it in full even on a low balance.
          allowOverdraft: true,
          referenceType: 'media_generation',
          referenceId: `openrouter-image:${result.fileName || result.imageUrl}`,
          insights:{attemptId:`gemini_usages:${usageRecord.id}`,operationId:`gemini_usages:${usageRecord.id}`,process:'media',
            conversation:this.threadId?{kind:'workspace',id:this.threadId}:undefined},
          pricingSnapshot:{version:1,capturedAt:new Date().toISOString(),source:'provider_reported',sourceReference:'openrouter_usage_cost',
            model:this.modelName,provider:'openrouter',providerCostUsd:baseCostUSD.toFixed(8),chargedCostUsd:totalCostUSD.toFixed(8),
            marginPercentage:marginPct,usdToInr:getUsdToInrRate(),creditsPerInr:rechargeRate,usageCreditsPerInr:usageRate,minimumCredits:1,rounding:'ceil_whole'},
          metadata: { provider: 'openrouter', model: this.modelName, baseCostUSD, marginPct, totalCostUSD },
        });
        if(!deduction.success)throw new Error(deduction.error||'Image usage charge was not completed');
      }
    } catch (error) {
      logger.error({ err: error }, '[OpenRouterImageGenerationWorker] Failed to track usage');
    }
  }

  private async generateWithReferences(
    prompt: string,
    references: Array<{ base64Data: string; mimeType: string }>,
    imageConfig: Record<string, unknown> = {},
  ): Promise<ImageGenerationResult> {
    try {
      const { loadApprovedBrandLogoReference, buildBrandReferencePrompt } = await import('../services/content/BrandMediaComposer.js');
      const logo = await loadApprovedBrandLogoReference(this.userId, imageConfig.brandLogoUrl as string | null | undefined);
      const effectivePrompt = logo ? buildBrandReferencePrompt(prompt, 'image') : prompt;
      const allReferences = [...references, ...(logo ? [{ base64Data: logo.base64Data, mimeType: logo.mimeType }] : [])].slice(0, 14);
      const negativePrompt = typeof imageConfig.negativePrompt === 'string' && imageConfig.negativePrompt.trim()
        ? `\n\nAvoid: ${imageConfig.negativePrompt.trim()}` : '';
      const payload: Record<string, unknown> = {
        model: this.modelName,
        prompt: `${effectivePrompt}${negativePrompt}`.slice(0, 4000),
        n: 1,
      };
      if (typeof imageConfig.aspectRatio === 'string') payload.aspect_ratio = imageConfig.aspectRatio;
      if (typeof imageConfig.imageSize === 'string') payload.resolution = imageConfig.imageSize;
      if (Number.isInteger(imageConfig.seed)) payload.seed = imageConfig.seed;
      if (allReferences.length > 0) {
        payload.input_references = allReferences.map((image) => ({
          type: 'image_url', image_url: { url: dataUrl(image.base64Data, image.mimeType) },
        }));
      }
      const response = await this.request(payload);
      const generated = response.data?.find((entry) => typeof entry.b64_json === 'string' && entry.b64_json.length > 0);
      if (!generated?.b64_json) throw new Error('OpenRouter returned no generated image');
      const mimeType = generated.media_type || 'image/png';
      const saved = await saveBase64File(generated.b64_json, mimeType, 'images', 'generated', this.userId);
      const result: ImageGenerationResult = {
        success: true,
        imageData: generated.b64_json,
        imageUrl: saved.url,
        mimeType,
        fileName: saved.fileName,
        imageDimensions: getImageDimensionsFromBase64(generated.b64_json, mimeType),
        brandReference: logo ? { logoUrl: logo.logoUrl, suppliedToModel: true } : undefined,
        usageMetadata: {
          promptTokens: response.usage?.prompt_tokens,
          candidatesTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens,
        },
      };
      await this.trackUsage(prompt, result, response.usage);
      return result;
    } catch (error) {
      logger.error({ err: error, model: this.modelName }, '[OpenRouterImageGenerationWorker] Generation failed');
      return { success: false, error: error instanceof Error ? error.message : 'OpenRouter image generation failed' };
    }
  }

  generateFromText(prompt: string, imageConfig?: Record<string, unknown>) {
    return this.generateWithReferences(prompt, [], imageConfig);
  }

  generateFromImage(prompt: string, imageBase64: string, imageMimeType = 'image/jpeg', imageConfig?: Record<string, unknown>) {
    return this.generateWithReferences(prompt, [{ base64Data: imageBase64, mimeType: imageMimeType }], imageConfig);
  }

  generateFromMultipleImages(prompt: string, images: Array<{ base64Data: string; mimeType: string }>, imageConfig?: Record<string, unknown>) {
    return this.generateWithReferences(prompt, images, imageConfig);
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!request.images?.length) return this.generateFromText(request.prompt, request.imageConfig);
    if (request.images.length === 1) {
      return this.generateFromImage(request.prompt, request.images[0].base64Data, request.images[0].mimeType, request.imageConfig);
    }
    return this.generateFromMultipleImages(request.prompt, request.images, request.imageConfig);
  }

  async isConfigured() {
    try { await this.credential(); return true; } catch { return false; }
  }

  async getStatus() {
    const configured = await this.isConfigured();
    return { configured, message: configured ? `OpenRouter image generation is ready (${this.modelName})` : 'OpenRouter is not configured for image generation.' };
  }
}
