/**
 * Job Queue System — BullMQ-based durable job processing
 * 
 * Provides named queues for each tool category with:
 * - Durable persistence (Redis-backed)
 * - Automatic retries with exponential backoff
 * - Dead-letter queues for failed jobs
 * - Priority levels
 * - Rate limiting per queue
 * - Repeatable jobs (replaces setInterval cron)
 */

import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { getRedisConnection } from '../infrastructure/redis.js';
import { logger } from '../utils/logger.js';
import { captureJobBusiness } from '../tenancy/jobBusinessScope.js';
import { admitCustomerDeliveryJob } from '../services/assistants/CustomerDeliveryJobs.js';

// ─── Queue Names ────────────────────────────────────────────────────────────────
export const QUEUE_NAMES = {
  IMAGE_GENERATION: 'image-generation',
  VIDEO_GENERATION: 'video-generation',
  KNOWLEDGE_BASE: 'knowledge-base',
  WEB_SCRAPING: 'web-scraping',
  EMAIL_SENDING: 'email-sending',
  SMS_SENDING: 'sms-sending',
  AD_PUBLISHING: 'ad-publishing',
  ORGANIC_PUBLISHING: 'organic-publishing',
  LEAD_ENRICHMENT: 'lead-enrichment',
  CONTENT_GENERATION: 'content-generation',
  OUTREACH: 'outreach',
  CRM_AUTOMATIONS: 'crm-automations',
  ANALYTICS: 'analytics',
  PERFORMANCE_SYNC: 'performance-sync',
  FOLLOW_UP: 'follow-up',
  EMBEDDING: 'embedding',
  AI_VISIBILITY_AUDIT: 'ai-visibility-audit',
  AI_VISIBILITY_MONITORING: 'ai-visibility-monitoring',
  GENERAL: 'general',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Job Payload Interfaces ─────────────────────────────────────────────────────

export interface BaseJobPayload {
  userId: number;
  businessProfileId?: number;
  threadId?: number;
  workflowId?: string;
  executionId?: string;
  correlationId?: string;
  createdAt: string;
}

export interface ImageGenerationJobPayload extends BaseJobPayload {
  prompt: string;
  provider?: 'google' | 'openrouter';
  style?: string;
  size?: string;
  model?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brandToolkit?: any;
  parentAssetId?: number;
  assetType?: string;
  referenceImages?: Array<{
    base64Data: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  }>;
  imageConfig?: {
    numberOfImages?: number;
    aspectRatio?: string;
    imageSize?: string;
    seed?: number;
  };
}

export interface VideoGenerationJobPayload extends BaseJobPayload {
  prompt: string;
  provider?: 'google' | 'openrouter';
  duration?: number;
  style?: string;
  model?: string;
  parentAssetId?: number;
  assetType?: string;
  operationName?: string;
  videoConfig?: {
    numberOfVideos?: number;
    durationSeconds?: number;
    aspectRatio?: string;
    personGeneration?: string;
    negativePrompt?: string;
    seed?: number;
  };
}

export interface KnowledgeBaseJobPayload extends BaseJobPayload {
  entryId: number;
  storageFileId: number;
}

export interface WebScrapingJobPayload extends BaseJobPayload {
  actorId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>;
  platform?: string;
  maxItems?: number;
}

export interface EmailSendingJobPayload extends BaseJobPayload {
  to: string;
  from?: string;
  subject: string;
  body: string;
  html?: string;
  replyTo?: string;
  leadId?: number;
  campaignId?: number;
}

export interface SmsSendingJobPayload extends BaseJobPayload {
  to: string;
  message: string;
  leadId?: number;
  campaignId?: number;
}

export interface AdPublishingJobPayload extends BaseJobPayload {
  platform: 'meta' | 'google';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  campaignData: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adSetData?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adCreativeData?: Record<string, any>;
}

export interface LeadEnrichmentJobPayload extends BaseJobPayload {
  leadId: number;
  enrichmentType: 'email_validation' | 'data_enrichment' | 'scoring' | 'deep_enrichment';
}

export interface ContentGenerationJobPayload extends BaseJobPayload {
  contentType: 'email' | 'sms' | 'social' | 'ad_copy' | 'magic_prompt';
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brandToolkit?: any;
  icpId?: number;
}

export interface OutreachJobPayload extends BaseJobPayload {
  campaignId: number;
  channel: 'email' | 'sms' | 'instagram';
  leadIds: number[];
  templateId?: number;
  sequenceId?: number;
}

export interface AnalyticsJobPayload extends BaseJobPayload {
  type: 'poll_metrics' | 'aggregate_stats' | 'refresh_cache';
  platform?: 'meta' | 'google';
  campaignId?: number;
}

export interface FollowUpJobPayload extends BaseJobPayload {
  sequenceId: number;
  stepIndex: number;
  leadId: number;
  campaignId: number;
}

export interface EmbeddingJobPayload extends BaseJobPayload {
  texts: string[];
  sourceType: string;
  sourceIds?: number[];
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface AiVisibilityAuditJobPayload extends BaseJobPayload {
  projectId: number;
  auditId: number;
}

export interface AiVisibilityMonitoringJobPayload extends BaseJobPayload {
  projectId?: number;
}

export type JobPayload =
  | ImageGenerationJobPayload
  | VideoGenerationJobPayload
  | KnowledgeBaseJobPayload
  | WebScrapingJobPayload
  | EmailSendingJobPayload
  | SmsSendingJobPayload
  | AdPublishingJobPayload
  | LeadEnrichmentJobPayload
  | ContentGenerationJobPayload
  | OutreachJobPayload
  | AnalyticsJobPayload
  | FollowUpJobPayload
  | EmbeddingJobPayload
  | AiVisibilityAuditJobPayload
  | AiVisibilityMonitoringJobPayload;

// ─── Default Job Options per Queue ──────────────────────────────────────────────

const DEFAULT_JOB_OPTIONS: Record<QueueName, JobsOptions> = {
  [QUEUE_NAMES.CRM_AUTOMATIONS]: {
    attempts: 1,
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 30 },
  },
  [QUEUE_NAMES.IMAGE_GENERATION]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 }, // 24 hours
    removeOnFail: { age: 3600 * 24 * 7 }, // 7 days
  },
  [QUEUE_NAMES.VIDEO_GENERATION]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.KNOWLEDGE_BASE]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.WEB_SCRAPING]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.EMAIL_SENDING]: {
    attempts: 5,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 30 }, // 30 days
  },
  [QUEUE_NAMES.SMS_SENDING]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 30 },
  },
  [QUEUE_NAMES.AD_PUBLISHING]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.LEAD_ENRICHMENT]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 3600 * 12 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.CONTENT_GENERATION]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.OUTREACH]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 30 },
  },
  [QUEUE_NAMES.ANALYTICS]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { age: 3600 * 4 },
    removeOnFail: { age: 3600 * 24 },
  },
  [QUEUE_NAMES.PERFORMANCE_SYNC]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { age: 3600 * 4 },
    removeOnFail: { age: 3600 * 24 },
  },
  [QUEUE_NAMES.FOLLOW_UP]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 30 },
  },
  [QUEUE_NAMES.EMBEDDING]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.AI_VISIBILITY_AUDIT]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15000 },
    removeOnComplete: { age: 3600 * 24 * 7 },
    removeOnFail: { age: 3600 * 24 * 30 },
  },
  [QUEUE_NAMES.AI_VISIBILITY_MONITORING]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: { age: 3600 * 24 * 7 },
    removeOnFail: { age: 3600 * 24 * 30 },
  },
  [QUEUE_NAMES.GENERAL]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 * 7 },
  },
  [QUEUE_NAMES.ORGANIC_PUBLISHING]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
  },
};

