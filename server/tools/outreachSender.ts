import { randomUUID } from 'node:crypto';
import { assertCustomerDeliveryReady, deliverySetupFailure, throwIfCustomerDeliverySetupRequired, withCustomerDeliveryReceipt } from '../services/assistants/CustomerDeliveryGate.js';
import {
  assertRecipientNotSuppressed,
  RecipientSuppressedError,
} from '../services/outreach/RecipientSuppressionService.js';
import { withCreationDailyQuota } from '../services/outreach/QuotaService.js';
/**
 * Outreach Sender Worker
 * Background job processor for scheduled outreach messages (email and SMS)
 * Handles retry logic, rate limiting, and delivery tracking
 *
 */

import { db } from '../models/db';
import {
  assertCampaignJobReview,
  campaignMessageHash,
  CampaignDeliveryReviewError,
  type CampaignJobReview,
} from '../services/outreach/CampaignDeliveryService.js';
import { escapeOutreachHtml } from '../../shared/outreachCompose.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { sql } from 'drizzle-orm';
import { emailService } from '../services/emailService';
import { sendSMS } from '../services/smsService';
import { SentMessageModel } from '../models/sentMessages/functions';
import { creditService } from '../services/CreditService';
import { logger } from '../utils/logger.js';
import {
  reconcileOutreachJobCampaign,
  reconcilePendingOutreachJobCampaigns,
} from '../services/outreach/OutreachJobCampaignService.js';
import { deliveryOutcomeIsUncertain } from '../services/outreach/deliveryOutcome.js';
import { emailRetryTime } from '../services/outreach/emailRetry.js';
import {
  OUTREACH_POLL_INTERVAL_MS,
  OUTREACH_SENDER_BATCH_SIZE,
  OUTREACH_SENDER_MAX_CONCURRENT,
} from '../utils/timingConstants';

export interface SendResult {
  success: boolean;
  code?: string;
  reason?: string;
  setupUrl?: string;
  messageId?: string;
  error?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
  retryAt?: string;
  retryable?: boolean;
}

export interface OutreachJob {
  id: number;
  userId: number;
  sequenceId: number;
  campaignId: number;
  leadId: number;
  stepNumber: number;
  sequenceStepKey?: number;
  claimToken?: string;
  deliveryReview?: CampaignJobReview;
  messageType: 'email' | 'sms';
  scheduledFor: Date;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled' | 'setup_required';
  subject?: string;
  content: string;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  sentAt?: Date;
  messageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * OutreachSenderWorker - Processes scheduled outreach messages
 */
class OutreachClaimLostError extends Error {}

export class OutreachSenderWorker {
  private isRunning: boolean = false;
  private pollInterval: number = OUTREACH_POLL_INTERVAL_MS;
  private batchSize: number = OUTREACH_SENDER_BATCH_SIZE;
  private maxConcurrent: number = OUTREACH_SENDER_MAX_CONCURRENT;
  private pollLoopPromise: Promise<void> | null = null;
  private lastCampaignReconciliation = new Map<number, number>();

  constructor() {
    logger.info('[OutreachSenderWorker] Worker initialized');
  }

  /**
   * Start the worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info('[OutreachSenderWorker] Worker already running');
      return;
    }

    this.isRunning = true;
    logger.info('[OutreachSenderWorker] Starting worker...');

    // Ensure jobs table exists
    await this.ensureJobsTable();

    // Start polling loop
    this.pollLoopPromise = this.pollLoop();
  }

  /**
   * Stop the worker
   */
  async stop(): Promise<void> {
    logger.info('[OutreachSenderWorker] Stopping worker...');
    this.isRunning = false;
    await this.pollLoopPromise;
    this.pollLoopPromise = null;
  }

  /**
   * Poll for pending jobs
   */
  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await forEachBusiness(() => this.processPendingJobs());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        logger.error('[OutreachSenderWorker] Error in poll loop:', error);
      }

