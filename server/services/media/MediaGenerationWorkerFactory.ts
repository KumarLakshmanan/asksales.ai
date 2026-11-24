import {
  ImageGenerationWorker,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from '../../tools/imageGenerationWorker.js';
import {
  VideoGenerationWorker,
  type VideoGenerationRequest,
  type VideoGenerationResult,
  type VideoGenerationStatus,
} from '../../tools/videoGenerationWorker.js';
import { OpenRouterImageGenerationWorker } from '../../tools/openRouterImageGenerationWorker.js';
import { OpenRouterVideoGenerationWorker } from '../../tools/openRouterVideoGenerationWorker.js';
import { assertValidVideoReview } from './VideoReviewPolicy.js';
import {
  friendlyVideoProviderError,
  normalizeVideoImageRole,
  prepareVideoInputImage,
  VideoInputImageError,
} from './VideoInputImage.js';
import {
  resolveMediaProviderSelection,
  resolveImageAuthenticationFallback,
  getImageModelCapabilities,
  type MediaProviderSelection,
} from './MediaProviderRegistry.js';
import { prepareImageSettings } from '../../../shared/imageSettings.js';
import { logger } from '../../utils/logger.js';

export type { ImageGenerationRequest, ImageGenerationResult, VideoGenerationRequest, VideoGenerationResult, VideoGenerationStatus };

const videoStatusChecks = new Map<string, Promise<VideoGenerationStatus>>();
const COMPLETED_VIDEO_STATUS_CACHE_MS = 30_000;

function videoStatusCheckKey(
  userId: number | undefined,
  operationName: string,
  selection: MediaProviderSelection,
  requestedLogoUrl?: string | null,
) {
  return [userId ?? 'anonymous', selection.provider, selection.model, operationName, requestedLogoUrl ?? 'default-logo'].join(':');
}

function selectionFromOperation(operationName?: string): Partial<MediaProviderSelection> | undefined {
  if (!operationName?.startsWith('openrouter/')) return undefined;
  const [, encodedModel] = operationName.split('/');
  if (!encodedModel || operationName.split('/').length < 3) return { provider: 'openrouter' };
  try {
    const model = Buffer.from(encodedModel, 'base64url').toString('utf8');
    return model && model.length <= 200 ? { provider: 'openrouter', model } : { provider: 'openrouter' };
  } catch {
    return { provider: 'openrouter' };
  }
}

export class MediaImageGenerationWorker {
  constructor(
    private readonly userId?: number,
    private readonly threadId?: number,
    private readonly _explicit?: Partial<MediaProviderSelection>,
  ) {}

  private async worker() {
    const selection = await resolveMediaProviderSelection('image', this.userId);
    const worker = selection.provider === 'openrouter'
      ? new OpenRouterImageGenerationWorker(this.userId, this.threadId, selection.model)
      : new ImageGenerationWorker(this.userId, this.threadId, selection.model);
    return { worker, selection };
  }

  /**
   * Match the requested ratio and resolution to what the selected model
   * accepts, so an unsupported value (for example 4K on Seedream 5.0 Pro, or
   * 4:5 on Gemini) is mapped to the nearest one instead of failing or being
   * silently dropped by the provider.
   */
  private async prepareConfig(
    selection: MediaProviderSelection,
    prompt: string,
    imageConfig?: Record<string, unknown>,
  ) {
    const settings = prepareImageSettings(
      { aspectRatio: imageConfig?.aspectRatio, imageSize: imageConfig?.imageSize, prompt },
      await getImageModelCapabilities(selection),
    );
    const { imageSize: _requestedSize, ...rest } = imageConfig || {};
    const { aspectRatio: _requestedRatio, ...unsized } = rest;
    const config: Record<string, unknown> = { ...unsized };
    if (settings.aspectRatio) config.aspectRatio = settings.aspectRatio;
    if (settings.imageSize) config.imageSize = settings.imageSize;
    if (settings.adjustments.length) logger.info({ ...selection, adjustments: settings.adjustments }, 'Adjusted image settings to the model capabilities');
    return { config, settings };
  }

  private async generateWithAuthenticationFallback(
    prompt: string,
    imageConfig: Record<string, unknown> | undefined,
    invokeWith: (worker: ImageGenerationWorker | OpenRouterImageGenerationWorker, config: Record<string, unknown>) => Promise<ImageGenerationResult>,
  ): Promise<ImageGenerationResult> {
    const { worker, selection } = await this.worker();
    const prepared = await this.prepareConfig(selection, prompt, imageConfig);
    const invoke = (target: ImageGenerationWorker | OpenRouterImageGenerationWorker) => invokeWith(target, prepared.config);
    const authenticationFailure = (message: string) => /UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|API key (?:not valid|is invalid)|invalid[_ ]api[_ ]key/i.test(message);
    let result: ImageGenerationResult;
    try { result = await invoke(worker); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!authenticationFailure(message)) throw error;
      result = { success: false, error: message };
    }
    // Authentication failure means no image was produced. Never retry policy,
    // moderation, validation or ambiguous successful-provider outcomes elsewhere.
    const authenticationFailed = !result.success && authenticationFailure(result.error || '');
    if (!authenticationFailed) return { ...result, ...selection, imageSettings: prepared.settings };
    const fallback = await resolveImageAuthenticationFallback(selection.provider);
    if (!fallback) return { ...result, ...selection, imageSettings: prepared.settings };
    logger.warn({ fromProvider: selection.provider, toProvider: fallback.provider }, 'Retrying image generation with an active integration after authentication failed');
    const fallbackWorker = fallback.provider === 'openrouter'
      ? new OpenRouterImageGenerationWorker(this.userId, this.threadId, fallback.model)
      : new ImageGenerationWorker(this.userId, this.threadId, fallback.model);
    // The fallback model has its own limits; match the original request to them.
    const fallbackPrepared = await this.prepareConfig(fallback, prompt, imageConfig);
    return { ...(await invokeWith(fallbackWorker, fallbackPrepared.config)), ...fallback, fallbackFrom: selection.provider, imageSettings: fallbackPrepared.settings };
  }

  async generateFromText(prompt: string, imageConfig?: Record<string, unknown>) {
    return this.generateWithAuthenticationFallback(prompt, imageConfig, (worker, config) => worker.generateFromText(prompt, config));
  }

  async generateFromImage(prompt: string, imageBase64: string, imageMimeType = 'image/jpeg', imageConfig?: Record<string, unknown>) {
    return this.generateWithAuthenticationFallback(prompt, imageConfig, (worker, config) => worker.generateFromImage(prompt, imageBase64, imageMimeType, config));
  }

  async generateFromMultipleImages(prompt: string, images: Array<{ base64Data: string; mimeType: string }>, imageConfig?: Record<string, unknown>) {
    return this.generateWithAuthenticationFallback(prompt, imageConfig, (worker, config) => worker.generateFromMultipleImages(prompt, images, config));
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return this.generateWithAuthenticationFallback(request.prompt, request.imageConfig, (worker, config) =>
      worker.generate({ ...request, imageConfig: config as ImageGenerationRequest['imageConfig'] }));
  }

  async isConfigured() { return (await this.worker()).worker.isConfigured(); }
  async getStatus() { return (await this.worker()).worker.getStatus(); }
}

