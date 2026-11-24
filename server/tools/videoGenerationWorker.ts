/**
 * Video Generation Worker
 * Generates videos using Google Vertex AI with veo-3.1-generate-preview model
 * Saves generated videos to disk
 * 
 * NOTE: Uses admin API credentials from admin_api_credentials table.
 * All users share these system-wide credentials.
 * Authentication priority:
 *   1. Service account JSON from data/service-accounts/ (preferred)
 *   2. Vertex AI Project ID (apiSecret) from admin credentials (fallback)
 */

import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';
import { isRateLimitError } from '../services/apiKeyFallbackService';
import { saveBufferFile } from '../utils/fileStorage';
import { createGeminiUsage } from '../models/geminiUsages/functions';
import { getAdminGeminiVideoKey, updateAdminCredentialUsage, markAdminCredentialAsInactive, getNextAdminCredential } from '../services/adminCredentialsService';
import { GEMINI_VIDEO_MODEL } from '../utils/llmConstants';
import { logger } from '../utils/logger.js';
import { VIDEO_POLL_INTERVAL_MS, VIDEO_MAX_POLL_ATTEMPTS } from '../utils/timingConstants';
 
import { loadVertexServiceAccount } from '../utils/vertexAuth';
import { getUsdToInrRate, meteredCreditsFromUsd } from '../utils/currency.js';

export interface VideoGenerationRequest {
  prompt: string;
  provider?: 'google' | 'openrouter';
  model?: string;
  image?: {
    base64Data: string;
    mimeType: string;
  };
  userId?: number; // User ID for tracking (uses admin credentials)
  threadId?: number; // Thread ID for linking transactions to chat threads
  operationName?: string; // For tracking long-running operations across delayed jobs
  videoConfig?: {
    provider?: 'google' | 'openrouter';
    model?: string;
    numberOfVideos?: number;
    durationSeconds?: number;
    aspectRatio?: string;
    resolution?: string;
    generateAudio?: boolean;
    personGeneration?: string;
    negativePrompt?: string;
    seed?: number;
    /** Selected Brand Toolkit logo. Null explicitly disables automatic branding. */
    brandLogoUrl?: string | null;
    /** How the uploaded image is used: subject reference (default) or exact first frame. */
    imageRole?: 'reference' | 'start_frame';
  };
}

export interface VideoGenerationResult {
  mediaProbe?: import('../services/media/MediaTranscodingService.js').MediaProbe;
  success: boolean;
  provider?: 'google' | 'openrouter';
  model?: string;
  videoData?: string; // Base64 encoded video
  videoUrl?: string; // Direct URL to video
  mimeType?: string;
  fileName?: string;
  operationName?: string; // For tracking long-running operations
  status?: 'pending' | 'completed' | 'failed'; // State of async jobs
  error?: string;
  branding?: { logoApplied: true; logoUrl: string; position: 'bottom-right' };
  brandReference?: { logoUrl: string; suppliedToModel: true };
  usageMetadata?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
}

export interface VideoGenerationStatus {
  mediaProbe?: import('../services/media/MediaTranscodingService.js').MediaProbe;
  done: boolean;
  operationName: string;
  provider?: 'google' | 'openrouter';
  model?: string;
  videoUrl?: string;
  error?: string;
  branding?: { logoApplied: true; logoUrl: string; position: 'bottom-right' };
  brandReference?: { logoUrl: string; suppliedToModel: true };
}

function videoOperationError(operation: any): Error | undefined {
  const providerError = operation?.error;
  if (!providerError) return undefined;
  const message = typeof providerError === 'string'
    ? providerError
    : providerError.message || JSON.stringify(providerError);
  const error = new Error(message || 'The video provider returned an unknown operation error');
  (error as Error & { providerCode?: number | string }).providerCode = providerError.code;
  return error;
}

function isRetryableVideoProviderError(error: any): boolean {
  const code = error?.providerCode ?? error?.code;
  const message = String(error?.message || '');
  return code === 8
    || code === 429
    || code === 500
    || code === 503
    || /high load|temporar(?:y|ily)|try again|resource exhausted|unavailable/i.test(message);
}

/**
 * VideoGenerationWorker - Generates videos using Vertex AI via @google/genai SDK
 * Uses service account JSON for authentication (preferred), with admin credential fallback.
 */
export class VideoGenerationWorker {
  private pollInterval: number = VIDEO_POLL_INTERVAL_MS;
  private maxPollAttempts: number = VIDEO_MAX_POLL_ATTEMPTS;
  private userId?: number;
  private threadId?: number;
  private adminCredentialId?: number;
  private ai?: GoogleGenAI;
  private modelName: string = GEMINI_VIDEO_MODEL;
  private vertexProjectId?: string;

  private readonly requestedModelName?: string;
  private appliedBranding?: { logoApplied: true; logoUrl: string; position: 'bottom-right' };