      // Wait before next poll
      await this.sleep(this.pollInterval);
    }

    logger.info('[OutreachSenderWorker] Worker stopped');
  }

  /**
   * Process pending jobs
   */
  private async processPendingJobs(): Promise<void> {
    try {
      await this.recoverStaleProcessingJobs();
      const profileId = requireBusinessScope().businessProfileId;
      if (
        Date.now() - (this.lastCampaignReconciliation.get(profileId) || 0) >=
        60_000
      ) {
        await reconcilePendingOutreachJobCampaigns();
        const { reconcileWhatsAppProviderRetries } = await import('../services/outreach/WhatsAppProviderRetry.js');
        await reconcileWhatsAppProviderRetries();
        const {reconcileDashboardRetries}=await import('../services/outreach/OutreachRetryService.js');
        await reconcileDashboardRetries();
        this.lastCampaignReconciliation.set(profileId, Date.now());
      }

      // Fetch pending jobs that are due
      const jobs = await this.fetchPendingJobs();

      if (jobs.length === 0) {
        return;
      }

      logger.info(
        `[OutreachSenderWorker] Processing ${jobs.length} pending jobs`,
      );

      // Process jobs in batches to limit concurrency
      for (let i = 0; i < jobs.length; i += this.maxConcurrent) {
        const batch = jobs.slice(i, i + this.maxConcurrent);
        await Promise.all(batch.map((job) => this.processJob(job)));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OutreachSenderWorker] Error processing jobs:', error);
    }
  }

  /**
   * Resolve jobs left in processing after a worker crash. Jobs that never
   * reached the provider are refunded and retried; jobs that may have reached
   * the provider are stopped for manual review to prevent duplicate delivery.
   */
  private async recoverStaleProcessingJobs(): Promise<void> {
    // Revoke the old token in the same statement that observes stale state.
    // A resumed worker must win a token-checked provider-start transition.
    const result = await db.execute(sql`
      WITH stale AS (
        SELECT * FROM outreach_jobs WHERE status='processing'
          AND updated_at < NOW()-INTERVAL '15 minutes'
        ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED
      ) UPDATE outreach_jobs job SET
        status=CASE WHEN stale.metadata->>'providerCallStarted'='false' AND stale.attempts+1<stale.max_attempts THEN 'pending' ELSE 'failed' END,
        attempts=job.attempts+1, last_attempt_at=NOW(), scheduled_for=NOW(),
        is_dead_letter=NOT (stale.metadata->>'providerCallStarted'='false' AND stale.attempts+1<stale.max_attempts),
        error='Interrupted worker recovered; uncertain provider attempts require review.',
        metadata=(COALESCE(job.metadata,'{}'::jsonb)-'claimToken')||jsonb_build_object(
          'manualReviewRequired',COALESCE(stale.metadata->>'providerCallStarted','unknown')<>'false'),
        updated_at=NOW()
      FROM stale WHERE job.id=stale.id
      RETURNING job.id,job.user_id AS "userId",job.campaign_id AS "campaignId",job.channel,stale.metadata
    `);
    for (const row of result.rows as Array<{
      id: number;
      userId: number;
      campaignId: number;
      channel: string;
      metadata?: Record<string, unknown>;
    }>) {
      const reservationId = Number(row.metadata?.reservationTransactionId);
      if (row.metadata?.providerCallStarted === false && reservationId > 0) {
        await creditService.refundDeduction({
          userId: row.userId,
          transactionId: reservationId,
          description: `Refund for interrupted ${row.channel} campaign job ${row.id}`,
        });
      }
      await this.updateCampaignCompletion(row.campaignId, row.userId);
    }
  }

  /**
   * Fetch pending jobs from database
   */
  private async fetchPendingJobs(): Promise<OutreachJob[]> {
    try {
      const result = await db.execute(sql`
        SELECT
          id,
          user_id AS "userId",
          lead_id AS "leadId",
          COALESCE(campaign_id, 0) AS "campaignId",
          COALESCE(
            CASE
              WHEN metadata->>'sequenceId' ~ '^[0-9]{1,9}$' THEN (metadata->>'sequenceId')::integer
              ELSE NULL
            END,
            0
          ) AS "sequenceId",
          CASE WHEN metadata->'deliveryReview'->>'stepNumber' ~ '^[1-9][0-9]{0,2}$' THEN (metadata->'deliveryReview'->>'stepNumber')::integer ELSE sequence_step_id END AS "stepNumber",
          sequence_step_id AS "sequenceStepKey",
          metadata->'deliveryReview' AS "deliveryReview",
          channel AS "messageType",
          scheduled_for AS "scheduledFor",
          status,
          subject,
          message_body AS content,
          attempts AS "retryCount",
          max_attempts AS "maxRetries",
          error AS "lastError",
          sent_at AS "sentAt",
          external_message_id AS "messageId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM outreach_jobs
        WHERE status = 'pending'
          AND scheduled_for <= NOW()
          AND attempts < max_attempts
          AND COALESCE(metadata->>'manualReviewRequired','false') <> 'true'
          AND (campaign_id IS NULL OR EXISTS (
            SELECT 1 FROM outreach_campaigns c
            WHERE c.id = outreach_jobs.campaign_id AND c.user_id = outreach_jobs.user_id
              AND c.status IN ('scheduled','running','queued','queued_partial')
          ))
        ORDER BY scheduled_for ASC
        LIMIT ${this.batchSize}
      `);

      return result.rows as unknown as OutreachJob[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OutreachSenderWorker] Error fetching jobs:', error);
      return [];
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: OutreachJob): Promise<void> {
    logger.info(
      `[OutreachSenderWorker] Processing job ${job.id} (${job.messageType})`,
    );

    let reservationTransactionId: number | undefined;
    let providerCallStarted = false;
    job = { ...job, claimToken: randomUUID() };

    try {
      // Atomically claim the job. With multiple worker processes, a plain
      // SELECT followed by an unconditional UPDATE lets both workers send it.
      const claimed = await this.claimJob(job.id, job.claimToken!);
      if (!claimed) {
        logger.info(
          `[OutreachSenderWorker] Job ${job.id} already claimed; skipping`,
        );
        return;
      }

      await this.updateCampaignCompletion(job.campaignId, job.userId);

      // Fetch lead data
      const lead = await this.fetchLead(job.leadId, job.userId);
      if (!lead) {
        throw new Error(`Lead ${job.leadId} not found`);
      }

      // Check if lead is blacklisted or unsubscribed
      if (
        lead.blacklisted ||
        lead.doNotContact ||
        (job.messageType === 'email' && lead.emailUnsubscribed)
      ) {
        logger.info(
          `[OutreachSenderWorker] Lead ${job.leadId} is blacklisted/unsubscribed, skipping`,
        );
        await this.updateJobStatus(
          job.id,
          'cancelled',
          'Lead opted out',
          job.claimToken!,
        );
        await this.updateCampaignCompletion(job.campaignId, job.userId);
        return;
      }

      if (job.messageType === 'email' && !lead.email) {
        await this.handleDefinitiveFailure(job, 'Lead has no email address');
        return;
      }
      if (job.messageType === 'sms' && !lead.phone) {
        await this.handleDefinitiveFailure(job, 'Lead has no phone number');
        return;
      }

      const review = await assertCampaignJobReview(job);
      if (job.stepNumber > 1) {
        const anchor =
          await db.execute(sql`SELECT id,status,metadata FROM outreach_jobs WHERE campaign_id=${job.campaignId}
          AND user_id=${job.userId} AND lead_id=${job.leadId} AND channel=${job.messageType}
          AND metadata->'deliveryReview'->>'stepNumber'=${String(job.stepNumber - 1)} LIMIT 1`);
        if (
          ['pending', 'processing'].includes(String(anchor.rows[0]?.status))
        ) {
          await this.deferJob(
            job,
            'Waiting for the preceding sequence message.',
          );
          return;
        }
        if (anchor.rows[0]?.status === 'cancelled') {
          await this.updateJobStatus(
            job.id,
            'cancelled',
            'The preceding sequence message was cancelled.',
            job.claimToken!,
          );
          return;
        }
        if (anchor.rows[0]?.status !== 'sent')
          throw new CampaignDeliveryReviewError(
            'The preceding sequence message has no confirmed receipt. Review before continuing.',
          );
        // Both the current canonical conversation and retained receipt history
        // stop an unanswered sequence after a customer response.
        const replied =
          await db.execute(sql`SELECT 1 FROM outreach_conversations conversation
          JOIN outreach_messages message ON message.conversation_id=conversation.id AND message.user_id=conversation.user_id
          WHERE conversation.user_id=${job.userId} AND conversation.lead_id=${job.leadId}
            AND conversation.channel=${job.messageType} AND conversation.provider_account_id=${review.providerAccountId}
            AND message.direction='inbound' AND message.created_at>(SELECT MIN(sent_at) FROM outreach_jobs
              WHERE campaign_id=${job.campaignId} AND lead_id=${job.leadId} AND channel=${job.messageType} AND status='sent')
          UNION ALL SELECT 1 FROM sent_messages WHERE user_id=${job.userId} AND lead_id=${job.leadId}
            AND is_reply=true AND reply_received_at IS NOT NULL AND reply_received_at>(SELECT MIN(sent_at) FROM outreach_jobs
              WHERE campaign_id=${job.campaignId} AND lead_id=${job.leadId} AND channel=${job.messageType} AND status='sent') LIMIT 1`);
        if (replied.rows.length) {
          await this.updateJobStatus(
            job.id,
            'cancelled',
            'Customer replied; sequence stopped.',
            job.claimToken!,
          );
          await this.updateCampaignCompletion(job.campaignId, job.userId);
          return;
        }
        const superseded =
          await db.execute(sql`SELECT 1 FROM sent_messages WHERE user_id=${job.userId} AND lead_id=${job.leadId}
          AND COALESCE(is_reply,false)=false AND campaign_id IS DISTINCT FROM ${job.campaignId}
          AND ((channel IN ('email','gmail','resend') AND ${job.messageType}='email' AND sender_id=${review.senderId || null})
            OR (channel='sms' AND ${job.messageType}='sms'))
          AND sent_at>(SELECT MAX(sent_at) FROM outreach_jobs WHERE campaign_id=${job.campaignId}
            AND user_id=${job.userId} AND lead_id=${job.leadId} AND channel=${job.messageType} AND status='sent')
          UNION ALL SELECT 1 FROM outreach_conversations conversation JOIN outreach_messages message
            ON message.conversation_id=conversation.id AND message.user_id=conversation.user_id
          WHERE conversation.user_id=${job.userId} AND conversation.lead_id=${job.leadId}
            AND conversation.channel=${job.messageType} AND conversation.provider_account_id=${review.providerAccountId}
            AND message.direction='outbound' AND message.created_at>(SELECT MAX(sent_at) FROM outreach_jobs
              WHERE campaign_id=${job.campaignId} AND user_id=${job.userId} AND lead_id=${job.leadId} AND channel=${job.messageType} AND status='sent')
            AND NOT EXISTS(SELECT 1 FROM outreach_jobs own_job WHERE own_job.campaign_id=${job.campaignId}
              AND own_job.user_id=${job.userId} AND own_job.external_message_id=message.external_message_id) LIMIT 1`);
        if (superseded.rows.length) {
          await this.updateJobStatus(
            job.id,
            'cancelled',
            'A newer outbound message replaced this sequence anchor.',
            job.claimToken!,
          );
          await this.updateCampaignCompletion(job.campaignId, job.userId);
          return;
        }
      }

      const reservation = await creditService.reserveOutreachCredit({
        userId: job.userId,
        channel: job.messageType,
        referenceId: `outreach-job:${job.id}:attempt:${job.retryCount + 1}`,
        service: 'OutreachSenderWorker',
      });
      if (!reservation.success) {
        const reservationError =
          reservation.error ||
          'Insufficient credits. Recharge your wallet before retrying.';
        await this.updateJobStatus(
          job.id,
          'failed',
          reservationError,
          job.claimToken!,
        );
        await this.updateCampaignCompletion(job.campaignId, job.userId);
        return;
      }
      reservationTransactionId = reservation.transactionId;
      if (
        !(await this.recordAttemptMetadata(
          job.id,
          {
            reservationTransactionId: reservationTransactionId || null,
            providerCallStarted: false,
            attempt: job.retryCount + 1,
          },
          job.claimToken!,
        ))
      )
        throw new OutreachClaimLostError();

      // Provider calls happen only after the credit is reserved. Tracking
      // layers are told not to charge again after a successful send.
      let result: SendResult;

      if (job.messageType === 'email') {
        // Use sendPersonalizedEmail which routes through the user's configured
        // email provider (Resend or Gmail OAuth) based on outreach_settings

        // Look up threading info from previous messages to this lead
        let threadingOptions: {
          inReplyTo?: string;
          references?: string;
          threadId?: string;
          skipCreditDeduction?: boolean;
          senderId?: number;
          text?: string;
        } = {
          skipCreditDeduction: true,
          senderId: review.senderId,
          text: job.content,
        };
        if (job.stepNumber > 1) {
          const threadResult = await db.execute(sql`
              SELECT rfc_message_id, references_header, gmail_thread_id FROM sent_messages
              WHERE lead_id = ${job.leadId}
                AND user_id = ${job.userId}
                AND channel IN ('email', 'gmail', 'resend')
                AND campaign_id=${job.campaignId} AND sender_id=${review.senderId}
                AND rfc_message_id IS NOT NULL
              ORDER BY sent_at DESC LIMIT 1
            `);
          if (!threadResult.rows.length)
            throw new CampaignDeliveryReviewError(
              'The preceding email has no verified RFC threading identity. Review before continuing.',
            );
          if (threadResult.rows.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const prev = threadResult.rows[0] as any;
            threadingOptions = {
              inReplyTo: prev.rfc_message_id || undefined,
              references: [prev.references_header, prev.rfc_message_id]
                .filter(Boolean)
                .join(' '),
              threadId: prev.gmail_thread_id || undefined,
              skipCreditDeduction: true,
              senderId: review.senderId,
              text: job.content,
            };
          }
        }

        // Every campaign step uses the brand saved on the campaign, not today's default.
        const { campaignBrandToolkitId } = await import('../services/outreach/WorkflowBrand.js');
        const brandToolkitId = await campaignBrandToolkitId(job.userId, job.campaignId);
        if (!(await this.startProvider(job, review.recipient))) {
          await this.refundUnstarted(job, reservationTransactionId);
          return;
        }
        providerCallStarted = true;
        result = await withCustomerDeliveryReceipt(review.assistant!, () => emailService.sendEmailWithUserCredentials(
          job.userId,
          {
            to: review.recipient,
            brandToolkitId,
            subject: job.subject || 'Message from our team',
            html: `<p>${escapeOutreachHtml(job.content).replace(/\n/g, '<br>')}</p>`,
            text: job.content,
            leadId: job.leadId,
            campaignId: job.campaignId,
            sequenceStep: job.stepNumber,
            inReplyTo: threadingOptions.inReplyTo,
            references: threadingOptions.references,
            threadId: threadingOptions.threadId,
            isFollowUp: job.stepNumber > 1,
            followUpStep: job.stepNumber > 1 ? job.stepNumber : undefined,
            skipCreditDeduction: true,
            idempotencyKey: `outreach-job:${job.id}`,
            expectedFromEmail: review.fromEmail,
            expectedProviderAccountId: review.providerAccountId,
            expectedCredentialId: review.providerCredentialId,
          },
          review.senderId,
        ));
      } else {
        if (!(await this.startProvider(job, review.recipient))) {
          await this.refundUnstarted(job, reservationTransactionId);
          return;
        }
        providerCallStarted = true;
        result = await sendSMS(
          job.userId,
          review.recipient,
          job.content,
          undefined,
          review.providerAccountId,
        );
      }
      providerCallStarted =
        result.success || result.deliveryAttempted !== false;
      throwIfCustomerDeliverySetupRequired(result);

      if (!result.success) {
        if (deliveryOutcomeIsUncertain(result)) {
          throw new Error(
            result.error ||
              'Provider delivery is uncertain. Review provider history before retrying.',
          );
        }
        if (reservationTransactionId) {
          await creditService.refundDeduction({
            userId: job.userId,
            transactionId: reservationTransactionId,
            description: `Refund for failed ${job.messageType} campaign job ${job.id}`,
          });
          reservationTransactionId = undefined;
        }
        await this.handleDefinitiveFailure(
          job,
          result.error || 'Provider rejected the message',
          result.retryAt,
          result.retryable === true,
        );
        return;
      }

      if (!result.messageId?.trim()) {
        // A nominal success without a provider receipt cannot be counted as
        // sent or safely retried: the provider might already have accepted it.
        throw new Error('Provider returned success without a message receipt');
      }

      if (job.messageType === 'sms') {
        await SentMessageModel.create(
          {
            leadId: job.leadId,
            userId: job.userId,
            leadName: lead.full_name || lead.name || lead.phone,
            channel: 'sms',
            subject: job.subject || null,
            message: job.content,
            sentAt: new Date(),
            status: 'sent',
            deliveryStatus: 'sent',
            messageId: result.messageId || null,
            campaignId: job.campaignId > 0 ? job.campaignId : null,
            sequenceStep: job.stepNumber,
          },
          { skipCreditDeduction: true },
        );
      }

      await this.updateJobSuccess(
        job.id,
        result.messageId || null,
        job.claimToken!,
      );
      await this.updateCampaignCompletion(job.campaignId, job.userId);
      logger.info(
        `[OutreachSenderWorker] Job ${job.id} completed successfully`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const message = error?.message || 'Unexpected outreach worker failure';
      logger.error(
        { err: error, jobId: job.id },
        '[OutreachSenderWorker] Error processing job',
      );
      const setup = deliverySetupFailure(error);
      if (setup && !providerCallStarted) {
        await this.refundUnstarted(job, reservationTransactionId);
        await this.recordAttemptMetadata(job.id, { customerDeliverySetup: setup, manualReviewRequired: true, providerCallStarted: false }, job.claimToken!);
        await this.updateJobStatus(job.id, 'setup_required', setup.error, job.claimToken!);
        await this.updateCampaignCompletion(job.campaignId, job.userId);
        return;
      }

      if (error instanceof OutreachClaimLostError) {
        await this.refundUnstarted(job, reservationTransactionId);
        return;
      }
      if (error instanceof RecipientSuppressedError && !providerCallStarted) {
        await this.refundUnstarted(job, reservationTransactionId);
        await this.updateJobStatus(
          job.id,
          'cancelled',
          error.message,
          job.claimToken!,
        );
        await this.updateCampaignCompletion(job.campaignId, job.userId);
        return;
      }
      if (
        error instanceof CampaignDeliveryReviewError &&
        !providerCallStarted
      ) {
        await this.refundUnstarted(job, reservationTransactionId);
        await this.recordAttemptMetadata(
          job.id,
          {
            manualReviewRequired: true,
            accountReviewRequired: true,
            providerCallStarted: false,
          },
          job.claimToken!,
        );
        await this.updateJobStatus(
          job.id,
          'failed',
          error.message,
          job.claimToken!,
        );
        await this.updateCampaignCompletion(job.campaignId, job.userId);
        return;
      }
      if (providerCallStarted) {
        // Once a provider call begins, an exception can mean the provider
        // accepted the message but our acknowledgement was interrupted. Never
        // auto-retry this state because that can duplicate delivery.
        await this.markUncertain(job.id, message, job.claimToken!);
      } else {
        if (reservationTransactionId) {
          await creditService.refundDeduction({
            userId: job.userId,
            transactionId: reservationTransactionId,
            description: `Refund for interrupted ${job.messageType} campaign job ${job.id}`,
          });
        }
        await this.handleDefinitiveFailure(job, message);
      }
      await this.updateCampaignCompletion(job.campaignId, job.userId);
    }
  }

  /**
   * Fetch lead by ID
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchLead(leadId: number, userId: number): Promise<any> {
    try {
      const result = await db.execute(sql`
        SELECT
          *,
          do_not_contact AS "doNotContact",
          email_unsubscribed AS "emailUnsubscribed"
        FROM leads
        WHERE id = ${leadId} AND user_id = ${userId} AND deleted_at IS NULL
      `);

      return result.rows[0] || null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OutreachSenderWorker] Error fetching lead:', error);
      return null;
    }
  }

  /**
   * Update job status
   */
  private async updateJobStatus(
    jobId: number,
    status: OutreachJob['status'],
    error: string | undefined,
    claimToken: string,
  ): Promise<void> {
    await db.execute(sql`
      UPDATE outreach_jobs
      SET status = ${status},
          error = ${error || null},
          is_dead_letter = ${status === 'failed'},
          updated_at = NOW()
      WHERE id = ${jobId} AND status='processing' AND metadata->>'claimToken'=${claimToken}
    `);
  }

  /** Claim a pending job once, even when several worker processes poll it. */
  private async claimJob(jobId: number, claimToken: string): Promise<boolean> {
    try {
      const result = await db.execute(sql`
        UPDATE outreach_jobs
        SET status = 'processing', updated_at = NOW(),
          metadata=(COALESCE(metadata,'{}'::jsonb)-'reservationTransactionId')||${JSON.stringify({ claimToken, providerCallStarted: false, providerAcknowledged: false, manualReviewRequired: false })}::jsonb
        WHERE id = ${jobId} AND status = 'pending' AND scheduled_for<=NOW() AND attempts<max_attempts
          AND COALESCE(metadata->>'manualReviewRequired','false') <> 'true'
          AND (campaign_id IS NULL OR EXISTS (
            SELECT 1 FROM outreach_campaigns c
            WHERE c.id = outreach_jobs.campaign_id AND c.user_id = outreach_jobs.user_id
              AND c.status IN ('scheduled','running','queued','queued_partial')
          ))
        RETURNING id
      `);
      return result.rows.length > 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OutreachSenderWorker] Error claiming job:', error);
      return false;
    }
  }

  /**
   * Update job on successful send
   */
  private async updateJobSuccess(
    jobId: number,
    messageId: string | null,
    claimToken: string,
  ): Promise<void> {
    await db.execute(sql`
      UPDATE outreach_jobs
      SET status = 'sent',
          sent_at = NOW(),
          external_message_id = ${messageId},
          error = NULL,
          is_dead_letter = false,
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ providerAcknowledged: true })}::jsonb,
          updated_at = NOW()
      WHERE id = ${jobId} AND status='processing' AND metadata->>'claimToken'=${claimToken}
    `);
  }

  private async recordAttemptMetadata(
    jobId: number,
    metadata: Record<string, unknown>,
    claimToken: string,
  ): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE outreach_jobs
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb,
          updated_at = NOW()
      WHERE id = ${jobId} AND status = 'processing' AND metadata->>'claimToken'=${claimToken}
      RETURNING id
    `);
    return result.rows.length === 1;
  }

  private async handleDefinitiveFailure(
    job: OutreachJob,
    error: string,
    providerRetryAt?: string,
    retryable = true,
  ): Promise<void> {
    const nextAttempt = job.retryCount + 1;
    const exhausted = !retryable || nextAttempt >= job.maxRetries;
    const retryAt = new Date(emailRetryTime(job.retryCount, providerRetryAt));

    await db.execute(sql`
      UPDATE outreach_jobs
      SET attempts = attempts + 1,
          last_attempt_at = NOW(),
          status = ${exhausted ? 'failed' : 'pending'},
          scheduled_for = CASE WHEN ${exhausted} THEN scheduled_for ELSE ${retryAt.toISOString()}::timestamp END,
          error = ${error},
          is_dead_letter = ${exhausted},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            providerCallStarted: false,
            providerAcknowledged: false,
            manualReviewRequired: false,
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${job.id} AND status = 'processing' AND metadata->>'claimToken'=${job.claimToken}
    `);

    if (exhausted) {
      logger.info(
        { jobId: job.id, attempts: nextAttempt },
        '[OutreachSenderWorker] Job exhausted its retries',
      );
    } else {
      logger.info(
        { jobId: job.id, nextAttempt: nextAttempt + 1, retryAt },
        '[OutreachSenderWorker] Job scheduled for retry',
      );
    }
    await this.updateCampaignCompletion(job.campaignId, job.userId);
  }

  private async markUncertain(
    jobId: number,
    error: string,
    claimToken: string,
  ): Promise<void> {
    const userMessage = `Delivery outcome is uncertain after the provider call: ${error}. Review provider history before retrying.`;
    await db.execute(sql`
      UPDATE outreach_jobs
      SET status = 'failed',
          attempts = attempts + 1,
          last_attempt_at = NOW(),
          error = ${userMessage},
          is_dead_letter = true,
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            providerCallStarted: true,
            providerAcknowledged: false,
            manualReviewRequired: true,
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${jobId} AND status = 'processing' AND metadata->>'claimToken'=${claimToken}
    `);
  }

  private async refundUnstarted(
    job: OutreachJob,
    transactionId?: number,
  ): Promise<void> {
    if (transactionId)
      await creditService.refundDeduction({
        userId: job.userId,
        transactionId,
        description: `Refund for unstarted campaign job ${job.id}`,
      });
  }

  private async deferJob(
    job: OutreachJob,
    reason: string,
    until?: Date,
  ): Promise<void> {
    await db.execute(sql`UPDATE outreach_jobs SET status='pending',scheduled_for=${until || new Date(Date.now() + 60_000)},
      error=${reason},updated_at=NOW(),metadata=COALESCE(metadata,'{}'::jsonb)-'claimToken'
      WHERE id=${job.id} AND status='processing' AND metadata->>'claimToken'=${job.claimToken}`);
    await this.updateCampaignCompletion(job.campaignId, job.userId);
  }

  private async startProvider(
    job: OutreachJob,
    recipient: string,
  ): Promise<boolean> {
    const receipt = job.deliveryReview?.assistant;
    if (receipt) await assertCustomerDeliveryReady({ userId: job.userId, channel: job.messageType, accountId: receipt.accountId, expected: receipt });
    const started = await withCreationDailyQuota(
      job.userId,
      job.messageType,
      async (tx: typeof db) => {
        // Serialize cancellation against the same campaign row; no cancelled work
        // can acquire permission to start a provider call after this transaction.
        if (job.campaignId > 0) {
          const campaign =
            await tx.execute(sql`SELECT id FROM outreach_campaigns WHERE id=${job.campaignId}
          AND user_id=${job.userId} AND status IN ('scheduled','running','queued','queued_partial') FOR UPDATE`);
          if (!campaign.rows.length) return false;
        }
        await assertRecipientNotSuppressed(
          job.userId,
          job.messageType,
          recipient,
          tx,
        );
        const result = await tx.execute(sql`UPDATE outreach_jobs SET
        metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('providerCallStarted',true,'providerStartedAt',NOW()),updated_at=NOW()
        WHERE id=${job.id} AND status='processing' AND metadata->>'claimToken'=${job.claimToken}
          AND metadata->>'providerCallStarted'='false' RETURNING id`);
        return result.rows.length === 1;
      },
    );
    if (started === null)
      await this.deferJob(
        job,
        'Daily outreach allowance reached.',
        new Date(new Date().setUTCHours(24, 0, 0, 0)),
      );
    return started === true;
  }

  private async updateCampaignCompletion(
    campaignId: number,
    userId: number,
  ): Promise<void> {
    if (!campaignId || campaignId <= 0) return;
    try {
      await reconcileOutreachJobCampaign(campaignId, userId);
    } catch (error) {
      logger.error(
        { err: error, campaignId },
        '[OutreachSenderWorker] Unable to update campaign completion',
      );
    }
  }

  /**
   * Verify the migrated jobs table is available before polling.
   */
  private async ensureJobsTable(): Promise<void> {
    try {
      await db.execute(sql`SELECT 1 FROM outreach_jobs LIMIT 1`);
      logger.info('[OutreachSenderWorker] Migrated jobs table ready');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error(
        '[OutreachSenderWorker] Outreach jobs migration is missing:',
        error,
      );
      throw error;
    }
  }

  /**
   * Enqueue a new outreach job
   */
  async enqueueJob(
    job: Omit<
      OutreachJob,
      'id' | 'status' | 'retryCount' | 'createdAt' | 'updatedAt'
    >,
    executor: Pick<typeof db, 'execute'> = db,
  ): Promise<number> {
    try {
      const assistantReceipt = job.deliveryReview?.assistant;
      if (!assistantReceipt) {
        const { CustomerDeliverySetupError } = await import('../services/assistants/CustomerDeliveryGate.js');
        throw new CustomerDeliverySetupError('queued_setup_review_required', 'Review the exact account assistant before queueing campaign delivery.');
      }
      await assertCustomerDeliveryReady({ userId: job.userId, channel: job.messageType,
        accountId: job.messageType === 'email' ? job.deliveryReview?.fromEmail || '' : job.deliveryReview?.providerAccountId || '', expected: assistantReceipt });
      if (
        !job.deliveryReview ||
        job.deliveryReview.contentHash !==
          campaignMessageHash(
            job.messageType,
            job.deliveryReview.recipient,
            job.subject,
            job.content,
          )
      )
        throw new CampaignDeliveryReviewError(
          'Campaign messages require reviewed sending account, recipients, and content.',
        );
      const leadResult = await executor.execute(sql`
        SELECT email, phone
        FROM leads
        WHERE id = ${job.leadId}
          AND user_id = ${job.userId}
          AND deleted_at IS NULL
        LIMIT 1
      `);
      if (leadResult.rows.length === 0) {
        throw new Error(`Lead ${job.leadId} was not found for this user`);
      }
      const lead = leadResult.rows[0] as {
        email?: string | null;
        phone?: string | null;
      };

      const result = await executor.execute(sql`
        INSERT INTO outreach_jobs (
          user_id,
          campaign_id,
          lead_id,
          sequence_step_id,
          channel,
          recipient_email,
          recipient_phone,
          scheduled_for,
          subject,
          message_body,
          max_attempts,
          metadata
        ) VALUES (
          ${job.userId},
          ${job.campaignId > 0 ? job.campaignId : null},
          ${job.leadId},
          ${job.sequenceStepKey || job.stepNumber},
          ${job.messageType},
          ${job.messageType === 'email' ? job.deliveryReview?.recipient || lead.email || null : null},
          ${job.messageType === 'sms' ? job.deliveryReview?.recipient || lead.phone || null : null},
          ${job.scheduledFor.toISOString()},
          ${job.subject || null},
          ${job.content},
          ${job.maxRetries},
          ${JSON.stringify({ sequenceId: job.sequenceId, deliveryReview: job.deliveryReview })}::jsonb
        )
        ON CONFLICT (campaign_id, lead_id, sequence_step_id)
          WHERE campaign_id IS NOT NULL
          DO NOTHING
        RETURNING id
      `);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let jobId = (result.rows[0] as any)?.id as number | undefined;
      if (!jobId && job.campaignId > 0) {
        const existing = await executor.execute(sql`
          SELECT id FROM outreach_jobs
          WHERE campaign_id = ${job.campaignId}
            AND lead_id = ${job.leadId}
            AND sequence_step_id = ${job.sequenceStepKey || job.stepNumber}
          LIMIT 1
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jobId = (existing.rows[0] as any)?.id;
      }
      if (!jobId) throw new Error('Unable to persist outreach job');
      logger.info(
        `[OutreachSenderWorker] Enqueued job ${jobId} for lead ${job.leadId}`,
      );

      return jobId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OutreachSenderWorker] Error enqueuing job:', error);
      throw error;
    }
  }

  /**
   * Cancel all jobs for a campaign
   */
  async cancelCampaignJobs(
    campaignId: number,
    userId: number,
  ): Promise<number> {
    const cancelled = await db.transaction(async (tx: typeof db) => {
      const campaign = await tx.execute(
        sql`SELECT id,status FROM outreach_campaigns WHERE id=${campaignId} AND user_id=${userId} FOR UPDATE`,
      );
      if (!campaign.rows.length) throw new Error('Campaign not found');
      if (campaign.rows[0].status === 'completed')
        throw new Error('Campaign is already completed');
      await tx.execute(sql`UPDATE outreach_campaigns SET status='cancelled',is_active=false,completed_at=COALESCE(completed_at,NOW()),updated_at=NOW()
        WHERE id=${campaignId} AND user_id=${userId}`);
      const result =
        await tx.execute(sql`UPDATE outreach_jobs SET status='cancelled',error='Campaign cancelled by user',updated_at=NOW(),
        metadata=COALESCE(metadata,'{}'::jsonb)-'claimToken'
        WHERE campaign_id=${campaignId} AND user_id=${userId} AND (status='pending'
          OR (status='processing' AND metadata->>'providerCallStarted'='false')) RETURNING id`);
      return result.rows.length;
    });
    await this.updateCampaignCompletion(campaignId, userId);
    return cancelled;
  }

  /** Retrying failures never implicitly resumes a paused or cancelled campaign. */
  async retryFailedCampaignJobs(
    campaignId: number,
    userId: number,
  ): Promise<number> {
    const retried = await db.transaction(async (tx: typeof db) => {
      const campaign =
        await tx.execute(sql`SELECT id FROM outreach_campaigns WHERE id=${campaignId} AND user_id=${userId}
        AND status IN ('failed','partial_success','needs_attention') AND COALESCE(settings->>'accountReviewRequired','false')<>'true' FOR UPDATE`);
      if (!campaign.rows.length) return 0;
      const result =
        await tx.execute(sql`UPDATE outreach_jobs SET status='pending',attempts=0,scheduled_for=NOW(),error=NULL,is_dead_letter=false,
        metadata=(COALESCE(metadata,'{}'::jsonb)-'claimToken')||' {"providerCallStarted":false,"providerAcknowledged":false}'::jsonb,updated_at=NOW()
        WHERE campaign_id=${campaignId} AND user_id=${userId} AND status='failed'
          AND metadata->>'providerCallStarted'='false'
          AND COALESCE(metadata->>'manualReviewRequired','false')<>'true' RETURNING id`);
      if (result.rows.length)
        await tx.execute(sql`UPDATE outreach_campaigns SET status='scheduled',is_active=true,completed_at=NULL,updated_at=NOW()
        WHERE id=${campaignId} AND user_id=${userId}`);
      return result.rows.length;
    });
    await this.updateCampaignCompletion(campaignId, userId);
    return retried;
  }

  /**
   * Get job statistics
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getJobStats(userId: number, campaignId?: number): Promise<any> {
    try {
      const campaignFilter = campaignId
        ? sql`AND campaign_id = ${campaignId}`
        : sql``;

      const result = await db.execute(sql`
        SELECT 
          status,
          channel,
          COUNT(*) as count
        FROM outreach_jobs
        WHERE user_id = ${userId}
        ${campaignFilter}
        GROUP BY status, channel
      `);

      return result.rows;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OutreachSenderWorker] Error fetching stats:', error);
      return [];
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const outreachSenderWorker = new OutreachSenderWorker();
import { forEachBusiness } from '../tenancy/businessScopeResolver.js';