export class MediaVideoGenerationWorker {
  constructor(
    private readonly userId?: number,
    private readonly threadId?: number,
    private readonly _explicit?: Partial<MediaProviderSelection>,
  ) {}

  private async worker(operationName?: string) {
    const operationSelection = selectionFromOperation(operationName);
    const selection = operationSelection?.provider && operationSelection.model
      ? operationSelection as MediaProviderSelection
      : operationName && this._explicit?.provider && this._explicit?.model
        ? this._explicit as MediaProviderSelection
      : await resolveMediaProviderSelection('video', this.userId);
    const worker = selection.provider === 'openrouter'
      ? new OpenRouterVideoGenerationWorker(this.userId, this.threadId, selection.model)
      : new VideoGenerationWorker(this.userId, this.threadId, selection.model);
    return { worker, selection };
  }

  private async validateConfig(config?: Record<string, unknown>) {
    await assertValidVideoReview({ aspect_ratio: config?.aspectRatio, resolution: config?.resolution, duration_seconds: config?.durationSeconds, number_of_videos: config?.numberOfVideos }, this.userId);
  }

  /**
   * Shared submission preparation for every provider and model:
   * - the uploaded image is validated and enlarged/padded to provider minimums,
   * - the prompt keeps the user's request first and says how the image is used,
   * - the model is told not to draw logos/brand text (the real logo is overlaid).
   * Polling requests (operationName set) are passed through untouched.
   */
  private async prepare(request: VideoGenerationRequest): Promise<VideoGenerationRequest> {
    if (request.operationName) return request;
    const videoConfig = { ...(request.videoConfig || {}) };
    const imageRole = normalizeVideoImageRole(videoConfig.imageRole);
    let image = request.image;
    if (image) {
      const prepared = await prepareVideoInputImage(image, { role: imageRole, aspectRatio: videoConfig.aspectRatio });
      image = { base64Data: prepared.base64Data, mimeType: prepared.mimeType };
      videoConfig.imageRole = imageRole;
    }
    const { resolveApprovedBrandLogoUrl } = await import('../content/BrandMediaComposer.js');
    const { adaptBrandContextForVideo, brandNamesFromContext, buildVideoBrandPrompt } = await import('./BrandVideoOverlay.js');
    const logoUrl = await resolveApprovedBrandLogoUrl(this.userId, videoConfig.brandLogoUrl).catch(() => undefined);
    const prompt = buildVideoBrandPrompt(adaptBrandContextForVideo(String(request.prompt || ''), Boolean(logoUrl)), {
      logoOverlay: Boolean(logoUrl),
      brandNames: brandNamesFromContext(request.prompt),
      imageRole: image ? imageRole : undefined,
    });
    return { ...request, prompt, image, videoConfig };
  }