export const QUEUE_LIMITERS: Partial<Record<QueueName, { max: number; duration: number }>> = {
  // Phase 3.11 / QUEUE-006: per-queue provider rate limits to avoid
  // tripping upstream 429s. Values are conservative; tune via env if needed.
  [QUEUE_NAMES.EMAIL_SENDING]: { max: 5, duration: 1000 },    // Resend default rate
  [QUEUE_NAMES.SMS_SENDING]: { max: 1, duration: 1000 },      // Twilio 1 msg/sec
  [QUEUE_NAMES.OUTREACH]: { max: 1, duration: 1000 },         // Shared provider-side effect guard
  [QUEUE_NAMES.WEB_SCRAPING]: { max: 5, duration: 1000 },     // Apify default rate
  [QUEUE_NAMES.LEAD_ENRICHMENT]: { max: 10, duration: 1000 }, // 10/sec for enrichment APIs
};

// ─── Queue Registry ─────────────────────────────────────────────────────────────

class QueueRegistry {
  private queues: Map<string, Queue> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  // Phase 3.8 / QUEUE-002: store the in-flight init promise so concurrent
  // callers share a single bootstrap instead of each starting their own
  // (which would race on `this.queues` and create duplicate Queue / QueueEvents
  // instances that leak Redis connections).
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize all queues
   */
  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    const connection = getRedisConnection();

    for (const queueName of Object.values(QUEUE_NAMES)) {
      const queue = new Queue(queueName, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connection: connection as any,
        defaultJobOptions: DEFAULT_JOB_OPTIONS[queueName],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = new QueueEvents(queueName, { connection: connection as any });

      // Listen for completed/failed events
      events.on('completed', ({ jobId }) => {
        logger.debug({ queue: queueName, jobId }, 'Job completed');
      });

      events.on('failed', ({ jobId, failedReason }) => {
        logger.error({ queue: queueName, jobId, failedReason }, 'Job failed');
      });

      this.queues.set(queueName, queue);
      this.queueEvents.set(queueName, events);
    }

    logger.info(`[QueueRegistry] Initialized ${this.queues.size} queues`);
  }

  /**
   * Get all initialized queues
   */
  getAllQueues(): Queue[] {
    return Array.from(this.queues.values());
  }

