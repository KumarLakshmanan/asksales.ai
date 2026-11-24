import { sql } from 'drizzle-orm';
import { db } from '../models/db';

export interface EmailFollowUpPeriod {
  id: string | number;
  delayDays?: number;
  delayHours?: number;
  delayMinutes?: number;
  enabled?: boolean;
  templateId?: number | null;
  templateName?: string;
}

export interface EmailFollowUpOriginState {
  direction: string;
  messageKind: string;
  followUpOriginMessageId: number | null;
  followUpCancelledAt: Date | null;
  hasReply: boolean;
}

export function isEmailFollowUpOriginEligible(state: EmailFollowUpOriginState): boolean {
  return (
    state.direction === 'outbound'
    && state.messageKind === 'outreach'
    && state.followUpOriginMessageId === null
    && state.followUpCancelledAt === null
    && !state.hasReply
  );
}

export function getConfiguredDelayMinutes(step: EmailFollowUpPeriod): number {
  return (
    Math.max(0, Number(step.delayDays) || 0) * 24 * 60
    + Math.max(0, Number(step.delayHours) || 0) * 60
    + Math.max(0, Number(step.delayMinutes) || 0)
  );
}

/**
 * Configured periods are absolute offsets from the original outreach send.
 * They are not delays from the previous worker execution time.
 */
export function getEmailFollowUpDueAt(
  originalSentAt: Date,
  step: EmailFollowUpPeriod,
): Date {
  return new Date(originalSentAt.getTime() + getConfiguredDelayMinutes(step) * 60_000);
}

export function emailFollowUpJobId(originMessageId: number, step: number): string {
  return `email-follow-up-${originMessageId}-${step}`;
}

interface ReserveEmailFollowUpInput {
  originMessageId: number;
  userId: number;
  expectedCurrentStep: number;
  step: number;
  subject: string;
  content: string;
  htmlContent: string;
  dispatch?: import('./outreach/ConfiguredFollowUpDispatchService.js').ConfiguredFollowUpDispatch;
}

/**
 * Atomically advances the original and creates the one durable delivery row
 * allowed for this origin/step. The partial unique index is the final race
 * barrier if two schedulers reach this statement concurrently.
 */
export async function reserveEmailFollowUp(
  input: ReserveEmailFollowUpInput,
): Promise<number | null> {
  const result = await db.execute(sql`
    WITH claimed_origin AS (
      UPDATE outreach_messages origin
      SET follow_up_step = ${input.step},
          updated_at = NOW()
      WHERE origin.id = ${input.originMessageId}
        AND origin.user_id = ${input.userId}
        AND origin.direction = 'outbound'
        AND origin.message_kind = 'outreach'
        AND origin.follow_up_origin_message_id IS NULL
        AND origin.follow_up_cancelled_at IS NULL
        AND COALESCE(origin.follow_up_step, 0) = ${input.expectedCurrentStep}
        AND NOT EXISTS (
          SELECT 1
          FROM outreach_messages reply
          WHERE reply.conversation_id = origin.conversation_id
            AND reply.direction = 'inbound'
            AND reply.created_at > COALESCE(origin.sent_at, origin.created_at)
        )
      RETURNING origin.conversation_id, origin.campaign_id
    )
    INSERT INTO outreach_messages (
      conversation_id,
      user_id,
      direction,
      subject,
      content,
      html_content,
      status,
      campaign_id,
      is_automatic,
      sequence_step,
      message_kind,
      follow_up_origin_message_id,
      follow_up_step,
      metadata,
      created_at,
      updated_at
    )
    SELECT
      claimed_origin.conversation_id,
      ${input.userId},
      'outbound',
      ${input.subject},
      ${input.content},
      ${input.htmlContent},
      'queued',
      claimed_origin.campaign_id,
      true,
      ${input.step},
      'follow_up',
      ${input.originMessageId},
      ${input.step},
      ${JSON.stringify(input.dispatch ? { configuredFollowUpDispatch: input.dispatch } : {})}::jsonb,
      NOW(),
      NOW()
    FROM claimed_origin
    ON CONFLICT (follow_up_origin_message_id, follow_up_step)
      WHERE message_kind = 'follow_up'
        AND follow_up_origin_message_id IS NOT NULL
        AND follow_up_step IS NOT NULL
    DO NOTHING
    RETURNING id
  `);
  const row = result.rows[0] as { id?: number } | undefined;
  return row?.id ? Number(row.id) : null;
}

export async function cancelConversationEmailFollowUps(
  conversationId: number,
  receivedAt = new Date(),
): Promise<void> {
  await db.execute(sql`
    UPDATE outreach_messages
    SET follow_up_cancelled_at = COALESCE(follow_up_cancelled_at, ${receivedAt}),
        updated_at = NOW()
    WHERE conversation_id = ${conversationId}
      AND direction = 'outbound'
      AND message_kind = 'outreach'
      AND follow_up_origin_message_id IS NULL
      AND follow_up_cancelled_at IS NULL
  `);

  await db.execute(sql`
    UPDATE outreach_messages follow_up
    SET status = 'cancelled',
        updated_at = NOW()
    FROM outreach_messages origin
    WHERE follow_up.follow_up_origin_message_id = origin.id
      AND origin.conversation_id = ${conversationId}
      AND follow_up.message_kind = 'follow_up'
      AND follow_up.status IN ('queued','pending')
  `);

  await db.execute(sql`
    UPDATE followup_sequences
    SET completed = true,
        replied_at = COALESCE(replied_at, ${receivedAt}),
        updated_at = NOW()
    WHERE conversation_id = ${conversationId}
      AND completed = false
  `);
}

/** Call after all preparation awaits, immediately before the Email provider.
 * This does not grant permission to retry an uncertain provider call. */
export async function confirmEmailFollowUpDelivery(followUpMessageId: number, userId: number): Promise<boolean> {
  const result = await db.execute(sql`UPDATE outreach_messages delivery SET updated_at=NOW()
    FROM outreach_messages origin,outreach_conversations conversation
    WHERE delivery.id=${followUpMessageId} AND delivery.user_id=${userId} AND delivery.status='sending'
      AND delivery.message_kind='follow_up' AND origin.id=delivery.follow_up_origin_message_id AND origin.user_id=${userId}
      AND origin.follow_up_cancelled_at IS NULL AND conversation.id=origin.conversation_id AND conversation.user_id=${userId}
      AND conversation.session_ended_at IS NULL
      AND COALESCE(conversation.automation_mode,'ai_active') NOT IN ('human_owned','approval_pending','resolved','closed','opted_out')
      AND NOT EXISTS(SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id=conversation.id
        AND reply.direction='inbound' AND reply.created_at>COALESCE(origin.sent_at,origin.created_at))
    RETURNING delivery.id`);
  return result.rows.length === 1;
}
