import type { FollowUpProvenance } from '../../../shared/followUpProvenance.js';
import type { TemplateRenderContext } from '../../../shared/templateRenderContext.js';
import {
  assertConfiguredFollowUpReady,
  ConfiguredFollowUpStoppedError,
} from './ConfiguredFollowUpDispatchService.js';
import { confirmEmailFollowUpDelivery } from '../emailFollowUpService.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import * as messages from '../../models/outreachConversations/functions.js';
import { getDefault } from '../../models/emailSenders/functions.js';
import { businessCacheKey } from '../../tenancy/businessContext.js';
import { followUpSettingsRevision } from '../../utils/followUpSettingsRevision.js';
import { resolveCreationAccount } from './CreationService.js';
import {
  assertRecipientNotSuppressed,
  RecipientSuppressedError,
} from './RecipientSuppressionService.js';
import { withCreationDailyQuota } from './QuotaService.js';

export interface QueuedEmailInput {
  jobId: string;
  userId: number;
  leadId: number;
  to: string;
  subject?: string;
  body?: string;
  html?: string;
  senderId?: number;
  campaignId?: number;
  isFollowUp?: boolean;
  followUpMessageId?: number;
  followUpOriginMessageId?: number;
  followUpStep?: number;
  followUpProvenance?: FollowUpProvenance;
  templateRenderContext?: TemplateRenderContext;
}
interface Account {
  senderId: number;
  providerAccountId: string;
  credentialId: number;
  fromEmail: string;
}
export interface EmailQueueClaim {
  messageId: number;
  token: string;
  account: Account;
  recoveredReservationId?: number;
}
export class EmailQueuePolicyError extends Error {}

function inputHash(input: QueuedEmailInput): string {
  return followUpSettingsRevision({
    leadId: input.leadId,
    to: input.to.trim().toLowerCase(),
    subject: input.subject || '',
    body: input.body || '',
    html: input.html || '',
    requestedSenderId: input.senderId,
    campaignId: input.campaignId,
    isFollowUp: input.isFollowUp === true,
    originId: input.followUpOriginMessageId,
    step: input.followUpStep,
    followUpProvenance: input.followUpProvenance,
    templateRenderContext: input.templateRenderContext,
  });
}