  /** Applies the approved logo overlay (real logo pixels) and stores the video. */
  private async saveGeneratedVideo(videoBuffer: Buffer, fileName: string, requestedLogoUrl?: string | null) {
    const { applyBrandLogoToVideo } = await import('../services/media/BrandVideoOverlay.js');
    const branded = await applyBrandLogoToVideo(videoBuffer, this.userId, requestedLogoUrl);
    this.appliedBranding = branded.branding;
    return saveBufferFile(branded.buffer, fileName, 'videos', 'generated', this.userId);
  }

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
    const configModel = cred.config?.model;
    // Only use config model if it's a known valid video-generation model
    const { VALID_VIDEO_MODELS } = await import('../utils/llmConstants.js');
    if (!this.requestedModelName && configModel && typeof configModel === 'string' && VALID_VIDEO_MODELS.includes(configModel)) {
      this.modelName = configModel;
    } else if (!this.requestedModelName && configModel && typeof configModel === 'string') {
      logger.warn(
        { configuredModel: configModel, fallback: this.modelName },
        '[VideoGenerationWorker] Ignoring invalid/non-video model from config — using default video model'
      );
    }

    const location = (cred.config?.location as string) || 'us-central1';

    // Try service account JSON first (preferred for Vertex AI)
    const serviceAccount = loadVertexServiceAccount();
    if (serviceAccount) {
      const project = serviceAccount.project_id;
      this.vertexProjectId = project;
      logger.info({ project, location }, '[VideoGenerationWorker] Initializing Vertex AI with service account');
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
      // Use API key directly (avoids ADC credential error)
      logger.info({ location }, '[VideoGenerationWorker] Initializing with API key (no service account)');
      this.ai = new GoogleGenAI({ apiKey: cred.apiKey });
    } else {
      throw new Error('Vertex AI authentication failed: No service account JSON found and no API key configured. Please add a service account JSON at data/service-accounts/ or configure the Gemini API key in Admin > Integrations > Gemini Video.');
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
      adminCred = await getAdminGeminiVideoKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.warn({ err: err.message }, '[VideoGenerationWorker] Failed to query admin credentials DB, falling back to service account');
    }

    if (adminCred) {
      await this.initializeFromCredential(adminCred);
      return this.ai!;
    }
    
    // Try service account JSON as fallback if no DB credential exists
    const serviceAccount = loadVertexServiceAccount();
    if (serviceAccount) {
      const project = serviceAccount.project_id;
      this.vertexProjectId = project;
      logger.info({ project }, '[VideoGenerationWorker] Initializing Vertex AI with service account (no admin DB credential)');
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
    
    throw new Error('Gemini API key is not configured for video generation. Please ask an administrator to add the Gemini API key in Admin > Integrations > Gemini Video.');
  }

