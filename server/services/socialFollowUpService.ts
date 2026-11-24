import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import type { EmailFollowUpPeriod } from './emailFollowUpService.js';

export const SOCIAL_FOLLOW_UP_CHANNELS = ['instagram', 'facebook', 'whatsapp'] as const;
export type SocialFollowUpChannel = typeof SOCIAL_FOLLOW_UP_CHANNELS[number];

export type SocialFollowUpStep = EmailFollowUpPeriod;

export function isSocialFollowUpChannel(channel: string): channel is SocialFollowUpChannel {
  return SOCIAL_FOLLOW_UP_CHANNELS.includes(channel as SocialFollowUpChannel);
}

export function socialFollowUpDelayMinutes(step: SocialFollowUpStep): number {
  return (
    Math.max(0, Number(step.delayDays) || 0) * 1440
    + Math.max(0, Number(step.delayHours) || 0) * 60
    + Math.max(0, Number(step.delayMinutes) || 0)
  );
}

export function socialFollowUpDueAt(anchorSentAt: Date, step: SocialFollowUpStep): Date {
  return new Date(anchorSentAt.getTime() + socialFollowUpDelayMinutes(step) * 60_000);
}

// Raw Drizzle queries return TIMESTAMP WITHOUT TIME ZONE as a string. These
// columns contain UTC values, so a host-local parse would shift the schedule.
export function parseUtcDatabaseTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  const timestamp = String(value).trim().replace(' ', 'T');
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`);
}

export function socialFollowUpJobId(
  scheduleId: number,
  anchorMessageId: number,
  step: number,
): string {
  return `social-follow-up-${scheduleId}-${anchorMessageId}-${step}`;
}

function normalizeSteps(value: unknown): SocialFollowUpStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((step): step is SocialFollowUpStep => Boolean(step) && typeof step === 'object')
    .filter((step) => step.enabled !== false && socialFollowUpDelayMinutes(step) > 0)
    .sort((a, b) => socialFollowUpDelayMinutes(a) - socialFollowUpDelayMinutes(b));
}

export async function activateSocialFollowUpForAnchor(messageId: number): Promise<boolean> {
  const {assistantsRuntimeEnabled}=await import('./assistants/AssistantContext.js');
  if (assistantsRuntimeEnabled()) {
    const anchor=await db.execute(sql`SELECT message_kind FROM outreach_messages WHERE id=${messageId}`);
    if (anchor.rows[0]?.message_kind === 'reply') return (await import('./assistants/AssistantFollowUps.js')).scheduleAssistantFollowUp(messageId);
  }
  const result = await db.execute(sql`
    SELECT
      message.id,
      message.user_id,
      message.conversation_id,
      COALESCE(message.sent_at, message.created_at) AS sent_at,
      conversation.channel,
      conversation.automation_mode,
      settings.enable_auto_follow_up,
      settings.channel_follow_ups->conversation.channel AS channel_settings
    FROM outreach_messages message
    JOIN outreach_conversations conversation ON conversation.id = message.conversation_id
    LEFT JOIN outreach_settings settings ON settings.user_id = conversation.user_id
    WHERE message.id = ${messageId}
      AND message.direction = 'outbound'
      AND message.status IN ('sent', 'delivered', 'read')
      AND message.message_kind IN ('outreach', 'reply')
      AND message.follow_up_origin_message_id IS NULL
      AND COALESCE(message.metadata->'outreachCreation'->>'followUpSource','') NOT IN ('campaign_manual', 'outreach')
      AND message.metadata->'outreachCreation'->'campaignManual' IS NULL
      AND conversation.session_ended_at IS NULL
      AND conversation.channel IN ('instagram', 'facebook', 'whatsapp')
    LIMIT 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return false;

  const channelSettings = row.channel_settings as Record<string, unknown> | null;
  const steps = normalizeSteps(channelSettings?.followUps);
  const enabled = row.enable_auto_follow_up === true && channelSettings?.enabled === true;
  const automationMode = String(row.automation_mode || 'ai_active');

  const automationPaused = ['human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out'].includes(automationMode);
  if (!enabled || steps.length === 0 || automationPaused) {
    await cancelSocialFollowUpsForConversation(
      Number(row.conversation_id),
      automationPaused
        ? 'human_takeover'
        : 'configuration_disabled',
    );
    return false;
  }

  const anchorSentAt = parseUtcDatabaseTimestamp(row.sent_at);
  const nextRunAt = socialFollowUpDueAt(anchorSentAt, steps[0]);
  await db.execute(sql`
    INSERT INTO social_follow_up_schedules (
      conversation_id, user_id, channel, anchor_message_id, steps,
      next_step, next_run_at, status, delivery_message_id,
      cancelled_at, cancellation_reason, version, created_at, updated_at
    ) VALUES (
      ${Number(row.conversation_id)}, ${Number(row.user_id)}, ${String(row.channel)},
      ${messageId}, ${JSON.stringify(steps)}::jsonb,
      1, ${nextRunAt}, 'active', NULL,
      NULL, NULL, 1, NOW(), NOW()
    )
    ON CONFLICT (conversation_id)
    DO UPDATE SET
      anchor_message_id = EXCLUDED.anchor_message_id,
      steps = EXCLUDED.steps,
      next_step = 1,
      next_run_at = EXCLUDED.next_run_at,
      status = 'active',
      delivery_message_id = NULL,
      cancelled_at = NULL,
      cancellation_reason = NULL,
      version = social_follow_up_schedules.version + 1,
      updated_at = NOW()
    WHERE EXCLUDED.anchor_message_id <> social_follow_up_schedules.anchor_message_id AND (
      SELECT candidate.created_at
      FROM outreach_messages candidate
      WHERE candidate.id = EXCLUDED.anchor_message_id
    ) >= (
      SELECT current_anchor.created_at
      FROM outreach_messages current_anchor
      WHERE current_anchor.id = social_follow_up_schedules.anchor_message_id
    )
  `);
  return true;
}

