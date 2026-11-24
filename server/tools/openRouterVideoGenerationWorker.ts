import { saveBufferFile } from '../utils/fileStorage.js';
import { getAdminOpenRouterKey, updateAdminCredentialUsage } from '../services/adminCredentialsService.js';
import { createGeminiUsage } from '../models/geminiUsages/functions.js';
import { getVideoMarginPercentage } from '../models/apiPricing/functions.js';
import { getRechargeRate, getUsageRate } from '../models/creditPricing/functions.js';
import { getUsdToInrRate, meteredCreditsFromUsd } from '../utils/currency.js';
import { logger } from '../utils/logger.js';
import type { VideoGenerationRequest, VideoGenerationResult, VideoGenerationStatus } from './videoGenerationWorker.js';

interface OpenRouterVideoJob {
  id?: string;
  polling_url?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  generation_id?: string;
  unsigned_urls?: string[];
  usage?: { cost?: number; is_byok?: boolean };
  error?: string | { message?: string };
}

class OpenRouterVideoRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OpenRouterVideoRequestError';
  }
}

function externalJobId(operationName: string): string {
  return operationName.startsWith('openrouter/') ? operationName.split('/').at(-1) || operationName : operationName;
}

function operationName(jobId: string, modelName: string): string {
  return `openrouter/${Buffer.from(modelName).toString('base64url')}/${jobId}`;
}

function errorMessage(error: OpenRouterVideoJob['error']): string | undefined {
  return typeof error === 'string' ? error : error?.message;
}

function isTerminalStatusError(error: unknown): boolean {
  if (!(error instanceof OpenRouterVideoRequestError)) return false;
  return error.status >= 400
    && error.status < 500
    && ![408, 409, 425, 429].includes(error.status);
}

export class OpenRouterVideoGenerationWorker {
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

