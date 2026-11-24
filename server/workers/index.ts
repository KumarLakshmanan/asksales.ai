/**
 * Tool Worker Processes
 *
 * Separate BullMQ worker processes that consume jobs from queues.
 * Each worker type can be scaled independently.
 *
 * Workers are stateless — they pick up jobs, execute, and report results.
 * Results are persisted to App DB and events are published to Event Bus.
 */

/**
 * Phase 6.10 / TYPE-001: the minimum-shape envelope every BullMQ job in
 * this codebase carries. Each worker narrows this further (e.g.
 * `& { leadId: number; campaignId: number }` for the outreach worker) so
 * reading `job.data.leadId` is type-checked.
 */
export interface BaseJobData {
  userId: number;
  threadId?: number;
  correlationId?: string;
  // Per-tool extras — keys vary, so we leave them open. Workers narrow
  // to a specific shape via intersection types.
  [key: string]: unknown;
}

import { Worker, DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { runCustomerDeliveryJob, holdCustomerDeliveryJob } from '../services/assistants/CustomerDeliveryJobs.js';
import { deliverySetupFailure, throwIfCustomerDeliverySetupRequired } from '../services/assistants/CustomerDeliveryGate.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { eventBus, EVENT_CHANNELS } from '../events/EventBus.js';
import { QUEUE_NAMES, queueRegistry, QUEUE_LIMITERS } from '../queues/index.js';
import { createWorkerLogger } from '../utils/logger.js';
import { queuedMediaConfig } from '../services/media/QueuedMediaConfig.js';
import type { InsertContentAsset } from '../models/contentAssets/schema.js';
import type {
  EmailProviderVariant,
  OfficialProviderChannel,
} from '../services/outreach/ProviderBindingService.js';
import { deliveryOutcomeIsUncertain, toOutreachEmailResult } from '../services/outreach/deliveryOutcome.js';
import { delayRejectedEmail } from '../services/outreach/emailRetry.js';
import { delayRejectedProvider, nextDailyCapacityTime, WHATSAPP_APP_RATE_LIMIT } from '../services/outreach/providerRetry.js';
import {
  sanitizeQueueDiagnosticString,
  sanitizeQueueDiagnosticValue,
} from '../utils/queueDiagnostics.js';

// ─── Worker Registry ────────────────────────────────────────────────────────────

const workers: Map<string, Worker> = new Map();
const WORKER_LOCK_DURATION_MS = 120_000;
/** How long a message waits when its confirmed sending account is connected but not ready (expired token, readiness check). */
const ACCOUNT_NOT_READY_RETRY_MS = 60 * 60_000;
let outreachSenderStarted = false;

type QueuedMediaKind = 'image' | 'video';

/** Whether BullMQ will give up on this job after the current failure. */
function isFinalAttempt(job: Job, err: unknown): boolean {
  return err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

async function updateQueuedMediaAsset(
  job: Job,
  kind: QueuedMediaKind,
  state: 'processing' | 'completed' | 'failed',
  result?: { imageUrl?: string; videoUrl?: string; mediaProbe?: import('../services/media/MediaTranscodingService.js').MediaProbe; mimeType?: string; fileName?: string; operationName?: string; error?: string; provider?: string; model?: string; branding?: { logoApplied: true; logoUrl: string; position: 'bottom-right' }; brandReference?: { logoUrl: string; suppliedToModel: true } },
  /** True only when BullMQ will not retry this job. */
  terminal = false,
): Promise<void> {
  const parentAssetId = Number(job.data.parentAssetId);
  const userId = Number(job.data.userId);
  if (!Number.isSafeInteger(parentAssetId) || parentAssetId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) return;

  const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
  const asset = await ContentAssetModel.findByIdForUser(parentAssetId, userId);
  if (!asset) throw new Error('Parent content asset no longer exists; media generation cannot continue.');
  if (['published', 'scheduled', 'processing'].includes(asset.status)) {
    throw new Error('Cancel or reconcile publishing before attaching generated media to this content.');
  }

  const existingPerformance = asset.performance && typeof asset.performance === 'object'
    ? asset.performance as Record<string, unknown>
    : {};
  const existingMediaGeneration = existingPerformance.mediaGeneration && typeof existingPerformance.mediaGeneration === 'object'
    ? existingPerformance.mediaGeneration as Record<string, unknown>
    : {};
  const mediaState = {
    status: state,
    jobId: String(job.id),
    operationName: result?.operationName,
    provider: result?.provider,
    model: result?.model,
    branding: result?.branding,
    brandReference: result?.brandReference,
    error: state === 'failed' ? result?.error || 'Media generation failed' : undefined,
    updatedAt: new Date().toISOString(),
  };

  const update: Partial<InsertContentAsset> = {
    performance: {
      ...existingPerformance,
      mediaGeneration: { ...existingMediaGeneration, [kind]: mediaState },
    },
  };

  const mediaUrl = kind === 'image' ? result?.imageUrl : result?.videoUrl;
  if (state === 'completed' && mediaUrl) {
    if (asset.status === 'pending') update.status = 'draft';
    let content: Record<string, unknown> = {};
    try {
      const parsed = asset.content ? JSON.parse(asset.content) : {};
      content = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { content: asset.content };
    } catch {
      content = { content: asset.content };
    }
    const pluralKey = kind === 'image' ? 'imageUrls' : 'videoUrls';
    const singularKey = kind === 'image' ? 'imageUrl' : 'videoUrl';
    const generatedKey = kind === 'image' ? 'generatedImage' : 'generatedVideo';
    const contentUrls = Array.isArray(content[pluralKey])
      ? (content[pluralKey] as unknown[]).filter((url): url is string => typeof url === 'string')
      : [];
    if (!contentUrls.includes(mediaUrl)) contentUrls.push(mediaUrl);
    content = {
      ...content,
      [singularKey]: mediaUrl,
      [generatedKey]: mediaUrl,
      [pluralKey]: contentUrls,
    };
    const rootUrls = kind === 'image'
      ? (Array.isArray(asset.imageUrls) ? [...asset.imageUrls] : [])
      : (Array.isArray(asset.videoUrls) ? [...asset.videoUrls] : []);
    if (!rootUrls.includes(mediaUrl)) rootUrls.push(mediaUrl);
    update.content = JSON.stringify(content);
    if (kind === 'image') {
      update.imageUrl = mediaUrl;
      update.imageUrls = rootUrls;
    } else {
      update.videoUrl = mediaUrl;
      update.videoUrls = rootUrls;
      const { withVideoProbeMetadata } = await import('../services/media/MediaTranscodingService.js');
      update.metadata = withVideoProbeMetadata(mediaUrl, result?.mediaProbe, asset.metadata || {});
    }
    update.version = asset.version + 1;
  }
  // A placeholder created only for this media must not keep showing "Rendering"
  // once the job has finally failed (no retry left); drafts that already hold
  // content keep their status. A later successful run lifts it back to draft.
  const existingMedia = kind === 'image' ? asset.imageUrl : asset.videoUrl;
  if (state === 'failed' && terminal && asset.status === 'pending' && !existingMedia) {
    update.status = 'failed';
    update.lastError = mediaState.error;
    update.version = asset.version + 1;
  }
  if (state === 'completed' && mediaUrl && asset.status === 'failed' && !existingMedia) {
    update.status = 'draft';
    update.lastError = null;
  }

  const { updateEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
  const updated = await updateEditableContentAsset(userId, parentAssetId, update);
  if (!updated) throw new Error('Parent content asset changed before queued media could be attached');

  const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter.js');
  // Media generated for a post/email/ad must also appear in the Image/Video
  // gallery. Keyed by the stored file, so BullMQ retries never add a second row.
  if (state === 'completed' && mediaUrl) {
    try {
      const { saveGeneratedMediaToGallery } = await import('../services/media/GeneratedMediaGallery.js');
      const gallery = await saveGeneratedMediaToGallery({
        userId, kind, url: mediaUrl, parent: updated,
        prompt: typeof job.data.prompt === 'string' ? job.data.prompt : undefined,
        provider: result?.provider, model: result?.model, mimeType: result?.mimeType, mediaProbe: result?.mediaProbe,
      });
      if (gallery?.created) webSocketEmitter.emit(userId, 'content_asset_updated', { assetId: gallery.assetId, type: kind, status: 'draft' });
    } catch (galleryErr) {
      createWorkerLogger(`${kind}-generation`).error({ err: galleryErr, jobId: job.id, parentAssetId }, 'Generated media is attached but could not be added to the gallery');
    }
  }
  webSocketEmitter.emit(userId, 'content_asset_updated', {
    assetId: parentAssetId,
    type: job.data.assetType,
    mediaType: kind,
    status: state,
    imageUrl: kind === 'image' ? mediaUrl : undefined,
    videoUrl: kind === 'video' ? mediaUrl : undefined,
    error: mediaState.error,
  });
}

/**
 * Phase 3.7: Emit correlation events for QueueBridge listeners.
 * No-op when the job has no correlationId. Use the same channel naming as
 * the existing image/video/embedding workers (`tool:completed:<id>` / `tool:failed:<id>`)
 * so listeners can subscribe uniformly.
 */
async function emitCorrelationEvent(
  outcome: 'completed' | 'failed',
  correlationId: string | undefined,
  userId: number | undefined,
  threadId: number | undefined,
  data: Record<string, unknown>
): Promise<void> {
  if (!correlationId) return;
  try {
    await eventBus.publish({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: `tool:${outcome}:${correlationId}` as any,
      // @ts-expect-error -- event payload type is narrower than the optional worker identifiers
      userId,
      threadId,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch (err) {
    // Correlation events are best-effort — never break the worker
    createWorkerLogger('events').warn(
      { correlationId, outcome, err },
      'Failed to publish correlation event',
    );
  }
}

// ─── Image Generation Worker ────────────────────────────────────────────────────

async function processImageGeneration(job: Job) {
  const log = createWorkerLogger('image-generation');
  const { userId, prompt, threadId, correlationId } = job.data;
  const brandedPrompt = typeof job.data.brandContext === 'string' && job.data.brandContext.trim()
    ? `${prompt}\n\n${job.data.brandContext}`
    : prompt;

  log.info({ jobId: job.id, userId, prompt: prompt?.substring(0, 50) }, 'Processing image generation');

  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'image_generation',
    executionId: job.id,
  });

  try {
    // Lazy import to avoid loading heavy dependencies at worker startup
    const { createImageGenerationWorker } = await import('../services/media/MediaGenerationWorkerFactory.js');
    const imageGenerationWorker = createImageGenerationWorker(userId, threadId, {
      provider: job.data.provider,
      model: job.data.model,
    });
    const referenceImages = Array.isArray(job.data.referenceImages)
      ? job.data.referenceImages.filter((image: unknown): image is { base64Data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' } => {
        if (!image || typeof image !== 'object') return false;
        const candidate = image as Record<string, unknown>;
        return typeof candidate.base64Data === 'string'
          && candidate.base64Data.length > 0
          && ['image/jpeg', 'image/png', 'image/webp'].includes(String(candidate.mimeType));
      }).slice(0, 8)
      : undefined;
    const result = await imageGenerationWorker.generate({
      prompt: brandedPrompt,
      userId,
      threadId,
      ...(referenceImages?.length ? { images: referenceImages } : {}),
      imageConfig: queuedMediaConfig(job.data, 'image'),
    });
    if (!result.success || !result.imageUrl) throw new Error(result.error || 'Image generation returned no media URL');
    await updateQueuedMediaAsset(job, 'image', 'completed', result);

    await eventBus.emitToolEvent('completed', {
      userId,
      threadId,
      toolName: 'image_generation',
      executionId: job.id,
      data: { result },
    });

    // Emit correlation-specific event for QueueBridge listeners
    if (correlationId) {
      await eventBus.publish({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: `tool:completed:${correlationId}` as any,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { result },
      });
    }

    log.info({ jobId: job.id, userId }, 'Image generation completed');
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    await updateQueuedMediaAsset(job, 'image', 'failed', { error: err.message }, isFinalAttempt(job, err)).catch((assetErr) => {
      log.error({ err: assetErr, jobId: job.id }, 'Failed to record image generation failure on parent asset');
    });
    await eventBus.emitToolEvent('failed', {
      userId,
      threadId,
      toolName: 'image_generation',
      executionId: job.id,
      data: { error: err.message },
    });

    // Emit correlation-specific failure for QueueBridge listeners
    if (correlationId) {
      await eventBus.publish({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: `tool:failed:${correlationId}` as any,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
    }

    throw err;
  }
}

// ─── Video Generation Worker ────────────────────────────────────────────────────

async function processVideoGeneration(job: Job) {
  const log = createWorkerLogger('video-generation');
  const { userId, prompt, threadId, correlationId } = job.data;
  const brandedPrompt = typeof job.data.brandContext === 'string' && job.data.brandContext.trim()
    ? `${prompt}\n\n${job.data.brandContext}`
    : prompt;

  log.info({ jobId: job.id, userId }, 'Processing video generation');

  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'video_generation',
    executionId: job.id,
  });

  try {
    const { createVideoGenerationWorker } = await import('../services/media/MediaGenerationWorkerFactory.js');
    await updateQueuedMediaAsset(job, 'video', 'processing', {
      operationName: job.data.operationName, provider: job.data.provider, model: job.data.model,
    });
    const videoGenerationWorker = createVideoGenerationWorker(userId, threadId, {
      provider: job.data.provider,
      model: job.data.model,
    });
    const { DelayedError } = await import('bullmq');

    const { runDurableVideoJob } = await import('../services/media/DurableVideoJobService.js');
    const result = await runDurableVideoJob(job, (operationName) => videoGenerationWorker.generate({
      prompt: brandedPrompt,
      image: job.data.image,
      userId,
      threadId,
      operationName,
      videoConfig: queuedMediaConfig(job.data, 'video'),
    }));

    if (!result.success) throw new Error(result.error || 'Video generation failed');

    if (result.status === 'pending' && result.operationName) {
      log.info({ jobId: job.id, operationName: result.operationName }, 'Video generation pending, delaying job for 10s');
      
      // Save operation name to job data so next attempt can check status
      job.data.operationName = result.operationName;
      await job.updateData(job.data);
      await updateQueuedMediaAsset(job, 'video', 'processing', result);
      
      // Delay this job by 10 seconds and put it back in the delayed queue
      await job.moveToDelayed(Date.now() + 10000, job.token!);
      throw new DelayedError();
    }

    if (!result.videoUrl) throw new Error('Video generation returned no media URL');
    await updateQueuedMediaAsset(job, 'video', 'completed', result);

    await eventBus.emitToolEvent('completed', {
      userId,
      threadId,
      toolName: 'video_generation',
      executionId: job.id,
      data: { result },
    });

    // Emit correlation-specific event for QueueBridge listeners
    if (correlationId) {
      await eventBus.publish({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: `tool:completed:${correlationId}` as any,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { result },
      });
    }

    log.info({ jobId: job.id, userId }, 'Video generation completed');
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err.name === 'DelayedError') {
      // This is a controlled suspension, do not emit a failed event
      throw err;
    }
    await updateQueuedMediaAsset(job, 'video', 'failed', { error: err.message }, isFinalAttempt(job, err)).catch((assetErr) => {
      log.error({ err: assetErr, jobId: job.id }, 'Failed to record video generation failure on parent asset');
    });
    await eventBus.emitToolEvent('failed', {
      userId,
      threadId,
      toolName: 'video_generation',
      executionId: job.id,
      data: { error: err.message },
    });

    // Emit correlation-specific failure for QueueBridge listeners
    if (correlationId) {
      await eventBus.publish({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: `tool:failed:${correlationId}` as any,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
    }

    throw err;
  }
}

// ─── Knowledge Base Processing Worker ──────────────────────────────────────────

async function processKnowledgeBase(job: Job) {
  const log = createWorkerLogger('knowledge-base');
  const { userId, entryId, storageFileId, jobType, sourceUrl, selectedUrls, threadId, correlationId } = job.data;

  // URL crawl job type
  if (jobType === 'url-crawl') {
    log.info({ jobId: job.id, userId, entryId, urlCount: selectedUrls?.length }, 'Processing KB URL crawl');

    try {
      const { WebsiteCrawlerService } = await import('../services/WebsiteCrawlerService.js');
      const { KnowledgeBaseModel } = await import('../models/index.js');
      const entry = await KnowledgeBaseModel.findById(entryId, userId);
      if (!entry || entry.type !== 'url') {
        throw new Error('Knowledge-base URL entry does not belong to the queued tenant.');
      }

      const crawler = new WebsiteCrawlerService({
        maxPages: selectedUrls.length + 1,
        maxContentLength: 50000,
        timeoutMs: 20000,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages: any[] = [];
      for (let i = 0; i < selectedUrls.length; i += 5) {
        const batch = selectedUrls.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map((pageUrl: string) => crawler.fetchPage(pageUrl))
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.success) {
            pages.push(r.value);
          }
        }
      }

      const combinedContent = crawler.buildContent(pages);
      if (!combinedContent.trim()) {
        throw new Error('No readable content was found on the selected pages');
      }

      // Build per-page chunks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks: any[] = [];
      let charOffset = 0;
      for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i].text || pages[i].markdown || '';
        const pageTitle = pages[i].title || pages[i].url || `Page ${i + 1}`;
        const chunkText = `## ${pageTitle}\nURL: ${pages[i].url}\n\n${pageText}`;
        chunks.push({
          index: i,
          text: chunkText,
          charStart: charOffset,
          charEnd: charOffset + chunkText.length,
          tokenEstimate: Math.ceil(chunkText.length / 4),
          pageUrl: pages[i].url,
        });
        charOffset += chunkText.length + 1;
      }

      // Extract brand styles from raw HTML
      let brandStyles = null;
      try {
        const { extractBrandStyles } = await import('../services/BrandStyleExtractor.js');
        const htmlPages = pages
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((p: any) => p._html)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((p: any) => ({ html: p._html, url: p.url, isHomepage: p.url === sourceUrl }));
        if (htmlPages.length > 0) {
          brandStyles = extractBrandStyles(htmlPages);
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (extractErr: any) {
        log.warn({ err: extractErr.message }, 'Brand style extraction failed, continuing without');
      }

      // Brand styles remain brand-profile data and are never evidence chunks.
      // Searchable vectors are created only by the governed V2 index below
      // (as for file uploads); the old per-entry embeddings were never read.
      const { scanKnowledgeContent } = await import('../services/knowledge/KnowledgePrivacyService.js');
      const privacy = scanKnowledgeContent(combinedContent);
      for (const chunk of chunks) {
        chunk.hasEmbedding = false;
      }
      const embeddingsGenerated = false;
      try {
        const { embeddingService } = await import('../services/embeddings/EmbeddingService.js');
        await embeddingService.deleteBySource(userId, 'knowledge_base', entryId);
      } catch (cleanupErr) {
        log.warn({ err: cleanupErr, userId, entryId }, 'Stale legacy URL embeddings could not be removed');
      }

      const contentJson = JSON.stringify({
        extractedText: combinedContent,
        chunks,
        embeddingsGenerated,
        extractionSource: 'web-crawler',
        extractionWarnings: [
          ...(pages.length < selectedUrls.length ? [`${selectedUrls.length - pages.length} page(s) failed to crawl`] : []),
          ...(privacy.mustQuarantine ? [`Privacy/integrity scan requires quarantine: ${privacy.reasons.join(', ')}`] : []),
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pagesScraped: pages.map((p: any) => ({ url: p.url, title: p.title })),
        brandStyles,
      });

      const completedEntry = await KnowledgeBaseModel.update(entryId, userId, {
        content: contentJson,
        processingStatus: 'completed',
      });
      if (completedEntry) {
        try {
          const { knowledgeIngestionService } = await import('../services/knowledge/KnowledgeIngestionService.js');
          const governed = await knowledgeIngestionService.indexLegacyEntry(completedEntry, { autoPublish: false });
          await KnowledgeBaseModel.update(entryId, userId, { indexingStatus: governed.vectorIndexed ? 'completed' : 'failed' });
        } catch (v2Error) {
          log.warn({ err: v2Error, userId, entryId }, 'V2 URL knowledge version creation failed');
          await KnowledgeBaseModel.update(entryId, userId, { indexingStatus: 'failed' }).catch(() => undefined);
        }
      }

      log.info({ jobId: job.id, entryId, pagesScraped: pages.length }, 'KB URL crawl completed');
      await emitCorrelationEvent('completed', correlationId, userId, threadId, { entryId, pagesScraped: pages.length });
      return { pagesScraped: pages.length, brandStylesExtracted: !!brandStyles };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      log.error({ jobId: job.id, userId, entryId, err: err.message }, 'KB URL crawl failed');
      try {
        const { KnowledgeBaseModel } = await import('../models/index.js');
        await KnowledgeBaseModel.update(entryId, userId, { processingStatus: 'failed' });
      } catch (_) { /* best-effort */ }
      await emitCorrelationEvent('failed', correlationId, userId, threadId, { entryId, error: err.message });
      throw err;
    }
  }

  // Default: file ingestion
  log.info({ jobId: job.id, userId, entryId, storageFileId }, 'Processing knowledge base ingestion');

  try {
    const { processKnowledgeBaseEntryIngestion } = await import('../services/KnowledgeBaseProcessingService.js');
    const result = await processKnowledgeBaseEntryIngestion({ userId, entryId, storageFileId });
    log.info({ jobId: job.id, entryId }, 'Knowledge base ingestion completed');
    await emitCorrelationEvent('completed', correlationId, userId, threadId, { entryId, result });
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    log.error({ jobId: job.id, userId, entryId, err: err.message }, 'Knowledge base ingestion failed');
    await emitCorrelationEvent('failed', correlationId, userId, threadId, { entryId, error: err.message });
    throw err;
  }
}

// ─── Web Scraping Worker ────────────────────────────────────────────────────────

async function processWebScraping(job: Job) {
  const log = createWorkerLogger('web-scraping');
  const { userId, actorId, input, platform, threadId } = job.data;

  log.info({ jobId: job.id, userId, actorId, platform }, 'Processing web scraping');

  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'web_scraping',
    executionId: job.id,
    data: { actorId, platform },
  });

  try {
    const { ApifyService } = await import('../services/agents/ApifyService.js');
    const apifyService = await ApifyService.createWithAdminCredentials();
    const result = await apifyService.runActor({
      actorId,
      input,
      userId,
      threadId,
    });

    await eventBus.emitToolEvent('completed', {
      userId,
      threadId,
      toolName: 'web_scraping',
      executionId: job.id,
      data: { result: { itemCount: result.items?.length || 0, datasetId: result.datasetId } },
    });

    log.info({ jobId: job.id, userId, itemCount: result.items?.length }, 'Web scraping completed');
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    await eventBus.emitToolEvent('failed', {
      userId,
      threadId,
      toolName: 'web_scraping',
      executionId: job.id,
      data: { error: err.message },
    });
    throw err;
  }
}

// ─── Email Sending Worker ───────────────────────────────────────────────────────

export async function processEmailSending(job: Job) {
  const log = createWorkerLogger('email-sending');
  const {
    userId,
    to,
    subject,
    body,
    html,
    replyTo,
    leadId,
    campaignId,
    threadId,
    sequenceStep,
    inReplyTo,
    references,
    gmailThreadId,
    channel,
    isFollowUp,
    followUpStep,
    followUpOriginMessageId,
    followUpMessageId,
    correlationId,
  } = job.data;

  log.info(
    { jobId: job.id, userId, to, subject: subject?.substring(0, 30) },
    'Processing email send',
  );

  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'email_sending',
    executionId: job.id,
  });

  let reservationTransactionId: number | undefined;
  let providerCallStarted = false;
  let providerRejected = false;
  let acceptancePersisted = false;
  let queueClaim:
    | import('../services/outreach/EmailQueueDeliveryService.js').EmailQueueClaim
    | undefined;
  const queueDelivery =
    await import('../services/outreach/EmailQueueDeliveryService.js');
  const queueInput: import('../services/outreach/EmailQueueDeliveryService.js').QueuedEmailInput =
    {
      jobId: String(job.id || ''),
      userId: Number(userId),
      leadId: Number(leadId),
      to: String(to || ''),
      subject,
      body,
      html,
      senderId: job.data.senderId,
      campaignId,
      isFollowUp: isFollowUp === true,
      followUpMessageId: Number(followUpMessageId),
      followUpOriginMessageId: Number(followUpOriginMessageId),
      followUpStep: Number(followUpStep),
      followUpProvenance: job.data.followUpProvenance,
      templateRenderContext: isFollowUp === true
        ? job.data.followUpProvenance?.templateRenderContext
        : job.data.templateRenderContext,
    };

  try {
    const { emailService } = await import('../services/emailService.js');
    const { creditService } = await import('../services/CreditService.js');
    const { OutreachConversationModel } = await import('../models/index.js');
    const intent = await queueDelivery.claimQueuedEmail(queueInput);
    if (!intent.claim)
      return {
        success: intent.success === true,
        duplicate: true,
        inProgress: intent.inProgress,
        uncertain: intent.uncertain,
      };
    queueClaim = intent.claim;
    const configuredSenderId = queueClaim.account.senderId;
    if (queueClaim.recoveredReservationId)
      await creditService.refundDeduction({
        userId,
        transactionId: queueClaim.recoveredReservationId,
        description: `Refund for reclaimed unstarted email ${queueClaim.messageId}`,
      });

    const reservation = await creditService.reserveOutreachCredit({
      userId,
      channel: 'email',
      referenceId: `email-queue:${queueClaim.messageId}:claim:${queueClaim.token}`,
      service: 'EmailSendingWorker',
      messageKind: isFollowUp ? 'follow_up' : undefined,
    });
    if (!reservation.success) {
      throw new Error(
        reservation.error ||
          'Insufficient credits. Recharge your wallet before retrying.',
      );
    }
    reservationTransactionId = reservation.transactionId;
    if (
      !(await queueDelivery.recordQueuedEmailReservation(
        queueClaim,
        reservationTransactionId,
      ))
    ) {
      throw new queueDelivery.EmailQueuePolicyError(
        'The queued email claim was replaced before dispatch.',
      );
    }

    // Only exact RFC Message-ID header values are eligible for threading.
    // Provider API IDs must never be converted into guessed header values.
    const rfcMessageIdPattern = /^<[^<>@\s]+@[^<>\s]+>$/;
    const normalizedInReplyTo =
      typeof inReplyTo === 'string' && rfcMessageIdPattern.test(inReplyTo)
        ? inReplyTo
        : undefined;
    if (inReplyTo && !normalizedInReplyTo) {
      log.warn(
        { inReplyTo },
        'Provider ID supplied as In-Reply-To; dropping invalid threading header',
      );
    }

    const referenceIds =
      typeof references === 'string'
        ? references.match(/<[^<>@\s]+@[^<>\s]+>/g) || []
        : [];
    let normalizedReferences =
      referenceIds.length > 0 ? referenceIds.join(' ') : undefined;

    // If we have no valid references but have a valid inReplyTo, use it as references
    if (!normalizedReferences && normalizedInReplyTo) {
      normalizedReferences = normalizedInReplyTo;
    }

    const parentMessage =
      leadId && normalizedInReplyTo
        ? await OutreachConversationModel.getMessageByExternalId(
            normalizedInReplyTo,
          )
        : undefined;
    let threadConversation = parentMessage
      ? await OutreachConversationModel.getOutreachConversationById(
          parentMessage.conversationId,
        )
      : undefined;
    if (!threadConversation && leadId && gmailThreadId) {
      threadConversation =
        await OutreachConversationModel.getConversationByProviderThread(
          userId,
          leadId,
          'gmail',
          gmailThreadId,
        );
    }

    // Follow-ups keep the brand saved on their outreach thread, never the current default.
    const followUpBrandToolkitId = threadConversation?.brandToolkitId
      ?? await (await import('../services/outreach/WorkflowBrand.js')).outreachMessageBrandToolkitId(userId, followUpOriginMessageId);
    // All asynchronous preparation has finished. Fence cancellation, takeover,
    // settings/template provenance, suppression, quota and ownership here.
    await queueDelivery.assertQueuedEmailFollowUpReady(queueInput);
    const started = await queueDelivery.startQueuedEmailProvider(
      queueInput,
      queueClaim,
    );
    if (!started) {
      if (reservationTransactionId)
        await creditService.refundDeduction({
          userId,
          transactionId: reservationTransactionId,
          description: 'Refund for deferred unstarted queued email',
        });
      reservationTransactionId = undefined;
      await queueDelivery.finishQueuedEmail(
        queueClaim,
        'pending',
        undefined,
        started === null
          ? 'Daily outreach allowance reached.'
          : 'Delivery claim was replaced.',
      );
      if (started === null) {
        await job.moveToDelayed(new Date().setUTCHours(24, 0, 0, 0), job.token);
        throw new DelayedError();
      }
      return { success: false, suppressed: true };
    }
    await queueDelivery.confirmQueuedEmailFollowUp(queueInput);
    providerCallStarted = true;
    const result = await emailService.sendEmailWithUserCredentials(
      userId,
      {
        to,
        subject: threadConversation?.subject || subject,
        text: body,
        html: html || body,
        // Keep the brand saved on this outreach thread (never the current default).
        brandToolkitId: followUpBrandToolkitId,
        replyTo,
        leadId,
        campaignId,
        sequenceStep,
        // Threading info for proper email reply chains:
        // - threadId: Gmail API thread ID (used for Gmail requestBody.threadId)
        // - inReplyTo: RFC5322 Message-ID (used for In-Reply-To header, enables cross-client threading)
        inReplyTo: normalizedInReplyTo || undefined,
        references: normalizedReferences || undefined,
        threadId: gmailThreadId || undefined,
        // Worker creates outreach messages below, so skip duplicate from logSentEmail
        skipConversationLog: true,
        skipCreditDeduction: true,
        templateRenderContext: queueInput.templateRenderContext,
        idempotencyKey: `email-queue:${queueClaim.messageId}`,
        expectedFromEmail: queueClaim.account.fromEmail,
        expectedProviderAccountId: queueClaim.account.providerAccountId,
        expectedCredentialId: queueClaim.account.credentialId,
        // Follow-up flags: ensures logSentEmail marks the record with is_reply=true
        // and follow_up_step, preventing infinite follow-up loops
        isFollowUp: isFollowUp || false,
        followUpStep: followUpStep || undefined,
      },
      configuredSenderId,
    );

    if (result.code === 'ASSISTANT_SETUP_REQUIRED') {
      providerCallStarted = false;
      throwIfCustomerDeliverySetupRequired(result);
    }

    if (!result.success) {
      providerRejected = !deliveryOutcomeIsUncertain(result);
      if (providerRejected && reservationTransactionId) {
        await creditService.refundDeduction({
          userId,
          transactionId: reservationTransactionId,
          description: `Refund for rejected queued email ${String(job.id)}`,
        });
        reservationTransactionId = undefined;
      }
      await queueDelivery.finishQueuedEmail(
        queueClaim,
        providerRejected
          ? result.retryable === true
            ? 'pending'
            : 'failed'
          : 'manual_review',
        undefined,
        result.error,
      );
      await delayRejectedEmail(job, result, async (retryAt) => {
        log.info({ jobId: job.id, retryAt }, 'Queued email retry scheduled');
      });
      if (providerRejected) {
        throw new UnrecoverableError(
          result.error ||
            'Email provider rejected delivery or exhausted its retry budget',
        );
      }
      throw new Error(result.error || 'Email provider rejected the message');
    }
    const { providerMessageId } =
      await import('../services/outreach/deliveryOutcome.js');
    if (!providerMessageId(result.providerMessageId ?? result.messageId))
      throw new Error('Email provider acceptance receipt is unavailable.');
    if (!(await queueDelivery.finishQueuedEmail(queueClaim, 'sent', result)))
      throw new Error(
        'Provider accepted the email but its receipt could not be persisted.',
      );
    acceptancePersisted = true;

    await eventBus.publish({
      channel: EVENT_CHANNELS.OUTREACH_SENT,
      userId,
      threadId,
      timestamp: new Date().toISOString(),
      data: {
        channel: channel || 'email',
        leadId,
        campaignId,
        to,
        messageId: result.messageId,
      },
    });

    // The intent is the only message row. Bookkeeping after acceptance cannot
    // revoke its receipt or create a second generic message on replay.
    try {
      const accepted = await OutreachConversationModel.getOutreachMessageById(
        queueClaim.messageId,
      );
      if (accepted && result.threadId)
        await OutreachConversationModel.updateOutreachConversation(
          accepted.conversationId,
          { externalThreadId: result.threadId },
        );
    } catch (error) {
      log.warn(
        { err: error, jobId: job.id },
        'Accepted email thread bookkeeping needs reconciliation',
      );
    }

    log.info({ jobId: job.id, to }, 'Email sent successfully');
    await emitCorrelationEvent('completed', correlationId, userId, threadId, {
      to,
      messageId: result.messageId,
    });
    return result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof DelayedError) throw err;
    const setup = deliverySetupFailure(err);
    if (setup) {
      if (queueClaim) await queueDelivery.finishQueuedEmail(queueClaim, 'setup_required', undefined, `${setup.code}:${setup.reason}: ${setup.error}`);
      if (reservationTransactionId) {
        const { creditService } = await import('../services/CreditService.js');
        await creditService.refundDeduction({ userId, transactionId: reservationTransactionId, description: 'Refund for queued email blocked by assistant setup' });
      }
      throw err;
    }
    const attempts = Number(job.opts.attempts || 1);
    const finalAttempt =
      err instanceof UnrecoverableError || job.attemptsMade + 1 >= attempts;
    if (acceptancePersisted) return { success: true, accepted: true };
    if (queueClaim)
      await queueDelivery.finishQueuedEmail(
        queueClaim,
        providerCallStarted && !providerRejected
          ? 'manual_review'
          : err instanceof queueDelivery.EmailQueuePolicyError
            ? 'cancelled'
            : finalAttempt
              ? 'failed'
              : 'pending',
        undefined,
        err.message,
      );
    await Promise.allSettled([
      eventBus.emitToolEvent('failed', {
        userId,
        threadId,
        toolName: 'email_sending',
        executionId: job.id,
        data: { error: err.message, to },
      }),
      emitCorrelationEvent('failed', correlationId, userId, threadId, {
        to,
        error: err.message,
      }),
    ]);
    if (providerCallStarted && !providerRejected) {
      // The provider may have accepted the email before the worker lost its
      // acknowledgement. Complete the queue job without retrying to prevent a
      // duplicate send; the retained reservation is available for reconciliation.
      log.error(
        { jobId: job.id, err: err.message },
        'Email delivery outcome is uncertain; automatic retry suppressed',
      );
      return { success: false, uncertain: true, error: err.message };
    }
    if (!providerCallStarted && reservationTransactionId) {
      const { creditService } = await import('../services/CreditService.js');
      await creditService.refundDeduction({
        userId,
        transactionId: reservationTransactionId,
        description: `Refund for interrupted queued email ${String(job.id)}`,
      });
    }
    if (err instanceof queueDelivery.EmailQueuePolicyError)
      return { success: false, suppressed: true, error: err.message };
    throw err;
  }
}

// ─── SMS Sending Worker ─────────────────────────────────────────────────────────

type FollowUpActivityInput = {
  userId: number;
  leadId: number;
  leadName: string;
  channel: string;
  message: string;
  subject?: string | null;
  status: string;
  deliveryStatus: string;
  messageId?: string | null;
  followUpStep: number;
};

async function recordFollowUpActivity(input: FollowUpActivityInput): Promise<void> {
  try {
    const { SentMessageModel } = await import('../models/sentMessages/functions.js');
    await SentMessageModel.create({
      userId: input.userId,
      leadId: input.leadId,
      leadName: input.leadName || 'Unknown',
      channel: input.channel,
      subject: input.subject || null,
      message: input.message,
      status: input.status,
      deliveryStatus: input.deliveryStatus,
      sentAt: new Date(),
      messageId: input.messageId || null,
      isReply: true,
      followUpStep: input.followUpStep,
    }, { skipCreditDeduction: true });
  } catch (err) {
    createWorkerLogger('follow-up-activity').warn(
      { err, channel: input.channel, leadId: input.leadId, followUpStep: input.followUpStep },
      'Could not persist follow-up activity log',
    );
  }
}

async function processSmsSending(job: Job) {
  const { userId, to, message, leadId, campaignId, threadId, correlationId } = job.data;
  const followUpStep = Number(job.data.followUpStep);
  const isFollowUp =
    job.data.isFollowUp === true &&
    Number.isSafeInteger(Number(leadId)) &&
    Number(leadId) > 0 &&
    Number.isSafeInteger(followUpStep) &&
    followUpStep > 0;
  const delivery = await import('../services/outreach/SmsQueueDeliveryService.js');
  let deliveryId: number | undefined;
  const recordSmsFollowUp = async (failedPreparation = false) => {
    if (isFollowUp && deliveryId)
      await delivery.projectQueuedSmsActivity(
        deliveryId,
        {
          leadId: Number(leadId),
          leadName: String(job.data.leadName || 'Unknown'),
          message: String(message || ''),
          step: followUpStep,
        },
        failedPreparation,
      );
  };
  const { assertConfiguredFollowUpReady, ConfiguredFollowUpStoppedError } =
    await import('../services/outreach/ConfiguredFollowUpDispatchService.js');
  const { assertRecipientNotSuppressed, RecipientSuppressedError } =
    await import('../services/outreach/RecipientSuppressionService.js');
  const assertReady = async () => {
    if (isFollowUp)
      await assertConfiguredFollowUpReady(Number(userId), 'sms', job.data.followUpProvenance, {
        originMessageId: Number(job.data.followUpOriginMessageId),
        step: followUpStep,
      });
  };
  let claim: import('../services/outreach/SmsQueueDeliveryService.js').SmsQueueClaim | undefined;
  let reservationTransactionId: number | undefined;
  let providerCallStarted = false;
  let providerRejected = false;
  let providerAccepted = false;
  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'sms_sending',
    executionId: job.id,
  });
  try {
    const { sendSMS } = await import('../services/smsService.js');
    const { creditService } = await import('../services/CreditService.js');
    const intent = await delivery.claimQueuedSms(
      String(job.id || ''),
      job.data,
      job.stalledCounter > 0,
    );
    deliveryId = intent.claim?.id || intent.deliveryId;
    if (!intent.claim) {
      if (intent.success || intent.uncertain || intent.suppressed) await recordSmsFollowUp();
      if (intent.inProgress) {
        await job.moveToDelayed(Date.now() + 30_000, job.token);
        throw new DelayedError();
      }
      return {
        success: intent.success === true,
        duplicate: true,
        uncertain: intent.uncertain,
        suppressed: intent.suppressed,
        messageId: intent.messageId,
      };
    }
    claim = intent.claim;
    const recovered = await delivery.findSmsReservation(claim);
    if (recovered) {
      const refund = await creditService.refundDeduction({
        userId,
        transactionId: recovered,
        description: `Refund for unstarted SMS claim ${claim.id}`,
      });
      if (!refund.success)
        throw new Error('The previous unused SMS reservation could not be released.');
    }
    await assertReady();
    await assertRecipientNotSuppressed(Number(userId), 'sms', String(to));
    const originalBinding = async () => {
      if (isFollowUp && job.data.useSavedFollowUpSettings === true) {
        const { getConfiguredFollowUpDeliveryBinding } =
          await import('../services/outreach/ConfiguredFollowUpDeliveryService.js');
        try {
          return (
            await getConfiguredFollowUpDeliveryBinding(
              Number(userId),
              'sms',
              Number(job.data.followUpOriginMessageId),
              Number(leadId),
              String(to),
            )
          ).providerAccountId;
        } catch (error) {
          // This existing binding API exposes these three policy failures as
          // ordinary Errors. Preserve all other (including database) failures.
          if (
            error instanceof Error &&
            [
              'The original follow-up message is unavailable.',
              'Follow-up stopped because the contact replied or conversation automation is paused.',
              'The follow-up account or recipient no longer matches the original outreach.',
            ].includes(error.message)
          )
            throw new delivery.SmsQueuePolicyError(error.message);
          throw error;
        }
      }
      return undefined;
    };
    const configuredProviderAccountId = await originalBinding();
    claim.reservationId = undefined;
    claim.reservationReference = delivery.smsReservationReference(claim);
    const reservation = await creditService.reserveForResource({
      userId,
      eventKey: 'outreach_sms',
      description: 'Queued SMS delivery reservation',
      service: 'SmsSendingWorker',
      referenceType: 'sms_queue_claim',
      metadata: { channel: 'sms', messageKind: isFollowUp ? 'follow_up' : undefined },
      insights: { channel: 'sms', process: isFollowUp ? 'follow_up' : 'customer_chat' },
      createResource: (tx) => delivery.attachSmsReservation(claim!, tx),
    });
    if (!reservation.success)
      throw new Error(reservation.error || 'SMS delivery credits could not be reserved.');
    reservationTransactionId = reservation.transactionId;
    claim.reservationId = reservationTransactionId;
    if (!(await delivery.saveSmsReservation(claim, reservationTransactionId)))
      throw new delivery.SmsQueuePolicyError('SMS preparation claim was replaced.');
    const result = await sendSMS(userId, to, message, undefined, configuredProviderAccountId, {
      beforeProvider: async () => {
        // The adapter has finished recipient/account/credential preparation.
        // Check policy before recording the token-fenced durable start.
        await assertReady();
        if ((await originalBinding()) !== configuredProviderAccountId)
          throw new delivery.SmsQueuePolicyError(
            'The reviewed SMS account changed during preparation.',
          );
        await assertRecipientNotSuppressed(Number(userId), 'sms', String(to));
        if (!(await delivery.startQueuedSms(claim!)))
          throw new delivery.SmsQueuePolicyError('SMS preparation claim is no longer current.');
        providerCallStarted = true;
      },
    });
    providerCallStarted = result.deliveryAttempted !== false;
    if (!result.success) {
      providerRejected = providerCallStarted && !deliveryOutcomeIsUncertain(result);
      throw new Error(result.error || 'SMS provider did not confirm the request');
    }
    providerAccepted = true;
    await delivery.finishQueuedSms(claim, 'confirmed', undefined, result.messageId);
    await recordSmsFollowUp();
    await Promise.allSettled([
      eventBus.publish({
        channel: EVENT_CHANNELS.OUTREACH_SENT,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { channel: 'sms', leadId, campaignId, to },
      }),
      emitCorrelationEvent('completed', correlationId, userId, threadId, { to, result }),
    ]);
    return result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof DelayedError) throw err;
    const stopped =
      err instanceof ConfiguredFollowUpStoppedError ||
      err instanceof delivery.SmsQueuePolicyError ||
      err instanceof RecipientSuppressedError;
    const uncertain = providerCallStarted && !providerRejected;
    let finalized = false;
    if (claim) {
      if (!uncertain && !providerAccepted) {
        const { creditService } = await import('../services/CreditService.js');
        const unused = reservationTransactionId || (await delivery.findSmsReservation(claim));
        if (unused) {
          const refund = await creditService.refundDeduction({
            userId,
            transactionId: unused,
            description: `Refund for unstarted or rejected SMS ${claim.id}`,
          });
          if (!refund.success) throw new Error('The unused SMS reservation could not be released.');
        }
      }
      finalized = await delivery.finishQueuedSms(
        claim,
        uncertain ? 'unknown' : stopped ? 'stopped' : providerRejected ? 'rejected' : 'pending',
        err.message,
      );
    }
    if (finalized)
      await recordSmsFollowUp(
        !uncertain &&
          !stopped &&
          !providerRejected &&
          job.attemptsMade + 1 >= Number(job.opts.attempts || 1),
      );
    await Promise.allSettled([
      eventBus.emitToolEvent('failed', {
        userId,
        threadId,
        toolName: 'sms_sending',
        executionId: job.id,
        data: { error: err.message },
      }),
      emitCorrelationEvent('failed', correlationId, userId, threadId, { to, error: err.message }),
    ]);
    if (uncertain) return { success: false, uncertain: true, error: err.message };
    if (stopped || providerRejected)
      return { success: false, suppressed: stopped, error: err.message };
    throw err;
  }
}