export async function cancelSocialFollowUpsForConversation(
  conversationId: number,
  reason: 'reply_received' | 'human_takeover' | 'configuration_disabled' | 'delivery_uncertain',
): Promise<void> {
  await (await import('./assistants/AssistantFollowUps.js')).cancelAssistantFollowUps(conversationId,reason);
  await db.execute(sql`
    UPDATE social_follow_up_schedules
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, NOW()),
        cancellation_reason = ${reason},
        version = version + 1,
        updated_at = NOW()
    WHERE conversation_id = ${conversationId}
      AND status IN ('active', 'queued', 'sending')
  `);
  await db.execute(sql`
    UPDATE outreach_messages follow_up
    SET status = 'cancelled',
        updated_at = NOW()
    FROM social_follow_up_schedules schedule
    WHERE schedule.conversation_id = ${conversationId}
      AND follow_up.id = schedule.delivery_message_id
      AND follow_up.message_kind = 'follow_up'
      AND follow_up.status IN ('queued', 'sending')
  `);
}

export interface DueSocialFollowUp {
  scheduleId: number;
  scheduleVersion: number;
  anchorMessageId: number;
  conversationId: number;
  leadId: number;
  nextStep: number;
  step: SocialFollowUpStep;
  originalMessage: string;
  originalSubject: string;
  isSupportReply: boolean;
}

export async function getDueSocialFollowUps(
  userId: number,
  channel: SocialFollowUpChannel,
): Promise<DueSocialFollowUp[]> {
  const result = await db.execute(sql`
    SELECT
      schedule.id,
      schedule.version,
      schedule.anchor_message_id,
      schedule.conversation_id,
      schedule.next_step,
      schedule.steps,
      conversation.lead_id,
      anchor.content,
      anchor.message_kind,
      anchor.subject
    FROM social_follow_up_schedules schedule
    JOIN outreach_conversations conversation ON conversation.id = schedule.conversation_id
    JOIN outreach_messages anchor ON anchor.id = schedule.anchor_message_id
    WHERE schedule.user_id = ${userId}
      AND schedule.channel = ${channel}
      AND conversation.user_id = schedule.user_id
      AND conversation.channel = schedule.channel
      AND schedule.status = 'active'
      AND schedule.next_run_at <= NOW()
      AND conversation.automation_mode NOT IN ('human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out')
      AND anchor.message_kind IN ('outreach', 'reply')
      AND anchor.direction = 'outbound'
      AND NOT EXISTS (
        SELECT 1
        FROM outreach_messages reply
        WHERE reply.conversation_id = schedule.conversation_id
          AND reply.direction = 'inbound'
          AND reply.created_at > COALESCE(anchor.sent_at, anchor.created_at)
      )
    ORDER BY schedule.next_run_at, schedule.id
  `);

  return result.rows.flatMap((value: unknown) => {
    const row = value as Record<string, unknown>;
    const steps = normalizeSteps(row.steps);
    const nextStep = Number(row.next_step);
    const step = steps[nextStep - 1];
    if (!step) return [];
    return [{
      scheduleId: Number(row.id),
      scheduleVersion: Number(row.version),
      anchorMessageId: Number(row.anchor_message_id),
      conversationId: Number(row.conversation_id),
      leadId: Number(row.lead_id),
      nextStep,
      step,
      originalMessage: String(row.content || ''),
      originalSubject: String(row.subject || ''),
      isSupportReply: row.message_kind === 'reply',
    }];
  });
}

