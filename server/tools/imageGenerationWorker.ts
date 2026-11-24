/**
 * Image Generation Worker
 * Generates images using Google Vertex AI with gemini-2.5-flash-image model
 * Saves generated images to disk instead of returning base64
 * 
 * NOTE: Uses admin API credentials from admin_api_credentials table.
 * All users share these system-wide credentials.
 * Authentication priority:
 *   1. Service account JSON from data/service-accounts/ (preferred)
 *   2. Vertex AI Project ID (apiSecret) from admin credentials (fallback)
 */

import { GoogleGenAI } from '@google/genai';
import { googleApiKeyOptions } from '../utils/googleApiKeyOptions.js';
import { isRateLimitError } from '../services/apiKeyFallbackService';
import { saveBase64File } from '../utils/fileStorage';
import { createGeminiUsage } from '../models/geminiUsages/functions';
import { getAdminGeminiImageKey, updateAdminCredentialUsage, markAdminCredentialAsInactive, getNextAdminCredential } from '../services/adminCredentialsService';
import { GEMINI_IMAGE_MODEL } from '../utils/llmConstants';
import { logger } from '../utils/logger.js';
import { loadVertexServiceAccount } from '../utils/vertexAuth';
import { getUsdToInrRate, meteredCreditsFromUsd } from '../utils/currency.js';

function isModelNotFoundError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: number | string; message?: string } | null;
  const message = String(candidate?.message || error || '');
  return candidate?.status === 404
    || candidate?.code === 404
    || /\b(?:404|NOT_FOUND)\b/i.test(message)
    || /model .*(?:not found|does not exist|is not available)/i.test(message);
}

export interface ImageGenerationRequest {
  prompt: string;
  provider?: 'google' | 'openrouter';
  model?: string;
  images?: {
    base64Data: string;
    mimeType: string;
  }[];
  userId?: number; // User ID for tracking (uses admin credentials)
  threadId?: number; // Thread ID for linking transactions to chat threads
  imageConfig?: {
    provider?: 'google' | 'openrouter';
    model?: string;
    aspectRatio?: string;
    imageSize?: string;
    seed?: number;
    negativePrompt?: string;
    /** Selected Brand Toolkit logo. Null explicitly disables automatic branding. */
    brandLogoUrl?: string | null;
  };
}

export interface ImageGenerationResult {
  success: boolean;
  provider?: 'google' | 'openrouter';
  model?: string;
  fallbackFrom?: 'google' | 'openrouter';
  imageData?: string; // Base64 encoded image (kept for backward compatibility)
  imageUrl?: string;  // URL to the saved image file
  mimeType?: string;
  fileName?: string;
  error?: string;
  imageDimensions?: { width: number; height: number } | null;
  branding?: { logoApplied: true; logoUrl: string; position: 'bottom-right' };
  brandReference?: { logoUrl: string; suppliedToModel: true };
  /** Settings actually sent to the provider after matching the model's capabilities. */
  imageSettings?: { aspectRatio?: string; imageSize?: string; adjustments: string[] };
  usageMetadata?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
}

/**
 * ImageGenerationWorker - Generates images using Vertex AI via @google/genai SDK
 * Uses service account JSON for authentication (preferred), with admin credential fallback.
 */
export class ImageGenerationWorker {
  private userId?: number;
  private threadId?: number;
  private adminCredentialId?: number;
  private currentApiKey?: string;
  private ai?: GoogleGenAI;
  private modelName: string = GEMINI_IMAGE_MODEL;
  private vertexProjectId?: string;

  private readonly requestedModelName?: string;

  constructor(userId?: number, threadId?: number, modelName?: string) {
    this.userId = userId;
    this.threadId = threadId;
    this.requestedModelName = modelName;
    if (modelName) this.modelName = modelName;
  }

