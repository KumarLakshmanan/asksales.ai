import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook',
  instagram_comment: 'Instagram comment', facebook_comment: 'Facebook comment',
  email: 'Email', gmail: 'Email', web: 'Web chat', webchat: 'Web chat', support_chat: 'Support chat',
};

/** Persist only a known channel label, never customer text or a contact field. */
export async function resolveSupportNotificationSource(tx: typeof db, userId: number, ticketId: number): Promise<string | null> {
  const result = await tx.execute(sql`
    SELECT conversation.channel AS conversation_channel, handoff.channel AS handoff_channel
    FROM support_tickets ticket
    LEFT JOIN outreach_conversations conversation
      ON conversation.id = ticket.outreach_conversation_id AND conversation.user_id = ticket.user_id
    LEFT JOIN LATERAL (
      SELECT queue.channel FROM handoff_queue queue
      WHERE queue.support_ticket_id = ticket.id AND queue.user_id = ticket.user_id
      ORDER BY queue.created_at DESC, queue.id DESC LIMIT 1
    ) handoff ON TRUE
    WHERE ticket.id = ${ticketId} AND ticket.user_id = ${userId} AND ticket.deleted_at IS NULL
    LIMIT 1
  `);
  const row = result.rows[0] as { conversation_channel?: unknown; handoff_channel?: unknown } | undefined;
  for (const channel of [row?.conversation_channel, row?.handoff_channel]) {
    if (typeof channel === 'string' && Object.hasOwn(CHANNEL_LABELS, channel.toLowerCase())) {
      return CHANNEL_LABELS[channel.toLowerCase()];
    }
  }
  return null;
}