interface ReserveSocialFollowUpInput {
  scheduleId: number;
  scheduleVersion: number;
  anchorMessageId: number;
  userId: number;
  step: number;
  content: string;
  dispatch?: import('./outreach/ConfiguredFollowUpDispatchService.js').ConfiguredFollowUpDispatch;
}

export async function reserveSocialFollowUp(
  input: ReserveSocialFollowUpInput,
): Promise<number | null> {
  const result = await db.execute(sql`
    WITH eligible_schedule AS (
      SELECT schedule.conversation_id, schedule.channel
      FROM social_follow_up_schedules schedule
      JOIN outreach_conversations conversation ON conversation.id = schedule.conversation_id
      JOIN outreach_messages anchor ON anchor.id = schedule.anchor_message_id
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_id = ${input.userId}
        AND schedule.version = ${input.scheduleVersion}
        AND schedule.status = 'active'
        AND schedule.next_step = ${input.step}
        AND schedule.anchor_message_id = ${input.anchorMessageId}
        AND schedule.next_run_at <= NOW()
        AND conversation.user_id = schedule.user_id
        AND conversation.channel = schedule.channel
        AND conversation.automation_mode NOT IN ('human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out')
        AND anchor.message_kind IN ('outreach', 'reply')
        AND NOT EXISTS (
          SELECT 1 FROM outreach_messages reply
          WHERE reply.conversation_id = schedule.conversation_id
            AND reply.direction = 'inbound'
            AND reply.created_at > COALESCE(anchor.sent_at, anchor.created_at)
        )
    ),
    inserted_message AS (
      INSERT INTO outreach_messages (
        conversation_id, user_id, direction, content, status,
        is_automatic, sequence_step, message_kind,
        follow_up_origin_message_id, follow_up_step, metadata, created_at, updated_at
      )
      SELECT
        eligible_schedule.conversation_id, ${input.userId}, 'outbound', ${input.content}, 'queued',
        true, ${input.step}, 'follow_up',
        ${input.anchorMessageId}, ${input.step}, ${JSON.stringify(input.dispatch ? { configuredFollowUpDispatch: input.dispatch } : {})}::jsonb, NOW(), NOW()
      FROM eligible_schedule
      ON CONFLICT (follow_up_origin_message_id, follow_up_step)
        WHERE message_kind = 'follow_up'
          AND follow_up_origin_message_id IS NOT NULL
          AND follow_up_step IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    UPDATE social_follow_up_schedules schedule
    SET status = 'queued',
        delivery_message_id = inserted_message.id,
        version = version + 1,
        updated_at = NOW()
    FROM inserted_message, outreach_conversations conversation, outreach_messages anchor
    WHERE schedule.id = ${input.scheduleId}
      AND schedule.user_id = ${input.userId}
      AND schedule.version = ${input.scheduleVersion}
      AND schedule.status = 'active'
      AND schedule.next_step = ${input.step}
      AND schedule.anchor_message_id = ${input.anchorMessageId}
      AND schedule.next_run_at <= NOW()
      AND conversation.id = schedule.conversation_id
      AND conversation.user_id = schedule.user_id
      AND conversation.channel = schedule.channel
      AND conversation.automation_mode NOT IN ('human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out')
      AND anchor.id = schedule.anchor_message_id
      AND anchor.message_kind IN ('outreach', 'reply')
      AND NOT EXISTS (
        SELECT 1 FROM outreach_messages reply
        WHERE reply.conversation_id = schedule.conversation_id
          AND reply.direction = 'inbound'
          AND reply.created_at > COALESCE(anchor.sent_at, anchor.created_at)
      )
    RETURNING inserted_message.id
  `);
  const row = result.rows[0] as { id?: number } | undefined;
  return row?.id ? Number(row.id) : null;
}