// ─── Lead Enrichment Worker ─────────────────────────────────────────────────────

async function processLeadEnrichment(job: Job) {
  const log = createWorkerLogger('lead-enrichment');
  const { userId, leadId, enrichmentType, threadId, correlationId } = job.data;

  log.info({ jobId: job.id, userId, leadId, enrichmentType }, 'Processing lead enrichment');

  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'lead_enrichment',
    executionId: job.id,
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;

    switch (enrichmentType) {
      case 'email_validation': {
        const { EmailValidationService } = await import('../services/EmailValidationService.js');
        const service = await EmailValidationService.createWithAdminCredentials(userId);
        // Validate by fetching lead email from DB
        result = await service.validateEmail(job.data.email || '');
        break;
      }
      case 'data_enrichment': {
        const { enrichmentService } = await import('../services/EnrichmentService.js');
        // Enrich using lead's email
        result = await enrichmentService.enrichPerson(job.data.email || '');
        break;
      }
      case 'scoring': {
        const { LeadScoringService } = await import('../services/LeadScoringService.js');
        const scorer = new LeadScoringService();
        result = await scorer.scoreLead(userId, job.data.lead || {}, job.data.icpCriteria || {});
        break;
      }
      case 'deep_enrichment': {
        const { leadEnrichmentOrchestrator } = await import('../services/enrichment/index.js');
        let runId = job.data.enrichmentRunId as number | undefined;
        if (!runId) {
          // Legacy queued payloads get one deterministic receipt before any IO.
          const { reserveDeepEnrichment } = await import('../services/enrichment/deepExecution.js');
          const reservation = await reserveDeepEnrichment(userId, leadId, `legacy-job:${job.id}`);
          runId = reservation.run.id;
          try { await job.updateData({ ...job.data, enrichmentRunId: runId }); }
          catch (error) {
            const { cancelUnstartedDeepForAuthority } = await import('../services/enrichment/deepExecution.js');
            await cancelUnstartedDeepForAuthority({ ...job.data, enrichmentRunId: runId }, 'Queue receipt could not be saved before provider dispatch. The unused fixed fee was released.');
            throw error;
          }
        }
        result = await leadEnrichmentOrchestrator.enrichLead(userId, leadId, { threadId, runId });
        if (!result.success) throw new UnrecoverableError(result.error || 'Enrichment failed. Review the saved attempt before starting another request.');
        break;
      }
      default:
        throw new Error(`Unknown enrichment type: ${enrichmentType}`);
    }

    await eventBus.emitToolEvent('completed', {
      userId,
      threadId,
      toolName: 'lead_enrichment',
      executionId: job.id,
      data: { enrichmentType, result },
    });

    log.info({ jobId: job.id, leadId, enrichmentType }, 'Lead enrichment completed');
    await emitCorrelationEvent('completed', correlationId, userId, threadId, { leadId, enrichmentType, result });
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    await eventBus.emitToolEvent('failed', {
      userId,
      threadId,
      toolName: 'lead_enrichment',
      executionId: job.id,
      data: { error: err.message },
    });
    await emitCorrelationEvent('failed', correlationId, userId, threadId, { leadId, error: err.message });
    throw err;
  }
}