export async function claimQueuedEmail(input: QueuedEmailInput): Promise<{
  claim?: EmailQueueClaim;
  success?: boolean;
  inProgress?: boolean;
  uncertain?: boolean;
}> {
  if (
    !input.jobId ||
    !Number.isSafeInteger(input.userId) ||
    input.userId <= 0 ||
    !Number.isSafeInteger(input.leadId) ||
    input.leadId <= 0
  ) {
    throw new EmailQueuePolicyError(
      'Queued email requires a persisted owner, contact and stable job ID.',
    );
  }
  const key = businessCacheKey(
    input.isFollowUp
      ? `email-follow-up:${input.followUpMessageId}`
      : `email-queue:${input.jobId}`,
  );
  const hash = inputHash(input);
  let message = input.isFollowUp
    ? await messages.getOutreachMessageById(Number(input.followUpMessageId))
    : await messages.getOutreachMessageByIdempotencyKey(input.userId, key);
  if (message && message.userId !== input.userId)
    throw new EmailQueuePolicyError('Queued email is unavailable.');
  const saved = (
    message?.metadata as {
      queueEmail?: { hash: string; account: Account };
    } | null
  )?.queueEmail;
  if (saved && saved.hash !== hash)
    throw new EmailQueuePolicyError(
      'Queued email changed after its delivery intent was saved.',
    );
  if (message && ['sent', 'delivered', 'read'].includes(message.status))
    return { success: true };
  if (message?.manualReviewRequired || message?.providerCallState === 'unknown')
    return { uncertain: true };
  if (message?.providerCallState === 'started') {
    const stale =
      await db.execute(sql`UPDATE outreach_messages SET status='manual_review',provider_call_state='unknown',manual_review_required=true,updated_at=NOW()
      WHERE id=${message.id} AND status='sending' AND provider_call_state='started' AND send_claimed_at<NOW()-INTERVAL '15 minutes' RETURNING id`);
    return stale.rows.length ? { uncertain: true } : { inProgress: true };
  }
  let account = saved?.account;
  if (!account) {
    let senderId = input.senderId;
    if (input.isFollowUp) {
      if (
        !message ||
        message.followUpOriginMessageId !== input.followUpOriginMessageId ||
        message.messageKind !== 'follow_up'
      )
        throw new EmailQueuePolicyError('The queued follow-up origin changed.');
      const { getConfiguredFollowUpDeliveryBinding } =
        await import('./ConfiguredFollowUpDeliveryService.js');
      const original = await getConfiguredFollowUpDeliveryBinding(
        input.userId,
        'email',
        Number(input.followUpOriginMessageId),
        input.leadId,
        input.to,
      );
      senderId = original.senderId;
    } else if (!senderId) senderId = (await getDefault(input.userId))?.id;
    if (!senderId)
      throw new EmailQueuePolicyError(
        'Choose an exact verified email sender before queueing.',
      );
    const resolved = await resolveCreationAccount(input.userId, 'email', {
      senderId,
    });
    if (
      !resolved.account.ready ||
      !resolved.account.providerAccountId ||
      !resolved.binding?.credentialId
    )
      throw new EmailQueuePolicyError(
        'The queued email account is unavailable.',
      );
    account = {
      senderId,
      providerAccountId: resolved.account.providerAccountId,
      credentialId: resolved.binding.credentialId,
      fromEmail: resolved.account.label,
    };
  }
  if (!message) {
    const conversation = await messages.createOutreachConversation({
      userId: input.userId,
      leadId: input.leadId,
      channel: 'email',
      leadEmail: input.to,
      providerAccountId: account.providerAccountId,
      subject: input.subject,
      status: 'active',
    });
    message = await messages.createOutreachMessage({
      userId: input.userId,
      conversationId: conversation.id,
      direction: 'outbound',
      content: input.body || '',
      subject: input.subject,
      htmlContent: input.html,
      status: 'pending',
      idempotencyKey: key,
      providerAccountId: account.providerAccountId,
      campaignId: input.campaignId,
      messageKind: 'outreach',
      metadata: { queueEmail: { hash, account } },
    });
  }
  const persisted = (
    message.metadata as {
      queueEmail?: { hash: string; account: Account };
    } | null
  )?.queueEmail;
  if (persisted && persisted.hash !== hash)
    throw new EmailQueuePolicyError(
      'Queued email changed after its delivery intent was saved.',
    );
  account = persisted?.account || account;
  const token = randomUUID();
  const claimed = await db.execute(sql`WITH previous AS (
    SELECT * FROM outreach_messages WHERE id=${message.id} AND user_id=${input.userId} FOR UPDATE
  ) UPDATE outreach_messages m SET status='sending',provider_call_state='not_started',send_claimed_at=NOW(),
    metadata=COALESCE(m.metadata,'{}'::jsonb)||jsonb_build_object('queueEmail',${JSON.stringify({ hash, account, token })}::jsonb),updated_at=NOW()
    FROM previous WHERE m.id=previous.id AND m.direction='outbound' AND COALESCE(m.manual_review_required,false)=false
      AND (previous.metadata->'queueEmail'->>'hash' IS NULL OR previous.metadata->'queueEmail'->>'hash'=${hash})
      AND (previous.status IN ('pending','queued') OR (previous.status='sending' AND previous.provider_call_state='not_started'
        AND previous.send_claimed_at<NOW()-INTERVAL '15 minutes'))
    RETURNING m.id,previous.metadata->'queueEmail'->>'reservationId' AS reservation_id`);
  if (!claimed.rows.length) return { inProgress: true };
  return {
    claim: {
      messageId: message.id,
      token,
      account,
      recoveredReservationId:
        Number(claimed.rows[0].reservation_id) || undefined,
    },
  };
}