  /**
   * Initialize AI client from admin credentials (system-wide)
   * Uses service account JSON for Vertex AI authentication when available.
   */
  private async initializeFromCredential(cred: { id: number; apiKey: string; apiSecret?: string | null; config?: Record<string, unknown> }): Promise<void> {
    this.adminCredentialId = cred.id;
    this.currentApiKey = cred.apiKey;
    const configModel = cred.config?.model;
    // Only use config model if it's a known valid image-generation model
    // Reject regular LLM model names (e.g. 'gemini-3.1-flash-lite') that can't generate images
    const { VALID_IMAGE_MODELS } = await import('../utils/llmConstants.js');
    if (!this.requestedModelName && configModel && typeof configModel === 'string' && VALID_IMAGE_MODELS.includes(configModel)) {
      this.modelName = configModel;
    } else if (!this.requestedModelName && configModel && typeof configModel === 'string') {
      logger.warn(
        { configuredModel: configModel, fallback: this.modelName },
        '[ImageGenerationWorker] Ignoring invalid/non-image model from config — using default image model'
      );
    }

    const location = (cred.config?.location as string) || 'us-central1';

    // Try service account JSON first (preferred for Vertex AI)
    // Only use Vertex service account if:
    // 1. Service account exists
    // 2. We have a Vertex project ID (apiSecret) configured in DB
    const keyOptions = googleApiKeyOptions(cred.apiKey);
    const serviceAccount = keyOptions.vertexai ? null : loadVertexServiceAccount();
    if (keyOptions.vertexai) {
      logger.info('[ImageGenerationWorker] Initializing Vertex AI Express with the configured API key');
      this.ai = new GoogleGenAI(keyOptions);
    } else if (serviceAccount && cred.apiSecret) {
      const project = serviceAccount.project_id;
      this.vertexProjectId = project;
      logger.info({ project, location }, '[ImageGenerationWorker] Initializing Vertex AI with service account');
      this.ai = new GoogleGenAI({
        vertexai: true,
        project,
        location,
        googleAuthOptions: {
          credentials: serviceAccount,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      });
    } else if (cred.apiKey) {
      // Use API key directly (standard Gemini API / AI Studio)
      logger.info({ location }, '[ImageGenerationWorker] Initializing with Gemini API key (no service account)');
      this.ai = new GoogleGenAI(keyOptions);
    } else {
      throw new Error('Gemini API authentication failed: No service account JSON found and no API key configured. Please configure the Gemini API key in Admin > Integrations > Gemini Image.');
    }

    await updateAdminCredentialUsage(cred.id);
  }

  /**
   * Get or initialize GoogleGenAI instance from admin credentials
   */
  private async getAI(): Promise<GoogleGenAI> {
    if (this.ai) return this.ai;

    let adminCred = null;
    try {
      adminCred = await getAdminGeminiImageKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.warn({ err: err.message }, '[ImageGenerationWorker] Failed to query admin credentials DB, falling back to service account');
    }

    if (adminCred) {
      await this.initializeFromCredential(adminCred);
      return this.ai!;
    }
    // Try Gemini API Key from environment first (AI Studio)
    const envApiKey = process.env.GEMINI_API_KEY;
    if (envApiKey && envApiKey !== 'your_gemini_api_key_here') {
      logger.info('[ImageGenerationWorker] Initializing Gemini API with environment API Key');
      this.ai = new GoogleGenAI(googleApiKeyOptions(envApiKey));
      return this.ai;
    }

    // Try service account JSON as fallback if no DB credential exists
    const serviceAccount = loadVertexServiceAccount();
    if (serviceAccount) {
      const project = serviceAccount.project_id;
      this.vertexProjectId = project;
      logger.info({ project }, '[ImageGenerationWorker] Initializing Vertex AI with service account (no admin DB credential)');
      this.ai = new GoogleGenAI({
        vertexai: true,
        project,
        location: 'us-central1',
        googleAuthOptions: {
          credentials: serviceAccount,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      });
      return this.ai;
    }
    
    throw new Error('Gemini API key is not configured for image generation. Please ask an administrator to add the Gemini API key in Admin > Integrations > Gemini Image.');
  }

  /**
   * Handle rate limit error and try to get next available admin key
   */
  private async handleRateLimitAndGetNextKey(): Promise<boolean> {
    // If we were using Vertex AI (this.vertexProjectId is set) and we have a fallback API key,
    // we can try using the API key directly (AI Studio) before deactivating the DB key.
    if (this.vertexProjectId && this.currentApiKey) {
      logger.warn('[ImageGenerationWorker] Vertex AI rate limit / quota hit, falling back to standard Gemini API Key (AI Studio)');
      this.vertexProjectId = undefined;
      this.ai = new GoogleGenAI(googleApiKeyOptions(this.currentApiKey));
      this.modelName = GEMINI_IMAGE_MODEL;
      return true;
    }

    if (this.adminCredentialId) {
      logger.info({ adminKeyId: this.adminCredentialId }, '[ImageGenerationWorker] Deactivating rate-limited Gemini Image credential');
      await markAdminCredentialAsInactive(this.adminCredentialId, 'rate_limit');
      
      const nextAdmin = await getNextAdminCredential('gemini_image', this.adminCredentialId);
      if (nextAdmin) {
        logger.info({ adminKeyId: nextAdmin.id }, '[ImageGenerationWorker] Falling back to next admin Gemini Image key');
        await this.initializeFromCredential(nextAdmin);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Generate image from text prompt only using GenAI SDK
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateFromText(prompt: string, imageConfig?: Record<string, any>): Promise<ImageGenerationResult> {
    await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'gemini','image');
    if (!imageConfig?.__brandReferenceAttached) {
      const { loadApprovedBrandLogoReference, buildBrandReferencePrompt } = await import('../services/content/BrandMediaComposer.js');
      const logo = await loadApprovedBrandLogoReference(this.userId, imageConfig?.brandLogoUrl);
      if (logo) {
        return this.generateFromMultipleImages(
          buildBrandReferencePrompt(prompt, 'image'),
          [{ base64Data: logo.base64Data, mimeType: logo.mimeType }],
          { ...imageConfig, __brandReferenceAttached: true, __brandReferenceLogoUrl: logo.logoUrl } as ImageGenerationRequest['imageConfig'],
        );
      }
    }
    const maxRetries = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.info({ imageConfig }, '[ImageGenerationWorker] Generating image from text prompt');

        if (!prompt || prompt.trim().length === 0) {
          throw new Error('Prompt is required');
        }

        // Validate prompt length (max ~4000 characters)
        if (prompt.length > 4000) {
          throw new Error('Prompt too long. Maximum length is approximately 4000 characters.');
        }

        const ai = await this.getAI();
        
        // Build generation config — only pass SDK-whitelisted fields in imageConfig
        // @google/genai v1.44+ rejects unsupported fields (personGeneration, imageSize, etc.)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config: Record<string, any> = {
          responseModalities: ['TEXT', 'IMAGE'],
        };
        if (imageConfig) {
          if (imageConfig.aspectRatio) {
            config.imageConfig = { aspectRatio: imageConfig.aspectRatio };
          }
          if (imageConfig.seed !== undefined) config.seed = imageConfig.seed;
        }

        // Append negative prompt to the text prompt if provided
        let finalPrompt = prompt;
        if (imageConfig?.negativePrompt) {
          finalPrompt += `\n\nDo NOT include: ${imageConfig.negativePrompt}`;
        }

        const actualModelName = this.modelName;

        let response;
        try {
          response = await ai.models.generateContent({
            model: actualModelName,
            contents: finalPrompt,
            config,
          });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (apiError: any) {
          // If the model doesn't support aspect ratio, retry without it
          const errMsg = apiError?.message || String(apiError);
          if (errMsg.includes('Aspect ratio is not enabled') && config.imageConfig?.aspectRatio) {
            logger.warn({ model: this.modelName, aspectRatio: config.imageConfig.aspectRatio }, '[ImageGenerationWorker] Model does not support aspect ratio, retrying without it');
            delete config.imageConfig;
            response = await ai.models.generateContent({
              model: actualModelName,
              contents: finalPrompt,
              config,
            });
          } else {
            throw apiError;
          }
        }

        const result = await this.parseGenAIResponse(response, imageConfig?.brandLogoUrl);
        
        // If the model returned text instead of an image, retry with IMAGE-only modality
        if (!result.success && result.error?.includes('Model returned text instead of image')) {
          logger.warn({ attempt: attempt + 1, error: result.error }, '[ImageGenerationWorker] Model returned text, retrying with IMAGE-only response modality');
          const imageOnlyConfig = { ...config, responseModalities: ['IMAGE'] };
          // Simplify the prompt - strip any instructions that might confuse the model
          const retryPrompt = `Generate an image: ${prompt.substring(0, 2000)}`;
          try {
            const retryResponse = await ai.models.generateContent({
              model: actualModelName,
              contents: retryPrompt,
              config: imageOnlyConfig,
            });
            const retryResult = await this.parseGenAIResponse(retryResponse, imageConfig?.brandLogoUrl);
            if (retryResult.success) {
              if (this.userId) {
                await this.trackUsage(prompt, 'image_generation', retryResult.success, 1, undefined, retryResult.usageMetadata, retryResult.imageDimensions);
              }
              return retryResult;
            }
          } catch (retryErr) {
            logger.warn({ err: retryErr }, '[ImageGenerationWorker] Retry with IMAGE-only modality also failed');
          }
          // If retry still failed, return original failure
          return result;
        }

        // Track usage after successful generation with actual token counts
        if (result.success && this.userId) {
          await this.trackUsage(prompt, 'image_generation', result.success, 1, undefined, result.usageMetadata, result.imageDimensions);
        } else if (result.success) {
          logger.warn('[ImageGenerationWorker] Skipping credit tracking — userId not set');
        }
        
        return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        logger.error({ err: error, attempt: attempt + 1 }, '[ImageGenerationWorker] Error on attempt');
        
        if (isModelNotFoundError(error)) {
          if (this.modelName !== GEMINI_IMAGE_MODEL) {
            logger.warn(
              { configuredModel: this.modelName, fallbackModel: GEMINI_IMAGE_MODEL, attempt: attempt + 1 },
              '[ImageGenerationWorker] Configured image model is unavailable; retrying with the supported default',
            );
            this.modelName = GEMINI_IMAGE_MODEL;
            continue;
          }
          throw new Error(`The configured image model (${this.modelName}) is unavailable. Update the Gemini Image integration to a supported model.`);
        }

        // Rate limits rotate credentials; model configuration errors must never deactivate a healthy key.
        if (isRateLimitError(error)) {
          logger.warn({ attempt: attempt + 1 }, '[ImageGenerationWorker] Rate limit encountered, trying credential fallback...');
          const hasNext = await this.handleRateLimitAndGetNextKey();
          
          if (hasNext) {
            continue; // Retry with new key
          }
          
          // No more keys available
          throw new Error('All Gemini API keys have hit rate limits. Please add more API keys or wait for rate limits to reset in Settings > Integrations.');
        }
        
        // Not a rate limit error, throw immediately
        throw error;
      }
    }
    
    logger.error({ err: lastError }, '[ImageGenerationWorker] Max retries reached');
    return {
      success: false,
      error: lastError?.message || 'Max retries reached for image generation',
    };
  }

  /**
   * Generate image from a single image + text prompt (image-to-image) using GenAI SDK
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateFromImage(prompt: string, imageBase64: string, imageMimeType: string = 'image/jpeg', imageConfig?: Record<string, any>): Promise<ImageGenerationResult> {
    await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'gemini','image');
    if (!imageConfig?.__brandReferenceAttached) {
      const { loadApprovedBrandLogoReference, buildBrandReferencePrompt } = await import('../services/content/BrandMediaComposer.js');
      const logo = await loadApprovedBrandLogoReference(this.userId, imageConfig?.brandLogoUrl);
      if (logo) {
        return this.generateFromMultipleImages(
          buildBrandReferencePrompt(prompt, 'image'),
          [
            { base64Data: imageBase64, mimeType: imageMimeType },
            { base64Data: logo.base64Data, mimeType: logo.mimeType },
          ],
          { ...imageConfig, __brandReferenceAttached: true, __brandReferenceLogoUrl: logo.logoUrl } as ImageGenerationRequest['imageConfig'],
        );
      }
    }
    const maxRetries = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.info({ imageConfig }, '[ImageGenerationWorker] Generating image from image + text prompt');

        if (!prompt || prompt.trim().length === 0) {
          prompt = 'Generate an image based on this image';
        }

        if (!imageBase64) {
          throw new Error('Image data is required');
        }

        const ai = await this.getAI();
        
        // Build generation config — only pass SDK-whitelisted fields in imageConfig
        // @google/genai v1.44+ rejects unsupported fields (personGeneration, imageSize, etc.)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config: Record<string, any> = {
          responseModalities: ['TEXT', 'IMAGE'],
        };
        if (imageConfig) {
          if (imageConfig.aspectRatio) {
            config.imageConfig = { aspectRatio: imageConfig.aspectRatio };
          }
          if (imageConfig.seed !== undefined) config.seed = imageConfig.seed;
        }

        // Append negative prompt to the text prompt if provided
        let finalPrompt = prompt;
        if (imageConfig?.negativePrompt) {
          finalPrompt += `\n\nDo NOT include: ${imageConfig.negativePrompt}`;
        }
        
        const contents = [
            { text: finalPrompt },
            { 
              inlineData: {
                mimeType: imageMimeType,
                data: imageBase64,
              }
            }
          ];
        
        let response;
        try {
          response = await ai.models.generateContent({
            model: this.modelName,
            contents,
            config,
          });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (apiError: any) {
          // If the model doesn't support aspect ratio, retry without it
          const errMsg = apiError?.message || String(apiError);
          if (errMsg.includes('Aspect ratio is not enabled') && config.imageConfig?.aspectRatio) {
            logger.warn({ model: this.modelName, aspectRatio: config.imageConfig.aspectRatio }, '[ImageGenerationWorker] Model does not support aspect ratio, retrying without it');
            delete config.imageConfig;
            response = await ai.models.generateContent({
              model: this.modelName,
              contents,
              config,
            });
          } else {
            throw apiError;
          }
        }

        const result = await this.parseGenAIResponse(response, imageConfig?.brandLogoUrl);
        
        // If the model returned text instead of an image, retry with IMAGE-only modality
        if (!result.success && result.error?.includes('Model returned text instead of image')) {
          logger.warn({ attempt: attempt + 1, error: result.error }, '[ImageGenerationWorker] Model returned text in image-to-image, retrying with IMAGE-only modality');
          const imageOnlyConfig = { ...config, responseModalities: ['IMAGE'] };
          const retryContents = [
            { text: `Generate an image: ${prompt.substring(0, 2000)}` },
            { inlineData: { mimeType: imageMimeType, data: imageBase64 } }
          ];
          try {
            const retryResponse = await ai.models.generateContent({
              model: this.modelName,
              contents: retryContents,
              config: imageOnlyConfig,
            });
            const retryResult = await this.parseGenAIResponse(retryResponse, imageConfig?.brandLogoUrl);
            if (retryResult.success) {
              if (this.userId) {
                await this.trackUsage(prompt, 'image_generation', retryResult.success, 1, undefined, retryResult.usageMetadata, retryResult.imageDimensions);
              } else {
                logger.warn('[ImageGenerationWorker] Skipping credit tracking (image-to-image retry) — userId not set');
              }
              return retryResult;
            }
          } catch (retryErr) {
            logger.warn({ err: retryErr }, '[ImageGenerationWorker] Image-to-image retry with IMAGE-only also failed');
          }
          return result;
        }

        // Track usage after successful generation with actual token counts
        if (result.success && this.userId) {
          await this.trackUsage(prompt, 'image_generation', true, 1, undefined, result.usageMetadata, result.imageDimensions);
        } else if (result.success) {
          logger.warn('[ImageGenerationWorker] Skipping credit tracking (image-to-image) — userId not set');
        }
        
        return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        logger.error({ err: error, attempt: attempt + 1 }, '[ImageGenerationWorker] Error on attempt');
        
        if (isRateLimitError(error)) {
          logger.warn({ attempt: attempt + 1 }, '[ImageGenerationWorker] Rate limit, trying fallback...');
          const hasNext = await this.handleRateLimitAndGetNextKey();
          
          if (hasNext) {
            continue;
          }
          
          throw new Error('All Gemini API keys have hit rate limits.');
        }
        
        throw error;
      }
    }
    
    return {
      success: false,
      error: lastError?.message || 'Max retries reached for image generation',
    };
  }

  /**
   * Generate image from multiple images + text prompt using GenAI SDK
   */
  async generateFromMultipleImages(
    prompt: string,
    images: { base64Data: string; mimeType: string }[],
    imageConfig?: ImageGenerationRequest['imageConfig'],
  ): Promise<ImageGenerationResult> {
    await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'gemini','image');
    const internalConfig = imageConfig as (ImageGenerationRequest['imageConfig'] & {
      __brandReferenceAttached?: boolean;
      __brandReferenceLogoUrl?: string;
    }) | undefined;
    if (!internalConfig?.__brandReferenceAttached) {
      const { loadApprovedBrandLogoReference, buildBrandReferencePrompt } = await import('../services/content/BrandMediaComposer.js');
      const logo = await loadApprovedBrandLogoReference(this.userId, internalConfig?.brandLogoUrl);
      if (logo) {
        return this.generateFromMultipleImages(
          buildBrandReferencePrompt(prompt, 'image'),
          [...images, { base64Data: logo.base64Data, mimeType: logo.mimeType }],
          { ...internalConfig, __brandReferenceAttached: true, __brandReferenceLogoUrl: logo.logoUrl } as ImageGenerationRequest['imageConfig'],
        );
      }
    }
    const maxRetries = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.info('[ImageGenerationWorker] Generating image from multiple images + text prompt');

        if (!prompt || prompt.trim().length === 0) {
          prompt = 'Combine these images creatively';
        }

        if (!images || images.length === 0) {
          throw new Error('At least one image is required');
        }

        const ai = await this.getAI();
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let finalPrompt = prompt;
        if (internalConfig?.negativePrompt) {
          finalPrompt += `\n\nDo NOT include: ${internalConfig.negativePrompt}`;
        }
        const contents: any[] = [{ text: finalPrompt }];
        for (const image of images) {
          contents.push({
            inlineData: {
              mimeType: image.mimeType || 'image/jpeg',
              data: image.base64Data,
            }
          });
        }
        
        const config: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
        if (imageConfig?.aspectRatio) config.imageConfig = { aspectRatio: imageConfig.aspectRatio };
        if (imageConfig?.seed !== undefined) config.seed = imageConfig.seed;

        const response = await ai.models.generateContent({
          model: this.modelName,
          contents,
          config,
        });

        const result = await this.parseGenAIResponse(
          response,
          imageConfig?.brandLogoUrl,
          internalConfig?.__brandReferenceLogoUrl,
        );
        
        // Track usage after successful generation with actual token counts
        if (result.success && this.userId) {
          await this.trackUsage(prompt, 'image_generation', true, 1, undefined, result.usageMetadata, result.imageDimensions);
        } else if (result.success) {
          logger.warn('[ImageGenerationWorker] Skipping credit tracking (multi-image) — userId not set');
        }
        
        return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        logger.error({ err: error, attempt: attempt + 1 }, '[ImageGenerationWorker] Error on attempt');
        
        if (isRateLimitError(error)) {
          logger.warn({ attempt: attempt + 1 }, '[ImageGenerationWorker] Rate limit, trying fallback...');
          const hasNext = await this.handleRateLimitAndGetNextKey();
          
          if (hasNext) {
            continue;
          }
          
          throw new Error('All Gemini API keys have hit rate limits.');
        }
        
        throw error;
      }
    }
    
