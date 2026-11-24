import type { FollowUpProvenance } from '../../shared/followUpProvenance.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { issueTemplateRenderContext } from './content/TemplateRenderContext.js';
import { configuredFollowUpDispatch, recoverConfiguredFollowUpDispatches, reserveSmsFollowUpDispatch } from './outreach/ConfiguredFollowUpDispatchService.js';
import { followUpSettingsRevision } from '../utils/followUpSettingsRevision.js';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { outreachSettings, type FollowUpStep, type ChannelFollowUps, type ChannelFollowUp } from '../models/outreachSettings/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { queueRegistry, QUEUE_NAMES } from '../queues/index.js';
import { LLMProviderFactory } from './agents/LLMProviderFactory';
import { getRedisConnection } from '../infrastructure/redis.js';
import { renderBrandedEmail, getBrandInfo } from '../utils/emailTemplates.js';
import {
  getEmailFollowUpDueAt,
  reserveEmailFollowUp,
} from './emailFollowUpService.js';
import {
  getDueSocialFollowUps,
  isSocialFollowUpChannel,
  parseUtcDatabaseTimestamp,
  reserveSocialFollowUp,
  type SocialFollowUpStep,
} from './socialFollowUpService.js';

// Supported follow-up channels (must match keys in ChannelFollowUps interface)
import { FOLLOW_UP_CHANNELS, type FollowUpChannel } from '../../shared/followUpChannels.js';
import { loadFollowUpTemplate, renderFollowUpTemplate } from './followUpTemplateService.js';
import { sanitizeEmailHtml } from '../utils/contentTemplateRendering.js';
import { emailBodyToHtml } from '../../shared/emailFormatting.js';

/**
 * Strip greeting lines (e.g. "Hi John,", "Hello,", "Dear {{firstName}},") and
 * sign-off lines (e.g. "Best regards", "Thanks", "Sincerely") from generated/template
 * follow-up content. The branded email template handles greeting separately.
 */
function stripGreetingAndSignoff(text: string): string {
  let result = text.trim();
  // Remove leading greeting line (supports names, template vars, and plain greetings)
  result = result.replace(/^(Hi|Hello|Hey|Dear|Greetings)\s*[^,\n]*[,!]?\s*\n?/i, '').trim();
  // Remove trailing sign-off block (last 1-3 lines containing common closings)
  result = result.replace(/\n\s*(Best\s*regards?|Kind\s*regards?|Thanks|Thank\s*you|Sincerely|Cheers|Regards|Warm\s*regards?|All\s*the\s*best)[,.]?\s*(\n.*)?$/i, '').trim();
  return result;
}

/**
 * Cron Service
 * Handles scheduled background tasks including:
 * - Processing follow-up email sequences every 5 minutes
 * - Analytics polling for Facebook/Meta ads every 5 minutes
 *
 * Requires Redis + BullMQ. No fallback — Redis is mandatory.
 */

// Environment prefix to avoid BullMQ job name collisions between environments (staging vs production)
// sharing the same Redis instance
const ENV_PREFIX = process.env.NODE_ENV === 'production' ? '' : `${process.env.NODE_ENV || 'dev'}:`;

class CronService {
  private isProcessing = false;
  private processCount = 0;
  private dlqMonitorTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start all cron jobs via BullMQ repeatable jobs.
   * Redis must be available — throws if scheduling fails.
   */
  async start(): Promise<void> {
    logger.info('[CronService] Starting cron jobs...');
    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL, `${ENV_PREFIX}subscription-reconciliation`,
      { type: 'cron-subscription-reconciliation' }, 60 * 1000);