  /**
   * Get a queue by name
   */
  getQueue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) {
      throw new Error(`Queue "${name}" not found. Did you call initialize()?`);
    }
    return queue;
  }

  /**
   * Add a job to a queue
   */
  async addJob<T extends BaseJobPayload>(
    queueName: QueueName,
    jobName: string,
    data: T,
    options?: JobsOptions
  ): Promise<string> {
    const queue = this.getQueue(queueName);
    const scoped = await admitCustomerDeliveryJob(jobName, await captureJobBusiness({ ...data }));
    const job = await queue.add(jobName, scoped, options);
    logger.info(
      { queue: queueName, jobName, jobId: job.id, userId: data.userId },
      'Job enqueued'
    );
    return job.id!;
  }

  /**
   * Remove all existing repeatable jobs for a queue, optionally filtered by jobName.
   * Prevents stale repeatable jobs from accumulating across server restarts.
   */
  async removeRepeatableJobs(
    queueName: QueueName,
    jobName?: string
  ): Promise<number> {
    const queue = this.getQueue(queueName);
    const repeatableJobs = await queue.getRepeatableJobs();
    let removed = 0;
    for (const rj of repeatableJobs) {
      if (!jobName || rj.name === jobName) {
        await queue.removeRepeatableByKey(rj.key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info(
        { queue: queueName, jobName, removed },
        'Removed stale repeatable jobs'
      );
    }
    return removed;
  }

  /**
   * Remove queued instances left behind after a repeatable schedule is retired.
   * BullMQ removes the schedule and its next delayed occurrence separately, so
   * deleting only the repeatable key can still execute one obsolete job.
   */
  async removeJobsByName(
    queueName: QueueName,
    jobName: string,
  ): Promise<number> {
    const queue = this.getQueue(queueName);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'paused', 'failed'], 0, -1, true);
    const matching = jobs.filter((job) => job.name === jobName);
    await Promise.all(matching.map((job) => job.remove()));
    if (matching.length > 0) {
      logger.info(
        { queue: queueName, jobName, removed: matching.length },
        'Removed queued instances for retired job',
      );
    }
    return matching.length;
  }

  /**
   * Add a repeatable job (replaces setInterval cron).
   * Removes any existing repeatable job with the same name first to prevent duplicates.
   */
  async addRepeatableJob(
    queueName: QueueName,
    jobName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>,
    repeatEveryMs: number
  ): Promise<void> {
    const queue = this.getQueue(queueName);
    // Remove existing repeatable jobs with the same name to avoid stacking
    await this.removeRepeatableJobs(queueName, jobName);
    await queue.add(jobName, { ...data, systemJob: true }, {
      repeat: { every: repeatEveryMs },
    });
    logger.info(
      { queue: queueName, jobName, intervalMs: repeatEveryMs },
      'Repeatable job scheduled'
    );
  }

  /**
   * Get queue metrics for monitoring
   */
  async getQueueMetrics(queueName: QueueName) {
    const queue = this.getQueue(queueName);
    const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.isPaused(),
    ]);
    return { queueName, waiting, active, completed, failed, delayed, isPaused };
  }

  /**
   * Get metrics for all queues
   */
  async getAllQueueMetrics() {
    const metrics = await Promise.all(
      Object.values(QUEUE_NAMES).map((name) => this.getQueueMetrics(name))
    );
    return metrics;
  }

  /**
   * Wait for BullMQ's durable completion state instead of relying on a
   * best-effort Pub/Sub message that can be missed between enqueue and subscribe.
   */
  async waitForJobResult(
    queueName: QueueName,
    jobId: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const queue = this.getQueue(queueName);
    const events = this.queueEvents.get(queueName);
    if (!events) throw new Error(`Queue events for "${queueName}" are not initialized`);
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Queued job "${jobId}" was not found`);
    return job.waitUntilFinished(events, timeoutMs);
  }

  /**
   * Gracefully close all queues
   */
  async close(): Promise<void> {
    // Phase 3.9 / QUEUE-003: use allSettled so one failing close() doesn't
    // strand the rest of the queues (e.g. during graceful shutdown when
    // Redis may be partially down).
    const closePromises: Promise<unknown>[] = [];

    for (const [name, queue] of this.queues) {
      closePromises.push(
        queue.close()
          .then(() => logger.debug(`Queue ${name} closed`))
          .catch((err) => logger.error({ err, queue: name }, '[QueueRegistry] queue.close() failed'))
      );
    }

    for (const [name, events] of this.queueEvents) {
      closePromises.push(
        events.close()
          .then(() => logger.debug(`QueueEvents ${name} closed`))
          .catch((err) => logger.error({ err, queue: name }, '[QueueRegistry] events.close() failed'))
      );
    }

    const results = await Promise.allSettled(closePromises);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      logger.warn({ failed, total: results.length }, '[QueueRegistry] Some close() calls failed');
    }
    this.queues.clear();
    this.queueEvents.clear();
    this.initPromise = null;
    logger.info('[QueueRegistry] All queues closed');
  }
}

// Singleton
export const queueRegistry = new QueueRegistry();