export async function recordQueuedEmailReservation(
  claim: EmailQueueClaim,
  reservationId?: number,
): Promise<boolean> {
  const result =
    await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{queueEmail,reservationId}',${JSON.stringify(reservationId || null)}::jsonb),updated_at=NOW()
    WHERE id=${claim.messageId} AND status='sending' AND provider_call_state='not_started'
      AND metadata->'queueEmail'->>'token'=${claim.token} RETURNING id`);
  return result.rows.length === 1;
}

export async function startQueuedEmailProvider(
  input: QueuedEmailInput,
  claim: EmailQueueClaim,
): Promise<boolean | null> {
  return withCreationDailyQuota(
    input.userId,
    'email',
    async (tx: typeof db) => {
      try {
        await assertRecipientNotSuppressed(input.userId, 'email', input.to, tx);
      } catch (error) {
        if (error instanceof RecipientSuppressedError)
          throw new EmailQueuePolicyError(error.message);
        throw error;
      }
      const result =
        await tx.execute(sql`UPDATE outreach_messages SET provider_call_state='started',updated_at=NOW()
      WHERE id=${claim.messageId} AND user_id=${input.userId} AND status='sending' AND provider_call_state='not_started'
        AND metadata->'queueEmail'->>'token'=${claim.token} RETURNING id`);
      return result.rows.length === 1;
    },
  );
}

/** Run the producer's real provenance preflight after preparation, before the
 * token-fenced provider-start transition. Infrastructure failures must propagate. */
export async function assertQueuedEmailFollowUpReady(
  input: QueuedEmailInput,
): Promise<void> {
  if (!input.isFollowUp) return;
  try {
    await assertConfiguredFollowUpReady(
      input.userId,
      'email',
      input.followUpProvenance,
      {
        originMessageId: Number(input.followUpOriginMessageId),
        step: Number(input.followUpStep),
      },
    );
  } catch (error) {
    if (error instanceof ConfiguredFollowUpStoppedError)
      throw new EmailQueuePolicyError(error.message);
    throw error;
  }
}

/** The shared confirmation only checks late origin/reply/takeover state. It
 * preserves our already-started reservation and token; it never claims a lease. */
export async function confirmQueuedEmailFollowUp(
  input: QueuedEmailInput,
): Promise<void> {
  if (!input.isFollowUp) return;
  if (
    !(await confirmEmailFollowUpDelivery(
      Number(input.followUpMessageId),
      input.userId,
    ))
  )
    throw new EmailQueuePolicyError(
      'Follow-up cancelled after preparation because reply, cancellation or ownership state changed.',
    );
}

export async function finishQueuedEmail(
  claim: EmailQueueClaim,
  status: 'sent' | 'pending' | 'failed' | 'manual_review' | 'cancelled' | 'setup_required',
  receipt?: {
    messageId?: string;
    providerMessageId?: string;
    rfcMessageId?: string;
  },
  error?: string,
): Promise<boolean> {
  const result =
    await db.execute(sql`UPDATE outreach_messages SET status=${status},
    provider_call_state=${status === 'sent' ? 'confirmed' : status === 'manual_review' ? 'unknown' : 'not_started'},manual_review_required=${status === 'manual_review'},
    external_message_id=COALESCE(${receipt?.messageId || null},external_message_id),provider_message_id=COALESCE(${receipt?.providerMessageId || null},provider_message_id),
    rfc_message_id=COALESCE(${receipt?.rfcMessageId || null},rfc_message_id),error_message=${error || null},
    sent_at=CASE WHEN ${status === 'sent'} THEN COALESCE(sent_at,NOW()) ELSE sent_at END,updated_at=NOW()
    WHERE id=${claim.messageId} AND status IN ('sending','manual_review') AND metadata->'queueEmail'->>'token'=${claim.token} RETURNING id`);
  return result.rows.length === 1;
}