    // Repeatable schedules live in Redis after their source code is removed.
    // Reconcile explicitly retired jobs before registering the current set so
    // an old schedule cannot keep filling the failed-job queue indefinitely.
    const retiredJobs = [
      {
        queue: QUEUE_NAMES.GENERAL,
        name: `${ENV_PREFIX}threads-engagement-sync`,
        payloadType: 'cron-threads-engagement-sync',
      },
    ] as const;
    for (const retired of retiredJobs) {
      const [schedules, queued] = await Promise.all([
        queueRegistry.removeRepeatableJobs(retired.queue, retired.name),
        queueRegistry.removeJobsByName(retired.queue, retired.name),
      ]);
      let failedDiagnostics = 0;
      try {
        const failedRows = await db.execute(sql`
          DELETE FROM failed_jobs
          WHERE queue = ${retired.queue}
            AND payload->>'type' = ${retired.payloadType}
          RETURNING id
        `);
        failedDiagnostics = failedRows.rows.length;
      } catch (error) {
        logger.warn({ err: error, jobName: retired.name }, '[CronService] Retired job diagnostics could not be deleted');
      }
      if (schedules > 0 || queued > 0 || failedDiagnostics > 0) {
        logger.info({
          jobName: retired.name,
          schedules,
          queued,
          failedDiagnostics,
        }, '[CronService] Retired queue job reconciled');
      }
    }

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.FOLLOW_UP,
      `${ENV_PREFIX}process-follow-ups`,
      { type: 'cron-follow-up' },
      60 * 1000 // every 1 minute — follow-ups can be configured at minute-level granularity
    );
    logger.info('[CronService] ✅ Follow-up processing scheduled via BullMQ (every 1 minute)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.ANALYTICS,
      `${ENV_PREFIX}poll-analytics`,
      { type: 'cron-analytics' },
      5 * 60 * 1000 // every 5 minutes
    );
    logger.info('[CronService] ✅ Analytics ingestion scheduled via BullMQ (every 5 minutes)');

    for (const type of ['cron-paid-meta-sync', 'cron-social-analytics-sync']) {
      await queueRegistry.addRepeatableJob(QUEUE_NAMES.PERFORMANCE_SYNC, `${ENV_PREFIX}${type}`, { type }, 5 * 60 * 1000);
    }


    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}gmail-watch-renewal`,
      { type: 'cron-gmail-watch-renewal' },
      6 * 60 * 60 * 1000 // every 6 hours
    );
    logger.info('[CronService] ✅ Gmail watch renewal scheduled via BullMQ (every 6 hours)');
    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL, `${ENV_PREFIX}gmail-mailbox-sync-recovery`,
      { type: 'cron-gmail-mailbox-sync-recovery' }, 60_000);

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}instagram-follower-sync`,
      { type: 'cron-instagram-follower-sync' },
      30 * 60 * 1000 // every 30 minutes
    );
    logger.info('[CronService] ✅ Instagram follower sync scheduled via BullMQ (every 30 minutes)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}facebook-follower-sync`,
      { type: 'cron-facebook-follower-sync' },
      30 * 60 * 1000 // every 30 minutes
    );
    logger.info('[CronService] ✅ Facebook follower sync scheduled via BullMQ (every 30 minutes)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}twitter-follower-sync`,
      { type: 'cron-twitter-follower-sync' },
      30 * 60 * 1000 // every 30 minutes
    );
    logger.info('[CronService] ✅ Twitter follower sync scheduled via BullMQ (every 30 minutes)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}linkedin-follower-sync`,
      { type: 'cron-linkedin-follower-sync' },
      30 * 60 * 1000 // every 30 minutes
    );
    logger.info('[CronService] ✅ LinkedIn follower sync scheduled via BullMQ (every 30 minutes)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}process-reminders`,
      { type: 'cron-process-reminders' },
      5 * 60 * 1000 // every 5 minutes
    );
    logger.info('[CronService] ✅ CRM reminder processing scheduled via BullMQ (every 5 minutes)');

    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL, `${ENV_PREFIX}instagram-automation-recovery`,
      { type: 'cron-instagram-automation-recovery' }, 60_000);

    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL,`${ENV_PREFIX}crm-automation-dispatch`,
      {type:'cron-crm-automation-dispatch'},15_000);
    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL,`${ENV_PREFIX}dashboard-operations-recovery`,
      {type:'cron-dashboard-operations-recovery'},60_000);
    // Keeps the stored per-outreach counts on the Message tracking pages current.
    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL, `${ENV_PREFIX}outreach-batch-counts`,
      { type: 'cron-outreach-batch-counts' }, 15_000);
    // WhatsApp platform billing: stale-charge sweep, Meta reconciliation (every 6h inside) and credit-line spend alert.
    await queueRegistry.addRepeatableJob(QUEUE_NAMES.GENERAL, `${ENV_PREFIX}whatsapp-billing-maintenance`,
      { type: 'cron-whatsapp-billing-maintenance' }, 60 * 60 * 1000);

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}expire-hotel-booking-holds`,
      { type: 'cron-expire-hotel-booking-holds' },
      60 * 1000,
    );
    logger.info('[CronService] ✅ Hotel booking hold expiry scheduled via BullMQ (every 1 minute)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}storage-object-cleanup`,
      { type: 'cron-storage-object-cleanup' },
      10 * 60 * 1000
    );
    logger.info('[CronService] ✅ Storage object cleanup scheduled via BullMQ (every 10 minutes)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}meta-token-refresh`,
      { type: 'cron-meta-token-refresh' },
      6 * 60 * 60 * 1000 // every 6 hours
    );
    logger.info('[CronService] ✅ Meta token refresh scheduled via BullMQ (every 6 hours)');

    // Support ticket SLA risk and breach detection (every 5 minutes)
    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}support-sla-check`,
      { type: 'cron-support-sla-check' },
      5 * 60 * 1000
    );
    logger.info('[CronService] ✅ Support SLA risk/breach check scheduled via BullMQ (every 5 minutes)');

    // Failed customer replies use a 15s-15min backoff; drain them on that
    // timescale instead of waiting for the 5-minute maintenance job.
    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}support-delivery-recovery`,
      { type: 'cron-support-delivery-recovery' },
      30 * 1000,
    );
    logger.info('[CronService] ✅ Support delivery and approved-tool recovery scheduled via BullMQ (every 30 seconds)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}support-notification-maintenance`,
      { type: 'cron-support-notification-maintenance' },
      60 * 1000,
    );
    logger.info('[CronService] ✅ Support notification outbox recovery scheduled via BullMQ (every 1 minute)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}support-presence-maintenance`,
      { type: 'cron-support-presence-maintenance' },
      60 * 1000,
    );
    logger.info('[CronService] ✅ Support presence inactivity closure scheduled via BullMQ (every 1 minute)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}knowledge-maintenance`,
      { type: 'cron-knowledge-maintenance' },
      24 * 60 * 60 * 1000,
    );
    logger.info('[CronService] ✅ Knowledge repair and governance review scheduled via BullMQ (daily)');

    // Scheduled content publishing — checks for due assets every 1 minute
    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}scheduled-publishing`,
      { type: 'cron-scheduled-publishing' },
      60 * 1000 // every 1 minute
    );
    logger.info('[CronService] ✅ Scheduled content publishing scheduled via BullMQ (every 1 minute)');

    await queueRegistry.addRepeatableJob(
      QUEUE_NAMES.GENERAL,
      `${ENV_PREFIX}scheduled-social-reports`,
      { type: 'cron-scheduled-social-reports' },
      60 * 1000,
    );
    logger.info('[CronService] ✅ Scheduled social reports scheduled via BullMQ (every 1 minute)');

    // DLQ monitoring: log warning if any queue has too many failed jobs
    if (!this.dlqMonitorTimer) {
      this.dlqMonitorTimer = setInterval(async () => {
        try {
          const metrics = await queueRegistry.getAllQueueMetrics();
          for (const m of metrics) {
            if (m.failed > 10) {
              logger.warn(
                { queueName: m.queueName, failedCount: m.failed },
                '[CronService] Dead letter queue alert: high failed job count — check the admin queue monitor'
              );
            }
          }
        } catch (err) {
          logger.error({ err }, '[CronService] DLQ monitoring check failed');
        }
      }, 15 * 60 * 1000); // check every 15 minutes
    }
  }

  /**
   * Stop all cron jobs.
   * BullMQ repeatable jobs remain registered in Redis — they persist across restarts.
   */
  stop(): void {
    if (this.dlqMonitorTimer) { clearInterval(this.dlqMonitorTimer); this.dlqMonitorTimer = null; }
    logger.info('[CronService] Cron jobs stopped (BullMQ repeatable jobs remain registered in Redis)');
  }

  /**
   * Process scheduled content assets that are due for publishing.
   * Queries for assets with scheduled_publish_at <= NOW() and status != 'published',
   * then publishes them via the SocialPublishingService.
   */
  async processScheduledPublishing(): Promise<void> {
    const redis = getRedisConnection();
    const lockKey = 'lock:scheduled-publishing';
    const lockValue = `${process.pid}-${Date.now()}`;
    const acquired = await redis.set(lockKey, lockValue, 'PX', 10 * 60_000, 'NX');
    if (!acquired) {
      logger.debug('[CronService] Scheduled publishing skipped — another worker holds the lock');
      return;
    }
    const lockRenewal = setInterval(() => {
      void redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        lockKey,
        lockValue,
        10 * 60_000,
      ).catch((error) => {
        logger.warn({ err: error }, '[CronService] Scheduled-publishing lock renewal failed');
      });
    }, 60_000);
    lockRenewal.unref?.();

    try {
      const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
      const { enqueueOrganicPublishAttempt } = await import('./social/OrganicPublishQueue.js');
      const quarantined = await SocialPublishAttemptModel.quarantineExpiredClaims();
      if (quarantined > 0) {
        logger.error(
          { count: quarantined },
          '[CronService] Expired organic publishing claims quarantined for reconciliation',
        );
      }
      const batches = await Promise.all([
        SocialPublishAttemptModel.providerSucceededPending(100),
        SocialPublishAttemptModel.ambiguousPending(50),
        SocialPublishAttemptModel.due(100),
      ]);
      // The sweep only dispatches. Slow provider uploads run independently in
      // the publishing queue with bounded concurrency and database claims.
      const dispatches = await Promise.allSettled(batches.flat().map(enqueueOrganicPublishAttempt));
      dispatches.forEach((result, index) => {
        if (result.status === 'rejected') logger.error({ err: result.reason, attemptId: batches.flat()[index].id }, '[CronService] Organic publishing dispatch failed; next sweep will retry');
      });

      const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
      const { and, eq, lte, lt, isNull } = await import('drizzle-orm');

      // Find assets due for publishing
      const dueAssets = await db
        .select()
        .from(contentAssetsTable)
        .where(
          and(
            eq(contentAssetsTable.status, 'scheduled'),
            lte(contentAssetsTable.scheduledPublishAt, new Date()),
            lt(contentAssetsTable.retryCount, 5),
            isNull(contentAssetsTable.publishedAt),
          )
        )
        .limit(10); // Process up to 10 at a time

      if (dueAssets.length === 0) return;

      logger.info({ count: dueAssets.length }, '[CronService] Processing scheduled content assets');

      for (const asset of dueAssets) {
        if ((asset.metadata as Record<string, unknown> | null)?.organicPublishAttemptId) {
          // Durable attempts above are authoritative for newly scheduled organic posts.
          continue;
        }
        if (['linkedin', 'instagram', 'facebook', 'youtube'].includes(asset.publishPlatform || '')) {
          // A legacy row has no immutable actor/receipt history. Inventory must
          // not turn the current owner into its approving actor or replay a
          // possibly accepted publication. Keep the draft for explicit review.
          await db.update(contentAssetsTable).set({ status: 'failed',
            lastError: 'Legacy publication has no durable originating approval. Inspect the channel, then review a new publication request.',
            scheduledPublishAt: null, updatedAt: new Date() }).where(eq(contentAssetsTable.id, asset.id));
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const platform = (asset as any).publishPlatform;
        if (!platform || !['instagram', 'facebook', 'youtube', 'linkedin', 'twitter'].includes(platform)) {
          logger.warn({ assetId: asset.id, platform }, '[CronService] Skipping asset with unsupported platform');
          await this.handlePublishFailure({ ...asset, retryCount: 4 }, platform || 'unknown', 'Scheduled post has no supported publishing platform');
          continue;
        }

        try {
          const metadata = (asset.metadata || {}) as Record<string, unknown>;
          const rawPostType = typeof metadata.postType === 'string' ? metadata.postType : 'post';
          const postType = ['post', 'story', 'reel', 'carousel', 'video', 'short', 'shorts', 'photo', 'text'].includes(rawPostType)
            ? rawPostType
            : 'post';
          const { executePublishSocialPost } = await import('../mastra/tools/executors/contentExecutor.js');
          const { getOrganicPublishingReview } = await import('./social/OrganicPublishingService.js');
          const sourceReview = await getOrganicPublishingReview(asset);
          const result = await executePublishSocialPost(
            {
              platform,
              content_asset_id: asset.id,
              expected_version: asset.version,
              expected_review_token: sourceReview.token,
              post_type: postType,
              title: asset.title,
              tags: Array.isArray(metadata.tags) ? metadata.tags : undefined,
              privacy_status: typeof metadata.privacyStatus === 'string' ? metadata.privacyStatus : undefined,
            },
            // @ts-expect-error -- executor context accepts the authenticated user subset at runtime
            { userId: asset.userId }
          );

          if (result.success) {
            logger.info({ assetId: asset.id, platform, postId: result.output?.postId }, '[CronService] Scheduled asset published successfully');
            // Reset retry count on success
            await db
              .update(contentAssetsTable)
              .set({ retryCount: 0, lastError: null })
              .where(eq(contentAssetsTable.id, asset.id));
          } else {
            const errorMsg = result.error || 'Unknown publishing error';
            logger.error({ assetId: asset.id, platform, error: errorMsg }, '[CronService] Failed to publish scheduled asset');
            await this.handlePublishFailure(asset, platform, errorMsg);
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          const errorMsg = err.message || String(err);
          logger.error({ assetId: asset.id, err }, '[CronService] Error publishing scheduled asset');
          await this.handlePublishFailure(asset, platform, errorMsg);
        }
      }
    } finally {
      clearInterval(lockRenewal);
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockValue,
      );
    }
  }

  /**
   * Handle scheduling publish failure - increments retry count, applies exponential backoff, and alerts user
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handlePublishFailure(asset: any, platform: string, error: string): Promise<void> {
    try {
      const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
      const { eq } = await import('drizzle-orm');

      const nextRetryCount = asset.retryCount + 1;
      const hasReachedLimit = nextRetryCount >= 5;

      // Calculate backoff: 5m, 10m, 20m, 40m, 80m
      const backoffMinutes = Math.pow(2, nextRetryCount) * 5;
      const nextScheduledDate = new Date(Date.now() + backoffMinutes * 60 * 1000);

      await db
        .update(contentAssetsTable)
        .set({
          retryCount: nextRetryCount,
          lastError: error,
          status: hasReachedLimit ? 'failed' : 'scheduled',
          scheduledPublishAt: hasReachedLimit ? asset.scheduledPublishAt : nextScheduledDate,
        })
        .where(eq(contentAssetsTable.id, asset.id));

      // 1. WebSocket in-app notification
      try {
        const { webSocketEmitter } = await import('./agents/WebSocketEmitter.js');
        webSocketEmitter.emit(asset.userId, 'notification', {
          title: `Publishing to ${platform} Failed`,
          message: `Post "${asset.title}" failed to publish: ${error}. ${hasReachedLimit ? 'Failed permanently.' : `Retrying in ${backoffMinutes} minutes.`}`,
          type: 'error',
        });
      } catch (wsErr) {
        logger.warn({ wsErr }, '[CronService] Failed to emit WebSocket alert');
      }

      // 2. Email user warning
      if (asset.userId) {
        try {
          const { usersTable } = await import('../models/users/schema.js');
          const [user] = await db
            .select({ email: usersTable.email, name: usersTable.name })
            .from(usersTable)
            .where(eq(usersTable.id, asset.userId))
            .limit(1);

          if (user?.email) {
            const { sendAdminEmail } = await import('./adminEmailService.js');
            const { renderAdminEmail } = await import('../utils/emailTemplates.js');

            const html = renderAdminEmail({
              title: `Social Publish Failed`,
              preheader: `Publishing scheduled post to ${platform} failed.`,
              name: user.name || user.email,
              content: `Your scheduled content asset <strong>"${asset.title}"</strong> failed to publish to <strong>${platform}</strong>.<br><br><strong>Error details:</strong> ${error}<br><br>${hasReachedLimit ? 'This was the final retry attempt. The post is marked as Failed.' : `We will automatically retry in ${backoffMinutes} minutes.`}`,
              footer: 'You can manually retry publishing this content directly from the Content Library.',
            });

            await sendAdminEmail({
              to: user.email,
              subject: `Failed to publish scheduled post to ${platform}`,
              html,
            });
          }
        } catch (emailErr) {
          logger.warn({ emailErr }, '[CronService] Failed to send failure notification email');
        }
      }
    } catch (dbErr) {
      logger.error({ err: dbErr }, '[CronService] Failed to update asset retry details in database');
    }
  }

  /**
   * Process due follow-up emails.
   * Uses a Redis distributed lock to prevent concurrent processing across
   * multiple BullMQ worker processes.
   */
  async processFollowUps(): Promise<void> {
    // Prevent concurrent processing within this process
    if (this.isProcessing) {
      return;
    }

    // Distributed lock across all worker processes (TTL 120s as safety ceiling)
    const redis = getRedisConnection();
    const lockKey = 'lock:followup-processing';
    const lockValue = `${process.pid}-${Date.now()}`;
    const acquired = await redis.set(lockKey, lockValue, 'PX', 120_000, 'NX');
    if (!acquired) {
      logger.debug('[CronService] Follow-up processing skipped — another worker holds the lock');
      return;
    }
    const lockRenewal = setInterval(() => {
      void redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        lockKey,
        lockValue,
        120_000,
      ).catch((error) => {
        logger.warn({ err: error }, '[CronService] Follow-up lock renewal failed');
      });
    }, 40_000);
    lockRenewal.unref?.();

    this.isProcessing = true;
    this.processCount++;
    const runId = this.processCount;

    try {
      // Quick pre-check: are there any users with follow-ups enabled?
      const { recoverCreationFollowUps } = await import('./outreach/CreationFollowUpService.js');
      await recoverCreationFollowUps();
      await recoverConfiguredFollowUpDispatches();
      await (await import('./assistants/AssistantFollowUps.js')).assistantFollowUps.processDue();
      const hasActiveFollowUps = await this.hasAnyActiveFollowUps();
      if (!hasActiveFollowUps) {
        // No users have follow-ups configured — skip quietly
        return;
      }

      logger.info({ runId }, '[CronService] Processing follow-ups...');

      // Process user-configured follow-up steps (channel-based Gmail OAuth/Resend)
      const configuredResults = await this.processConfiguredFollowUps();

      const totalSent = configuredResults.sent;
      const totalErrors = configuredResults.errors;

      if (totalSent > 0 || totalErrors.length > 0) {
        logger.info({ 
          runId, 
          totalSent, 
          totalErrors: totalErrors.length,
          errors: totalErrors.slice(0, 5) // Log first 5 errors to avoid log bloating
        }, '[CronService] Follow-up run completed');
      }
    } catch (error) {
      logger.error({ runId, err: error }, '[CronService] Error processing follow-ups');
    } finally {
      this.isProcessing = false;
      clearInterval(lockRenewal);
      // Release the distributed lock atomically, only if we still own it.
      try {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          lockValue,
        );
      } catch { /* lock will expire via TTL */ }
    }
  }

  /**
   * Quick check: are there any users with follow-ups enabled and
   * at least one channel configured with follow-up steps?
   * Returns false if the cron can skip this cycle entirely.
   */
  private async hasAnyActiveFollowUps(): Promise<boolean> {
    try {
      // Check for users with channel follow-ups configured
      const settingsResult = await db.execute(sql`
        SELECT 1 FROM outreach_settings
        WHERE enable_auto_follow_up = true
          AND channel_follow_ups IS NOT NULL
          AND channel_follow_ups::text != '{}'
          AND channel_follow_ups::text != 'null'
        LIMIT 1
      `);
      return settingsResult.rows.length > 0;
    } catch {
      // If check fails, proceed with processing to be safe
      return true;
    }
  }

  /**
   * Process follow-ups based on user-configured follow-up steps
   */
  private async processConfiguredFollowUps(): Promise<{
    processed: number;
    sent: number;
    errors: string[];
  }> {
    const results = { processed: 0, sent: 0, errors: [] as string[] };

    try {
      // Get all users with auto follow-up enabled
      const usersWithSettings = await db.select().from(outreachSettings).where(eq(outreachSettings.enableAutoFollowUp, true));

      const channels = FOLLOW_UP_CHANNELS;

      for (const userSettings of usersWithSettings) {
        try {
          const userId = userSettings.userId as number;
          const channelFollowUps: ChannelFollowUps = (userSettings.channelFollowUps as ChannelFollowUps) || {};

          for (const channel of channels) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const chSettings = (channelFollowUps as any)[channel] as any;
            if (!chSettings || !chSettings.enabled) continue;
            const followUps = chSettings.followUps || [];
            if (!Array.isArray(followUps) || followUps.length === 0) continue;
            const enabledFollowUps = followUps.filter((step) => step?.enabled);
            if (enabledFollowUps.length === 0) continue;

            // Find pending follow-ups for this channel
            const pendingFollowUps = await this.getPendingFollowUpsForChannel(userId, enabledFollowUps, channel);
            logger.debug({ userId, channel, pendingCount: pendingFollowUps.length }, '[CronService] Pending follow-ups found');
            results.processed += pendingFollowUps.length;

            for (const pending of pendingFollowUps) {
              if (pending.isSupportReply) {
                // Support check-ins belong only to a published assistant sequence.
                if (pending.socialScheduleId) await db.execute(sql`UPDATE social_follow_up_schedules
                  SET status='cancelled',version=version+1,cancelled_at=NOW(),cancellation_reason='assistant_sequence_replaced_legacy',updated_at=NOW()
                  WHERE id=${pending.socialScheduleId} AND user_id=${userId} AND status IN ('active','queued')`);
                continue;
              }
              try {
                const nextIndex = pending.nextStepIndex; // 0-based index into followUps
                const msg_follow_up_step_raw = pending.currentStepRaw;
                const step = pending.configuredStep || enabledFollowUps[nextIndex];
                if (!step) continue;

                // Fetch lead
                const leadRes = await db.execute(sql`
                  SELECT * FROM leads
                  WHERE id = ${pending.leadId} AND user_id = ${userId} AND deleted_at IS NULL
                `);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const lead = leadRes.rows[0] as any;
                if (!lead) {
                  results.errors.push(`Lead ${pending.leadId} not found`);
                  continue;
                }

                // Generate or fetch follow-up content
                let generated = '';

                let templateHtml = '';
                let templateSubject = '';
                const provenance: FollowUpProvenance = { version: 1, userId, businessProfileId: requireBusinessScope().businessProfileId, channel, originTable: channel === 'sms' ? 'sent_messages' : 'outreach_messages', originMessageId: pending.messageId, step: nextIndex + 1, settingsRevision: followUpSettingsRevision(chSettings) };
                const usesTemplate = Boolean(step.templateId && step.templateId !== -1);
                if (usesTemplate) {
                  // Legacy manual settings cannot establish campaign/template ownership.
                  // Keep AI generation below intact; campaign manual work uses creation recovery.
                  results.errors.push(`CAMPAIGN_MANUAL_REVIEW_REQUIRED: origin ${pending.messageId} must be reviewed in its campaign.`);
                  continue;
                }
                if (usesTemplate) {
                  const { template, context } = await loadFollowUpTemplate(userId, channel, Number(step.templateId));
                  const business = context.businessProfile;
                  provenance.templateId = template.id; provenance.templateVersion = template.version;
                  provenance.templateRenderContext = issueTemplateRenderContext(userId, template.id, template.version, business.timezone || 'Asia/Kolkata');
                  const rendered = renderFollowUpTemplate(template, {
                    first_name: lead.first_name || lead.full_name?.split(' ')[0] || lead.name?.split(' ')[0],
                    last_name: lead.last_name,
                    full_name: lead.full_name || lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(' '),
                    email: lead.email, phone: lead.phone || lead.whatsapp_phone,
                    company_name: lead.company_name || lead.company,
                    company_industry: lead.industry, company_size: lead.company_size,
                    company_website: lead.website || lead.company_domain,
                    company_location: typeof lead.location === 'string' ? lead.location : [lead.location?.city, lead.location?.state, lead.location?.country].filter(Boolean).join(', '),
                    job_title: lead.role, department: lead.department,
                    pain_point: Array.isArray(lead.pain_points) ? lead.pain_points.join(', ') : lead.pain_points,
                    budget_range: lead.budget_range,
                    your_company_name: business.companyName || business.businessName,
                    your_website: business.website, your_industry: business.industry,
                    value_proposition: business.valueProposition, target_audience: business.targetMarket,
                  }, pending.originalSubject || '', { now: new Date(provenance.templateRenderContext.renderedAt), timeZone: provenance.templateRenderContext.timeZone, channel });
                  generated = rendered.body;
                  templateHtml = rendered.html;
                  templateSubject = rendered.subject;
                }

                // Only auto-generate when no reusable template was selected.
                if (!generated) {
                  const previousText = pending.originalMessage || pending.originalSubject || '';
                  const totalSteps = enabledFollowUps.length;
                  const isLastStep = nextIndex >= totalSteps - 1;

                  // Use stage-specific prompts that feel like natural follow-ups
                  const stagePrompts: Record<string, string> = {
                    first: 'This is the first follow-up. Be brief, reference your initial message, and gently check if they had a chance to review it.',
                    middle: 'This is a mid-sequence follow-up. Add value by mentioning a relevant insight and politely check in.',
                    final: 'This is the final follow-up. Be direct about this being your last reach-out, offer to close the loop, and give them an easy way to respond.',
                  };
                  const stage = isLastStep ? 'final' : nextIndex === 0 ? 'first' : 'middle';

                  const systemPrompt = `You are an expert SDR writing natural follow-up ${channel === 'email' ? 'emails' : 'messages'}.