export async function claimSocialFollowUpDelivery(
  scheduleId: number,
  followUpMessageId: number,
  userId: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH claimed AS (
      UPDATE social_follow_up_schedules schedule
      SET status = 'sending',
          version = version + 1,
          updated_at = NOW()
      FROM outreach_conversations conversation, outreach_messages anchor
      WHERE schedule.id = ${scheduleId}
        AND schedule.user_id = ${userId}
        AND schedule.status = 'queued'
        AND schedule.delivery_message_id = ${followUpMessageId}
        AND conversation.id = schedule.conversation_id
        AND conversation.user_id = schedule.user_id
        AND conversation.channel = schedule.channel
        AND conversation.automation_mode NOT IN ('human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out')
        AND anchor.id = schedule.anchor_message_id
        AND anchor.message_kind IN ('outreach', 'reply')
        AND NOT EXISTS (
          SELECT 1 FROM outreach_messages reply
          WHERE reply.conversation_id = schedule.conversation_id
            AND reply.direction = 'inbound'
            AND reply.created_at > COALESCE(anchor.sent_at, anchor.created_at)
        )
      RETURNING schedule.id
    )
    UPDATE outreach_messages message
    SET status = 'sending',
        updated_at = NOW()
    FROM claimed
    WHERE message.id = ${followUpMessageId}
      AND message.status = 'queued'
      AND message.message_kind = 'follow_up'
    RETURNING message.id
  `);
  if (result.rows.length === 1) return true;
  await db.execute(sql`
    UPDATE social_follow_up_schedules
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, NOW()),
        cancellation_reason = 'reply_or_handoff',
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${scheduleId}
      AND status = 'queued'
  `);
  return false;
}

/**
 * Final compare-and-set immediately before the provider service boundary.
 * This closes the preparation window between the worker claim and delivery.
 */
export async function confirmSocialFollowUpDelivery(
  scheduleId: number,
  followUpMessageId: number,
  userId: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE social_follow_up_schedules schedule
    SET updated_at = NOW()
    FROM outreach_conversations conversation, outreach_messages anchor, outreach_messages delivery
    WHERE schedule.id = ${scheduleId}
      AND schedule.user_id = ${userId}
      AND schedule.status = 'sending'
      AND schedule.delivery_message_id = ${followUpMessageId}
      AND conversation.id = schedule.conversation_id
      AND conversation.user_id = schedule.user_id
      AND conversation.channel = schedule.channel
      AND conversation.automation_mode NOT IN ('human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out')
      AND anchor.id = schedule.anchor_message_id
      AND anchor.message_kind IN ('outreach', 'reply')
      AND delivery.id = schedule.delivery_message_id
      AND delivery.status = 'sending'
      AND delivery.message_kind = 'follow_up'
      AND NOT EXISTS (
        SELECT 1 FROM outreach_messages reply
        WHERE reply.conversation_id = schedule.conversation_id
          AND reply.direction = 'inbound'
          AND reply.created_at > COALESCE(anchor.sent_at, anchor.created_at)
      )
    RETURNING schedule.id
  `);
  if (result.rows.length === 1) return true;

  await db.execute(sql`
    UPDATE social_follow_up_schedules
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, NOW()),
        cancellation_reason = 'reply_or_handoff',
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${scheduleId}
      AND status = 'sending'
      AND delivery_message_id = ${followUpMessageId}
  `);
  await db.execute(sql`
    UPDATE outreach_messages
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE id = ${followUpMessageId}
      AND status = 'sending'
      AND message_kind = 'follow_up'
  `);
  return false;
}