// ─── Analytics Worker ───────────────────────────────────────────────────────────

async function processAnalytics(job: Job) {
  const log = createWorkerLogger('analytics');
  const { userId, type, platform, threadId, correlationId } = job.data;

  log.info({ jobId: job.id, type, platform }, 'Processing analytics job');

  try {
    const { AnalyticsIngestionService } = await import('../services/AnalyticsIngestionService.js');
    const service = new AnalyticsIngestionService();

    switch (type) {
      case 'poll_metrics':
      case 'cron-analytics':
        // One deterministic cycle; the BullMQ repeat schedule owns cadence.
        await service.pollForMetrics();
        {
          const { autonomousAdsService } = await import('../services/ads/AutonomousAdsService.js');
          const optimization = await autonomousAdsService.runOptimizationCycle();
          log.info(optimization, 'Autonomous ads optimization cycle completed');
          const { autonomousAdsActionProcessor } = await import('../services/ads/AutonomousAdsActionProcessor.js');
          await autonomousAdsActionProcessor.processBatch(10);
        }
        break;
      case 'cron-paid-meta-sync': {
        const { syncDuePaidMetaAccounts } = await import('../services/PerformanceProviderSyncService.js');
        await syncDuePaidMetaAccounts();
        await (await import('../services/PerformanceProviderSyncService.js')).syncDuePaidAdAccounts();
        break;
      }
      case 'social-account-sync': {
        const { syncSocialAccount } = await import('../services/PerformanceProviderSyncService.js');
        const input = job.data.input as {platform:string;credentialId:number;startDate:string;endDate:string;timezone:string};
        const result = await syncSocialAccount(Number(userId),input,true);
        return result || {status:409,body:{error:'This account is already syncing. Its saved measurements will refresh when that sync completes.',code:'SOCIAL_SYNC_IN_PROGRESS'}};
      }
      case 'cron-social-analytics-sync': {
        const { syncDueSocialAccounts } = await import('../services/PerformanceProviderSyncService.js');
        await syncDueSocialAccounts();
        break;
      }
      case 'fetch-campaign-metrics': {
        // Started by POST /api/campaigns/analytics/fetch-now; the request
        // waits briefly for this result and otherwise answers 202.
        const { refreshCampaignMetrics } = await import('../services/AnalyticsIngestionService.js');
        const range = job.data.input as { dateStart: string; dateStop: string };
        return await refreshCampaignMetrics(Number(userId), range.dateStart, range.dateStop);
      }
      case 'refresh_cache': {
        const { refreshMetaPerformanceCacheForUser } = await import('../controllers/performanceMarketingController.js');
        if (Number.isSafeInteger(Number(userId)) && Number(userId) > 0) await refreshMetaPerformanceCacheForUser(Number(userId), 'last_30d');
        break;
      }
      default:
        log.warn({ type }, 'Unknown analytics job type');
    }

    log.info({ jobId: job.id, type }, 'Analytics job completed');
    await emitCorrelationEvent('completed', correlationId, userId, threadId, { type, platform });
    return { success: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    log.error({ jobId: job.id, type, err: err.message }, 'Analytics job failed');
    await emitCorrelationEvent('failed', correlationId, userId, threadId, { type, error: err.message });
    throw err;
  }
}

// ─── Follow-Up Worker ───────────────────────────────────────────────────────────

async function processFollowUp(job: Job) {
  const log = createWorkerLogger('follow-up');
  const { userId, sequenceId, stepIndex, leadId, type, threadId, correlationId } = job.data;

  // Handle repeatable cron-style follow-up jobs (from CronService V2)
  if (type === 'cron-follow-up' || job.name === 'process-follow-ups') {
    log.info({ jobId: job.id }, 'Processing scheduled follow-up batch (cron)');
    try {
      const { cronService } = await import('../services/cronService.js');
      await cronService.processFollowUps();
      log.info({ jobId: job.id }, 'Cron follow-up batch completed');
      await emitCorrelationEvent('completed', correlationId, userId, threadId, { type: 'cron-follow-up' });
      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      log.error({ jobId: job.id, err: err.message }, 'Cron follow-up batch failed');
      await emitCorrelationEvent('failed', correlationId, userId, threadId, { type: 'cron-follow-up', error: err.message });
      throw err;
    }
  }

  // Individual follow-ups are delivered by the email/outreach queues. Never
  // acknowledge an obsolete payload as successful because that loses messages.
  const error = new Error(
    `Unsupported follow-up job "${job.name}". Individual sends must use the email or outreach queue.`,
  );
  log.error({ jobId: job.id, userId, sequenceId, stepIndex, leadId }, error.message);
  await emitCorrelationEvent('failed', correlationId, userId, threadId, {
    sequenceId,
    stepIndex,
    leadId,
    error: error.message,
  });
  throw error;
}

// ─── General Worker ─────────────────────────────────────────────────────────────

export async function processGeneralJob(job: Job) {
  const log = createWorkerLogger('general');
  const { type, userId, threadId, correlationId } = job.data;

  log.info({ jobId: job.id, type }, 'Processing general job');

  try {
    switch (type) {
      case 'workspace-website-analysis': {
        const { processWorkspaceWebsiteAnalysis } = await import('../services/workspaceWebsiteAnalysisJobs.js');
        return processWorkspaceWebsiteAnalysis(job);
      }
      case 'dashboard-operation': {
        const {processDashboardOperation}=await import('../services/operations/DashboardOperations.js');
        return processDashboardOperation(job.data);
      }
      case 'cron-dashboard-operations-recovery': {
        const {recoverDashboardOperations}=await import('../services/operations/DashboardOperations.js');
        return recoverDashboardOperations();
      }

      case 'cron-gmail-watch-renewal':
        await renewGmailWatches(log);
        break;
      case 'gmail-mailbox-sync': {
        const { processGmailMailboxSync } = await import('../services/GmailMailboxSyncService.js');
        return processGmailMailboxSync({ userId: Number(userId), credentialId: Number(job.data.credentialId), emailAddress: String(job.data.emailAddress) });
      }
      case 'cron-gmail-mailbox-sync-recovery': {
        const { recoverGmailMailboxSync } = await import('../services/GmailMailboxSyncService.js');
        return { recovered: await recoverGmailMailboxSync() };
      }
      case 'cron-instagram-automation-recovery': {
        const { recoverInstagramAutomationRuns } = await import('../services/instagramAutomations/InstagramAutomationRuntime.js');
        return { recovered: await recoverInstagramAutomationRuns() };
      }
      case 'cron-crm-automation-dispatch': {
        const {dispatchAutomationEvents}=await import('../services/automations/AutomationEngine.js');
        return {dispatched:await dispatchAutomationEvents()};
      }
      case 'cron-whatsapp-billing-maintenance': {
        const { runWhatsAppBillingMaintenance } = await import('../services/whatsapp/WhatsAppBillingMaintenance.js');
        return runWhatsAppBillingMaintenance();
      }
      case 'cron-outreach-batch-counts': {
        const { refreshOutreachBatchCounts } = await import('../services/outreach/OutreachTrackingService.js');
        return refreshOutreachBatchCounts();
      }
      case 'cron-instagram-follower-sync': {
        const { processInstagramFollowerSync } = await import('../services/instagramFollowerSyncService.js');
        log.info('Starting Instagram follower sync...');
        await processInstagramFollowerSync();
        break;
      }
      case 'cron-facebook-follower-sync': {
        const { processFacebookFollowerSync } = await import('../services/socialFollowerSyncService.js');
        log.info('Starting Facebook follower sync...');
        await processFacebookFollowerSync();
        break;
      }
      case 'cron-twitter-follower-sync': {
        const { processTwitterFollowerSync } = await import('../services/socialFollowerSyncService.js');
        log.info('Starting Twitter follower sync...');
        await processTwitterFollowerSync();
        break;
      }
      case 'cron-linkedin-follower-sync': {
        const { processLinkedInFollowerSync } = await import('../services/socialFollowerSyncService.js');
        log.info('Starting LinkedIn follower sync...');
        await processLinkedInFollowerSync();
        break;
      }
      case 'cron-subscription-reconciliation': {
        const { subscriptions } = await import('../services/subscriptions/service.js');
        log.info(await subscriptions.runScheduled(), 'Subscription reconciliation completed');
        break;
      }
      case 'cron-process-reminders': {
        const { reminderService } = await import('../services/ReminderService.js');
        log.info('Processing due CRM reminders...');
        const { processProposalEvents } = await import('../services/ProposalWorkspaceService.js');
        await processProposalEvents();
        const result = await reminderService.processAndSendDueReminders();
        log.info({ processed: result.processed, errors: result.errors }, 'CRM reminders processed');
        break;
      }
      case 'cron-expire-hotel-booking-holds': {
        const { bookingService } = await import('../services/booking/BookingService.js');
        const result = await bookingService.releaseExpiredHolds(200);
        log.info({ expired: result.expired }, 'Expired hotel booking holds released');
        break;
      }
      case 'cron-storage-object-cleanup': {
        const { storageService } = await import('../services/StorageService.js');
        const result = await storageService.cleanupPendingObjects(200);
        const { outreachAttachmentService } = await import('../services/OutreachAttachmentService.js');
        const expiredAttachments = await outreachAttachmentService.cleanupExpired(200);
        log.info({ ...result, expiredAttachments }, 'Pending storage object cleanup completed');
        break;
      }
      case 'cron-meta-token-refresh': {
        const { refreshExpiringMetaTokens } = await import('../services/metaTokenRefreshService.js');
        log.info('Starting Meta token refresh check...');
        const refreshResult = await refreshExpiringMetaTokens();
        log.info({ refreshed: refreshResult.refreshed, failed: refreshResult.failed }, 'Meta token refresh completed');
        break;
      }
      case 'cron-support-sla-check': {
        // Each step is isolated: a failing SLA check must not stop privacy
        // purges, approval expiry or widget commit recovery. Delivery and tool
        // resume run in cron-support-delivery-recovery (every 30 seconds) and
        // member notifications in cron-support-notification-maintenance.
        const { db } = await import('../models/db.js');
        const { sql } = await import('drizzle-orm');
        const { runMaintenanceSteps, assertMaintenanceSucceeded } = await import('../services/supportMaintenanceSteps.js');
        const { enqueueSupportSlaEvents } = await import('../services/SupportSlaService.js');
        const { handoffService } = await import('../services/agents/pipeline/HandoffService.js');
        const { privacyVaultService } = await import('../services/agents/orchestration/PrivacyVaultService.js');
        const { RateLimitStage } = await import('../services/agents/pipeline/stages/RateLimitStage.js');
        const { webhookRetentionService } = await import('../services/WebhookRetentionService.js');
        const { ToolApprovalModel } = await import('../models/toolApprovals/functions.js');
        const { recoverWidgetCommits } = await import('../services/agents/orchestration/WidgetCommitRecovery.js');
        const run = await runMaintenanceSteps([
          { name: 'slaEvents', run: () => enqueueSupportSlaEvents() },
          { name: 'slaBreaches', run: () => handoffService.checkSLABreaches() },
          { name: 'privacyVaultPurge', run: () => privacyVaultService.purgeExpired() },
          { name: 'rateLimitPurge', run: () => RateLimitStage.purgeExpired() },
          { name: 'webhookTelemetryPurge', run: () => webhookRetentionService.purgeExpired() },
          { name: 'approvalExpiry', run: () => ToolApprovalModel.expirePending(30) },
          { name: 'widgetCommitRecovery', run: () => recoverWidgetCommits() },
          { name: 'operationalRisks', run: async () => {
            const result = await db.execute(sql`
              SELECT
                (SELECT COUNT(*)::int FROM support_effect_ledger WHERE status = 'reconciliation_required') AS effect_reconciliation_count,
                (SELECT COUNT(*)::int FROM support_delivery_outbox WHERE status = 'uncertain') AS uncertain_delivery_count,
                (SELECT COUNT(*)::int FROM support_tool_executions WHERE reconciliation_status IS NOT NULL AND reconciliation_status NOT IN ('confirmed_executed', 'confirmed_not_executed')) AS tool_reconciliation_count,
                (SELECT COUNT(*)::int FROM knowledge_document_versions v JOIN knowledge_documents d ON d.id = v.document_id AND d.user_id = v.user_id
                  WHERE v.status IN ('failed', 'quarantined')
                    AND (v.status = 'quarantined' OR d.current_published_version_id IS NULL OR d.current_published_version_id = v.id)) AS knowledge_action_required_count
            `);
            return (result.rows[0] || {}) as Record<string, number>;
          } },
        ], log);
        const r = run.results as Record<string, any>;
        const riskCounts = (r.operationalRisks || {}) as Record<string, number>;
        if (Object.values(riskCounts).some((count) => Number(count) > 0)) log.warn(riskCounts, 'Support operations attention required');
        if (Number(r.privacyVaultPurge) > 0) log.info({ purged: r.privacyVaultPurge }, 'Expired restricted support content purged');
        if (Number(r.rateLimitPurge) > 0) log.info({ purgedRateBuckets: r.rateLimitPurge }, 'Expired support AI rate-limit buckets purged');
        if (r.webhookTelemetryPurge && Number(r.webhookTelemetryPurge.integrationEvents) + Number(r.webhookTelemetryPurge.healthEvents) > 0) {
          log.info(r.webhookTelemetryPurge, 'Expired webhook telemetry purged');
        }
        if (Number(r.approvalExpiry) > 0) log.info({ expiredApprovals: r.approvalExpiry }, 'Expired support tool approvals closed');
        if (Number(r.slaEvents) > 0) log.info({ count: r.slaEvents }, 'Support SLA events created');
        assertMaintenanceSucceeded('Support maintenance', run);
        break;
      }
      case 'cron-support-delivery-recovery': {
        const { runMaintenanceSteps, assertMaintenanceSucceeded } = await import('../services/supportMaintenanceSteps.js');
        const { supportToolResumeService } = await import('../services/agents/orchestration/SupportToolResumeService.js');
        const { deliveryOutboxService } = await import('../services/agents/orchestration/DeliveryOutboxService.js');
        const run = await runMaintenanceSteps([
          { name: 'approvedToolResume', run: () => supportToolResumeService.processReady(25) },
          // The general queue runs one job at a time; a bounded batch keeps
          // slow provider calls from delaying publishing and SLA jobs.
          { name: 'deliveryOutbox', run: () => deliveryOutboxService.processReady(25) },
        ], log);
        const resumed = Number(run.results.approvedToolResume || 0);
        const delivery = run.results.deliveryOutbox as { processed: number; expired: number } | undefined;
        if (resumed > 0) log.info({ resumedApprovals: resumed }, 'Approved support tools resumed');
        if (delivery && (delivery.processed > 0 || delivery.expired > 0)) log.info(delivery, 'Support delivery recovery processed');
        assertMaintenanceSucceeded('Support delivery recovery', run);
        break;
      }
      case 'cron-knowledge-maintenance': {
        const { knowledgeMaintenanceService } = await import('../services/knowledge/KnowledgeMaintenanceService.js');
        const report = await knowledgeMaintenanceService.run();
        const actionRequired = Array.isArray(report.actionRequired) ? report.actionRequired.length : 0;
        if (actionRequired > 0 || (Array.isArray(report.failures) && report.failures.length > 0)) {
          log.warn({ ...report, actionRequired }, 'Knowledge maintenance completed with review items');
        } else {
          log.info(report, 'Knowledge maintenance completed');
        }
        break;
      }
      case 'cron-support-notification-maintenance': {
        const { recoverSupportConversationTurns } = await import('../services/agents/orchestration/SupportConversationTurn.js');
        const recoveredTurns = await recoverSupportConversationTurns();
        if (recoveredTurns) log.info({ recoveredTurns }, 'Pending support turns rescheduled');
        const { supportMemberNotificationService } = await import('../services/SupportMemberNotificationService.js');
        const result = await supportMemberNotificationService.runMaintenance();
        if (Object.values(result).some((count) => count > 0)) log.info(result, 'Support notification maintenance completed');
        break;
      }
      case 'cron-support-presence-maintenance': {
        const { supportPresenceService } = await import('../services/SupportPresenceService.js');
        await supportPresenceService.closeStaleSessions();
        break;
      }
      case 'support-member-notification': {
        const deliveryId = Number(job.data.deliveryId);
        const userId = Number(job.data.userId);
        if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
          throw new Error('Invalid support member notification delivery ID.');
        }
        if (!Number.isSafeInteger(userId) || userId <= 0) {
          throw new Error('Invalid support member notification tenant ID.');
        }
        const { supportMemberNotificationService } = await import('../services/SupportMemberNotificationService.js');
        await supportMemberNotificationService.processDelivery(deliveryId, userId);
        break;
      }
      case 'support-notification-event': {
        const eventId = Number(job.data.eventId);
        const userId = Number(job.data.userId);
        if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          throw new Error('Invalid support notification event job.');
        }
        const { supportMemberNotificationService } = await import('../services/SupportMemberNotificationService.js');
        await supportMemberNotificationService.processEvent(eventId, userId);
        break;
      }
      case 'cron-scheduled-publishing': {
        const { cronService } = await import('../services/cronService.js');
        log.info('Processing scheduled content publishing...');
        await cronService.processScheduledPublishing();
        break;
      }
      case 'cron-scheduled-social-reports': {
        const { processDueSocialReports } = await import('../controllers/socialAnalyticsController.js');
        const result = await processDueSocialReports();
        log.info(result, 'Scheduled social reports processed');
        break;
      }
      default:
        // Phase 5.2 / QUEUE-007: surface unknown job types as failures
        // so the BullMQ retry path can run (or DLQ the job) instead of
        // silently succeeding.
        throw new Error('Unknown general job type: ' + type);
    }
    log.info({ jobId: job.id, type }, 'General job completed');
    await emitCorrelationEvent('completed', correlationId, userId, threadId, { type });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    log.error({ jobId: job.id, type, err: err.message }, 'General job failed');
    await emitCorrelationEvent('failed', correlationId, userId, threadId, { type, error: err.message });
    throw err;
  }
}

