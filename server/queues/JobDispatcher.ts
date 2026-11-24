/**
 * Job Dispatcher — Enqueues tool calls to BullMQ instead of executing inline
 *
 * Replaces direct tool execution in the request cycle with queue-based dispatch.
 * The actual execution happens in worker processes (server/workers/).
 *
 * Requires Redis + BullMQ. No fallback — Redis is mandatory.
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { queueRegistry, QUEUE_NAMES, type QueueName, type BaseJobPayload } from '../queues/index.js';
import { logger } from '../utils/logger.js';

// ─── Dispatch Result ────────────────────────────────────────────────────────────

export interface DispatchResult {
  jobId: string;
  queue: QueueName;
  status: 'queued';
  correlationId: string;
}

// ─── Tool-to-Queue Mapping ──────────────────────────────────────────────────────

const TOOL_QUEUE_MAP: Record<string, QueueName> = {
  // Media processors
  generate_image: QUEUE_NAMES.IMAGE_GENERATION,
  generate_video: QUEUE_NAMES.VIDEO_GENERATION,

  // Generic actor execution
  run_apify_actor: QUEUE_NAMES.WEB_SCRAPING,

  // Direct delivery processors
  send_email: QUEUE_NAMES.EMAIL_SENDING,
  send_sms: QUEUE_NAMES.SMS_SENDING,

  // Enrichment processor
  deep_enrich_lead: QUEUE_NAMES.LEAD_ENRICHMENT,

  // Outreach and inbound-message processors
  start_outreach_campaign: QUEUE_NAMES.OUTREACH,
  process_whatsapp_webhook: QUEUE_NAMES.OUTREACH,
  process_instagram_webhook: QUEUE_NAMES.OUTREACH,
  process_facebook_webhook: QUEUE_NAMES.OUTREACH,
  process_social_comment_webhook: QUEUE_NAMES.OUTREACH,
  process_instagram_automation: QUEUE_NAMES.OUTREACH,
  process_support_widget_turn: QUEUE_NAMES.OUTREACH,
  send_outreach_message: QUEUE_NAMES.OUTREACH,

  // Embedding processor
  generate_embeddings: QUEUE_NAMES.EMBEDDING,
};

// ─── Tool-to-Payload Schemas (Phase 3.10 / QUEUE-005) ──────────────────────────
// Each tool has a Zod schema that validates the payload *before* the job is
// enqueued. This catches malformed dispatcher calls at the API edge instead of
// in the worker (where the cost of debugging is higher).
//
// Schemas are intentionally permissive (z.unknown() for rarely-used fields) but
// require userId and a sensible identifier so we can route logs / metrics.

const basePayloadSchema = z.object({
  userId: z.number().int().positive(),
  threadId: z.number().int().positive().optional(),
  correlationId: z.string().optional(),
}).passthrough();

const toolSchemas: Record<string, z.ZodTypeAny> = {
  process_instagram_automation: basePayloadSchema.extend({ runId: z.number().int().positive() }),
  process_social_comment_webhook: basePayloadSchema.extend({ conversationId: z.number().int().positive(), data: z.object({ channel: z.enum(['instagram','facebook']), messageId: z.string().min(1) }).passthrough() }),
  process_support_widget_turn: basePayloadSchema.extend({
    sessionId: z.number().int().positive(),
    widgetMessageId: z.number().int().positive(),
    inboundText: z.string().max(100_000),
  }),
  // Image
  generate_image: basePayloadSchema.extend({ prompt: z.string().min(1).max(10000) }),

  // Video
  generate_video: basePayloadSchema.extend({ prompt: z.string().min(1).max(10000) }),

  // Scraping
  run_apify_actor: basePayloadSchema.extend({ actorId: z.string().min(1).max(255) }),

  // Email
  send_email: basePayloadSchema.extend({
    to: z.string().email(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(500_000),
  }),

  // SMS
  send_sms: basePayloadSchema.extend({
    to: z.string().min(5).max(20),
    message: z.string().min(1).max(5_000),
  }),

  // Enrichment
  deep_enrich_lead: basePayloadSchema.extend({
    enrichmentRunId: z.number().int().positive().optional(),
    leadId: z.number().int().positive(),
    enrichmentType: z.literal('deep_enrichment'),
  }),

  // Outreach
  start_outreach_campaign: basePayloadSchema.extend({
    leadId: z.number().int().positive(),
    channel: z.enum(['whatsapp', 'instagram', 'facebook', 'linkedin', 'twitter']),
    message: z.string().min(1).max(20_000),
    campaignId: z.number().int().positive().optional(),
    sequenceId: z.number().int().positive().optional(),
    sequenceExecutionId: z.number().int().positive().optional(),
    providerAccountId: z.string().min(1).max(255).optional(),
    providerCredentialId: z.number().int().positive().optional(),
  }),
  process_whatsapp_webhook: basePayloadSchema.extend({
    conversationId: z.number().int().positive(),
    inboundText: z.string().min(1).max(100_000),
    messageId: z.string().min(1).max(500),
    inboundMessageId: z.number().int().positive().optional(),
    voiceReplyRequested: z.boolean().optional(),
    privacyPreprotected: z.object({
      vaultId: z.number().int().positive().nullable(),
      piiTypes: z.array(z.string().max(40)).max(20),
      tokenCount: z.number().int().min(0).max(10_000),
    }).optional(),
  }),
  process_instagram_webhook: basePayloadSchema.extend({
    conversationId: z.number().int().positive(),
    inboundText: z.string().min(1).max(100_000),
    messageId: z.string().min(1).max(500),
    inboundMessageId: z.number().int().positive().optional(),
    providerAccountId: z.string().min(1).max(255).optional(),
    voiceReplyRequested: z.boolean().optional(),
    privacyPreprotected: z.object({
      vaultId: z.number().int().positive().nullable(),
      piiTypes: z.array(z.string().max(40)).max(20),
      tokenCount: z.number().int().min(0).max(10_000),
    }).optional(),
  }),
  process_facebook_webhook: basePayloadSchema.extend({
    conversationId: z.number().int().positive(),
    inboundText: z.string().min(1).max(100_000),
    messageId: z.string().min(1).max(500),
    inboundMessageId: z.number().int().positive().optional(),
    voiceReplyRequested: z.boolean().optional(),
    privacyPreprotected: z.object({
      vaultId: z.number().int().positive().nullable(),
      piiTypes: z.array(z.string().max(40)).max(20),
      tokenCount: z.number().int().min(0).max(10_000),
    }).optional(),
  }),
  send_outreach_message: basePayloadSchema.extend({ messageId: z.number().int().positive() }),

  // Embedding
  generate_embeddings: basePayloadSchema,
};

// ─── Job Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Phase 6.10 / TYPE-001: a structural alias for a tool's payload. We keep
 * the per-tool field shape open (each tool's `toolSchemas` entry is the
 * source of truth for runtime validation) but the name documents intent
 * at call sites — `payload: ToolPayload` reads as "any tool-validated
 * JSON object" instead of `payload: any`.
 */