  /**
   * Handle rate limit error and try to get next available admin key
   */
  private async handleRateLimitAndGetNextKey(): Promise<boolean> {
    if (this.adminCredentialId) {
      await markAdminCredentialAsInactive(this.adminCredentialId, 'rate_limit');
      
      const nextAdmin = await getNextAdminCredential('gemini_video', this.adminCredentialId);
      if (nextAdmin) {
        logger.info({ adminKeyId: nextAdmin.id }, '[VideoGenerationWorker] Falling back to next admin Gemini Video key');
        await this.initializeFromCredential(nextAdmin);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Generate video from text prompt only using GenAI SDK with Veo 3.1
   */
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   async generateFromText(prompt: string, videoConfig?: Record<string, any>, operationName?: string): Promise<VideoGenerationResult> {
    if(!operationName)await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'gemini','video');
    const maxRetries = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.info({ videoConfig, operationName }, '[VideoGenerationWorker] Generating video from text prompt (async)');

        if (!prompt || prompt.trim().length === 0) {
          throw new Error('Prompt is required');
        }

        const ai = await this.getAI();
        // The approved logo is never sent to the model as a frame or reference:
        // Veo redraws it (distorted, misspelled) and a logo start frame turns the
        // whole clip into an animated still. It is overlaid after generation.
        // Prompts are bounded to Veo's limit with the user's request first.
        const finalPrompt = prompt.slice(0, 4000);
        
        // Build generation config — only Veo-supported params
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config: Record<string, any> = {};
        if (videoConfig) {
          if (videoConfig.numberOfVideos !== undefined) config.numberOfVideos = videoConfig.numberOfVideos;
          if (videoConfig.durationSeconds !== undefined) config.durationSeconds = videoConfig.durationSeconds;
          if (videoConfig.aspectRatio) config.aspectRatio = videoConfig.aspectRatio;
          if (videoConfig.personGeneration) config.personGeneration = videoConfig.personGeneration;
          if (videoConfig.negativePrompt) config.negativePrompt = videoConfig.negativePrompt;
          if (videoConfig.seed !== undefined) config.seed = videoConfig.seed;
          if (videoConfig.resolution) config.resolution = videoConfig.resolution;
          if (videoConfig.generateAudio !== undefined) config.generateAudio = videoConfig.generateAudio;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let operation: any;
        if (operationName) {
           logger.info({ operationName }, '[VideoGenerationWorker] Checking existing video generation status');
           operation = await this.getOperationViaRestApi(operationName);
        } else {
           logger.info({
             configKeys: Object.keys(config),
           }, '[VideoGenerationWorker] Sending new video generation request via SDK');
           try {
             operation = await ai.models.generateVideos({
               model: this.modelName,
               prompt: finalPrompt,
               ...(Object.keys(config).length > 0 ? { config } : {}),
             });
           // eslint-disable-next-line @typescript-eslint/no-explicit-any
           } catch (sdkErr: any) {
             // SDK failed (likely v1beta API issue), fall back to REST API
             logger.warn({ err: sdkErr.message }, '[VideoGenerationWorker] SDK generateVideos failed, trying REST API fallback');
             operation = await this.generateViaRestApi(finalPrompt, config);
           }
        }

        if (!operation.done) {
          logger.info({ operationName: operation.name || operationName }, '[VideoGenerationWorker] Video generation pending, suspending worker...');
          return {
            success: true,
            status: 'pending',
            operationName: operation.name || operationName,
          };
        }

        // Get the generated video
        const generatedVideos = operation.response?.generatedVideos;
        if (!generatedVideos || generatedVideos.length === 0) {
          logger.warn({ response: JSON.stringify(operation.response || {}).substring(0, 500) }, '[VideoGenerationWorker] Operation done but no videos in response');
          const providerError = videoOperationError(operation);
          if (providerError) throw providerError;
          throw new Error('No video generated — the model may have rejected the prompt or config');
        }

        const video = generatedVideos[0].video;
        
        // Log what's available in the video object for debugging
        logger.info({ 
          hasUri: !!video?.uri,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hasVideoBytes: !!(video as any)?.videoBytes,
          videoKeys: video ? Object.keys(video) : [],
        }, '[VideoGenerationWorker] Video object details');
        
        // Extract usage metadata if available from operation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = operation.metadata as any;
        const usageMetadata = meta?.usageMetadata ? {
          promptTokens: meta.usageMetadata.promptTokenCount || 0,
          candidatesTokens: meta.usageMetadata.candidatesTokenCount || 0,
          totalTokens: meta.usageMetadata.totalTokenCount || 0,
        } : undefined;

        // Download and save video to disk
        let savedUrl: string | undefined;
        let mediaProbe: import('../services/media/MediaTranscodingService.js').MediaProbe | undefined;
        const responseId = Date.now().toString();
        const fileName = `generated-video-${responseId}.mp4`;

        if (video?.uri) {
          // Download from temporary Vertex AI URI
          try {
            const videoResponse = await fetch(video.uri);
            if (videoResponse.ok) {
              const arrayBuffer = await videoResponse.arrayBuffer();
              const videoBuffer = Buffer.from(arrayBuffer);
              const saved = await this.saveGeneratedVideo(videoBuffer, fileName, videoConfig?.brandLogoUrl);
              savedUrl = saved.url;
              mediaProbe = saved.mediaProbe;
              logger.info({ fileName: saved.fileName, url: saved.url }, '[VideoGenerationWorker] Video saved to disk from URI');
            } else {
              logger.warn({ status: videoResponse.status }, '[VideoGenerationWorker] Failed to download video from URI');
              savedUrl = video.uri;
            }
          } catch (downloadErr) {
            logger.warn({ err: downloadErr }, '[VideoGenerationWorker] Failed to download video, returning URI directly');
            savedUrl = video.uri;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } else if ((video as any)?.videoBytes) {
          // Save from raw bytes
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bytes = (video as any).videoBytes;
            const videoBuffer = typeof bytes === 'string' ? Buffer.from(bytes, 'base64') : Buffer.from(bytes);
            const saved = await this.saveGeneratedVideo(videoBuffer, fileName, videoConfig?.brandLogoUrl);
            savedUrl = saved.url;
            mediaProbe = saved.mediaProbe;
            logger.info({ fileName: saved.fileName, url: saved.url }, '[VideoGenerationWorker] Video saved to disk from bytes');
          } catch (bytesErr) {
            logger.warn({ err: bytesErr }, '[VideoGenerationWorker] Failed to save video from bytes');
          }
        }

        if (!savedUrl || !mediaProbe) throw new Error('Generated video could not be saved and validated for publication. Retry media processing.');
        logger.info({ fileName, savedUrl, hasVideo: !!video, usageMetadata }, '[VideoGenerationWorker] Text-to-video generation complete');

        // Track usage with actual cost data (pass durationSeconds from config for accurate billing)
        if (this.userId) {
          const configDuration = config.durationSeconds || undefined;
          await this.trackUsage(prompt, 'video_generation', true, 1, undefined, usageMetadata, configDuration);
        } else {
          logger.warn('[VideoGenerationWorker] Skipping credit tracking (text-to-video) — userId not set');
        }

        return {
          success: true,
          videoUrl: savedUrl || video?.uri || undefined,
          mediaProbe,
          mimeType: 'video/mp4',
          fileName,
          branding: this.appliedBranding,
          usageMetadata,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        logger.error({ err: error, attempt: attempt + 1 }, '[VideoGenerationWorker] Error on attempt');
        
        if (isRateLimitError(error)) {
          logger.warn({ attempt: attempt + 1 }, '[VideoGenerationWorker] Rate limit, trying fallback...');
          const hasNext = await this.handleRateLimitAndGetNextKey();
          
          if (hasNext) {
            continue;
          }
          
          throw new Error('All Gemini API keys have hit rate limits.');
        }

        if (isRetryableVideoProviderError(error) && attempt < maxRetries - 1) {
          logger.warn(
            { attempt: attempt + 1, providerCode: error?.providerCode },
            '[VideoGenerationWorker] Transient provider failure; starting a fresh video operation',
          );
          operationName = undefined;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }
        
        throw error;
      }
    }
    
    logger.error({ err: lastError }, '[VideoGenerationWorker] Max retries reached');
    return {
      success: false,
      error: lastError?.message || 'Max retries reached for video generation',
    };
  }

  /**
   * Generate video from image + text prompt (image-to-video) using GenAI SDK
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateFromImage(prompt: string, imageBase64: string, imageMimeType: string = 'image/jpeg', videoConfig?: Record<string, any>, operationName?: string): Promise<VideoGenerationResult> {
    if(!operationName)await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'gemini','video');
    const maxRetries = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.info({ videoConfig, operationName }, '[VideoGenerationWorker] Generating video from image + text prompt (async)');

        if (!prompt || prompt.trim().length === 0) {
          prompt = 'A beautiful cinematic video based on this image';
        }

        if (!imageBase64 && !operationName) {
          throw new Error('Image data is required');
        }

        const ai = await this.getAI();
        const finalPrompt = prompt.slice(0, 4000);
        const useAsReference = videoConfig?.imageRole !== 'start_frame';
        
        // Build generation config — only Veo-supported params
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config: Record<string, any> = {};
        if (videoConfig) {
          if (videoConfig.numberOfVideos !== undefined) config.numberOfVideos = videoConfig.numberOfVideos;
          if (videoConfig.durationSeconds !== undefined) config.durationSeconds = videoConfig.durationSeconds;
          if (videoConfig.aspectRatio) config.aspectRatio = videoConfig.aspectRatio;
          if (videoConfig.personGeneration) config.personGeneration = videoConfig.personGeneration;
          if (videoConfig.negativePrompt) config.negativePrompt = videoConfig.negativePrompt;
          if (videoConfig.seed !== undefined) config.seed = videoConfig.seed;
          if (videoConfig.resolution) config.resolution = videoConfig.resolution;
          if (videoConfig.generateAudio !== undefined) config.generateAudio = videoConfig.generateAudio;
        }
        if (useAsReference && !operationName) {
          // A subject/style reference lets the prompt direct the scene. Sending the
          // image as `image` makes it the literal first frame, so Veo only adds
          // subtle motion to it (the "ignores my prompt" report). Veo 3.1 asset
          // references require the full model and an 8-second clip.
          this.modelName = 'veo-3.1-generate-001';
          config.durationSeconds = 8;
          config.referenceImages = [{
            image: { imageBytes: imageBase64, mimeType: imageMimeType },
            referenceType: 'asset',
          }];
        }
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let operation: any;
        if (operationName) {
           logger.info({ operationName }, '[VideoGenerationWorker] Checking existing image-to-video generation status');
           operation = await this.getOperationViaRestApi(operationName);
        } else {
           logger.info({ configKeys: Object.keys(config), imageRole: useAsReference ? 'reference' : 'start_frame' }, '[VideoGenerationWorker] Sending new image-to-video generation request via SDK');
           try {
             operation = await ai.models.generateVideos({
               model: this.modelName,
               prompt: finalPrompt,
               ...(useAsReference ? {} : {
                 image: {
                   imageBytes: imageBase64,
                   mimeType: imageMimeType,
                 },
               }),
               ...(Object.keys(config).length > 0 ? { config } : {}),
             });
           // eslint-disable-next-line @typescript-eslint/no-explicit-any
           } catch (sdkErr: any) {
             // SDK failed (likely v1beta API issue), fall back to REST API
             logger.warn({ err: sdkErr.message }, '[VideoGenerationWorker] SDK generateVideos failed for image, trying REST API fallback');
             operation = useAsReference
               ? await this.generateViaRestApi(finalPrompt, config)
               : await this.generateViaRestApi(finalPrompt, config, imageBase64, imageMimeType);
           }
        }

        if (!operation.done) {
          logger.info({ operationName: operation.name || operationName }, '[VideoGenerationWorker] Video generation pending, suspending worker...');
          return {
            success: true,
            status: 'pending',
            operationName: operation.name || operationName,
          };
        }

        // Get the generated video
        const generatedVideos = operation.response?.generatedVideos;
        if (!generatedVideos || generatedVideos.length === 0) {
          logger.warn({ response: JSON.stringify(operation.response || {}).substring(0, 500) }, '[VideoGenerationWorker] Operation done but no videos in response');
          const providerError = videoOperationError(operation);
          if (providerError) throw providerError;
          throw new Error('No video generated — the model may have rejected the prompt or config');
        }

        const video = generatedVideos[0].video;
        
        // Log what's available in the video object for debugging
        logger.info({ 
          hasUri: !!video?.uri,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hasVideoBytes: !!(video as any)?.videoBytes,
          videoKeys: video ? Object.keys(video) : [],
        }, '[VideoGenerationWorker] Image-to-video object details');
        
        // Extract usage metadata if available from operation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = operation.metadata as any;
        const usageMetadata = meta?.usageMetadata ? {
          promptTokens: meta.usageMetadata.promptTokenCount || 0,
          candidatesTokens: meta.usageMetadata.candidatesTokenCount || 0,
          totalTokens: meta.usageMetadata.totalTokenCount || 0,
        } : undefined;

        // Download and save video to disk
        let savedUrl: string | undefined;
        let mediaProbe: import('../services/media/MediaTranscodingService.js').MediaProbe | undefined;
        const responseId = Date.now().toString();
        const fileName = `generated-video-${responseId}.mp4`;

        if (video?.uri) {
          try {
            const videoResponse = await fetch(video.uri);
            if (videoResponse.ok) {
              const arrayBuffer = await videoResponse.arrayBuffer();
              const videoBuffer = Buffer.from(arrayBuffer);
              const saved = await this.saveGeneratedVideo(videoBuffer, fileName, videoConfig?.brandLogoUrl);
              savedUrl = saved.url;
              mediaProbe = saved.mediaProbe;
              logger.info({ fileName: saved.fileName, url: saved.url }, '[VideoGenerationWorker] Video saved to disk from URI');
            } else {
              logger.warn({ status: videoResponse.status }, '[VideoGenerationWorker] Failed to download video from URI');
              savedUrl = video.uri;
            }
          } catch (downloadErr) {
            logger.warn({ err: downloadErr }, '[VideoGenerationWorker] Failed to download video, returning URI directly');
            savedUrl = video.uri;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } else if ((video as any)?.videoBytes) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bytes = (video as any).videoBytes;
            const videoBuffer = typeof bytes === 'string' ? Buffer.from(bytes, 'base64') : Buffer.from(bytes);
            const saved = await this.saveGeneratedVideo(videoBuffer, fileName, videoConfig?.brandLogoUrl);
            savedUrl = saved.url;
            mediaProbe = saved.mediaProbe;
            logger.info({ fileName: saved.fileName, url: saved.url }, '[VideoGenerationWorker] Video saved to disk from bytes');
          } catch (bytesErr) {
            logger.warn({ err: bytesErr }, '[VideoGenerationWorker] Failed to save video from bytes');
          }
        }

        if (!savedUrl || !mediaProbe) throw new Error('Generated video could not be saved and validated for publication. Retry media processing.');
        logger.info({ fileName, savedUrl, hasVideo: !!video, usageMetadata }, '[VideoGenerationWorker] Image-to-video generation complete');

        // Track usage with actual cost data for image-to-video
        if (this.userId) {
          const configDuration = videoConfig?.durationSeconds || undefined;
          await this.trackUsage(prompt, 'video_generation', true, 1, undefined, usageMetadata, configDuration);
        } else {
          logger.warn('[VideoGenerationWorker] Skipping credit tracking (image-to-video) — userId not set');
        }

        return {
          success: true,
          videoUrl: savedUrl || video?.uri || undefined,
          mediaProbe,
          mimeType: 'video/mp4',
          fileName,
          branding: this.appliedBranding,
          usageMetadata,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        logger.error({ err: error, attempt: attempt + 1 }, '[VideoGenerationWorker] Error on attempt');
        
        if (isRateLimitError(error)) {
          logger.warn({ attempt: attempt + 1 }, '[VideoGenerationWorker] Rate limit, trying fallback...');
          const hasNext = await this.handleRateLimitAndGetNextKey();
          
          if (hasNext) {
            continue;
          }
          
          throw new Error('All Gemini API keys have hit rate limits.');
        }

        if (isRetryableVideoProviderError(error) && attempt < maxRetries - 1) {
          logger.warn(
            { attempt: attempt + 1, providerCode: error?.providerCode },
            '[VideoGenerationWorker] Transient provider failure; starting a fresh image-to-video operation',
          );
          operationName = undefined;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }
        
        throw error;
      }
    }
    
    return {
      success: false,
      error: lastError?.message || 'Max retries reached for video generation',
    };
  }

  /**
   * Start video generation and return for tracking
   * Use this for async workflows
   */
  async startGeneration(request: VideoGenerationRequest): Promise<{ success: boolean; operationName?: string; error?: string }> {
    try {
      logger.info('[VideoGenerationWorker] Starting video generation');
      const result = await this.generate(request);
      return result.success
        ? { success: true, operationName: result.operationName }
        : { success: false, error: result.error || 'Unable to start video generation' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[VideoGenerationWorker] Error starting video generation');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Main generate method that routes based on input type
   */
  async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    try {
      // Set userId and threadId from request so trackUsage() can deduct credits
      if (request.userId) {
        this.userId = request.userId;
      }
      if (request.threadId) {
        this.threadId = request.threadId;
      }

      logger.info('[VideoGenerationWorker] Processing video generation request');

      const { prompt, image, operationName, videoConfig } = request;

      if (image) {
        return await this.generateFromImage(prompt, image.base64Data, image.mimeType, videoConfig, operationName);
      } else {
        return await this.generateFromText(prompt, videoConfig, operationName);
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[VideoGenerationWorker] Error in generate');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Track Gemini API usage for video generation - calculates cost from actual model pricing + admin margin
   */
  private async trackUsage(
    prompt: string,
    operationType: string,
    success: boolean,
    videosGenerated: number = 0,
    errorMessage?: string,
    usageMetadata?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number },
    durationSeconds?: number,
    resolution?: string
  ): Promise<void> {
    logger.info({ userId: this.userId, videosGenerated, operationType, success }, '[VideoGenerationWorker] trackUsage called');
    try {
      const { getVideoCostWithMarginUSD } = await import('../models/apiPricing/functions.js');
      const { getRechargeRate, getUsageRate } = await import('../models/creditPricing/functions.js');

      // Calculate actual cost based on model pricing (per second) + resolution tier + admin margin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const videoResolution = resolution as any;
      const costInfo = await getVideoCostWithMarginUSD(this.modelName, durationSeconds, videoResolution);
      const originalCostUSD = costInfo.baseCostUSD * videosGenerated;
      const totalCostUSD = costInfo.totalCostUSD * videosGenerated;
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
        videosGenerated,
        costCents: originalCostCents.toFixed(8),
        threadId: this.threadId ?? null,
        resolution: resolution ?? null,
        service: 'video_worker',
        purpose: 'video_generation',
        status: success ? 'success' : 'error',
        errorMessage,
        inputTokens: usageMetadata?.promptTokens,
        outputTokens: usageMetadata?.candidatesTokens,
        metadata: {
          threadId: this.threadId,
          resolution,
          durationSeconds: costInfo.durationSeconds,
          baseCostUSD: costInfo.baseCostUSD,
          marginPct: costInfo.marginPct,
          totalCostUSD,
          totalCredits,
          promptTokens: usageMetadata?.promptTokens,
          completionTokens: usageMetadata?.candidatesTokens,
        },
      });

      // Deduct credits based on actual model cost + margin
      if (this.userId && videosGenerated > 0 && totalCredits > 0) {
        const { creditService } = await import('../services/CreditService.js');
        const deduction = await creditService.deductForEvent({
          userId: this.userId,
          eventKey: 'api_gemini',
          description: `Video generation (${videosGenerated} videos, ${this.modelName}, ${costInfo.durationSeconds}s${resolution ? `, ${resolution}` : ''}) - ₹${(totalCostUSD * getUsdToInrRate()).toFixed(2)}${costInfo.marginPct > 0 ? ` including ${costInfo.marginPct}% margin` : ''}`,
          service: 'VideoGenerationWorker',
          apiProvider: 'gemini_video',
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
            videosGenerated,
            durationSeconds: costInfo.durationSeconds,
            resolution,
            baseCostUSD: costInfo.baseCostUSD,
            marginPct: costInfo.marginPct,
            totalCostUSD,
            originalCostUSD,
            totalCredits,
            threadId: this.threadId,
            promptTokens: usageMetadata?.promptTokens,
            completionTokens: usageMetadata?.candidatesTokens,
          },
        });
        if (!deduction.success) throw new Error(deduction.error || 'Video usage charge was not completed');
        logger.info({ userId: this.userId, threadId: this.threadId, videosGenerated, model: this.modelName, resolution, durationSeconds: costInfo.durationSeconds, baseCostUSD: costInfo.baseCostUSD, marginPct: costInfo.marginPct, totalCostUSD, totalCredits }, '[VideoGenerationWorker] Cost-based credits deducted for video generation');
      }
    } catch (err) {
      logger.error({ err }, '[VideoGenerationWorker] Failed to track usage');
      // Don't throw - usage tracking failure shouldn't break video generation
    }
  }

  /**
   * Download video from URL, save to disk, and return local URL
   */
  async downloadVideo(videoUrl: string): Promise<{ success: boolean; videoData?: string; localUrl?: string; error?: string }> {
    try {
      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const videoData = buffer.toString('base64');
      
      // Save video to disk
      const { url: localUrl, fileName } = await saveBufferFile(
        buffer,
        'generated-video.mp4',
        'videos',
        'generated',
        this.userId
      );
      
      logger.info({ fileName }, '[VideoGenerationWorker] Video saved to disk');
      
      return {
        success: true,
        videoData, // Keep base64 for backward compatibility
        localUrl,  // New: local URL to saved file
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[VideoGenerationWorker] Error downloading video');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check status of a video generation operation via REST API
   * Falls back to REST polling since the SDK's getVideosOperation has issues
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getOperationViaRestApi(operationName: string): Promise<any> {
    const serviceAccount = loadVertexServiceAccount();
    if (!serviceAccount) throw new Error('No service account is available for video polling');

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.createJwt(serviceAccount),
      }),
    });
    if (!tokenResponse.ok) throw new Error(`Unable to authenticate video polling (${tokenResponse.status})`);
    const { access_token } = await tokenResponse.json() as { access_token: string };
    const resourceName = operationName.split('/operations/')[0];
    if (!resourceName || resourceName === operationName) throw new Error('Invalid video operation name');
    const response = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${resourceName}:fetchPredictOperation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationName }),
    });
    if (!response.ok) throw new Error(`Unable to poll video operation (${response.status})`);
    // Convert the raw Vertex predict response to the shape used by the SDK so
    // the completion/save path remains identical for SDK- and REST-started jobs.
    const operation = await response.json() as {
      response?: { videos?: Array<{ gcsUri?: string; bytesBase64Encoded?: string; mimeType?: string }> };
      [key: string]: unknown;
    };
    if (operation.response?.videos) {
      return {
        ...operation,
        response: {
          ...operation.response,
          generatedVideos: operation.response.videos.map((video) => ({
            video: {
              uri: video.gcsUri,
              videoBytes: video.bytesBase64Encoded,
              mimeType: video.mimeType,
            },
          })),
        },
      };
    }
    return operation;
  }

  async checkStatus(operationName: string, requestedLogoUrl?: string | null): Promise<VideoGenerationStatus> {
    try {
      const ai = await this.getAI();
      
      // Try SDK method first
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const op = await ai.operations.getVideosOperation({ operation: { name: operationName } as any });
        if (op?.done) {
          const generatedVideos = op.response?.generatedVideos;
          // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
          if (generatedVideos?.length > 0) {
            // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
            const video = generatedVideos[0].video;
            let savedUrl: string | undefined;
            let mediaProbe: import('../services/media/MediaTranscodingService.js').MediaProbe | undefined;
            
            if (video?.uri) {
              try {
                const videoResponse = await fetch(video.uri);
                if (videoResponse.ok) {
                  const arrayBuffer = await videoResponse.arrayBuffer();
                  const videoBuffer = Buffer.from(arrayBuffer);
                  const fileName = `generated-video-${Date.now()}.mp4`;
                  const saved = await this.saveGeneratedVideo(videoBuffer, fileName, requestedLogoUrl);
                  savedUrl = saved.url;
                  mediaProbe = saved.mediaProbe;
                }
              } catch {
                savedUrl = video.uri;
              }
            } else if (video?.videoBytes) {
              const videoBuffer = Buffer.from(video.videoBytes, 'base64');
              const fileName = `generated-video-${Date.now()}.mp4`;
              const saved = await this.saveGeneratedVideo(videoBuffer, fileName, requestedLogoUrl);
              savedUrl = saved.url;
              mediaProbe = saved.mediaProbe;
            }
            
            if (!savedUrl || !mediaProbe) throw new Error('Generated video could not be saved and validated for publication. Retry media processing.');
            return {
              done: true,
              operationName,
              videoUrl: savedUrl || video?.uri || undefined,
              mediaProbe,
              branding: this.appliedBranding,
            };
          }
          return { done: true, operationName, error: 'No video in response' };
        }
        return { done: false, operationName };
      } catch (sdkErr) {
        // SDK method failed, fall through to REST API polling
        logger.debug({ err: sdkErr }, '[VideoGenerationWorker] SDK poll failed, using REST API');
      }
      
      const data = await this.getOperationViaRestApi(operationName);
      
      if (data.done) {
        // Extract video from response
        const generatedVideos = data.response?.generatedVideos;
        if (generatedVideos?.length > 0) {
          const video = generatedVideos[0].video;
          let savedUrl: string | undefined;
          let mediaProbe: import('../services/media/MediaTranscodingService.js').MediaProbe | undefined;
          
          if (video?.uri) {
            try {
              const videoResponse = await fetch(video.uri);
              if (videoResponse.ok) {
                const arrayBuffer = await videoResponse.arrayBuffer();
                const videoBuffer = Buffer.from(arrayBuffer);
                const fileName = `generated-video-${Date.now()}.mp4`;
                const saved = await this.saveGeneratedVideo(videoBuffer, fileName, requestedLogoUrl);
                savedUrl = saved.url;
                mediaProbe = saved.mediaProbe;
              }
            } catch {
              savedUrl = video.uri;
            }
          } else if (video?.videoBytes) {
            const videoBuffer = Buffer.from(video.videoBytes, 'base64');
            const fileName = `generated-video-${Date.now()}.mp4`;
            const saved = await this.saveGeneratedVideo(videoBuffer, fileName, requestedLogoUrl);
            savedUrl = saved.url;
            mediaProbe = saved.mediaProbe;
          }
          
          if (!savedUrl || !mediaProbe) throw new Error('Generated video could not be saved and validated for publication. Retry media processing.');
          return {
            done: true,
            operationName,
            videoUrl: savedUrl || video?.uri || undefined,
            mediaProbe,
            branding: this.appliedBranding,
          };
        }
        return { done: true, operationName, error: data.error ? JSON.stringify(data.error) : 'No video in response' };
      }
      
      return { done: false, operationName };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[VideoGenerationWorker] Error checking video status');
      return {
        done: true,
        operationName,
        error: error.message,
      };
    }
  }

  /**
   * Create a JWT for Google Cloud authentication
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createJwt(serviceAccount: any): string {
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base64url = (data: any) => Buffer.from(JSON.stringify(data)).toString('base64url');
    const signingInput = `${base64url(header)}.${base64url(payload)}`;
    
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');
    
    return `${signingInput}.${signature}`;
  }

  /**
   * Generate video via REST API (fallback when SDK fails)
   * Uses the correct v1 API endpoint for Vertex AI
   * Tries multiple models if the primary fails
   */
  private async generateViaRestApi(
    prompt: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: Record<string, any>,
    imageBase64?: string,
    imageMimeType?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const serviceAccount = loadVertexServiceAccount();
    if (!serviceAccount) {
      throw new Error('No service account for REST API fallback');
    }

    // Get access token via JWT
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.createJwt(serviceAccount),
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get access token: ${tokenResponse.status}`);
    }

    const { access_token } = await tokenResponse.json() as { access_token: string };

    // Build request body for Veo predictLongRunning
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance: any = {};
    if (prompt) instance.prompt = prompt;
    if (imageBase64) {
      instance.image = {
        bytesBase64Encoded: imageBase64,
        mimeType: imageMimeType || 'image/jpeg',
      };
    }
    if (Array.isArray(config.referenceImages) && config.referenceImages.length > 0) {
      instance.referenceImages = config.referenceImages.map((reference: { image?: { imageBytes?: string; mimeType?: string }; referenceType?: string }) => ({
        image: {
          bytesBase64Encoded: reference.image?.imageBytes,
          mimeType: reference.image?.mimeType || 'image/png',
        },
        referenceType: String(reference.referenceType || 'asset').toLowerCase(),
      }));
    }
    instances.push(instance);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parameters: any = {};
    if (config.numberOfVideos !== undefined) parameters.numberOfVideos = config.numberOfVideos;
    if (config.durationSeconds !== undefined) parameters.durationSeconds = config.durationSeconds;
    if (config.aspectRatio) parameters.aspectRatio = config.aspectRatio;
    if (config.personGeneration) parameters.personGeneration = config.personGeneration;
    if (config.negativePrompt) parameters.negativePrompt = config.negativePrompt;
    if (config.seed !== undefined) parameters.seed = config.seed;
    if (config.resolution) parameters.resolution = config.resolution;
    if (config.generateAudio !== undefined) parameters.generateAudio = config.generateAudio;

    const projectId = serviceAccount.project_id;
    const location = 'us-central1';

    // Try multiple models in order of preference
    const modelsToTry = config.referenceImages?.length
      ? ['veo-3.1-generate-001']
      : [this.modelName, 'veo-3.1-generate-001'];
    const uniqueModels = [...new Set(modelsToTry)];

    for (const model of uniqueModels) {
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
      
      logger.info({ url, model }, '[VideoGenerationWorker] Trying REST API for video generation');

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ instances, parameters }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          logger.warn({ model, status: response.status, error: errorBody }, '[VideoGenerationWorker] REST API failed for model');
          continue; // Try next model
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await response.json() as any;
        
        // Update modelName to the one that worked
        this.modelName = model;
        
        // The REST API returns the operation directly
        return {
          name: data.name,
          done: data.done || false,
          response: data.response,
          metadata: data.metadata,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.warn({ model, err: err.message }, '[VideoGenerationWorker] REST API call failed');
        continue;
      }
    }

    throw new Error(`All video generation models failed. Tried: ${uniqueModels.join(', ')}`);
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
        message: 'Video generation worker is ready (Veo 3.1)',
      };
    } else {
      return {
        configured: false,
        message: 'Gemini Video API key is not configured. Please ask your admin to add it in Admin Panel → Integrations → Gemini Video.',
      };
    }
  }
}

// Export factory function instead of singleton
export const createVideoGenerationWorker = (userId?: number, threadId?: number) => new VideoGenerationWorker(userId, threadId);
// Legacy singleton for backward compatibility (uses env variable only)
export const videoGenerationWorker = new VideoGenerationWorker();