export async function completeSocialFollowUpDelivery(
  scheduleId: number,
  followUpMessageId: number,
  externalMessageId?: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE outreach_messages message
    SET status = 'sent',
        sent_at = COALESCE(message.sent_at, NOW()),
        external_message_id = COALESCE(${externalMessageId || null}, message.external_message_id),
        provider_message_id = COALESCE(${externalMessageId || null}, message.provider_message_id),
        waba_message_id = CASE WHEN conversation.channel = 'whatsapp'
          THEN COALESCE(${externalMessageId || null}, message.waba_message_id) ELSE message.waba_message_id END,
        phone_number_id = CASE WHEN conversation.channel = 'whatsapp'
          THEN COALESCE(conversation.provider_account_id, message.phone_number_id) ELSE message.phone_number_id END,
        provider_account_id = COALESCE(conversation.provider_account_id, message.provider_account_id),
        updated_at = NOW()
    FROM outreach_conversations conversation
    WHERE message.id = ${followUpMessageId}
      AND conversation.id = message.conversation_id
      AND message.message_kind = 'follow_up'
  `);

  const scheduleResult = await db.execute(sql`
    SELECT schedule.steps, schedule.next_step, anchor.sent_at, anchor.created_at
    FROM social_follow_up_schedules schedule
    JOIN outreach_messages anchor ON anchor.id = schedule.anchor_message_id
    WHERE schedule.id = ${scheduleId}
      AND schedule.status = 'sending'
      AND schedule.delivery_message_id = ${followUpMessageId}
    LIMIT 1
  `);
  const row = scheduleResult.rows[0] as Record<string, unknown> | undefined;
  if (!row) return;
  const steps = normalizeSteps(row.steps);
  const completedStep = Number(row.next_step);
  const nextStep = completedStep + 1;
  const next = steps[nextStep - 1];
  const anchorSentAt = parseUtcDatabaseTimestamp(row.sent_at || row.created_at);

  if (next) {
    await db.execute(sql`
      UPDATE social_follow_up_schedules
      SET status = 'active',
          next_step = ${nextStep},
          next_run_at = ${socialFollowUpDueAt(anchorSentAt, next)},
          delivery_message_id = NULL,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${scheduleId}
        AND status = 'sending'
        AND delivery_message_id = ${followUpMessageId}
    `);
  } else {
    await db.execute(sql`
      WITH completed AS (
      UPDATE social_follow_up_schedules
      SET status = 'completed',
          delivery_message_id = NULL,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${scheduleId}
        AND status = 'sending'
        AND delivery_message_id = ${followUpMessageId}
      RETURNING conversation_id, anchor_message_id
      )
      UPDATE outreach_conversations conversation
      SET status = 'closed', automation_mode = 'closed', session_ended_at = NOW(),
          metadata = COALESCE(conversation.metadata, '{}'::jsonb)
            || jsonb_build_object('sessionCompletionReason', 'follow_ups_completed'),
          updated_at = NOW()
      FROM completed
      JOIN outreach_messages anchor ON anchor.id = completed.anchor_message_id
      WHERE conversation.id = completed.conversation_id
        AND conversation.session_ended_at IS NULL
        AND conversation.automation_mode = 'ai_active'
        AND NOT EXISTS (
          SELECT 1 FROM outreach_messages inbound
          WHERE inbound.conversation_id = conversation.id AND inbound.direction = 'inbound'
            AND inbound.created_at > COALESCE(anchor.sent_at, anchor.created_at)
        )
    `);
  }
}

export async function releaseSocialFollowUpDelivery(
  scheduleId: number,
  followUpMessageId: number,
): Promise<void> {
  await db.execute(sql`
    WITH released AS (
      UPDATE social_follow_up_schedules
      SET status = 'queued',
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${scheduleId}
        AND status = 'sending'
        AND delivery_message_id = ${followUpMessageId}
      RETURNING delivery_message_id
    )
    UPDATE outreach_messages message
    SET status = 'queued',
        updated_at = NOW()
    FROM released
    WHERE message.id = released.delivery_message_id
      AND message.status = 'sending'
      AND message.message_kind = 'follow_up'
  `);
}

export async function failSocialFollowUpDelivery(
  scheduleId: number,
  followUpMessageId: number,
  reason: 'delivery_failed' | 'delivery_uncertain' | 'account_unavailable' | 'template_required',
): Promise<void> {
  await db.execute(sql`
    UPDATE outreach_messages
    SET status = 'failed',
        failed_at = COALESCE(failed_at, NOW()),
        error_message = CASE
          WHEN ${reason} = 'delivery_uncertain'
            THEN 'Delivery outcome is uncertain. Review provider history before retrying.'
          WHEN ${reason} = 'account_unavailable'
            THEN 'The provider account bound to this conversation is unavailable. Reconnect that same account, then create a new follow-up.'
          WHEN ${reason} = 'template_required'
            THEN 'WhatsApp follow-ups require an approved template after the 24-hour reply window. This scheduled message was cancelled; start a new template message to continue.'
          ELSE 'Provider rejected the social follow-up after all retry attempts.'
        END,
        updated_at = NOW()
    WHERE id = ${followUpMessageId}
      AND status IN ('queued', 'sending')
      AND message_kind = 'follow_up'
  `);
  await db.execute(sql`
    UPDATE social_follow_up_schedules
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, NOW()),
        cancellation_reason = ${reason},
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${scheduleId}
      AND status IN ('queued', 'sending')
      AND delivery_message_id = ${followUpMessageId}
  `);
}

export async function abandonSocialFollowUpReservation(
  scheduleId: number,
  followUpMessageId: number,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM outreach_messages
    WHERE id = ${followUpMessageId}
      AND status = 'queued'
      AND message_kind = 'follow_up'
  `);
  await db.execute(sql`
    UPDATE social_follow_up_schedules
    SET status = 'active',
        delivery_message_id = NULL,
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${scheduleId}
      AND status = 'queued'
      AND delivery_message_id = ${followUpMessageId}
  `);
}