    return {
      success: false,
      error: lastError?.message || 'Max retries reached for image generation',
    };
  }

  /**
   * Main generate method that routes based on input type
   */
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    try {
      // Set userId and threadId from request so trackUsage() can deduct credits
      if (request.userId) {
        this.userId = request.userId;
      }
      if (request.threadId) {
        this.threadId = request.threadId;
      }

      logger.info('[ImageGenerationWorker] Processing image generation request');

      const { prompt, images, imageConfig } = request;

      if (!images || images.length === 0) {
        // Text-only generation
        return await this.generateFromText(prompt, imageConfig);
      } else if (images.length === 1) {
        // Single image + text
        return await this.generateFromImage(prompt, images[0].base64Data, images[0].mimeType, imageConfig);
      } else {
        // Multiple images + text
        return await this.generateFromMultipleImages(prompt, images, imageConfig);
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ImageGenerationWorker] Error in generate');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Track Gemini API usage - calculates cost from actual model pricing + admin margin
   * Uses resolution tier from generated image dimensions for accurate billing.
   */
  private async trackUsage(
    prompt: string,
    operationType: string,
    success: boolean,
    imagesGenerated: number = 0,
    errorMessage?: string,
    usageMetadata?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number },
    imageDimensions?: { width: number; height: number } | null
  ): Promise<void> {
    logger.info({ userId: this.userId, imagesGenerated, operationType, success }, '[ImageGenerationWorker] trackUsage called');
    try {
      const { getImageCostWithMarginUSD } = await import('../models/apiPricing/functions.js');
      const { getImageResolutionTier } = await import('../utils/geminiMediaPricing.js');
      const { getRechargeRate, getUsageRate } = await import('../models/creditPricing/functions.js');

      // Determine resolution tier from actual image dimensions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolutionOpts: { resolution?: any; width?: number; height?: number } = {};
      let detectedResolution: string | undefined;
      if (imageDimensions?.width && imageDimensions?.height) {
        const tier = getImageResolutionTier(imageDimensions.width, imageDimensions.height);
        resolutionOpts.resolution = tier;
        detectedResolution = tier;
        logger.info({ width: imageDimensions.width, height: imageDimensions.height, tier }, '[ImageGenerationWorker] Detected image resolution tier');
      }

      // Calculate actual cost based on model pricing + resolution tier + admin margin
      const costInfo = await getImageCostWithMarginUSD(this.modelName, resolutionOpts);
      const originalCostUSD = costInfo.baseCostUSD * imagesGenerated;
      const totalCostUSD = costInfo.totalCostUSD * imagesGenerated;
      const originalCostCents = originalCostUSD * 100;

      // Convert provider cost to INR, then into the configured credit rate.
      // rechargeRate values the credits (purchase rate); usageRate converts provider cost into credits.
      const [rechargeRate, usageRate] = await Promise.all([getRechargeRate(), getUsageRate()]);
      const totalCredits = meteredCreditsFromUsd(totalCostUSD, usageRate);

      const usageRecord = await createGeminiUsage({
        userId: this.userId ?? null,
        operationType,
        model: this.modelName,
        prompt: prompt.substring(0, 500),
        imagesGenerated,
        costCents: originalCostCents.toFixed(8),
        threadId: this.threadId ?? null,
        resolution: detectedResolution ?? null,
        service: 'image_worker',
        purpose: 'image_generation',
        status: success ? 'success' : 'error',
        errorMessage,
        inputTokens: usageMetadata?.promptTokens,
        outputTokens: usageMetadata?.candidatesTokens,
        metadata: {
          threadId: this.threadId,
          resolution: detectedResolution,
          imageDimensions: imageDimensions ?? undefined,
          baseCostPerImageUSD: costInfo.baseCostUSD,
          marginPct: costInfo.marginPct,
          totalCostUSD,
          totalCredits,
          promptTokens: usageMetadata?.promptTokens,
          completionTokens: usageMetadata?.candidatesTokens,
        },
      });

      // Deduct credits based on actual model cost + margin
      if (this.userId && imagesGenerated > 0 && totalCredits > 0) {
        const { creditService } = await import('../services/CreditService.js');
        const deduction = await creditService.deductForEvent({
          userId: this.userId,
          eventKey: 'api_gemini',
          description: `Image generation (${imagesGenerated} images, ${this.modelName}${detectedResolution ? `, ${detectedResolution}` : ''}) - ₹${(totalCostUSD * getUsdToInrRate()).toFixed(2)}${costInfo.marginPct > 0 ? ` including ${costInfo.marginPct}% margin` : ''}`,
          service: 'ImageGenerationWorker',
          apiProvider: 'gemini_image',
          apiCostCents: originalCostCents,
          overrideAmount: totalCredits,
          // The media was generated: bill it in full even on a low balance.
          allowOverdraft: true,
          referenceType: this.threadId ? 'chat_thread' : 'content',
          referenceId: this.threadId ? String(this.threadId) : undefined,
          insights: { attemptId:`gemini_usages:${usageRecord.id}`,operationId:`gemini_usages:${usageRecord.id}`,
            process:'media',conversation:this.threadId?{kind:'workspace',id:this.threadId}:undefined },
          pricingSnapshot: {version:1,capturedAt:new Date().toISOString(),source:costInfo.source,sourceReference:costInfo.sourceReference,
            provider:'gemini',model:this.modelName,providerCostUsd:originalCostUSD.toFixed(8),chargedCostUsd:totalCostUSD.toFixed(8),
            marginPercentage:costInfo.marginPct,usdToInr:getUsdToInrRate(),creditsPerInr:rechargeRate,usageCreditsPerInr:usageRate,minimumCredits:1,rounding:'ceil_whole'},
          metadata: {
            model: this.modelName,
            operationType,
            imagesGenerated,
            resolution: detectedResolution,
            imageDimensions,
            baseCostPerImageUSD: costInfo.baseCostUSD,
            marginPct: costInfo.marginPct,
            totalCostUSD,
            originalCostUSD,
            totalCredits,
            threadId: this.threadId,
            promptTokens: usageMetadata?.promptTokens,
            completionTokens: usageMetadata?.candidatesTokens,
          },
        });
        if (!deduction.success) throw new Error(deduction.error || 'Image usage charge was not completed');
        logger.info({ userId: this.userId, threadId: this.threadId, imagesGenerated, model: this.modelName, resolution: detectedResolution, baseCostUSD: costInfo.baseCostUSD, marginPct: costInfo.marginPct, totalCostUSD, totalCredits }, '[ImageGenerationWorker] Cost-based credits deducted for image generation');
      }
    } catch (err) {
      logger.error({ err }, '[ImageGenerationWorker] Failed to track usage');
      // Don't throw - usage tracking failure shouldn't break image generation
    }
  }

  /**
   * Parse GenAI SDK response, save image to disk, and return URL
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseGenAIResponse(
    response: any,
    _requestedLogoUrl?: string | null,
    brandReferenceLogoUrl?: string,
  ): Promise<ImageGenerationResult> {
    try {
      const candidates = response.candidates || [];
      if (candidates.length === 0) {
        throw new Error('No candidates in response');
      }

      const parts = candidates[0].content?.parts || [];
      let imageData: string | null = null;
      let mimeType = 'image/png';

      // Extract usage metadata if available
      const usageMetadata = response.usageMetadata ? {
        promptTokens: response.usageMetadata.promptTokenCount || 0,
        candidatesTokens: response.usageMetadata.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata.totalTokenCount || 0,
      } : undefined;

      // Find inlineData in parts
      for (const part of parts) {
        if (part.inlineData) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }

      if (!imageData) {
        // Extract any text response for a more informative error
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join(' ');
        const errorDetail = textParts
          ? `Model returned text instead of image: "${textParts.substring(0, 200)}"`
          : 'No image data found in response';
        logger.warn({ partsCount: parts.length, hasText: !!textParts }, '[ImageGenerationWorker] Response contained no image data');
        return {
          success: false,
          error: errorDetail,
          usageMetadata,
        };
      }

      // Save image to disk and get URL
      const { fileName, url } = await saveBase64File(
        imageData,
        mimeType,
        'images',
        'generated',
        this.userId
      );

      // Detect image dimensions for resolution-based pricing
      let imageDimensions: { width: number; height: number } | null = null;
      try {
        const { getImageDimensionsFromBase64 } = await import('../utils/geminiMediaPricing.js');
        imageDimensions = getImageDimensionsFromBase64(imageData, mimeType);
        if (imageDimensions) {
          logger.info({ width: imageDimensions.width, height: imageDimensions.height }, '[ImageGenerationWorker] Detected image dimensions');
        }
      } catch {
        // Dimension detection is best-effort; don't fail on it
      }

      const brandReference: ImageGenerationResult['brandReference'] = brandReferenceLogoUrl
        ? { logoUrl: brandReferenceLogoUrl, suppliedToModel: true }
        : undefined;

      logger.info({ fileName, usageMetadata, imageDimensions, logoSuppliedToModel: brandReference?.suppliedToModel === true }, '[ImageGenerationWorker] Successfully generated and saved image');

      return {
        success: true,
        imageData, // Keep base64 for backward compatibility
        imageUrl: url, // New: URL to the saved file
        mimeType,
        fileName,
        imageDimensions,
        usageMetadata,
        brandReference,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ImageGenerationWorker] Error parsing response');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if the worker is properly configured
   */
  async isConfigured(): Promise<boolean> {
    try {
      await this.getAI();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get status of the worker
   */
  async getStatus(): Promise<{ configured: boolean; message: string }> {
    if (await this.isConfigured()) {
      return {
        configured: true,
        message: 'Image generation worker is ready',
      };
    } else {
      return {
        configured: false,
        message: 'Gemini Image API key is not configured. Please ask your admin to add it in Admin Panel → Integrations → Gemini Image.',
      };
    }
  }
}

// Export factory function instead of singleton
export const createImageGenerationWorker = (userId?: number, threadId?: number) => new ImageGenerationWorker(userId, threadId);
// Legacy singleton for backward compatibility (uses env variable only)
export const imageGenerationWorker = new ImageGenerationWorker();