  private async call(path: string, init?: RequestInit): Promise<{ job: OpenRouterVideoJob; credential: Awaited<ReturnType<OpenRouterVideoGenerationWorker['credential']>>; baseUrl: string }> {
    if(init?.method==='POST')await (await import('../services/insights/PricingService.js')).assertMediaPrice(this.modelName,'openrouter','video');
    const credential = await this.credential();
    const baseUrl = 'https://openrouter.ai/api/v1';
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(process.env.APP_URL ? { 'HTTP-Referer': process.env.APP_URL } : {}),
        'X-Title': 'SalesMarketing Content Studio',
        ...init?.headers,
      },
    });
    const text = await response.text();
    let job: OpenRouterVideoJob = {};
    try { job = text ? JSON.parse(text) as OpenRouterVideoJob : {}; } catch { /* handled below */ }
    if (!response.ok) {
      throw new OpenRouterVideoRequestError(
        errorMessage(job.error) || `OpenRouter video request failed (${response.status})`,
        response.status,
      );
    }
    return { job, credential, baseUrl };
  }

  private async submit(prompt: string, image: VideoGenerationRequest['image'], videoConfig: VideoGenerationRequest['videoConfig'] = {}): Promise<VideoGenerationResult> {
    try {
      // The approved logo is not sent to the model (it redraws and misspells it);
      // it is overlaid on the finished video in checkStatus.
      const negative = videoConfig.negativePrompt?.trim() ? `\n\nAvoid: ${videoConfig.negativePrompt.trim()}` : '';
      const payload: Record<string, unknown> = {
        model: this.modelName,
        // Keep the user's request first; trim trailing context, never the request.
        prompt: `${prompt.slice(0, Math.max(0, 4000 - negative.length))}${negative}`,
      };
      if (videoConfig.durationSeconds !== undefined) payload.duration = videoConfig.durationSeconds;
      if (videoConfig.resolution) payload.resolution = videoConfig.resolution;
      if (videoConfig.aspectRatio) payload.aspect_ratio = videoConfig.aspectRatio;
      if (videoConfig.generateAudio !== undefined) payload.generate_audio = videoConfig.generateAudio;
      if (videoConfig.seed !== undefined) payload.seed = videoConfig.seed;
      if (image && videoConfig.imageRole === 'start_frame') {
        payload.frame_images = [{
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.base64Data}` },
          frame_type: 'first_frame',
        }];
      } else if (image) {
        // Subject/style reference: the prompt directs the scene instead of the
        // model animating the uploaded image as a literal first frame.
        payload.input_references = [{
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.base64Data}` },
        }];
      }
      const { job } = await this.call('/videos', { method: 'POST', body: JSON.stringify(payload) });
      if (!job.id) throw new Error('OpenRouter did not return a video job ID');
      return {
        success: true,
        operationName: operationName(job.id, this.modelName),
        status: job.status === 'completed' ? 'completed' : 'pending',
      };
    } catch (error) {
      logger.error({ err: error, model: this.modelName }, '[OpenRouterVideoGenerationWorker] Submission failed');
      return { success: false, status: 'failed', error: error instanceof Error ? error.message : 'OpenRouter video generation failed' };
    }
  }

  private async trackUsage(jobId: string, prompt: string, usage?: OpenRouterVideoJob['usage'], durationSeconds?: number, resolution?: string) {
    try {
      const baseCostUSD = Number(usage?.cost) > 0 ? Number(usage?.cost) : 0;
      const marginPct = await getVideoMarginPercentage();
      const totalCostUSD = baseCostUSD * (1 + marginPct / 100);
      // rechargeRate values the credits (purchase rate); usageRate converts provider cost into credits.
      const [rechargeRate, usageRate] = await Promise.all([getRechargeRate(), getUsageRate()]);
      const totalCredits = meteredCreditsFromUsd(totalCostUSD, usageRate);
      const usageRecord = await createGeminiUsage({
        userId: this.userId ?? null,
        operationType: 'video_generation',
        model: this.modelName.slice(0, 100),
        prompt: prompt.slice(0, 500),
        videosGenerated: 1,
        costCents: (baseCostUSD * 100).toFixed(8),
        threadId: this.threadId ?? null,
        resolution: resolution || null,
        service: 'openrouter_video_worker',
        purpose: 'video_generation',
        status: baseCostUSD>0?'success':'partial',
        metadata: { provider: 'openrouter', model: this.modelName, jobId, baseCostUSD, marginPct, totalCostUSD, totalCredits, durationSeconds, resolution },
      });
      if (this.userId && totalCredits > 0) {
        const { creditService } = await import('../services/CreditService.js');
        const deduction = await creditService.deductOnceForResource({
          userId: this.userId,
          eventKey: 'api_openrouter',
          description: `OpenRouter video generation (${this.modelName})`,
          service: 'OpenRouterVideoGenerationWorker',
          apiProvider: 'openrouter',
          apiCostCents: baseCostUSD * 100,
          overrideAmount: totalCredits,
          // The media was generated: bill it in full even on a low balance.
          allowOverdraft: true,
          referenceType: 'media_generation',
          referenceId: `openrouter-video:${jobId}`,
          insights:{attemptId:`gemini_usages:${usageRecord.id}`,operationId:`openrouter-video:${jobId}`,process:'media',
            conversation:this.threadId?{kind:'workspace',id:this.threadId}:undefined},
          pricingSnapshot:{version:1,capturedAt:new Date().toISOString(),source:'provider_reported',sourceReference:'openrouter_usage_cost',
            model:this.modelName,provider:'openrouter',providerCostUsd:baseCostUSD.toFixed(8),chargedCostUsd:totalCostUSD.toFixed(8),
            marginPercentage:marginPct,usdToInr:getUsdToInrRate(),creditsPerInr:rechargeRate,usageCreditsPerInr:usageRate,minimumCredits:1,rounding:'ceil_whole'},
          metadata: { provider: 'openrouter', model: this.modelName, jobId, baseCostUSD, marginPct, totalCostUSD, durationSeconds, resolution },
        });
        if(!deduction.success)throw new Error(deduction.error||'Video usage charge was not completed');
      }
    } catch (error) {
      logger.error({ err: error, jobId }, '[OpenRouterVideoGenerationWorker] Failed to track usage');
    }
  }

  async checkStatus(operation: string, requestedLogoUrl?: string | null, context?: { prompt?: string; durationSeconds?: number; resolution?: string }): Promise<VideoGenerationStatus> {
    const jobId = externalJobId(operation);
    try {
      const { job, credential, baseUrl } = await this.call(`/videos/${encodeURIComponent(jobId)}`);
      if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
        return { done: true, operationName: operationName(jobId, this.modelName), error: errorMessage(job.error) || `OpenRouter video job ${job.status}` };
      }
      if (job.status !== 'completed') return { done: false, operationName: operationName(jobId, this.modelName) };
      const contentUrl = job.unsigned_urls?.[0] || `${baseUrl}/videos/${encodeURIComponent(jobId)}/content?index=0`;
      const response = await fetch(contentUrl, {
        signal: AbortSignal.timeout(180_000),
        headers: { Authorization: `Bearer ${credential.apiKey}` },
      });
      if (!response.ok) throw new Error(`Unable to download completed OpenRouter video (${response.status})`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error('OpenRouter returned an empty video file');
      const { applyBrandLogoToVideo } = await import('../services/media/BrandVideoOverlay.js');
      const branded = await applyBrandLogoToVideo(buffer, this.userId, requestedLogoUrl);
      const saved = await saveBufferFile(branded.buffer, `openrouter-video-${jobId}.mp4`, 'videos', 'generated', this.userId);
      if (!saved.mediaProbe) throw new Error('Generated video could not be validated for publication. Retry media processing.');
      await this.trackUsage(jobId, context?.prompt || '', job.usage, context?.durationSeconds, context?.resolution);
      return {
        done: true,
        operationName: operationName(jobId, this.modelName),
        videoUrl: saved.url,
        mediaProbe: saved.mediaProbe,
        branding: branded.branding,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to check OpenRouter video status';
      if (isTerminalStatusError(error)) {
        logger.warn({ err: error, jobId }, '[OpenRouterVideoGenerationWorker] Video job reached a terminal provider error');
        return { done: true, operationName: operationName(jobId, this.modelName), error: message };
      }
      logger.warn({ err: error, jobId }, '[OpenRouterVideoGenerationWorker] Status check failed; job remains retryable');
      return { done: false, operationName: operationName(jobId, this.modelName), error: message };
    }
  }

  async generateFromText(prompt: string, videoConfig?: VideoGenerationRequest['videoConfig'], operation?: string): Promise<VideoGenerationResult> {
    if (!operation) return this.submit(prompt, undefined, videoConfig);
    const status = await this.checkStatus(operation, videoConfig?.brandLogoUrl, { prompt, durationSeconds: videoConfig?.durationSeconds, resolution: videoConfig?.resolution });
    return status.done
      ? status.videoUrl
        ? { success: true, status: 'completed', operationName: status.operationName, videoUrl: status.videoUrl, mediaProbe: status.mediaProbe, mimeType: 'video/mp4', branding: status.branding }
        : { success: false, status: 'failed', operationName: status.operationName, error: status.error }
      : { success: true, status: 'pending', operationName: status.operationName, error: status.error };
  }

  async generateFromImage(prompt: string, imageBase64: string, imageMimeType = 'image/jpeg', videoConfig?: VideoGenerationRequest['videoConfig'], operation?: string) {
    if (operation) return this.generateFromText(prompt, videoConfig, operation);
    return this.submit(prompt, { base64Data: imageBase64, mimeType: imageMimeType }, videoConfig);
  }

  async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    if (request.image) {
      return this.generateFromImage(request.prompt, request.image.base64Data, request.image.mimeType, request.videoConfig, request.operationName);
    }
    return this.generateFromText(request.prompt, request.videoConfig, request.operationName);
  }

  async startGeneration(request: VideoGenerationRequest) {
    const result = await this.generate(request);
    return {
      success: result.success,
      operationName: result.operationName,
      error: result.error,
    };
  }

  async isConfigured() {
    try { await this.credential(); return true; } catch { return false; }
  }

  async getStatus() {
    const configured = await this.isConfigured();
    return { configured, message: configured ? `OpenRouter video generation is ready (${this.modelName})` : 'OpenRouter is not configured for video generation.' };
  }
}