async function processUnsupportedLegacyJob(job: Job) {
  const log = createWorkerLogger('legacy-queue');
  const { userId, threadId, correlationId } = job.data;
  const error = new Error(
    `Queue "${job.queueName}" no longer accepts "${job.name}". Use the canonical application service.`,
  );
  log.error({ queue: job.queueName, jobId: job.id, jobName: job.name }, error.message);
  await emitCorrelationEvent('failed', correlationId, userId, threadId, {
    queue: job.queueName,
    jobName: job.name,
    error: error.message,
  });
  throw error;
}

async function renewGmailWatches(log: ReturnType<typeof createWorkerLogger>) {
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');
  const { google } = await import('googleapis');
  const { getGmailClientForUser, getDefaultGmailCredentials, setupGmailWatchForUser } = await import('../controllers/gmailOAuthController.js');

  // Find all gmail_api credentials with a watch that expires within 24 hours
  const result = await db.execute(sql`
    SELECT id, user_id, account_identifier, session_data
    FROM channel_credentials
    WHERE platform = 'gmail_api' AND is_active IS TRUE
      AND access_token IS NOT NULL
      AND session_data IS NOT NULL
      AND (CASE WHEN session_data->>'watchExpiration' ~ '^[0-9]+$'
        THEN (session_data->>'watchExpiration')::numeric ELSE NULL END < ${Date.now() + 24 * 60 * 60 * 1000}
        OR (session_data->>'watchExpiration' IS NULL AND session_data->>'watchRenewalStatus'='failed'))
      AND COALESCE(NULLIF(session_data->>'watchRenewalRetryAfter', '')::timestamptz, '-infinity'::timestamptz) <= NOW()
  `);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = result.rows as any[];
  if (rows.length === 0) {
    log.info('No Gmail watches need renewal');
    return;
  }

  log.info({ count: rows.length }, 'Renewing Gmail watches');
  const adminCreds = await getDefaultGmailCredentials();
  if (!adminCreds.topicName) {
    log.warn('Gmail watch renewal requires a configured Pub/Sub topic');
    return;
  }

  for (const row of rows) {
    try {
      const clientResult = await getGmailClientForUser(row.user_id, {
        credentialId: Number(row.id), accountIdentifier: row.account_identifier,
      });
      if (!clientResult) {
        await db.execute(sql`
          UPDATE channel_credentials
          SET session_data = COALESCE(session_data, '{}'::jsonb) || jsonb_build_object(
                'watchRenewalStatus', 'needs_reconnect',
                'watchRenewalRetryAfter', NOW() + INTERVAL '24 hours'
              ),
              updated_at = NOW()
          WHERE id = ${Number(row.id)} AND user_id = ${row.user_id} AND platform = 'gmail_api'
        `);
        log.warn({ userId: row.user_id, retryAfterHours: 24 }, 'Gmail watch requires reconnect; renewal deferred');
        continue;
      }

      const gmail = google.gmail({ version: 'v1', auth: clientResult.client });
      await setupGmailWatchForUser(row.user_id, gmail, Number(row.id));
      log.info({ userId: row.user_id, credentialId: row.id }, 'Gmail watch renewed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      await db.execute(sql`
        UPDATE channel_credentials
        SET session_data = COALESCE(session_data, '{}'::jsonb) || jsonb_build_object(
              'watchRenewalStatus', 'failed',
              'watchRenewalRetryAfter', NOW() + INTERVAL '6 hours',
              'watchRenewalError', 'GMAIL_WATCH_RENEWAL_FAILED'
            ),
            updated_at = NOW()
        WHERE id = ${Number(row.id)} AND user_id = ${row.user_id} AND platform = 'gmail_api'
      `).catch(() => undefined);
      log.error({ userId: row.user_id, err: err.message }, 'Failed to renew Gmail watch');
    }
  }
}

// ─── Embedding Worker ───────────────────────────────────────────────────────────

async function processEmbedding(job: Job) {
  const log = createWorkerLogger('embedding');
  const { userId, texts, sourceType, sourceIds, provider, model, metadata, threadId, correlationId } = job.data;

  log.info({ jobId: job.id, userId, count: texts?.length }, 'Processing embedding batch');

  await eventBus.emitToolEvent('started', {
    userId,
    threadId,
    toolName: 'embedding_generation',
    executionId: job.id,
  });

  try {
    const { embeddingService } = await import('../services/embeddings/EmbeddingService.js');

    const ids: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const id = await embeddingService.storeEmbedding({
        userId,
        text: texts[i],
        sourceType,
        sourceId: sourceIds?.[i],
        provider,
        model,
        metadata,
      });
      ids.push(id);
    }

    await eventBus.emitToolEvent('completed', {
      userId,
      threadId,
      toolName: 'embedding_generation',
      executionId: job.id,
      data: { embeddingIds: ids },
    });

    if (correlationId) {
      await eventBus.publish({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: `tool:completed:${correlationId}` as any,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { embeddingIds: ids },
      });
    }

    log.info({ jobId: job.id, userId, count: ids.length }, 'Embedding batch completed');
    return { embeddingIds: ids };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    await eventBus.emitToolEvent('failed', {
      userId,
      threadId,
      toolName: 'embedding_generation',
      executionId: job.id,
      data: { error: err.message },
    });

    if (correlationId) {
      await eventBus.publish({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: `tool:failed:${correlationId}` as any,
        userId,
        threadId,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
    }

    throw err;
  }
}

// ─── Queued Outreach Message Processor ──────────────────────────────────────────

export async function processQueuedOutreachMessage(job: Job) {
  const log = createWorkerLogger('outreach-send');
  const {
    userId, messageId, conversationId, leadId, channel, message, subject,
    senderId, recipientEmail, handle, linkedinUrl, facebookId, phone, twitterHandle,
  } = job.data;
  let deliveryConfirmed = false;

  log.info({ jobId: job.id, userId, messageId, channel, leadId }, 'Processing queued outreach message');

  const { OutreachConversationModel } = await import('../models/index.js');
  let providerCallStarted = false;
  let reservationTransactionId: number | undefined;

  try {
    // Claim this persisted message once. BullMQ retries and duplicate jobs must
    // not repeat an external provider side effect.
    const { db } = await import('../models/db.js');
    const { sql } = await import('drizzle-orm');
    const claim = await db.execute(sql`
      UPDATE outreach_messages om
      SET
        status = 'sending',
        send_claimed_at = NOW(),
        send_attempt_count = COALESCE(send_attempt_count, 0) + 1,
        updated_at = NOW()
      FROM outreach_conversations oc
      WHERE om.id = ${messageId}
        AND om.conversation_id = ${conversationId}
        AND oc.id = om.conversation_id
        AND oc.user_id = ${userId}
        AND om.direction = 'outbound'
        AND om.status = 'pending'
        AND (om.metadata->'outreachCreation'->'campaignManual' IS NULL
          OR om.metadata->'outreachCreation'->'campaignManual'->>'reviewId' = ${String(job.data.campaignManualReviewId || '')})
        AND om.provider_call_state = 'not_started'
        AND om.confirmed_at IS NOT NULL
        AND (om.confirmation_expires_at IS NULL OR om.confirmation_expires_at > NOW())
        AND COALESCE(om.manual_review_required, false) = false
      RETURNING om.id, om.provider_account_id
    `);
    if (claim.rows.length === 0) {
      const existing = await db.execute(sql`
        SELECT om.status, om.external_message_id, om.provider_message_id,
               om.manual_review_required, om.provider_call_state,
               om.metadata->'outreachCreation'->'campaignManual'->>'reviewId' AS manual_review_id,
               om.confirmation_expires_at, om.send_claimed_at
        FROM outreach_messages om
        INNER JOIN outreach_conversations oc ON oc.id = om.conversation_id
        WHERE om.id = ${messageId} AND oc.user_id = ${userId}
        LIMIT 1
      `);
      const existingMessage = existing.rows[0] as {
        status?: string;
        external_message_id?: string;
        provider_message_id?: string;
        manual_review_required?: boolean;
        provider_call_state?: string;
        manual_review_id?: string;
        confirmation_expires_at?: string | Date | null;
        send_claimed_at?: string | Date | null;
      } | undefined;
      // A superseded job must not reset a current worker's claim or reconcile
      // another review's provider state merely because it lost this claim.
      if (existingMessage?.manual_review_id && existingMessage.manual_review_id !== job.data.campaignManualReviewId)
        return { success: false, error: 'This campaign review was superseded. The current reviewed job owns this message.', retryable: false };
      if (existingMessage && ['sent', 'delivered', 'read'].includes(existingMessage.status || '')) {
        deliveryConfirmed = true;
        if (['email', 'gmail'].includes(channel)) {
          const { outreachAttachmentService } = await import('../services/OutreachAttachmentService.js');
          await outreachAttachmentService.markDelivery(messageId, userId, 'sent');
        }
        const { activateCreationFollowUps } = await import('../services/outreach/CreationFollowUpService.js');
        await activateCreationFollowUps(userId, messageId);
        return {
          success: true,
          externalMessageId: existingMessage.external_message_id || existingMessage.provider_message_id,
          duplicate: true,
        };
      }
      if (existingMessage?.manual_review_required || existingMessage?.provider_call_state === 'unknown') {
        return { success: false, error: 'Delivery outcome requires manual review', retryable: false };
      }
      if (existingMessage?.status === 'sending') {
        // A duplicate queue delivery cannot recover another live worker's claim.
        // BullMQ's stalled recovery can revisit it after the lease is stale.
        const claimedAt=existingMessage.send_claimed_at ? new Date(existingMessage.send_claimed_at).getTime() : NaN;
        if(!Number.isFinite(claimedAt) || claimedAt>Date.now()-15*60_000)
          return {success:false,inProgress:true,error:'An existing worker owns this delivery intent',retryable:false};
        if (existingMessage.provider_call_state === 'started') {
          await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'manual_review', {
            errorMessage: 'A prior worker stopped after entering the provider boundary. Reconcile provider history before any new send.',
            providerCallState: 'unknown',
            manualReviewRequired: true,
          });
          return {
            success: false,
            error: 'Interrupted provider call requires manual review',
            retryable: false,
          };
        }
        if (existingMessage.provider_call_state === 'not_started') {
          await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'pending', {
            errorMessage: 'A prior worker stopped before entering the provider boundary. The durable job may retry.',
            providerCallState: 'not_started',
            manualReviewRequired: false,
            sendClaimedAt: null,
          });
          throw new Error('Recovered an unstarted outreach claim for a controlled queue retry');
        }
        return { success: false, error: 'Message claim state is not recoverable automatically', retryable: false };
      }
      if (
        existingMessage?.status === 'pending'
        && existingMessage.confirmation_expires_at
        && new Date(existingMessage.confirmation_expires_at).getTime() <= Date.now()
      ) {
        await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'failed', {
          errorMessage: 'The delivery confirmation expired before the job was claimed. Review the sender and recipient, then create a new send intent.',
          providerCallState: 'not_started',
          sendClaimedAt: null,
        });
        return { success: false, error: 'Delivery confirmation expired before claim', retryable: false };
      }
      return { success: false, error: existingMessage ? 'Message is not eligible for automatic delivery' : 'Message not found', retryable: false };
    }

    const claimedProviderAccountId = String((claim.rows[0] as { provider_account_id?: string }).provider_account_id || '');
    const normalizedOfficialChannel = channel === 'gmail' ? 'email' : channel;
    if (['email', 'instagram', 'facebook', 'whatsapp', 'twitter', 'linkedin', 'sms'].includes(normalizedOfficialChannel)) {
      const {
        inspectOfficialProviderBinding,
      } = await import('../services/outreach/ProviderBindingService.js');
      const conversation = await OutreachConversationModel.getOutreachConversationById(conversationId);
      const providerVariant: EmailProviderVariant | undefined = normalizedOfficialChannel === 'email'
        ? (conversation?.integrationProvider === 'resend' ? 'resend' : 'gmail')
        : undefined;
      const readiness = await inspectOfficialProviderBinding(
        userId,
        normalizedOfficialChannel as OfficialProviderChannel,
        {
          ...(providerVariant ? { providerVariant } : {}),
          ...(claimedProviderAccountId ? { providerAccountId: claimedProviderAccountId } : {}),
        },
      );
      const binding = readiness.binding;
      const accountMismatch = !claimedProviderAccountId
        || (['facebook', 'instagram'].includes(normalizedOfficialChannel) && conversation?.providerAccountId !== claimedProviderAccountId);
      // The confirmed account is still connected but not ready right now (an
      // expired token, a failed readiness check, Meta review). Hold the message
      // instead of failing it: one bad hour on 3 Nov failed 28,136 queued
      // WhatsApp messages on an account that was fine again soon after.
      if (!binding && !accountMismatch && !readiness.missing.some(item => ['credential', 'account_selection', 'account_reference'].includes(item))) {
        const retryAt = Date.now() + ACCOUNT_NOT_READY_RETRY_MS;
        const intent = await db.execute(sql`SELECT confirmation_expires_at FROM outreach_messages WHERE id=${messageId} AND user_id=${userId}`);
        const expiresAt = (intent.rows[0] as { confirmation_expires_at?: string | Date | null } | undefined)?.confirmation_expires_at;
        if (expiresAt && new Date(expiresAt).getTime() > retryAt) {
          const due = new Date(retryAt).toISOString();
          await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'pending', {
            errorMessage: `The sending account needs attention (${readiness.missing.join(', ')}). Queued to retry at ${due}.`,
            providerCallState: 'not_started', sendClaimedAt: null,
          });
          await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{outreachQueue}',COALESCE(metadata->'outreachQueue','{}'::jsonb)||${JSON.stringify({reason:'account_not_ready',nextAttemptAt:due})}::jsonb) WHERE id=${messageId} AND user_id=${userId}`);
          const { NotificationService } = await import('../services/NotificationService.js');
          void NotificationService.outreachAccountNeedsAttention(userId, channel);
          await job.moveToDelayed(retryAt, job.token);
          throw new DelayedError();
        }
      }
      if (!binding || accountMismatch || binding.providerAccountId !== claimedProviderAccountId) {
        await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'failed', {
          errorMessage: 'The confirmed official provider account is not ready or no longer matches. Reconnect and create a new confirmed send intent.',
          providerCallState: 'not_started',
          sendClaimedAt: null,
        });
        return {
          success: false,
          error: 'Confirmed official provider account is unavailable',
          retryable: false,
        };
      }
    }

    const requiredRecipientPresent = (
      (['email', 'gmail'].includes(channel) && Boolean(recipientEmail))
      || (channel === 'instagram' && Boolean(handle))
      || (channel === 'facebook' && Boolean(facebookId))
      || (channel === 'whatsapp' && Boolean(phone))
      || (channel === 'twitter' && Boolean(twitterHandle))
      || (channel === 'linkedin' && Boolean(linkedinUrl))
      || (channel === 'sms' && Boolean(phone))
    );
    if (!requiredRecipientPresent) {
      await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'failed', {
        errorMessage: `The confirmed send intent has no valid ${channel} recipient mapping. Create a new intent after correcting the recipient.`,
        providerCallState: 'not_started',
        sendClaimedAt: null,
      });
      return { success: false, error: 'Confirmed recipient mapping is unavailable', retryable: false };
    }

    const { checkCreationDelivery } = await import('../services/outreach/CreationFollowUpService.js');
    const creationError = await checkCreationDelivery(userId, messageId, job.data);
    if (creationError) {
      await OutreachConversationModel.updateOutreachMessageStatus(messageId, creationError.cancelled ? 'cancelled' : 'failed', {
        errorMessage: creationError.error, providerCallState: 'not_started', sendClaimedAt: null,
      });
      return { success: false, error: creationError.error, retryable: false };
    }
    const preparedMessage = await OutreachConversationModel.getOutreachMessageById(messageId);
    const queuedUntil = (preparedMessage?.metadata as {outreachQueue?:{nextAttemptAt?:string}})?.outreachQueue?.nextAttemptAt;
    const queueDue = queuedUntil ? Date.parse(queuedUntil) : NaN;
    // The DB deadline remains authoritative if Redis lost a delayed-job acknowledgement.
    if (Number.isFinite(queueDue) && queueDue > Date.now()) {
      await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'pending', {
        providerCallState:'not_started',sendClaimedAt:null,
      });
      await job.moveToDelayed(queueDue,job.token);
      throw new DelayedError();
    }
    const { outreachAttachmentService } = await import('../services/OutreachAttachmentService.js');
    const emailAttachments = ['email', 'gmail'].includes(channel) ? await outreachAttachmentService.getEmailAttachments(messageId, userId) : undefined;

    const { creditService } = await import('../services/CreditService.js');
    const reservation = await creditService.reserveOutreachCredit({
      userId,
      channel,
      referenceId: String(messageId),
      service: 'OutreachQueueWorker',
      messageKind:preparedMessage?.messageKind,
      conversationId:preparedMessage?.conversationId,
      providerAccountId: claimedProviderAccountId || undefined,
    });
    if (!reservation.success) {
      const errorMessage = reservation.error || 'Insufficient credits. Recharge your wallet before retrying.';
      await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'failed', { errorMessage });
      const { NotificationService } = await import('../services/NotificationService.js');
      void NotificationService.outreachOutOfCredits(userId, channel);
      return { success: false, error: errorMessage, code: 'INSUFFICIENT_CREDITS' };
    }
    reservationTransactionId = reservation.transactionId;

    let sendResult: {
      success: boolean;
      externalMessageId?: string;
      providerMessageId?: string;
      rfcMessageId?: string;
      threadId?: string;
      error?: string;
      deliveryAttempted?: boolean;
      outcomeUnknown?: boolean;
      retryable?: boolean;
      retryAt?: string;
      providerCode?: number | string;
    } | undefined;

    if ((preparedMessage?.metadata as {outreachQueuePolicy?:{version:number}})?.outreachQueuePolicy?.version === 1) {
      const origin = Object.fromEntries(['userId','businessProfileId','businessActorUserId','billingOrganizationId','billingActorUserId'].map(key=>[key,job.data[key]]));
      await db.execute(sql`UPDATE outreach_messages SET metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({outreachQueueOrigin:origin})}::jsonb WHERE id=${messageId} AND user_id=${userId}`);
    }
    const startDelivery = (executor: typeof db) => executor.execute(sql`
      UPDATE outreach_messages
      SET provider_call_state = 'started', updated_at = NOW()
      WHERE id = ${messageId}
        AND user_id = ${userId}
        AND status = 'sending'
        AND provider_call_state = 'not_started'
        AND (message_kind <> 'follow_up' OR NOT EXISTS (
          SELECT 1 FROM outreach_messages origin WHERE origin.id=outreach_messages.follow_up_origin_message_id
            AND (origin.follow_up_cancelled_at IS NOT NULL OR EXISTS (
              SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id=origin.conversation_id
                AND reply.direction='inbound' AND reply.created_at>COALESCE(origin.sent_at,origin.created_at)
            ))
        ))
      RETURNING id
    `);
    const usesCreation = (preparedMessage?.metadata as { outreachCreation?: { version?: number } } | null)?.outreachCreation?.version === 1;
    const started = usesCreation
      ? await (await import('../services/outreach/QuotaService.js')).withCreationDailyQuota(userId, channel, startDelivery)
      : await startDelivery(db);
    if (!started) {
      if (reservationTransactionId) await creditService.refundDeduction({ userId, transactionId: reservationTransactionId, description: `Refund for daily outreach limit on message ${messageId}` });
      reservationTransactionId = undefined;
      const { getEffectiveDailyLimit } = await import('../services/outreach/QuotaService.js');
      const capacity = await getEffectiveDailyLimit(userId, channel);
      const due = nextDailyCapacityTime();
      if (capacity > 0 && preparedMessage?.confirmationExpiresAt && new Date(preparedMessage.confirmationExpiresAt).getTime() > due) {
        const retryAt = new Date(due).toISOString();
        await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'pending', {
          errorMessage: `Daily sending allowance reached. Queued until ${retryAt}.`,
          providerCallState: 'not_started', sendClaimedAt: null,
        });
        await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{outreachQueue}',COALESCE(metadata->'outreachQueue','{}'::jsonb)||${JSON.stringify({reason:'daily_allowance',nextAttemptAt:retryAt})}::jsonb) WHERE id=${messageId} AND user_id=${userId}`);
        await job.moveToDelayed(due, job.token);
        throw new DelayedError();
      }
      const errorMessage = capacity === 0 ? `Daily ${channel} sending allowance is disabled. Update sending settings before retrying.` : `The reviewed queue lifetime expired before daily capacity became available. Review this outreach again.`;
      await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'failed', { errorMessage, providerCallState: 'not_started', sendClaimedAt: null });
      // Message tracking reports these as expired, separately from provider failures.
      if (capacity > 0) await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{outreachQueue}',COALESCE(metadata->'outreachQueue','{}'::jsonb)||'{"reason":"expired"}'::jsonb) WHERE id=${messageId} AND user_id=${userId}`);
      return { success: false, error: errorMessage, retryable: false };
    }
    if (started.rows.length !== 1) {
      throw new Error('Send intent could not be transitioned to provider-started state');
    }
    providerCallStarted = true;

    if (['email', 'gmail'].includes(channel) && recipientEmail) {
      // ── Email channel ──
      try {
        const { emailService } = await import('../services/emailService.js');
        const conversation = await OutreachConversationModel.getOutreachConversationById(conversationId);
        if (!conversation || conversation.userId !== userId) {
          throw new Error('Email conversation not found');
        }
        const existingMessages = await OutreachConversationModel.getMessagesByConversationId(conversationId);
        const hasPriorThreadMessage = existingMessages.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (candidate: any) => candidate.id !== messageId && (
            (candidate.direction === 'outbound' && ['sent', 'delivered', 'read'].includes(candidate.status))
            || candidate.direction === 'inbound'
          )
        );
        const inReplyTo = hasPriorThreadMessage
          ? await OutreachConversationModel.getLastMessageExternalId(conversationId)
          : null;
        const references = hasPriorThreadMessage
          ? await OutreachConversationModel.getFullReferenceChain(conversationId)
          : null;
        const result = await emailService.sendEmailWithUserCredentials(userId, {
          brandToolkitId: conversation.brandToolkitId,
          to: recipientEmail,
          subject: preparedMessage?.messageKind !== 'follow_up' && hasPriorThreadMessage && conversation.subject
            ? conversation.subject
            : (subject || conversation.subject || 'Hello'),
          html: preparedMessage?.htmlContent || `<p>${String(message).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!).replace(/\n/g, '<br>')}</p>`,
          text: message,
          attachments: emailAttachments,
          leadId,
          inReplyTo: inReplyTo || undefined,
          references: references || inReplyTo || undefined,
          threadId: hasPriorThreadMessage ? (conversation.externalThreadId || undefined) : undefined,
          skipConversationLog: true,
          skipCreditDeduction: true,
          idempotencyKey: `outreach-message-${userId}-${messageId}`,
        }, senderId || undefined);
        sendResult = toOutreachEmailResult(result);
        if (sendResult.success && result.threadId && result.threadId !== conversation.externalThreadId) {
          try {
            await OutreachConversationModel.updateOutreachConversation(conversationId, {
              externalThreadId: result.threadId,
            });
          } catch {
            log.warn({ conversationId, messageId }, 'Accepted email; thread mapping could not be updated');
          }
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (_e: any) {
        sendResult = {
          success: false,
          error: 'The email provider did not confirm whether this email was sent. It will not be resent automatically, to avoid a duplicate. Check your sent mail before sending it again.',
          outcomeUnknown: true,
          retryable: false,
        };
      }
    } else if (channel === 'instagram' && handle) {
      // ── Instagram channel ──
      const { sendInstagramDM } = await import('../services/instagramService.js');
      sendResult = await sendInstagramDM({
        recipientId: handle,
        message,
        userId,
        conversationId,
        messageId,
        providerAccountId: String((claim.rows[0] as { provider_account_id?: string }).provider_account_id || ''),
        skipCreditDeduction: true,
      });
    } else if (channel === 'sms' && phone) {
      // ── SMS channel ──
      try {
        const { sendSMS } = await import('../services/smsService.js');
        const result = await sendSMS(userId, phone, message, undefined,
          String((claim.rows[0] as { provider_account_id?: string }).provider_account_id || '') || undefined);
        sendResult = { success: result.success, externalMessageId: result.messageId, error: result.error,
          deliveryAttempted: result.deliveryAttempted, outcomeUnknown: result.outcomeUncertain, retryable: result.retryable };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (_e: any) {
        sendResult = {
          success: false,
          error: 'The SMS provider did not confirm whether this message was sent. It will not be resent automatically, to avoid a duplicate. Check the provider log before sending it again.',
          outcomeUnknown: true,
          retryable: false,
        };
      }
    } else if (channel === 'facebook' && facebookId) {
      // ── Facebook channel ──
      const { sendFacebookDM } = await import('../services/FacebookMessengerService.js');
      sendResult = await sendFacebookDM({ recipientId: facebookId, message, userId, conversationId, providerAccountId: String((claim.rows[0] as { provider_account_id?: string }).provider_account_id || '') });
    } else if (channel === 'whatsapp' && phone) {
      // ── WhatsApp channel via centralized service ──
      try {
        const { whatsappApiService } = await import('../services/whatsappApiService.js');
        const to = String(phone).replace(/^\+/, '');
        const tplName = (job.data?.templateName as string | undefined) || (job.data?.whatsappTemplateName as string | undefined);
        const tplLang = (job.data?.templateLanguage as string | undefined) || 'en_US';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tplComponents = job.data?.templateComponents as any[] | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let wa: any;
        if (tplName) {
          wa = await whatsappApiService.sendTemplate({ userId, phoneNumberId: claimedProviderAccountId, to, templateName: tplName, language: tplLang, components: tplComponents });
        } else {
          wa = await whatsappApiService.sendText({ userId, phoneNumberId: claimedProviderAccountId, to, text: message });
        }
        sendResult = { success: true, externalMessageId: wa.messages?.[0]?.id };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        sendResult = {
          success: false,
          error: e.message || 'WhatsApp send failed',
          deliveryAttempted: typeof e.deliveryAttempted === 'boolean' ? e.deliveryAttempted : undefined,
          outcomeUnknown: e.outcomeUncertain === true ? true : e.outcomeUncertain === false ? false : undefined,
          retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined,
          providerCode: e.code,
          retryAt: Number.isFinite(e.retryAfterMs) ? new Date(Date.now() + e.retryAfterMs).toISOString() : undefined,
        };
      }
    } else if (channel === 'twitter' && twitterHandle) {
      // ── Twitter channel ──
      const { sendTwitterDM } = await import('../services/TwitterApiService.js');
      sendResult = await sendTwitterDM({
        recipientId: twitterHandle,
        message,
        userId,
        providerAccountId: String((claim.rows[0] as { provider_account_id?: string }).provider_account_id || ''),
      });
      if (sendResult.success && conversationId) {
        OutreachConversationModel.updateOutreachConversation(conversationId, { externalThreadId: twitterHandle, integrationProvider: 'twitter_api' }).catch(() => {});
      }
    } else if (channel === 'linkedin' && linkedinUrl) {
      // ── LinkedIn channel ──
      const { sendLinkedInDM } = await import('../services/LinkedInApiService.js');
      sendResult = await sendLinkedInDM({
        recipientUrn: linkedinUrl,
        message,
        userId,
        providerAccountId: String((claim.rows[0] as { provider_account_id?: string }).provider_account_id || ''),
      });
      if (sendResult.success && conversationId) {
        OutreachConversationModel.updateOutreachConversation(conversationId, { externalThreadId: linkedinUrl, integrationProvider: 'linkedin_api' }).catch(() => {});
      }
    } else {
      sendResult = { success: false, error: `Missing required recipient info for ${channel}` };
    }

    if (
      sendResult
      && !sendResult.success
      && providerCallStarted
      && deliveryOutcomeIsUncertain(sendResult)
    ) {
      // Missing or uncertain provider evidence after the call boundary must
      // never be converted into a retryable rejection.
      sendResult = {
        success: false,
        error: "The provider did not confirm whether this message was delivered. It will not be resent automatically, to avoid a duplicate. Check the conversation or the provider's sent log before sending it again.",
        deliveryAttempted: true,
        outcomeUnknown: true,
        retryable: false,
      };
    }

    if ((sendResult as { code?: string })?.code === 'ASSISTANT_SETUP_REQUIRED') {
      providerCallStarted = false;
      throwIfCustomerDeliverySetupRequired(sendResult);
    }
    const providerReceipt = sendResult?.providerMessageId
      || sendResult?.externalMessageId
      || sendResult?.rfcMessageId;
    if (sendResult?.success && !providerReceipt) {
      sendResult = {
        success: false,
        error: 'The provider did not return a delivery receipt. Manual review is required before retrying.',
        outcomeUnknown: true,
        retryable: false,
      };
    }

    const deliveryUncertain = sendResult ? !sendResult.success && deliveryOutcomeIsUncertain(sendResult) : false;
    if (!sendResult?.success && !deliveryUncertain && reservationTransactionId) {
      await creditService.refundDeduction({
        userId,
        transactionId: reservationTransactionId,
        description: `Refund for failed ${channel} outreach message ${messageId}`,
      });
      reservationTransactionId = undefined;
    }

    if (sendResult && !sendResult.success && !deliveryUncertain && ['email', 'gmail'].includes(channel)) {
      providerCallStarted = false; // The provider explicitly rejected this attempt.
      const retryDecision = await delayRejectedEmail(job, sendResult, async retryAt => {
        await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'pending', {
          errorMessage: `Email provider temporarily limited sending. Retry scheduled after ${retryAt}.`,
          providerCallState: 'not_started', manualReviewRequired: false, sendClaimedAt: null,
        });
        await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{outreachQueue}',COALESCE(metadata->'outreachQueue','{}'::jsonb)||${JSON.stringify({reason:'provider_limit',nextAttemptAt:retryAt})}::jsonb) WHERE id=${messageId} AND user_id=${userId}`);
      }, preparedMessage?.confirmationExpiresAt);
      if (retryDecision === 'confirmation_expired') {
        sendResult.error = `${sendResult.error || 'Email provider temporarily limited sending'}. The delivery confirmation expires before the next retry. Review and send again after the provider cooldown.`;
      }
    }

    if (sendResult && !sendResult.success && !deliveryUncertain && ['whatsapp', 'instagram', 'facebook', 'sms'].includes(channel)) {
      providerCallStarted = false;
      const decision = await delayRejectedProvider(job, sendResult, async (retryAt, retryCount) => {
        await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'pending', {
          errorMessage: `${sendResult?.providerCode === WHATSAPP_APP_RATE_LIMIT ? 'App sending capacity reached' : 'Provider temporarily limited sending'}. Retry scheduled after ${retryAt}.`,
          providerCallState: 'not_started', manualReviewRequired: false, sendClaimedAt: null,
        });
        await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{outreachQueue}',COALESCE(metadata->'outreachQueue','{}'::jsonb)||${JSON.stringify({reason:sendResult?.providerCode === WHATSAPP_APP_RATE_LIMIT ? 'app_rate_limit' : 'provider_limit',nextAttemptAt:retryAt,retryCount})}::jsonb) WHERE id=${messageId} AND user_id=${userId}`);
      }, preparedMessage?.confirmationExpiresAt);
      if (decision === 'confirmation_expired') sendResult.error = `${sendResult.error || 'Provider temporarily limited sending'}. Review this outreach again: its queue lifetime expires before the next retry.`;
    }

    // Update message status
    if (sendResult?.success) {
      await OutreachConversationModel.updateOutreachMessageStatus(
        messageId,
        'sent',
        {
          externalMessageId: sendResult.externalMessageId,
          providerMessageId: sendResult.providerMessageId,
          rfcMessageId: sendResult.rfcMessageId,
          providerCallState: 'confirmed',
          manualReviewRequired: false,
        }
      );
      deliveryConfirmed = true;
      if (emailAttachments?.length) await outreachAttachmentService.markDelivery(messageId, userId, 'sent');

      // Update CRM pipeline status to 'contacted' (non-blocking, idempotent)
      if (leadId) {
        import('../services/CRMService.js').then(({ crmService }) =>
          crmService.autoCreateContactOnOutreachSend(userId, leadId, { source: channel })
        ).catch(() => {});
      }

      // Gmail/Resend already own sent-message tracking and credit accounting.
      // Other providers are tracked here exactly once through the shared model.
      if (!['email', 'gmail'].includes(channel)) {
        const { SentMessageModel } = await import('../models/sentMessages/functions.js');
        const lead = await db.execute(sql`
          SELECT full_name, first_name, name
          FROM leads WHERE id = ${leadId} AND user_id = ${userId} LIMIT 1
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const leadRow = lead.rows[0] as any;
        await SentMessageModel.create({
          leadId,
          leadName: leadRow?.full_name || leadRow?.first_name || leadRow?.name || 'Unknown',
          channel,
          subject: subject || null,
          message,
          status: 'sent',
          deliveryStatus: 'sent',
          sentAt: new Date(),
          userId,
          messageId: sendResult.externalMessageId || null,
          // Link the attempt to its message. Unlinked, every retry of one
          // message counted as a separate message in campaign reports.
          outreachMessageId: messageId,
        }, { skipCreditDeduction: true });
      }

      const { activateCreationFollowUps } = await import('../services/outreach/CreationFollowUpService.js');
      const usesCreationFollowUps = await activateCreationFollowUps(userId, messageId);
      if (!usesCreationFollowUps && ['instagram', 'facebook', 'whatsapp'].includes(channel)) {
        const { activateSocialFollowUpForAnchor } = await import('../services/socialFollowUpService.js');
        await activateSocialFollowUpForAnchor(messageId);
      }

      log.info({ jobId: job.id, messageId, channel }, 'Queued outreach message sent successfully');
    } else {
      await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'failed', {
        errorMessage: sendResult?.error || 'Provider rejected the message',
        providerCallState: deliveryUncertain ? 'unknown' : sendResult?.deliveryAttempted === false ? 'not_started' : 'rejected',
        manualReviewRequired: deliveryUncertain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      if (deliveryUncertain) {
        await OutreachConversationModel.updateOutreachMessageStatus(messageId, 'manual_review', {
          errorMessage: sendResult.error,
          providerCallState: 'unknown',
          manualReviewRequired: true,
        });
      }
      log.warn(
        {
          jobId: job.id,
          messageId,
          channel,
          outcome: sendResult?.outcomeUnknown ? 'unknown' : 'rejected',
        },
        'Queued outreach message did not reach a confirmed delivery state',
      );
    }

    return sendResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof DelayedError) throw err;
    if (deliveryConfirmed) {
      log.warn({ err, messageId }, 'Delivery confirmed; retrying follow-up activation without sending again');
      throw err;
    }
    const setup = deliverySetupFailure(err);
    const isLastAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts || 1);
    // Preserve retryable preparation failures until the durable job exhausts retries.
    try {
      await OutreachConversationModel.updateOutreachMessageStatus(
        messageId,
        setup ? 'setup_required' : providerCallStarted ? 'manual_review' : isLastAttempt ? 'failed' : 'pending',
        {
        errorMessage: setup ? `${setup.code}:${setup.reason}: ${setup.error}` : providerCallStarted
          ? 'Delivery outcome is uncertain after an interrupted send. Review provider history before reconciliation.'
          : isLastAttempt ? 'Message preparation failed after all delivery attempts. Create a new message to retry.' : 'Worker preparation failed before the provider boundary; the durable job may retry.',
        providerCallState: providerCallStarted ? 'unknown' : 'not_started',
        manualReviewRequired: providerCallStarted,
        sendClaimedAt: providerCallStarted ? new Date() : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    } catch (_e) { /* best effort */ }
    if (!providerCallStarted && reservationTransactionId) {
      try {
        const { creditService } = await import('../services/CreditService.js');
        await creditService.refundDeduction({
          userId,
          transactionId: reservationTransactionId,
          description: `Refund for unstarted ${channel} outreach message ${messageId}`,
        });
      } catch (_e) { /* best effort */ }
    }
    log.error(
      {
        jobId: job.id,
        messageId,
        channel,
        errorType: err instanceof Error ? err.name : 'UnknownError',
        providerCallStarted,
      },
      'Queued outreach message processing failed',
    );
    if (providerCallStarted) {
      return { success: false, error: 'Delivery outcome is uncertain; manual review is required' };
    }
    throw err;
  }
}

// ─── Outreach Worker (Social Follow-ups) ────────────────────────────────────────

function socialFollowUpPersistenceFromJob(job: Job): { messageId: number; step: number } | null {
  const messageId = Number(job.data.socialFollowUpMessageId);
  const step = Number(job.data.socialFollowUpStep);
  return job.data.isFollowUp === true
    && Number.isSafeInteger(messageId) && messageId > 0
    && Number.isSafeInteger(step) && step > 0
    ? { messageId, step }
    : null;
}

type OutboundSocialFollowUpLog = {
  scheduleMessageId?: number;
  originSentMessageId?: number;
  step: number;
};

function outboundSocialFollowUpLogFromJob(job: Job): OutboundSocialFollowUpLog | null {
  const managed = socialFollowUpPersistenceFromJob(job);
  if (managed) return { scheduleMessageId: managed.messageId, step: managed.step };

  const originSentMessageId = Number(job.data.followUpOriginMessageId);
  const step = Number(job.data.followUpStep);
  return job.data.isFollowUp === true
    && Number.isSafeInteger(originSentMessageId) && originSentMessageId > 0
    && Number.isSafeInteger(step) && step > 0
    ? { originSentMessageId, step }
    : null;
}

async function getCanonicalSocialRecipient(
  userId: number,
  leadId: number | undefined,
  channel: 'instagram' | 'facebook' | 'whatsapp',
  providerAccountId?: string,
): Promise<{ externalThreadId: string | null; leadInstagram: string | null } | null> {
  if (!leadId) return null;
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');
  const result = await db.execute(sql`
    SELECT external_thread_id, lead_instagram
    FROM outreach_conversations
    WHERE user_id = ${userId}
      AND lead_id = ${leadId}
      AND channel = ${channel}
      AND COALESCE(provider_account_id, '') = ${providerAccountId || ''}
      AND session_ended_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const row = result.rows[0] as {
    external_thread_id?: string | null;
    lead_instagram?: string | null;
  } | undefined;
  return row ? {
    externalThreadId: row.external_thread_id || null,
    leadInstagram: row.lead_instagram || null,
  } : null;
}

async function confirmManagedSocialFollowUp(job: Job, userId: number): Promise<boolean> {
  const persistence = socialFollowUpPersistenceFromJob(job);
  const scheduleId = Number(job.data.socialFollowUpScheduleId);
  if (!persistence || !Number.isSafeInteger(scheduleId) || scheduleId <= 0) return true;
  const { confirmSocialFollowUpDelivery } = await import('../services/socialFollowUpService.js');
  return confirmSocialFollowUpDelivery(scheduleId, persistence.messageId, userId);
}

/**
 * Phase 2.10: shared helper for "send + persist outreach_conversations" used by both
 * processOutreach and processQueuedOutreachMessage. Keeps the IG/FB dedup SQL in
 * one place and centralizes the post-send CRM hook.
 */
async function persistOutboundSocialMessage(
  userId: number,
  leadId: number | undefined,
  channel: string,
  leadName: string,
  recipientHandle: string,
  message: string,
  externalMessageId?: string | null,
  followUp?: OutboundSocialFollowUpLog | null,
  providerAccountId?: string,
): Promise<void> {
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');
  const { getOrCreateConversation, getOutreachConversationById } = await import('../models/outreachConversations/functions.js');
  const reserved = followUp?.scheduleMessageId ? await db.execute(sql`
    SELECT conversation_id FROM outreach_messages
    WHERE id = ${followUp.scheduleMessageId} AND user_id = ${userId} AND message_kind = 'follow_up'
  `) : null;
  const reservedConversationId = Number(reserved?.rows[0]?.conversation_id || 0);
  if (followUp?.scheduleMessageId && !reservedConversationId) throw new Error('Follow-up conversation no longer exists');
  const conversation = reservedConversationId
    ? await getOutreachConversationById(reservedConversationId)
    : await getOrCreateConversation({ userId, leadId: leadId || 0, channel, providerAccountId,
    leadName, leadInstagram: channel === 'instagram' ? recipientHandle : null,
    externalThreadId: recipientHandle, status: 'active' });
  if (!conversation || conversation.userId !== userId || conversation.channel !== channel) throw new Error('Follow-up conversation does not match');
  const conversationId = conversation.id;
  await db.execute(sql`UPDATE outreach_conversations SET status = 'active', last_message_by = 'user',
    last_message_at = NOW(), last_message_preview = ${message.substring(0, 200)},
    total_messages = COALESCE(total_messages, 0) + 1, updated_at = NOW()
    WHERE id = ${conversationId} AND user_id = ${userId}`);
  await db.execute(sql`
    INSERT INTO sent_messages (
      lead_id, lead_name, channel, message, status, delivery_status, sent_at, user_id,
      is_reply, follow_up_step, message_id
    )
    VALUES (
      ${leadId || null}, ${leadName}, ${channel}, ${message}, 'sent', 'sent', NOW(), ${userId},
      ${Boolean(followUp)}, ${followUp?.step || null}, ${externalMessageId || null}
    )
  `);
  if (!followUp) {
    const inserted = await db.execute(sql`
      INSERT INTO outreach_messages (
        conversation_id, user_id, direction, content, status, sent_at,
        external_message_id, provider_message_id, provider_account_id, is_automatic, message_kind,
        created_at, updated_at
      )
      VALUES (
        ${conversationId}, ${userId}, 'outbound', ${message}, 'sent', NOW(),
        ${externalMessageId || null}, ${externalMessageId || null}, ${providerAccountId || null}, false, 'outreach',
        NOW(), NOW()
      )
      RETURNING id
    `);
    const anchorMessageId = Number((inserted.rows[0] as { id: number }).id);
    const { activateSocialFollowUpForAnchor } = await import('../services/socialFollowUpService.js');
    await activateSocialFollowUpForAnchor(anchorMessageId);
  } else if (followUp.originSentMessageId && leadId) {
    // The legacy LinkedIn/X scheduler claims steps on sent_messages. Link the
    // successful delivery back to the existing outreach conversation so it is
    // visible there as a follow-up rather than another seed message.
    const originResult = await db.execute(sql`
      SELECT message_id
      FROM sent_messages
      WHERE id = ${followUp.originSentMessageId}
        AND user_id = ${userId}
        AND lead_id = ${leadId}
        AND channel = ${channel}
      LIMIT 1
    `);
    const originExternalId = String((originResult.rows[0] as { message_id?: string | null } | undefined)?.message_id || '');
    if (originExternalId) {
      const anchorResult = await db.execute(sql`
        SELECT id
        FROM outreach_messages
        WHERE conversation_id = ${conversationId}
          AND direction = 'outbound'
          AND message_kind = 'outreach'
          AND (
            external_message_id = ${originExternalId}
            OR provider_message_id = ${originExternalId}
            OR rfc_message_id = ${originExternalId}
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `);
      const anchorMessageId = Number((anchorResult.rows[0] as { id?: number } | undefined)?.id);
      if (Number.isSafeInteger(anchorMessageId) && anchorMessageId > 0) {
        await db.execute(sql`
          INSERT INTO outreach_messages (
            conversation_id, user_id, direction, content, status, sent_at,
            external_message_id, provider_message_id, provider_account_id,
            is_automatic, sequence_step, message_kind, follow_up_origin_message_id,
            follow_up_step, created_at, updated_at
          ) VALUES (
            ${conversationId}, ${userId}, 'outbound', ${message}, 'sent', NOW(),
            ${externalMessageId || null}, ${externalMessageId || null}, ${providerAccountId || null},
            true, ${followUp.step}, 'follow_up', ${anchorMessageId}, ${followUp.step}, NOW(), NOW()
          )
          ON CONFLICT DO NOTHING
        `);
      } else {
        createWorkerLogger('outreach').warn(
          { channel, originSentMessageId: followUp.originSentMessageId },
          'Follow-up was sent but its original conversation message could not be linked',
        );
      }
    } else {
      createWorkerLogger('outreach').warn(
        { channel, originSentMessageId: followUp.originSentMessageId },
        'Follow-up was sent but its original sent-message record could not be found',
      );
    }
  }
  if (leadId) {
    import('../services/CRMService.js').then(({ crmService }) =>
      crmService.autoCreateContactOnOutreachSend(userId, leadId, { source: channel })
    ).catch(() => {});
  }
}

async function processWhatsAppOutreach(
  job: Job,
  log: ReturnType<typeof createWorkerLogger>,
  userId: number,
  leadId: number | undefined,
  message: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { whatsappApiService } = await import('../services/whatsappApiService.js');
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');

  let phone = job.data.recipientPhone;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lead: any = null;
  if (job.data.isFollowUp === true) {
    const canonical = await getCanonicalSocialRecipient(userId, leadId, 'whatsapp', job.data.providerAccountId);
    phone = canonical?.externalThreadId || phone;
  }
  if (!phone && leadId) {
    const leadRes = await db.execute(sql`SELECT * FROM leads WHERE id = ${leadId} AND user_id = ${userId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lead = leadRes.rows[0] as any;
    if (!lead) {
      log.warn({ leadId }, 'Lead not found, skipping WhatsApp outreach');
      return { success: false, error: 'Lead not found' };
    }
    phone = lead.phone || lead.whatsapp_phone || null;
  }
  if (!phone) {
    log.warn({ leadId }, 'No WhatsApp phone number found for lead');
    return { success: false, error: 'No phone number for lead' };
  }

  // Clean phone number (strip leading +, spaces, hyphens)
  const recipientPhone = String(phone).replace(/[^0-9]/g, '');

  if (!outboundSocialFollowUpLogFromJob(job)) {
    const dupeCheck = await db.execute(sql`
      SELECT id FROM sent_messages
      WHERE lead_id = ${leadId} AND user_id = ${userId}
      AND channel = 'whatsapp' AND message = ${message}
      AND sent_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1
    `);
    if (dupeCheck.rows.length > 0) {
      log.info({ leadId, jobId: job.id }, 'WhatsApp message already sent recently, skipping duplicate');
      return { success: true, note: 'duplicate_prevention' };
    }
  }

  if (!await confirmManagedSocialFollowUp(job, userId)) {
    return { success: false, suppressed: true, error: 'Reply or human takeover suppressed this follow-up' };
  }
  const providerAccountId = String(job.data.providerAccountId || '');
  const { hasActiveWhatsAppWindow } = await import('../services/whatsappServiceWindow.js');
  if (!leadId || !await hasActiveWhatsAppWindow(userId, leadId, providerAccountId)) {
    return {
      success: false,
      code: 'WHATSAPP_TEMPLATE_REQUIRED',
      deliveryAttempted: false,
      error: 'An approved WhatsApp template is required outside the 24-hour reply window.',
    };
  }
  const result = await whatsappApiService.sendText({
    userId,
    phoneNumberId: providerAccountId || undefined,
    to: recipientPhone,
    text: message,
  });

  const sentWamid = result.messages?.[0]?.id || null;

  if (sentWamid) {
    const leadName = lead?.full_name || lead?.first_name || lead?.name || recipientPhone;
    await persistOutboundSocialMessage(
      userId,
      leadId,
      'whatsapp',
      leadName,
      recipientPhone,
      message,
      sentWamid,
      outboundSocialFollowUpLogFromJob(job),
      job.data.providerAccountId,
    );
    log.info({ jobId: job.id, leadId, channel: 'whatsapp', recipientPhone }, 'WhatsApp outreach sent');
    return { success: true, messageId: sentWamid };
  } else {
    log.warn({ jobId: job.id, leadId, channel: 'whatsapp', error: result?.error }, 'WhatsApp outreach failed');
    return { success: false, error: result?.error || 'Failed to send WhatsApp message' };
  }
}


async function processInstagramOutreach(
  job: Job,
  log: ReturnType<typeof createWorkerLogger>,
  userId: number,
  leadId: number | undefined,
  message: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { routeInstagramMessage, getDelayUntilTomorrow } = await import('../services/instagramMessageRouter.js');
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');

  let username = job.data.recipientUsername;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lead: any = null;
  if (job.data.isFollowUp === true) {
    const canonical = await getCanonicalSocialRecipient(userId, leadId, 'instagram', job.data.providerAccountId);
    username = canonical?.externalThreadId || canonical?.leadInstagram || username;
  }
  if (!username && leadId) {
    const leadRes = await db.execute(sql`SELECT * FROM leads WHERE id = ${leadId} AND user_id = ${userId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lead = leadRes.rows[0] as any;
    if (!lead) {
      log.warn({ leadId }, 'Lead not found, skipping outreach');
      return { success: false, error: 'Lead not found' };
    }
    username = lead.instagram_handle || lead.instagram || null;
    if (!username && lead.instagram_url) {
      const urlParts = lead.instagram_url.replace(/\/+$/, '').split('/');
      username = urlParts[urlParts.length - 1] || null;
    }
  }
  if (!username) {
    log.warn({ leadId }, 'No Instagram handle found for lead');
    return { success: false, error: 'No Instagram handle for lead' };
  }
  username = username.replace(/^@/, '').trim();
  if (username.includes('instagram.com/')) {
    const urlParts = username.replace(/\/+$/, '').split('/');
    username = urlParts[urlParts.length - 1] || username;
  }
  if (!outboundSocialFollowUpLogFromJob(job)) {
    const dupeCheck = await db.execute(sql`
      SELECT id FROM sent_messages
      WHERE lead_id = ${leadId} AND user_id = ${userId}
      AND channel = 'instagram' AND message = ${message}
      AND sent_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1
    `);
    if (dupeCheck.rows.length > 0) {
      log.info({ leadId, jobId: job.id }, 'Instagram message already sent recently, skipping duplicate');
      return { success: true, note: 'duplicate_prevention' };
    }
  }
  if (!await confirmManagedSocialFollowUp(job, userId)) {
    return { success: false, suppressed: true, error: 'Reply or human takeover suppressed this follow-up' };
  }
  const result = await routeInstagramMessage({
    userId,
    leadId: leadId || 0,
    recipientUsername: username,
    conversationId: job.data.conversationId,
    providerAccountId: job.data.providerAccountId,
    message,
    isWelcomeMessage: job.data.isWelcomeMessage || false,
    isFollowUp: job.data.isFollowUp || false,
  });
  if (result.method === 'delayed') {
    const delayMs = getDelayUntilTomorrow();
    log.info({ jobId: job.id, delayMs }, 'Daily limit reached, delaying job until tomorrow');
    await job.moveToDelayed(Date.now() + delayMs, job.token);
    throw new Error('DAILY_LIMIT_REACHED');
  }
  if (result.success) {
    const leadName = lead?.full_name || lead?.first_name || lead?.name || username;
    await persistOutboundSocialMessage(
      userId,
      leadId,
      'instagram',
      leadName,
      username,
      message,
      result.messageId || null,
      outboundSocialFollowUpLogFromJob(job),
      job.data.providerAccountId,
    );
    log.info({ jobId: job.id, leadId, channel: 'instagram', method: result.method, isWelcome: job.data.isWelcomeMessage }, 'Instagram outreach sent');
  }
  return result;
}

async function processFacebookOutreach(
  job: Job,
  log: ReturnType<typeof createWorkerLogger>,
  userId: number,
  leadId: number | undefined,
  message: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { sendFacebookDM } = await import('../services/FacebookMessengerService.js');
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');

  let recipientId = job.data.recipientId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lead: any = null;
  if (job.data.isFollowUp === true) {
    const canonical = await getCanonicalSocialRecipient(userId, leadId, 'facebook', job.data.providerAccountId);
    recipientId = canonical?.externalThreadId || recipientId;
  }
  if (!recipientId && leadId) {
    const leadRes = await db.execute(sql`SELECT * FROM leads WHERE id = ${leadId} AND user_id = ${userId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lead = leadRes.rows[0] as any;
    if (!lead) {
      log.warn({ leadId }, 'Lead not found, skipping Facebook outreach');
      return { success: false, error: 'Lead not found' };
    }
    recipientId = lead.platform_extended?.facebook_id || lead.facebook || null;
    if (!recipientId && lead.facebook_url) {
      const urlParts = lead.facebook_url.replace(/\/+$/, '').split('/');
      recipientId = urlParts[urlParts.length - 1] || null;
    }
  }
  if (!recipientId) {
    log.warn({ leadId }, 'No Facebook recipient ID found for lead');
    return { success: false, error: 'No Facebook recipient ID for lead' };
  }
  if (!outboundSocialFollowUpLogFromJob(job)) {
    const dupeCheck = await db.execute(sql`
      SELECT id FROM sent_messages
      WHERE lead_id = ${leadId} AND user_id = ${userId}
      AND channel = 'facebook' AND message = ${message}
      AND sent_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1
    `);
    if (dupeCheck.rows.length > 0) {
      log.info({ leadId, jobId: job.id }, 'Facebook message already sent recently, skipping duplicate');
      return { success: true, note: 'duplicate_prevention' };
    }
  }
  if (!await confirmManagedSocialFollowUp(job, userId)) {
    return { success: false, suppressed: true, error: 'Reply or human takeover suppressed this follow-up' };
  }
  const result = await sendFacebookDM({ recipientId, message, userId, providerAccountId: job.data.providerAccountId });
  if (result.success) {
    const leadName = lead?.full_name || lead?.first_name || lead?.name || recipientId;
    await persistOutboundSocialMessage(
      userId,
      leadId,
      'facebook',
      leadName,
      recipientId,
      message,
      result.externalMessageId || null,
      outboundSocialFollowUpLogFromJob(job),
      job.data.providerAccountId,
    );
    log.info({ jobId: job.id, leadId, channel: 'facebook', recipientId }, 'Facebook outreach sent');
  } else {
    log.warn({ jobId: job.id, leadId, channel: 'facebook', error: result.error }, 'Facebook outreach failed');
  }
  return result;
}

async function processTwitterOutreach(
  job: Job,
  log: ReturnType<typeof createWorkerLogger>,
  userId: number,
  leadId: number | undefined,
  message: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { sendTwitterDM } = await import('../services/TwitterApiService.js');
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');

  let twitterHandle = job.data.recipientId || job.data.twitterHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lead: any = null;
  if (!twitterHandle && leadId) {
    const leadRes = await db.execute(sql`SELECT * FROM leads WHERE id = ${leadId} AND user_id = ${userId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lead = leadRes.rows[0] as any;
    if (!lead) {
      log.warn({ leadId }, 'Lead not found, skipping Twitter outreach');
      return { success: false, error: 'Lead not found' };
    }
    twitterHandle = lead.twitter_handle || lead.twitter || null;
    if (!twitterHandle && lead.twitter_url) {
      const urlParts = lead.twitter_url.replace(/\/+$/, '').split('/');
      twitterHandle = urlParts[urlParts.length - 1] || null;
    }
  }
  if (!twitterHandle) {
    log.warn({ leadId }, 'No Twitter handle found for lead');
    return { success: false, error: 'No Twitter handle for lead' };
  }
  const dupeCheck = await db.execute(sql`
    SELECT id FROM sent_messages
    WHERE lead_id = ${leadId} AND user_id = ${userId}
    AND channel = 'twitter' AND message = ${message}
    AND sent_at > NOW() - INTERVAL '5 minutes'
    LIMIT 1
  `);
  if (dupeCheck.rows.length > 0) {
    log.info({ leadId, jobId: job.id }, 'Twitter message already sent recently, skipping duplicate');
    return { success: true, note: 'duplicate_prevention' };
  }
  const result = await sendTwitterDM({
    recipientId: twitterHandle,
    message,
    userId,
    providerAccountId: job.data.providerAccountId,
  });
  if (result.success) {
    const leadName = lead?.full_name || lead?.first_name || lead?.name || twitterHandle;
    await persistOutboundSocialMessage(
      userId,
      leadId,
      'twitter',
      leadName,
      twitterHandle,
      message,
      result.externalMessageId || null,
      outboundSocialFollowUpLogFromJob(job),
      job.data.providerAccountId,
    );
    log.info({ jobId: job.id, leadId, channel: 'twitter', twitterHandle }, 'Twitter outreach sent');
  } else {
    log.warn({ jobId: job.id, leadId, channel: 'twitter', error: result.error }, 'Twitter outreach failed');
  }
  return result;
}

async function processLinkedInOutreach(
  job: Job,
  log: ReturnType<typeof createWorkerLogger>,
  userId: number,
  leadId: number | undefined,
  message: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { sendLinkedInDM } = await import('../services/LinkedInApiService.js');
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');

  let linkedinUrl = job.data.recipientUrn || job.data.linkedinUrl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lead: any = null;
  if (!linkedinUrl && leadId) {
    const leadRes = await db.execute(sql`SELECT * FROM leads WHERE id = ${leadId} AND user_id = ${userId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lead = leadRes.rows[0] as any;
    if (!lead) {
      log.warn({ leadId }, 'Lead not found, skipping LinkedIn outreach');
      return { success: false, error: 'Lead not found' };
    }
    linkedinUrl = lead.linkedin_url || lead.linkedin || null;
  }
  if (!linkedinUrl) {
    log.warn({ leadId }, 'No LinkedIn URL/URN found for lead');
    return { success: false, error: 'No LinkedIn URL for lead' };
  }
  const dupeCheck = await db.execute(sql`
    SELECT id FROM sent_messages
    WHERE lead_id = ${leadId} AND user_id = ${userId}
    AND channel = 'linkedin' AND message = ${message}
    AND sent_at > NOW() - INTERVAL '5 minutes'
    LIMIT 1
  `);
  if (dupeCheck.rows.length > 0) {
    log.info({ leadId, jobId: job.id }, 'LinkedIn message already sent recently, skipping duplicate');
    return { success: true, note: 'duplicate_prevention' };
  }
  const result = await sendLinkedInDM({
    recipientUrn: linkedinUrl,
    message,
    userId,
    providerAccountId: job.data.providerAccountId,
  });
  if (result.success) {
    const leadName = lead?.full_name || lead?.first_name || lead?.name || linkedinUrl;
    await persistOutboundSocialMessage(
      userId,
      leadId,
      'linkedin',
      leadName,
      linkedinUrl,
      message,
      result.externalMessageId || null,
      outboundSocialFollowUpLogFromJob(job),
      job.data.providerAccountId,
    );
    log.info({ jobId: job.id, leadId, channel: 'linkedin', linkedinUrl }, 'LinkedIn outreach sent');
  } else {
    log.warn({ jobId: job.id, leadId, channel: 'linkedin', error: result.error }, 'LinkedIn outreach failed');
  }
  return result;
}

async function reconcileChatOutreachCampaign(
  job: Job,
  outcome: 'sent' | 'failed',
  providerReceipt?: string | null,
  error?: string,
): Promise<void> {
  const campaignId = Number(job.data.campaignId);
  const sequenceExecutionId = Number(job.data.sequenceExecutionId);
  const userId = Number(job.data.userId);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) return;

  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');
  if (Number.isSafeInteger(sequenceExecutionId) && sequenceExecutionId > 0) {
    await db.execute(sql`
      UPDATE sequence_executions
      SET status = ${outcome === 'sent' ? 'completed' : 'failed'},
          current_step = 1,
          total_messages_sent = total_messages_sent + ${outcome === 'sent' ? 1 : 0},
          completed_at = NOW(),
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            providerReceipt: providerReceipt || null,
            lastError: error || null,
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${sequenceExecutionId}
        AND user_id = ${userId}
        AND status = 'active'
    `);
  }

  await db.execute(sql`
    UPDATE outreach_campaigns
    SET messages_sent = COALESCE(messages_sent, 0) + ${outcome === 'sent' ? 1 : 0},
        messages_failed = COALESCE(messages_failed, 0) + ${outcome === 'failed' ? 1 : 0},
        status = CASE
          WHEN COALESCE(messages_sent, 0) + COALESCE(messages_failed, 0) + 1 >= COALESCE(total_leads, 0)
            THEN CASE
              WHEN COALESCE(messages_sent, 0) + ${outcome === 'sent' ? 1 : 0} > 0
                AND COALESCE(messages_failed, 0) + ${outcome === 'failed' ? 1 : 0} > 0
                THEN 'partial_success'
              WHEN ${outcome} = 'sent' THEN 'completed'
              ELSE 'failed'
            END
          ELSE 'running'
        END,
        is_active = COALESCE(messages_sent, 0) + COALESCE(messages_failed, 0) + 1 < COALESCE(total_leads, 0),
        completed_at = CASE
          WHEN COALESCE(messages_sent, 0) + COALESCE(messages_failed, 0) + 1 >= COALESCE(total_leads, 0) THEN NOW()
          ELSE completed_at
        END,
        updated_at = NOW()
    WHERE id = ${campaignId} AND user_id = ${userId}
  `);
}

async function processOutreach(job: Job) {
  const log = createWorkerLogger('outreach');
  const { userId, leadId, channel, message } = job.data;
  const socialScheduleId = Number(job.data.socialFollowUpScheduleId);
  const socialFollowUpMessageId = Number(job.data.socialFollowUpMessageId);
  const isManagedSocialFollowUp = job.name === 'send_follow_up_social'
    && job.data.isFollowUp === true
    && Number.isSafeInteger(socialScheduleId) && socialScheduleId > 0
    && Number.isSafeInteger(socialFollowUpMessageId) && socialFollowUpMessageId > 0;
  let managedDeliveryClaimed = false;
  let managedFailureHandled = false;
  let managedActivityRecorded = false;
  let socialDispatchStarted = false;

  log.info({ jobId: job.id, userId, leadId, channel }, 'Processing outreach job');

  // Stop legacy queued schedules as well as newly scheduled follow-ups.
  // Ordinary LinkedIn/X outreach remains available.
  if ((job.data.isFollowUp === true || job.name === 'send_follow_up_social')
    && (channel === 'linkedin' || channel === 'twitter')) {
    log.info({ jobId: job.id, channel }, 'Skipping retired follow-up channel');
    return { skipped: true, reason: 'follow_up_channel_disabled' };
  }

  try {
    // ── Queued Message Send (from bulk create) ──
    if (job.name === 'send_outreach_message') {
      return await processQueuedOutreachMessage(job);
    }

    if (job.name === 'process_whatsapp_webhook') {
      const { processWhatsAppWebhook } = await import('./outreach/whatsappProcessor.js');
      return await processWhatsAppWebhook(job);
    }

    if (job.name === 'process_support_widget_turn') {
      const { processSupportWidgetTurn } = await import('./outreach/supportWidgetProcessor.js');
      return await processSupportWidgetTurn(job);
    }

    if (job.name === 'process_instagram_automation') {
      const { processInstagramAutomationRun } = await import('../services/instagramAutomations/InstagramAutomationRuntime.js');
      await processInstagramAutomationRun(Number(job.data.userId), Number(job.data.runId));
      return { success: true };
    }
    if (job.name === 'process_social_comment_webhook') {
      const { triggerAutoReply } = await import('../controllers/webhooksController.js');
      await triggerAutoReply(job.data.userId, job.data.conversationId, job.data.lead, job.data.data);
      return { success: true };
    }
    if (job.name === 'process_instagram_webhook' || job.name === 'process_facebook_webhook') {
      const { processSocialWebhook } = await import('./outreach/socialProcessor.js');
      return await processSocialWebhook(job);
    }

    if (isManagedSocialFollowUp && ['whatsapp', 'facebook', 'instagram', 'twitter', 'linkedin'].includes(channel)) {
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');
      const origin = await db.execute(sql`
        SELECT conversation.provider_account_id FROM social_follow_up_schedules schedule
        JOIN outreach_conversations conversation ON conversation.id = schedule.conversation_id AND conversation.user_id = schedule.user_id
        JOIN outreach_messages message ON message.conversation_id = conversation.id AND message.user_id = conversation.user_id
        WHERE schedule.id = ${socialScheduleId} AND schedule.user_id = ${Number(userId)}
          AND conversation.channel = ${String(channel)} AND message.id = ${socialFollowUpMessageId}
      `);
      const accountId = String(origin.rows[0]?.provider_account_id || '');
      if (!accountId || (job.data.providerAccountId && job.data.providerAccountId !== accountId)) throw new Error('The follow-up account no longer matches its conversation.');
      job.data.providerAccountId = accountId;
    }

    // LinkedIn/X (and any legacy non-conversation social sequence) anchors are
    // stored in sent_messages. Reuse the account on the original conversation;
    // sending without it would either fail provider validation or risk choosing
    // a different account from the one that started the sequence.
    if (
      job.data.isFollowUp === true
      && !job.data.providerAccountId
      && Number.isSafeInteger(Number(job.data.followUpOriginMessageId))
      && Number(job.data.followUpOriginMessageId) > 0
      && ['facebook', 'instagram', 'twitter', 'linkedin'].includes(channel)
    ) {
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');
      const origin = await db.execute(sql`
        SELECT conversation.provider_account_id
        FROM sent_messages sent
        JOIN outreach_conversations conversation
          ON conversation.user_id = sent.user_id
          AND conversation.lead_id = sent.lead_id
          AND conversation.channel = sent.channel
        JOIN outreach_messages message
          ON message.conversation_id = conversation.id
          AND message.direction = 'outbound'
          AND message.message_kind = 'outreach'
          AND (
            message.external_message_id = sent.message_id
            OR message.provider_message_id = sent.message_id
            OR message.rfc_message_id = sent.message_id
          )
        WHERE sent.id = ${Number(job.data.followUpOriginMessageId)}
          AND sent.user_id = ${Number(userId)}
          AND sent.lead_id = ${Number(leadId)}
          AND sent.channel = ${String(channel)}
        ORDER BY conversation.updated_at DESC
        LIMIT 1
      `);
      const accountId = String(origin.rows[0]?.provider_account_id || '');
      if (!accountId) {
        throw new Error('The follow-up could not find the provider account used for the original social message.');
      }
      job.data.providerAccountId = accountId;
    }

    if (job.name === 'start_outreach_campaign' || ['whatsapp', 'facebook', 'instagram', 'twitter', 'linkedin'].includes(channel)) {
      const providerAccountId = String(job.data.providerAccountId || '');
      const providerCredentialId = Number(job.data.providerCredentialId);
      const { resolveOfficialProviderBinding } = await import('../services/outreach/ProviderBindingService.js');
      const binding = await resolveOfficialProviderBinding(
        Number(userId),
        channel as 'whatsapp' | 'instagram' | 'facebook' | 'linkedin' | 'twitter',
        {
          ...(providerAccountId ? { providerAccountId } : {}),
          ...(Number.isSafeInteger(providerCredentialId) && providerCredentialId > 0 ? { credentialId: providerCredentialId } : {}),
        },
      );
      if (!binding || !providerAccountId || binding.providerAccountId !== providerAccountId) {
        const errorMessage = 'The provider account bound to this conversation is unavailable. Reconnect that same account, then create a new follow-up.';
        if (isManagedSocialFollowUp) {
          const { failSocialFollowUpDelivery } = await import('../services/socialFollowUpService.js');
          await failSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId, 'account_unavailable');
          return { success: false, error: errorMessage };
        }
        throw new Error(errorMessage);
      }
    }

    if (isManagedSocialFollowUp) {
      const { claimSocialFollowUpDelivery } = await import('../services/socialFollowUpService.js');
      managedDeliveryClaimed = await claimSocialFollowUpDelivery(
        socialScheduleId,
        socialFollowUpMessageId,
        Number(userId),
      );
      if (!managedDeliveryClaimed) {
        log.info(
          { jobId: job.id, socialScheduleId, socialFollowUpMessageId },
          'Social follow-up suppressed because the anchor was answered or the conversation changed ownership',
        );
        return { success: false, suppressed: true, error: 'Reply or human takeover suppressed this follow-up' };
      }
    }

    let result: {
      success: boolean;
      error?: string;
      externalMessageId?: string;
      messageId?: string;
      [key: string]: unknown;
    };
    socialDispatchStarted = true;
    if (channel === 'whatsapp') {
      result = await processWhatsAppOutreach(job, log, userId, leadId, message);
    } else if (channel === 'instagram') {
      result = await processInstagramOutreach(job, log, userId, leadId, message);
    } else if (channel === 'facebook') {
      result = await processFacebookOutreach(job, log, userId, leadId, message);
    } else if (channel === 'twitter') {
      result = await processTwitterOutreach(job, log, userId, leadId, message);
    } else if (channel === 'linkedin') {
      result = await processLinkedInOutreach(job, log, userId, leadId, message);
    } else {
      // For other social channels — log and skip until services are available
      log.warn({ jobId: job.id, channel }, 'Social channel not yet supported for automated follow-ups');
      result = { success: false, error: `Channel ${channel} not yet supported for automated follow-ups` };
    }

    if (isManagedSocialFollowUp) {
      const {
        completeSocialFollowUpDelivery,
        failSocialFollowUpDelivery,
        releaseSocialFollowUpDelivery,
      } = await import('../services/socialFollowUpService.js');
      if (result.suppressed === true) {
        managedFailureHandled = true;
        return result;
      }
      if (result.code === 'WHATSAPP_TEMPLATE_REQUIRED') {
        await recordFollowUpActivity({
          userId: Number(userId), leadId: Number(leadId), leadName: String(job.data.leadName || 'Unknown'),
          channel: String(channel), message: String(message || ''), subject: job.data.subject || null,
          status: 'failed', deliveryStatus: 'failed', followUpStep: Number(job.data.followUpStep),
        });
        managedActivityRecorded = true;
        await failSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId, 'template_required');
        managedFailureHandled = true;
        return result;
      }
      if (result?.success) {
        await completeSocialFollowUpDelivery(
          socialScheduleId,
          socialFollowUpMessageId,
          result.externalMessageId || result.messageId || null,
        );
      } else {
        const attempts = Number(job.opts.attempts || 1);
        const isLastAttempt = job.attemptsMade + 1 >= attempts;
        if (isLastAttempt) {
          await recordFollowUpActivity({
            userId: Number(userId), leadId: Number(leadId), leadName: String(job.data.leadName || 'Unknown'),
            channel: String(channel), message: String(message || ''), subject: job.data.subject || null,
            status: 'failed', deliveryStatus: 'failed', followUpStep: Number(job.data.followUpStep),
          });
          managedActivityRecorded = true;
          await failSocialFollowUpDelivery(
            socialScheduleId,
            socialFollowUpMessageId,
            'delivery_failed',
          );
        } else {
          await releaseSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId);
        }
        managedFailureHandled = true;
        throw new Error(result?.error || `Failed to send ${channel} follow-up`);
      }
    }

    const followUpLog = outboundSocialFollowUpLogFromJob(job);
    if (followUpLog && !isManagedSocialFollowUp && result.success !== true && result.suppressed !== true) {
      await recordFollowUpActivity({
        userId: Number(userId), leadId: Number(leadId), leadName: String(job.data.leadName || 'Unknown'),
        channel: String(channel), message: String(message || ''), subject: job.data.subject || null,
        status: 'failed', deliveryStatus: 'failed', followUpStep: followUpLog.step,
      });
    }

    if (job.data.campaignId) {
      await reconcileChatOutreachCampaign(
        job,
        result.success === true ? 'sent' : 'failed',
        String(result.externalMessageId || result.messageId || '') || null,
        result.success === true ? undefined : result.error,
      );
    }

    if (job.data.widgetId) {
      const { WidgetStateModel } = await import('../models/widgetStates/functions.js');
      await WidgetStateModel.recordQueuedJobOutcomeForUser(
        Number(job.data.widgetId),
        Number(userId),
        String(job.id),
        Number(job.data.expectedWidgetJobCount || 1),
        result.success === true,
        result,
      );
    }
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof DelayedError) throw err;
    if (isManagedSocialFollowUp && managedDeliveryClaimed && !managedFailureHandled) {
      const { failSocialFollowUpDelivery, releaseSocialFollowUpDelivery } = await import('../services/socialFollowUpService.js');
      if (err?.message === 'DAILY_LIMIT_REACHED') {
        await releaseSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId);
      } else {
        const deliveryUncertain = deliveryOutcomeIsUncertain(err);
        if (!managedActivityRecorded) {
          await recordFollowUpActivity({
            userId: Number(userId), leadId: Number(leadId), leadName: String(job.data.leadName || 'Unknown'),
            channel: String(channel), message: String(message || ''), subject: job.data.subject || null,
            status: 'failed', deliveryStatus: deliveryUncertain ? 'uncertain' : 'failed', followUpStep: Number(job.data.followUpStep),
          });
        }
        await failSocialFollowUpDelivery(
          socialScheduleId,
          socialFollowUpMessageId,
          deliveryUncertain ? 'delivery_uncertain' : 'delivery_failed',
        );
      }
    }
    if (job.data.widgetId) {
      try {
        const { WidgetStateModel } = await import('../models/widgetStates/functions.js');
        await WidgetStateModel.recordQueuedJobOutcomeForUser(
          Number(job.data.widgetId),
          Number(userId),
          String(job.id),
          Number(job.data.expectedWidgetJobCount || 1),
          false,
          { error: err.message },
        );
      } catch (reconcileError) {
        log.error({ err: reconcileError, widgetId: job.data.widgetId }, 'Failed to reconcile queued widget outcome');
      }
    }
    const attempts = Number(job.opts.attempts || 1);
    const isLastAttempt = job.attemptsMade + 1 >= attempts;
    const genericFollowUpLog = !isManagedSocialFollowUp ? outboundSocialFollowUpLogFromJob(job) : null;
    if (isManagedSocialFollowUp && !managedDeliveryClaimed && isLastAttempt) {
      const { failSocialFollowUpDelivery } = await import('../services/socialFollowUpService.js');
      await failSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId, 'delivery_failed');
    }
    if (genericFollowUpLog && isLastAttempt) {
      await recordFollowUpActivity({
        userId: Number(userId), leadId: Number(leadId), leadName: String(job.data.leadName || 'Unknown'),
        channel: String(channel), message: String(message || ''), subject: job.data.subject || null,
        status: 'failed', deliveryStatus: socialDispatchStarted ? 'uncertain' : 'failed',
        followUpStep: genericFollowUpLog.step,
      });
    }
    if (job.data.campaignId && isLastAttempt) {
      try {
        await reconcileChatOutreachCampaign(job, 'failed', null, err.message);
      } catch (reconcileError) {
        log.error({ err: reconcileError, campaignId: job.data.campaignId }, 'Failed to reconcile outreach campaign failure');
      }
    }
    log.error({ jobId: job.id, userId, channel, err: err.message }, 'Outreach job failed');
    throw err;
  }
}

async function processAiVisibilityAudit(job: Job<BaseJobData & { auditId: number; projectId: number; retryReport?: boolean }>): Promise<unknown> {
  const auditId = Number(job.data.auditId);
  const userId = Number(job.data.userId);
  if (!Number.isSafeInteger(auditId) || auditId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('AI Visibility audit job is missing a valid auditId or userId.');
  }
  const { auditOrchestrator } = await import('../services/aiVisibility/AuditOrchestrator.js');
  if (job.data.retryReport) {
    await auditOrchestrator.retryReport(auditId, userId);
    return { auditId, reportRetry: true };
  }
  return auditOrchestrator.run(auditId, userId);
}

async function processAiVisibilityMonitoring(): Promise<{ scheduled: number; skipped: number }> {
  const { and, eq, lte } = await import('drizzle-orm');
  const { db } = await import('../models/db.js');
  const { aiVisibilityProjectsTable } = await import('../models/aiVisibility/schema.js');
  const { aiVisibilityService } = await import('../services/aiVisibility/AiVisibilityService.js');
  const due = await db.select().from(aiVisibilityProjectsTable).where(and(
    eq(aiVisibilityProjectsTable.monitoringEnabled, true),
    eq(aiVisibilityProjectsTable.status, 'active'),
    lte(aiVisibilityProjectsTable.nextMonitoringAt, new Date()),
  ));
  let scheduled = 0;
  let skipped = 0;
  for (const project of due) {
    const periodKey = new Date().toISOString().slice(0, 10);
    const reservation = await aiVisibilityService.createAudit(project.userId, project.id, 'monitoring', periodKey);
    if (!reservation.success || !reservation.resource) {
      skipped += 1;
      continue;
    }
    if ('alreadyScheduled' in reservation && reservation.alreadyScheduled) {
      skipped += 1;
      continue;
    }
    try {
      await queueRegistry.addJob(QUEUE_NAMES.AI_VISIBILITY_AUDIT, 'run-audit', {
        userId: project.userId,
        projectId: project.id,
        auditId: reservation.resource.id,
        createdAt: new Date().toISOString(),
      }, { jobId: `ai-visibility-audit-${reservation.resource.id}` });
    } catch (_error) {
      if ('transactionId' in reservation && reservation.transactionId) {
        const { creditService } = await import('../services/CreditService.js');
        await creditService.refundDeduction({ userId: project.userId, transactionId: reservation.transactionId, description: `Refund for monitoring audit ${reservation.resource.id}: queue dispatch failed` });
      }
      await aiVisibilityService.markAuditDispatchFailed(project.userId, reservation.resource.id, 'Monitoring queue dispatch failed. The base wallet charge was returned.');
      skipped += 1;
      continue;
    }
    await db.update(aiVisibilityProjectsTable).set({ nextMonitoringAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), updatedAt: new Date() }).where(eq(aiVisibilityProjectsTable.id, project.id));
    scheduled += 1;
  }
  return { scheduled, skipped };
}

// ─── Worker Initialization ──────────────────────────────────────────────────────

async function startWorkers(mediaOnly: boolean): Promise<void> {
  if (workers.size > 0) return;
  const connection = getRedisConnection();
  const log = createWorkerLogger('manager');

  // Initialize Event Bus and Queue Registry for workers
  await eventBus.initialize();
  await queueRegistry.initialize();
  if (!mediaOnly) {
    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.AI_VISIBILITY_MONITORING,
      'monitoring-sweep',
      { userId: 0, createdAt: new Date().toISOString() },
      60 * 60 * 1000,
    );
  }

  const allWorkerConfigs: Array<{
    name: string;
    queue: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    processor: (job: Job) => Promise<any>;
    concurrency: number;
    limiter?: { max: number; duration: number };
  }> = [
    { name: 'image-worker', queue: QUEUE_NAMES.IMAGE_GENERATION, processor: processImageGeneration, concurrency: 2 },
    { name: 'video-worker', queue: QUEUE_NAMES.VIDEO_GENERATION, processor: processVideoGeneration, concurrency: 1 },
    { name: 'knowledge-base-worker', queue: QUEUE_NAMES.KNOWLEDGE_BASE, processor: processKnowledgeBase, concurrency: 2 },
    { name: 'scraping-worker', queue: QUEUE_NAMES.WEB_SCRAPING, processor: processWebScraping, concurrency: 3, limiter: QUEUE_LIMITERS[QUEUE_NAMES.WEB_SCRAPING] },
    { name: 'email-worker', queue: QUEUE_NAMES.EMAIL_SENDING, processor: processEmailSending, concurrency: 2, limiter: QUEUE_LIMITERS[QUEUE_NAMES.EMAIL_SENDING] },
    { name: 'sms-worker', queue: QUEUE_NAMES.SMS_SENDING, processor: processSmsSending, concurrency: 3, limiter: QUEUE_LIMITERS[QUEUE_NAMES.SMS_SENDING] },
    { name: 'legacy-ad-worker', queue: QUEUE_NAMES.AD_PUBLISHING, processor: processUnsupportedLegacyJob, concurrency: 1 },
    { name: 'organic-publishing-worker', queue: QUEUE_NAMES.ORGANIC_PUBLISHING, concurrency: 4,
      processor: async job => {
        const { processOrganicPublishJob } = await import('../services/social/OrganicPublishQueue.js');
        const userId = Number(job.data.userId), attemptId = Number(job.data.attemptId);
        if (![userId, attemptId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid organic publish job');
        return processOrganicPublishJob({ ...job.data, userId, attemptId }, `organic-worker-${process.pid}-${job.id}`);
      } },
    { name: 'enrichment-worker', queue: QUEUE_NAMES.LEAD_ENRICHMENT, processor: processLeadEnrichment, concurrency: 3, limiter: QUEUE_LIMITERS[QUEUE_NAMES.LEAD_ENRICHMENT] },
    { name: 'content-research-worker', queue: QUEUE_NAMES.CONTENT_GENERATION, concurrency: 1,
      processor: async job => {
        if (!['creative-intelligence-research', 'creative-intelligence-brief'].includes(job.name)) return processUnsupportedLegacyJob(job);
        const userId = Number(job.data.userId), recordId = Number(job.data.recordId);
        if (![userId, recordId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid creative research job');
        const { creativeIntelligenceService } = await import('../services/ads/creative-intelligence/CreativeIntelligenceService.js');
        return creativeIntelligenceService.process(userId, recordId, job.name === 'creative-intelligence-research' ? 'research' : 'brief');
      } },
    { name: 'analytics-worker', queue: QUEUE_NAMES.ANALYTICS, processor: processAnalytics, concurrency: 1 },
    { name: 'performance-sync-worker', queue: QUEUE_NAMES.PERFORMANCE_SYNC, processor: processAnalytics, concurrency: 2 },
    { name: 'follow-up-worker', queue: QUEUE_NAMES.FOLLOW_UP, processor: processFollowUp, concurrency: 1 },
    { name: 'outreach-worker', queue: QUEUE_NAMES.OUTREACH, processor: processOutreach, concurrency: 1, limiter: QUEUE_LIMITERS[QUEUE_NAMES.OUTREACH] },
    {name:'crm-automation-worker',queue:QUEUE_NAMES.CRM_AUTOMATIONS,concurrency:1,limiter:{max:1,duration:1000},processor:async job=>{
      const {processAutomationEvent}=await import('../services/automations/AutomationEngine.js');
      return processAutomationEvent(Number(job.data.userId),Number(job.data.eventId));
    }},
    { name: 'embedding-worker', queue: QUEUE_NAMES.EMBEDDING, processor: processEmbedding, concurrency: 3 },
    { name: 'ai-visibility-audit-worker', queue: QUEUE_NAMES.AI_VISIBILITY_AUDIT, processor: processAiVisibilityAudit, concurrency: 2 },
    { name: 'ai-visibility-monitoring-worker', queue: QUEUE_NAMES.AI_VISIBILITY_MONITORING, processor: processAiVisibilityMonitoring, concurrency: 1 },
    { name: 'general-worker', queue: QUEUE_NAMES.GENERAL, processor: processGeneralJob, concurrency: 1 },
  ];
  const workerConfigs = mediaOnly
    ? allWorkerConfigs.filter(({ queue }) => queue === QUEUE_NAMES.IMAGE_GENERATION || queue === QUEUE_NAMES.VIDEO_GENERATION)
    : allWorkerConfigs;

  for (const config of workerConfigs) {
    const worker = new Worker(config.queue, job => runBusinessJob(job.data, async scopedData => {
      if (config.queue === QUEUE_NAMES.AI_VISIBILITY_AUDIT && !job.data.retryReport) {
        const { resumeCancelledAuditBilling } = await import('../services/aiVisibility/queuedAuditBilling.js');
        await resumeCancelledAuditBilling(Number(scopedData.userId),Number(job.data.auditId),Number(scopedData.billingOrganizationId));
      }
      const paidWorkQueues: string[] = [QUEUE_NAMES.IMAGE_GENERATION, QUEUE_NAMES.VIDEO_GENERATION, QUEUE_NAMES.WEB_SCRAPING,
        QUEUE_NAMES.EMAIL_SENDING, QUEUE_NAMES.SMS_SENDING, QUEUE_NAMES.LEAD_ENRICHMENT, QUEUE_NAMES.FOLLOW_UP,
        QUEUE_NAMES.OUTREACH, QUEUE_NAMES.EMBEDDING, QUEUE_NAMES.AI_VISIBILITY_AUDIT];
      if (paidWorkQueues.includes(config.queue) && Number(scopedData.userId) > 0) {
        if (config.queue === QUEUE_NAMES.AI_VISIBILITY_AUDIT && !job.data.retryReport) {
          const { requireQueuedAuditSubscription } = await import('../services/aiVisibility/queuedAuditBilling.js');
          await requireQueuedAuditSubscription(Number(scopedData.userId),Number(job.data.auditId),Number(scopedData.billingOrganizationId));
        } else {
          const { requireSubscriptionForOperation } = await import('../services/subscriptions/service.js');
          await requireSubscriptionForOperation(Number(scopedData.userId));
        }
      }
      const original = job.data;
      job.data = scopedData;
      try {
        return await runCustomerDeliveryJob(job.name, scopedData, () => config.processor(job));
      } catch (error) {
        const failure = deliverySetupFailure(error);
        if (!failure) throw error;
        await holdCustomerDeliveryJob(scopedData, error);
        await job.updateData({ ...scopedData, customerDeliveryStatus: 'setup_required', customerDeliverySetup: failure });
        throw new UnrecoverableError(`${failure.code}:${failure.reason}: ${failure.error}`);
      } finally { job.data = original; }
    }, config.queue === QUEUE_NAMES.AI_VISIBILITY_AUDIT ? async scopedData => {
      // Only audit creation prepays a durable charge on this queue. A report
      // retry has already consumed work and is never eligible for this refund.
      if (job.data.retryReport) return;
      const { cancelUnstartedAuditForBilling } = await import('../services/aiVisibility/queuedAuditBilling.js');
      await cancelUnstartedAuditForBilling(Number(scopedData.userId),Number(job.data.auditId),Number(scopedData.billingOrganizationId));
    } : config.queue === QUEUE_NAMES.LEAD_ENRICHMENT ? async scopedData => {
      const { cancelUnstartedDeepForAuthority } = await import('../services/enrichment/deepExecution.js');
      await cancelUnstartedDeepForAuthority({ ...job.data, ...scopedData });
    } : undefined), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connection: connection as any,
      concurrency: config.concurrency,
      limiter: config.limiter,
      lockDuration: WORKER_LOCK_DURATION_MS,
      lockRenewTime: WORKER_LOCK_DURATION_MS / 3,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    });

    worker.on('completed', (job) => {
      log.info({ worker: config.name, jobId: job.id }, 'Job completed');
    });

    worker.on('failed', async (job, err) => {
      log.error({ worker: config.name, jobId: job?.id, error: err.message }, 'Job failed');
      // Phase 5.5 / QUEUE-009: persist failed-job details for debugging.
      // Failures here must not propagate (would crash the worker), so
      // we swallow + log.
      if (!job) return;
      try {
        const { insertFailedJob } = await import('../models/failedJobs/functions.js');
        await insertFailedJob({
          queue: config.queue,
          jobId: job.id ? String(job.id) : null,
          payload: sanitizeQueueDiagnosticValue(job.data ?? null) as Record<string, unknown>,
          error: sanitizeQueueDiagnosticString(err?.message ?? String(err)),
          stack: err?.stack ? sanitizeQueueDiagnosticString(err.stack) : null,
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (persistErr: any) {
        log.error({ err: persistErr.message, jobId: job.id }, '[workers] failed to persist failed_jobs row');
      }
    });

    worker.on('error', (err) => {
      log.error({ worker: config.name, error: err.message }, 'Worker error');
    });

    await worker.waitUntilReady();
    workers.set(config.name, worker);
    log.info({ worker: config.name, queue: config.queue, concurrency: config.concurrency }, 'Worker started');
  }

  log.info(`Started ${workers.size} workers`);

  // The notification daemon belongs to the full standalone worker process.
  if (!mediaOnly) {
    try {
      const { notificationEventConsumer } = await import('./NotificationEventConsumer.js');
      await notificationEventConsumer.start();
      log.info('[workers] NotificationEventConsumer started');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      log.error({ err: err.message }, '[workers] Failed to start NotificationEventConsumer');
    }
  }
}

/** Start the complete worker set in the dedicated worker process. */
export function workersAreReady(): boolean {
  return workers.size > 0 && Array.from(workers.values()).every(worker => worker.isRunning() && !worker.isPaused());
}

export async function startAllWorkers(): Promise<void> {
  await startWorkers(false);
  const { outreachSenderWorker } = await import('../tools/outreachSender.js');
  await outreachSenderWorker.start();
  outreachSenderStarted = true;
}

/** Start only image/video consumers when the local API owns media processing. */
export async function startMediaWorkers(): Promise<void> {
  await startWorkers(true);
}

/**
 * Stop all workers gracefully
 */
export async function stopAllWorkers(): Promise<void> {
  const log = createWorkerLogger('manager');

  if (outreachSenderStarted) {
    try {
      const { outreachSenderWorker } = await import('../tools/outreachSender.js');
      await outreachSenderWorker.stop();
    } catch (err) {
      log.warn({ err }, 'Outreach sender failed to stop cleanly');
    } finally {
      outreachSenderStarted = false;
    }
  }

  const closes = Array.from(workers.entries()).map(async ([name, worker]) => {
    await worker.close();
    log.info({ worker: name }, 'Worker stopped');
  });
  const results = await Promise.allSettled(closes);
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      log.error(
        { worker: Array.from(workers.keys())[index], err: result.reason },
        'Worker failed to stop cleanly',
      );
    }
  }

  workers.clear();
  try {
    const { notificationEventConsumer } = await import('./NotificationEventConsumer.js');
    await notificationEventConsumer.stop();
  } catch (err) {
    log.warn({ err }, 'Notification event consumer failed to stop cleanly');
  }
  await Promise.allSettled([
    eventBus.close(),
    queueRegistry.close(),
  ]);
  log.info('All workers stopped');
}
import { runBusinessJob } from '../tenancy/jobBusinessScope.js';