Write concise, professional follow-up messages that feel genuine and conversational.
Do NOT be pushy or salesy. Include a clear, easy call to action.
Keep it under 80 words. Do not include a subject line.
Do NOT include any greeting (like "Hi", "Hello", "Dear") or sign-off (like "Best regards", "Thanks", "Sincerely"). Start directly with the message body. The greeting and sign-off are handled separately by the email template.`;

                  const userPrompt = `Lead: ${lead.first_name || lead.name || 'there'}
Company: ${lead.company || 'their company'}
Original subject: ${pending.originalSubject || 'our previous conversation'}
Original message summary: ${previousText.substring(0, 200)}
Follow-up stage: ${nextIndex + 1} of ${totalSteps}
Instruction: ${stagePrompts[stage]}
Channel: ${channel}

Write only the message body. No subject line.`;

                  try {
                    const llmResp = await LLMProviderFactory.executeWithFallback(userId, async (provider) => {
                      const response = await provider.createChatCompletion({
                        model: provider.defaultModel,
                        messages: [
                          { role: 'system', content: systemPrompt },
                          { role: 'user', content: userPrompt }
                        ],
                        temperature: 0.5,
                        max_tokens: 300,
                        loggingContext: { userId, purpose: 'follow_up', service: 'CronService' }
                      });
                      
                      if (!response.success) {
                        throw new Error(response.error || 'LLM completion failed');
                      }
                      return response;
                    });

                    generated = llmResp.result.content || '';
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } catch (llmErr: any) {
                    results.errors.push(`LLM generation failed for user ${userId} channel ${channel}: ${llmErr.message}`);
                    continue;
                  }
                }

                // Skip if we still have no content (avoid Resend validation errors)
                if (!usesTemplate && channel === 'email') generated = stripGreetingAndSignoff(generated);
                if (!generated || generated.trim().length === 0) {
                  results.errors.push(`No content generated for message ${pending.messageId}`);
                  continue;
                }

                // Commit recoverable work before queue I/O. Never roll back an
                // intent after an enqueue whose acknowledgement may have been lost.
                const payload = { userId, leadId: pending.leadId,
                  leadName: lead.full_name || lead.first_name || lead.name || 'Unknown',
                  isFollowUp: true, followUpStep: nextIndex + 1,
                  followUpOriginMessageId: pending.messageId,
                  useSavedFollowUpSettings: pending.useSavedFollowUpSettings,
                  followUpProvenance: provenance, createdAt: new Date().toISOString() };
                if (channel === 'email') {
                  if (!lead.email) { results.errors.push(`No email for lead ${pending.leadId}`); continue; }
                  const subject = pending.originalSubject
                    ? `Re: ${pending.originalSubject.replace(/^Re:\s*/i, '')}` : templateSubject || 'Follow-up';
                  let brandedHtml = templateHtml || sanitizeEmailHtml(emailBodyToHtml(generated));
                  if (!usesTemplate) {
                    // Follow-ups keep the brand their outreach was created with, not today's default.
                    const { outreachMessageBrandToolkitId } = await import('./outreach/WorkflowBrand.js');
                    const brand = await getBrandInfo(userId, await outreachMessageBrandToolkitId(userId, pending.messageId));
                    brandedHtml = renderBrandedEmail({ brand, recipientName: lead.first_name || lead.name || undefined, body: generated.replace(/\n/g, '<br>') });
                  }
                  const dispatch = await configuredFollowUpDispatch(channel, pending.messageId, nextIndex + 1,
                    { ...payload, to: lead.email, subject, body: generated, html: brandedHtml, sequenceStep: nextIndex + 1,
                      inReplyTo: pending.externalMessageId || undefined,
                      references: pending.referencesChain || pending.externalMessageId || undefined,
                      gmailThreadId: pending.gmailThreadId || undefined });
                  await reserveEmailFollowUp({ originMessageId: pending.messageId, userId,
                    expectedCurrentStep: msg_follow_up_step_raw || 0, step: nextIndex + 1,
                    subject, content: generated, htmlContent: brandedHtml, dispatch });
                } else if (channel === 'sms') {
                  const phone = lead.phone || lead.whatsapp_phone;
                  if (!phone) { results.errors.push(`No phone for lead ${pending.leadId}`); continue; }
                  const dispatch = await configuredFollowUpDispatch(channel, pending.messageId, nextIndex + 1,
                    { ...payload, to: phone, message: generated });
                  await reserveSmsFollowUpDispatch(pending.messageId, msg_follow_up_step_raw ?? null, nextIndex + 1, dispatch);
                } else if (isSocialFollowUpChannel(channel) && pending.socialScheduleId && pending.socialScheduleVersion) {
                  const dispatch = await configuredFollowUpDispatch(channel, pending.messageId, nextIndex + 1,
                    { ...payload, channel, message: generated, subject: pending.originalSubject || null,
                      socialFollowUpScheduleId: pending.socialScheduleId,
                      socialFollowUpAnchorMessageId: pending.messageId, socialFollowUpStep: nextIndex + 1 });
                  await reserveSocialFollowUp({ scheduleId: pending.socialScheduleId,
                    scheduleVersion: pending.socialScheduleVersion, anchorMessageId: pending.messageId,
                    userId, step: nextIndex + 1, content: generated, dispatch });
                }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } catch (error: any) {
                results.errors.push(`Error sending follow-up for message ${pending.messageId}: ${error.message}`);
              }
            }
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          results.errors.push(`Error processing user ${userSettings.userId}: ${error.message}`);
        }
      }

      results.sent += await recoverConfiguredFollowUpDispatches();
      return results;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      results.errors.push(`Error in processConfiguredFollowUps: ${error.message}`);
      return results;
    }
  }

  /**
   * Get pending follow-ups for a specific channel based on channel follow-up config.
   * Returns messages that are due for the next follow-up step.
   */
  private async getPendingFollowUpsForChannel(
    userId: number,
    followUps: ChannelFollowUp[],
    channel: FollowUpChannel
  ): Promise<Array<{
    messageId: number;
    leadId: number;
    originalSubject: string;
    originalMessage: string;
    nextStepIndex: number;
    currentStepRaw: number | null;
    externalMessageId: string;
    gmailThreadId: string;
    referencesChain: string;
    socialScheduleId?: number;
    socialScheduleVersion?: number;
    configuredStep?: SocialFollowUpStep;
    isSupportReply?: boolean;
    conversationId?: number;
    useSavedFollowUpSettings?: boolean;
  }>> {
    const pending: Array<{
      messageId: number;
      leadId: number;
      originalSubject: string;
      originalMessage: string;
      nextStepIndex: number;
      currentStepRaw: number | null;
      externalMessageId: string;
      gmailThreadId: string;
      referencesChain: string;
      socialScheduleId?: number;
      socialScheduleVersion?: number;
      configuredStep?: SocialFollowUpStep;
      isSupportReply?: boolean;
      conversationId?: number;
      useSavedFollowUpSettings?: boolean;
    }> = [];

    try {
      if (isSocialFollowUpChannel(channel)) {
        const due = await getDueSocialFollowUps(userId, channel);
        return due.map((item) => ({
          messageId: item.anchorMessageId,
          conversationId: item.conversationId,
          leadId: item.leadId,
          originalSubject: item.originalSubject,
          originalMessage: item.originalMessage,
          nextStepIndex: item.nextStep - 1,
          currentStepRaw: null,
          externalMessageId: '',
          gmailThreadId: '',
          referencesChain: '',
          socialScheduleId: item.scheduleId,
          socialScheduleVersion: item.scheduleVersion,
          configuredStep: item.step,
          isSupportReply: item.isSupportReply,
        }));
      }

      if (channel === 'email') {
        const originals = await db.execute(sql`
          SELECT
            origin.id,
            conversation.lead_id,
            origin.subject,
            origin.content,
            origin.sent_at,
            origin.follow_up_step,
            origin.metadata->'outreachCreation'->>'followUpSource' = 'channel_settings' AS uses_saved_follow_ups,
            conversation.external_thread_id AS gmail_thread_id,
            (
              SELECT message.rfc_message_id
              FROM outreach_messages message
              WHERE message.conversation_id = origin.conversation_id
                AND message.rfc_message_id IS NOT NULL
              ORDER BY message.created_at DESC, message.id DESC
              LIMIT 1
            ) AS external_message_id,
            (
              SELECT string_agg(message.rfc_message_id, ' ' ORDER BY message.created_at, message.id)
              FROM outreach_messages message
              WHERE message.conversation_id = origin.conversation_id
                AND message.rfc_message_id IS NOT NULL
            ) AS references_chain
          FROM outreach_messages origin
          JOIN outreach_conversations conversation
            ON conversation.id = origin.conversation_id
          WHERE conversation.user_id = ${userId}
            AND conversation.channel IN ('email', 'gmail')
            AND origin.user_id = ${userId}
            AND origin.direction = 'outbound'
            AND origin.message_kind = 'outreach'
            AND origin.follow_up_origin_message_id IS NULL
            AND origin.follow_up_cancelled_at IS NULL
            AND (origin.metadata->'outreachCreation' IS NULL
              OR origin.metadata->'outreachCreation'->>'followUpSource' = 'channel_settings')
            AND origin.status IN ('sent', 'delivered', 'read')
            AND origin.sent_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM sent_messages legacy_follow_up
              WHERE legacy_follow_up.user_id = origin.user_id
                AND legacy_follow_up.is_reply = true
                AND legacy_follow_up.follow_up_step IS NOT NULL
                AND (
                  legacy_follow_up.message_id = origin.provider_message_id
                  OR legacy_follow_up.message_id = origin.external_message_id
                  OR legacy_follow_up.message_id = origin.rfc_message_id
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM outreach_messages reply
              WHERE reply.conversation_id = origin.conversation_id
                AND reply.direction = 'inbound'
                AND reply.created_at > origin.sent_at
            )
          ORDER BY origin.sent_at, origin.id
        `);

        const enabledSteps = followUps.filter((step) => step.enabled);
        const now = new Date();
        for (const row of originals.rows as Array<Record<string, unknown>>) {
          const currentStep = Number(row.follow_up_step) || 0;
          if (currentStep >= enabledSteps.length) continue;
          const nextStep = enabledSteps[currentStep];
          const dueAt = getEmailFollowUpDueAt(parseUtcDatabaseTimestamp(row.sent_at), nextStep);
          if (!Number.isFinite(dueAt.getTime()) || now < dueAt) continue;

          pending.push({
            messageId: Number(row.id),
            leadId: Number(row.lead_id),
            originalSubject: String(row.subject || ''),
            originalMessage: String(row.content || ''),
            nextStepIndex: currentStep,
            currentStepRaw: row.follow_up_step === null ? null : currentStep,
            externalMessageId: String(row.external_message_id || ''),
            gmailThreadId: String(row.gmail_thread_id || ''),
            referencesChain: String(row.references_chain || row.external_message_id || ''),
            useSavedFollowUpSettings: row.uses_saved_follow_ups === true,
          });
        }
        return pending;
      }

      // Map channel key to the actual channel values stored in sent_messages
      const channelValues = `'${channel}'`;

      // Get sent messages for this channel that have no reply.
      // Fetch original outreach messages (seed messages per lead thread) that are awaiting follow-up.
      // A seed message is is_reply=false AND follow_up_step IS NULL (not a follow-up we sent).
      // We stop following up when:
      //   a) The lead replied back (sent_messages with is_reply=true AND follow_up_step IS NULL AND status='received')
      //   b) We (the user) sent a manual reply to this lead (outreach_messages with direction='inbound'
      //      in the conversation, or a smart reply was sent via emailReplyService)
      //   c) There's an inbound message in outreach_messages (direction='inbound') after the seed message
      const sentMessages = await db.execute(sql`
        SELECT 
          sm.id,
          sm.lead_id,
          sm.subject,
          sm.message,
          sm.sent_at,
          sm.updated_at,
          sm.follow_up_step,
          EXISTS (
            SELECT 1 FROM outreach_messages reviewed
            WHERE reviewed.user_id = sm.user_id
              AND reviewed.metadata->'outreachCreation'->>'followUpSource' = 'channel_settings'
              AND sm.message_id IN (reviewed.provider_message_id, reviewed.external_message_id)
          ) AS uses_saved_follow_ups,
          COALESCE(
            (SELECT seed.rfc_message_id
             FROM outreach_messages seed
             JOIN outreach_conversations seed_conversation
               ON seed_conversation.id = seed.conversation_id
             WHERE seed_conversation.user_id = sm.user_id
               AND seed_conversation.lead_id = sm.lead_id
               AND (
                 seed.provider_message_id = sm.message_id
                 OR seed.external_message_id = sm.message_id
                 OR seed.rfc_message_id = sm.message_id
               )
               AND seed.rfc_message_id IS NOT NULL
             ORDER BY seed.created_at ASC
             LIMIT 1),
            CASE
              WHEN sm.message_id ~ '^<[^<>[:space:]@]+@[^<>[:space:]]+>$'
                THEN sm.message_id
              ELSE NULL
            END
          ) AS external_message_id,
          (SELECT string_agg(ref.rfc_message_id, ' ' ORDER BY ref.created_at ASC)
           FROM outreach_messages ref
           WHERE ref.conversation_id = (
             SELECT seed.conversation_id
             FROM outreach_messages seed
             JOIN outreach_conversations seed_conversation
               ON seed_conversation.id = seed.conversation_id
             WHERE seed_conversation.user_id = sm.user_id
               AND seed_conversation.lead_id = sm.lead_id
               AND (
                 seed.provider_message_id = sm.message_id
                 OR seed.external_message_id = sm.message_id
                 OR seed.rfc_message_id = sm.message_id
               )
             ORDER BY seed.created_at ASC
             LIMIT 1
           )
             AND ref.rfc_message_id IS NOT NULL
          ) AS references_chain,
          COALESCE(
            (SELECT seed_conversation.external_thread_id
             FROM outreach_messages seed
             JOIN outreach_conversations seed_conversation
               ON seed_conversation.id = seed.conversation_id
             WHERE seed_conversation.user_id = sm.user_id
               AND seed_conversation.lead_id = sm.lead_id
               AND seed_conversation.integration_provider = 'gmail'
               AND (
                 seed.provider_message_id = sm.message_id
                 OR seed.external_message_id = sm.message_id
                 OR seed.rfc_message_id = sm.message_id
               )
             ORDER BY seed.created_at ASC
             LIMIT 1),
            sm.gmail_thread_id
          ) AS gmail_thread_id
        FROM sent_messages sm
        WHERE sm.user_id = ${userId}
          AND sm.channel IN (${sql.raw(channelValues)})
          AND sm.is_reply = false
          AND sm.sent_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM outreach_messages reviewed
            WHERE reviewed.user_id = sm.user_id
              AND reviewed.metadata->'outreachCreation' IS NOT NULL
              AND COALESCE(reviewed.metadata->'outreachCreation'->>'followUpSource', '') <> 'channel_settings'
              AND (sm.message_id IN (reviewed.provider_message_id, reviewed.external_message_id, reviewed.rfc_message_id)
                OR sm.gmail_message_id IN (reviewed.provider_message_id, reviewed.external_message_id, reviewed.rfc_message_id))
          )
          -- Skip messages marked as fully followed-up (9999 sentinel set on reply detection)
          AND (sm.follow_up_step IS NULL OR sm.follow_up_step < 9999)
          -- Stop follow-ups if the lead replied back (inbound reply with no follow_up_step)
          AND NOT EXISTS (
            SELECT 1 FROM sent_messages reply
            WHERE reply.lead_id = sm.lead_id
              AND reply.user_id = sm.user_id
              AND reply.is_reply = true
              AND reply.follow_up_step IS NULL
              AND reply.status = 'received'
              AND reply.channel IN (${sql.raw(channelValues)})
              AND reply.sent_at > sm.sent_at
          )
          -- Stop follow-ups if we (the user/agent) already sent a manual reply to this lead
          AND NOT EXISTS (
            SELECT 1 FROM sent_messages manual_reply
            WHERE manual_reply.lead_id = sm.lead_id
              AND manual_reply.user_id = sm.user_id
              AND manual_reply.is_reply = true
              AND manual_reply.follow_up_step IS NULL
              AND manual_reply.status = 'sent'
              AND manual_reply.channel IN (${sql.raw(channelValues)})
              AND manual_reply.sent_at > sm.sent_at
          )
          -- Stop if any inbound message arrived in the outreach conversation after the seed message
          AND NOT EXISTS (
            SELECT 1 FROM outreach_messages om
            JOIN outreach_conversations oc ON oc.id = om.conversation_id
            WHERE oc.lead_id = sm.lead_id
              AND oc.user_id = sm.user_id
              AND om.direction = 'inbound'
              AND om.created_at > sm.sent_at
          )
        ORDER BY sm.sent_at ASC
      `);

      const now = new Date();
      const enabledSteps = followUps.filter(f => f.enabled);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const msg of sentMessages.rows as any[]) {
        const currentStep = msg.follow_up_step || 0;
        // currentStep is 0-based count of follow-ups already sent
        const nextStepIndex = currentStep;

        if (nextStepIndex >= enabledSteps.length) continue; // All follow-ups sent

        const nextStep = enabledSteps[nextStepIndex];
        // All configured periods are offsets from the original send, matching
        // Email and social schedules. Dispatch/update time must not shift them.
        const dueAt = getEmailFollowUpDueAt(parseUtcDatabaseTimestamp(msg.sent_at), nextStep);

        if (now >= dueAt) {
          logger.debug({ 
            messageId: msg.id, 
            leadId: msg.lead_id, 
            sentAt: msg.sent_at, 
            dueAt, 
            now, 
            nextStepIndex 
          }, '[CronService] Follow-up IS DUE');
          pending.push({
            messageId: msg.id,
            leadId: msg.lead_id,
            originalSubject: msg.subject || '',
            originalMessage: msg.message || '',
            nextStepIndex,
            currentStepRaw: msg.follow_up_step ?? null,
            externalMessageId: msg.external_message_id || '',
            gmailThreadId: msg.gmail_thread_id || '',
            referencesChain: msg.references_chain || msg.external_message_id || '',
            useSavedFollowUpSettings: msg.uses_saved_follow_ups === true,
          });
        }
      }

      return pending;
    } catch (error) {
      logger.error({ err: error, channel }, '[CronService] Error getting pending follow-ups for channel');
      return [];
    }
  }

  /**
   * Get pending follow-ups for a user based on their configured steps
   */
  private async getPendingFollowUps(
    userId: number,
    followUpSteps: FollowUpStep[]
  ): Promise<Array<{
    messageId: number;
    leadId: number;
    originalSubject: string;
    nextStepId: number;
  }>> {
    const pending: Array<{
      messageId: number;
      leadId: number;
      originalSubject: string;
      nextStepId: number;
    }> = [];

    try {
      // Get sent messages that haven't received a reply
      const sentMessages = await db.execute(sql`
        SELECT 
          sm.id,
          sm.lead_id,
          sm.subject,
          sm.message,
          sm.sent_at,
          sm.follow_up_step
        FROM sent_messages sm
        WHERE sm.user_id = ${userId}
          AND sm.channel IN ('email', 'gmail', 'resend')
          AND sm.is_reply = false
          AND sm.sent_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sent_messages reply
            WHERE reply.lead_id = sm.lead_id
              AND reply.is_reply = true
              AND reply.follow_up_step IS NULL
              AND reply.channel IN ('email', 'gmail', 'resend')
              AND reply.sent_at > sm.sent_at
          )
        ORDER BY sm.sent_at ASC
      `);

      const now = new Date();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const msg of sentMessages.rows as any[]) {
        const currentStep = msg.follow_up_step || 0;
        const nextStepIndex = followUpSteps.findIndex(s => s.id > currentStep);
        
        if (nextStepIndex === -1) continue; // All follow-ups already sent
        
        const nextStep = followUpSteps[nextStepIndex];
        const sentAt = new Date(msg.sent_at);
        const dueAt = new Date(sentAt.getTime() + nextStep.delayHours * 60 * 60 * 1000);

        if (now >= dueAt) {
          // Extract subject - try from subject column first, then from message JSON
          let originalSubject = msg.subject || '';
          if (!originalSubject && msg.message) {
            try {
              const parsed = JSON.parse(msg.message);
              originalSubject = parsed.subject || '';
            } catch {
              // Not JSON, use as-is
            }
          }
          
          pending.push({
            messageId: msg.id,
            leadId: msg.lead_id,
            originalSubject: originalSubject || 'Follow-up',
            nextStepId: nextStep.id,
          });
        }
      }

      return pending;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[CronService] Error getting pending follow-ups');
      return [];
    }
  }

  /**
   * Send a follow-up email based on configured step
   */
  private async sendFollowUpEmail(
    leadId: number,
    originalSubject: string,
    step: FollowUpStep,
    userId: number
  ): Promise<boolean> {
    try {
      // Get lead details
      const leadResult = await db.execute(sql`
        SELECT * FROM leads WHERE id = ${leadId}
      `);

      if (leadResult.rows.length === 0) {
        logger.warn({ leadId: leadId }, '[CronService] Lead not found');
        return false;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = leadResult.rows[0] as any;

      // Get threading info from the most recent sent message to this lead
      const threadingResult = await db.execute(sql`
        SELECT message_id, gmail_thread_id FROM sent_messages
        WHERE lead_id = ${leadId} AND user_id = ${userId}
          AND channel IN ('email', 'gmail', 'resend')
          AND is_reply = false AND sent_at IS NOT NULL
        ORDER BY sent_at DESC LIMIT 1
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadingInfo = threadingResult.rows[0] as any;

      // Personalize the message
      const subject = step.customSubject
        .replace(/\{\{originalSubject\}\}/g, originalSubject)
        .replace(/\{\{firstName\}\}/g, lead.first_name || '')
        .replace(/\{\{lastName\}\}/g, lead.last_name || '')
        .replace(/\{\{company\}\}/g, lead.company || '');

      const body = step.customBody
        .replace(/\{\{firstName\}\}/g, lead.first_name || '')
        .replace(/\{\{lastName\}\}/g, lead.last_name || '')
        .replace(/\{\{company\}\}/g, lead.company || '')
        .replace(/\{\{originalSubject\}\}/g, originalSubject);

      // Dispatch to BullMQ email-sending queue
      await queueRegistry.addJob(
        QUEUE_NAMES.EMAIL_SENDING,
        'send_follow_up_email',
        {
          userId,
          leadId,
          to: lead.email || '',
          subject,
          body,
          html: body,
          sequenceStep: step.id,
          // Threading info for proper email reply chains
          inReplyTo: threadingInfo?.message_id || undefined,
          references: threadingInfo?.message_id || undefined,
          gmailThreadId: threadingInfo?.gmail_thread_id || undefined,
          createdAt: new Date().toISOString(),
        }
      );

      logger.info({ id: step.id, leadId: leadId }, '[CronService] Queued follow-up step for lead');
      return true;
    } catch (error) {
      logger.error({ err: error }, '[CronService] Error queuing follow-up email');
      return false;
    }
  }

  /**
   * Atomically claim the next follow-up step using compare-and-swap.
   * Returns true only if this process successfully advanced the step,
   * preventing duplicate sends from concurrent cron cycles.
   */
  private async claimFollowUpStep(
    messageId: number,
    currentStepInDb: number | null,
    newStep: number
  ): Promise<boolean> {
    try {
      const condition = currentStepInDb === null || currentStepInDb === 0
        ? sql`(follow_up_step IS NULL OR follow_up_step = 0)`
        : sql`follow_up_step = ${currentStepInDb}`;

      const result = await db.execute(sql`
        UPDATE sent_messages
        SET follow_up_step = ${newStep},
            updated_at = NOW()
        WHERE id = ${messageId}
          AND ${condition}
      `);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rowCount = (result as any).rowCount ?? (result as any).changes ?? 0;
      if (rowCount === 0) {
        logger.warn({ messageId, currentStepInDb, newStep }, '[CronService] CAS failed — row already advanced');
        return false;
      }
      return true;
    } catch (error) {
      logger.error({ err: error, messageId }, '[CronService] Error claiming follow-up step');
      return false; // On DB error, do NOT dispatch
    }
  }

  /**
   * Get cron status
   */
  getStatus(): {
    running: boolean;
    isProcessing: boolean;
    processCount: number;
    mode: 'bullmq';
  } {
    return {
      running: true,
      isProcessing: this.isProcessing,
      processCount: this.processCount,
      mode: 'bullmq',
    };
  }
}

export const cronService = new CronService();