  private async run(request: VideoGenerationRequest, call: (worker: VideoGenerationWorker | OpenRouterVideoGenerationWorker, prepared: VideoGenerationRequest) => Promise<VideoGenerationResult>): Promise<VideoGenerationResult> {
    if (!request.operationName) await this.validateConfig(request.videoConfig as Record<string, unknown> | undefined);
    let prepared: VideoGenerationRequest;
    try {
      prepared = await this.prepare(request);
    } catch (error) {
      if (error instanceof VideoInputImageError) return { success: false, status: 'failed', error: error.message };
      throw error;
    }
    const { worker, selection } = await this.worker(request.operationName);
    const result = await call(worker, prepared);
    return { ...result, error: friendlyVideoProviderError(result.error), ...selection };
  }

  async generateFromText(prompt: string, videoConfig?: Record<string, unknown>, operationName?: string) {
    return this.run({ prompt, videoConfig: videoConfig as VideoGenerationRequest['videoConfig'], operationName },
      (worker, prepared) => worker.generateFromText(prepared.prompt, prepared.videoConfig, operationName));
  }

  async generateFromImage(prompt: string, imageBase64: string, imageMimeType = 'image/jpeg', videoConfig?: Record<string, unknown>, operationName?: string) {
    return this.run({ prompt, image: { base64Data: imageBase64, mimeType: imageMimeType }, videoConfig: videoConfig as VideoGenerationRequest['videoConfig'], operationName },
      (worker, prepared) => worker.generateFromImage(prepared.prompt, prepared.image?.base64Data ?? imageBase64, prepared.image?.mimeType ?? imageMimeType, prepared.videoConfig, operationName));
  }

  async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    return this.run(request, (worker, prepared) => worker.generate(prepared));
  }

  async startGeneration(request: VideoGenerationRequest) {
    const result = await this.run({ ...request, operationName: undefined }, async (worker, prepared) => {
      const started = await worker.startGeneration(prepared);
      return { success: started.success, operationName: started.operationName, error: started.error };
    });
    return { success: result.success, operationName: result.operationName, error: result.error, provider: result.provider, model: result.model };
  }

  async checkStatus(operationName: string, requestedLogoUrl?: string | null): Promise<VideoGenerationStatus> {
    const { worker, selection } = await this.worker(operationName);
    const key = videoStatusCheckKey(this.userId, operationName, selection, requestedLogoUrl);
    const existing = videoStatusChecks.get(key);
    if (existing) return existing;

    const check = (async () => ({
      ...(await worker.checkStatus(operationName, requestedLogoUrl)),
      ...selection,
    }))();
    videoStatusChecks.set(key, check);
    void check.then(
      (status) => {
        if (!status.done) {
          if (videoStatusChecks.get(key) === check) videoStatusChecks.delete(key);
          return;
        }
        const timer = setTimeout(() => {
          if (videoStatusChecks.get(key) === check) videoStatusChecks.delete(key);
        }, COMPLETED_VIDEO_STATUS_CACHE_MS);
        timer.unref?.();
      },
      () => {
        if (videoStatusChecks.get(key) === check) videoStatusChecks.delete(key);
      },
    );
    return check;
  }

  async isConfigured() { return (await this.worker()).worker.isConfigured(); }
  async getStatus() { return (await this.worker()).worker.getStatus(); }
}

export const createImageGenerationWorker = (
  userId?: number,
  threadId?: number,
  selection?: Partial<MediaProviderSelection>,
) => new MediaImageGenerationWorker(userId, threadId, selection);

export const createVideoGenerationWorker = (
  userId?: number,
  threadId?: number,
  selection?: Partial<MediaProviderSelection>,
) => new MediaVideoGenerationWorker(userId, threadId, selection);