export type ToolPayload = Record<string, unknown>;

class JobDispatcher {
  /**
   * Initialize the dispatcher — sets up queue registry
   */
  async initialize(): Promise<void> {
    await queueRegistry.initialize();
    logger.info('[JobDispatcher] Queue-based dispatch enabled');
  }

  /**
   * Dispatch a tool call to the appropriate queue
   */
  async dispatch(
    toolName: string,
    payload: Omit<BaseJobPayload, 'createdAt' | 'correlationId'> & ToolPayload,
    options?: { priority?: number; delay?: number; jobId?: string }
  ): Promise<DispatchResult> {
    const queueName = TOOL_QUEUE_MAP[toolName];
    if (!queueName) {
      throw new Error(
        `Tool "${toolName}" has no registered queue processor. Execute it through its canonical service instead.`,
      );
    }

    // Validate against the processor-specific schema before enqueue.
    const schema = toolSchemas[toolName];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      logger.error(
        { toolName, errors: parsed.error.flatten() },
        '[JobDispatcher] Rejecting dispatch — payload failed toolSchema validation'
      );
      throw new Error(`Invalid payload for tool "${toolName}": ${parsed.error.message}`);
    }

    if (['process_whatsapp_webhook', 'process_instagram_webhook', 'process_facebook_webhook', 'process_support_widget_turn'].includes(toolName)) {
      const { registerSupportTurnInput } = await import('../services/agents/orchestration/SupportConversationTurn.js');
      await registerSupportTurnInput(toolName, payload);
    }
    const correlationId = uuidv4();

    const jobPayload: BaseJobPayload & ToolPayload = {
      ...payload,
      correlationId,
      createdAt: new Date().toISOString(),
    };

    // Provider retries reuse the durable inbound identity. Database message
    // deduplication alone still allowed two queue jobs to run the AI in
    // parallel for that same message. BullMQ atomically reuses this job ID
    // while queued, active, retrying, or retained after completion.
    const inboundJobId = ['process_whatsapp_webhook', 'process_instagram_webhook', 'process_facebook_webhook'].includes(toolName)
      ? `inbound-${createHash('sha256').update(JSON.stringify([
        toolName, payload.userId, payload.conversationId,
        payload.phoneNumberId || payload.providerAccountId || '',
        payload.inboundMessageId || payload.messageId,
      ])).digest('hex')}` : undefined;
    const jobId = await queueRegistry.addJob(queueName, toolName, jobPayload, {
      priority: options?.priority,
      delay: options?.delay,
      jobId: options?.jobId ?? inboundJobId,
    });

    return {
      jobId,
      queue: queueName,
      status: 'queued',
      correlationId,
    };
  }

  /**
   * Schedule a repeatable job (replaces CronService setInterval)
   */
  async scheduleRepeating(
    queueName: QueueName,
    jobName: string,
    data: ToolPayload,
    intervalMs: number
  ): Promise<void> {
    await queueRegistry.addRepeatableJob(queueName, jobName, data, intervalMs);
  }

  /**
   * Get queue metrics for the dashboard
   */
  async getMetrics() {
    const metrics = await queueRegistry.getAllQueueMetrics();
    return { mode: 'queued', queues: metrics };
  }

  /**
   * Check if queue-based dispatch is active (always true — Redis is required)
   */
  isQueueEnabled(): boolean {
    return true;
  }
}

// Singleton
export const jobDispatcher = new JobDispatcher();
