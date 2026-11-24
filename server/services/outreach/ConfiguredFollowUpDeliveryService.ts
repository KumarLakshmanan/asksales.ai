import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

/** Reuse the account and recipient reviewed for the original outreach. */
export async function getConfiguredFollowUpDeliveryBinding(
  userId: number,
  channel: 'email' | 'sms',
  originId: number,
  leadId: number,
  recipient: string,
): Promise<{ providerAccountId: string; senderId?: number }> {
  const result = await db.execute(channel === 'email' ? sql`
    SELECT origin.metadata, origin.provider_account_id, origin.follow_up_cancelled_at,
      conversation.automation_mode, conversation.session_ended_at,
      EXISTS (SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id = conversation.id
        AND reply.direction = 'inbound' AND reply.created_at > COALESCE(origin.sent_at, origin.created_at)) AS has_reply
    FROM outreach_messages origin
    JOIN outreach_conversations conversation ON conversation.id = origin.conversation_id
    WHERE origin.id = ${originId} AND origin.user_id = ${userId}
      AND conversation.user_id = ${userId} AND conversation.lead_id = ${leadId}
      AND conversation.channel IN ('email', 'gmail') AND origin.message_kind = 'outreach'
      AND origin.direction = 'outbound'
  ` : sql`
    SELECT origin.metadata, origin.provider_account_id, origin.follow_up_cancelled_at,
      conversation.automation_mode, conversation.session_ended_at,
      EXISTS (SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id = conversation.id
        AND reply.direction = 'inbound' AND reply.created_at > COALESCE(origin.sent_at, origin.created_at)) AS has_reply
    FROM sent_messages receipt
    JOIN outreach_messages origin ON origin.user_id = receipt.user_id
      AND receipt.message_id IN (origin.provider_message_id, origin.external_message_id)
    JOIN outreach_conversations conversation ON conversation.id = origin.conversation_id
      AND conversation.user_id = receipt.user_id AND conversation.lead_id = receipt.lead_id
      AND conversation.channel = 'sms'
    WHERE receipt.id = ${originId} AND receipt.user_id = ${userId} AND receipt.lead_id = ${leadId}
      AND receipt.channel = 'sms' AND origin.message_kind = 'outreach' AND origin.direction = 'outbound'
  `);
  if (result.rows.length !== 1) throw new Error('The original follow-up message is unavailable.');
  const row = result.rows[0] as {
    provider_account_id?: string;
    follow_up_cancelled_at?: unknown;
    automation_mode?: string;
    session_ended_at?: unknown;
    has_reply?: boolean;
    metadata?: { outreachCreation?: { version?: number; followUpSource?: string; delivery?: Record<string, unknown> } };
  };
  if (row.follow_up_cancelled_at || row.has_reply || row.session_ended_at
    || ['human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out'].includes(row.automation_mode || '')) {
    throw new Error('Follow-up stopped because the contact replied or conversation automation is paused.');
  }
  const creation = row.metadata?.outreachCreation;
  const delivery = creation?.delivery;
  const originalRecipient = channel === 'email' ? delivery?.recipientEmail : delivery?.phone;
  const senderId = Number(delivery?.senderId);
  if (creation?.version !== 1 || creation.followUpSource !== 'channel_settings'
    || delivery?.channel !== channel || Number(delivery.leadId) !== leadId
    || !row.provider_account_id || !originalRecipient || originalRecipient !== recipient
    || (channel === 'email' && (!Number.isSafeInteger(senderId) || senderId <= 0))) {
    throw new Error('The follow-up account or recipient no longer matches the original outreach.');
  }
  return { providerAccountId: row.provider_account_id, ...(channel === 'email' ? { senderId } : {}) };
}
