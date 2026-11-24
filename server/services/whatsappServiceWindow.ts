import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';

/**
 * WhatsApp's 24-hour service window belongs to the phone-number account that
 * received the customer's last message. A reply on another connected number
 * must not authorize a free-form send from this one.
 */
export async function hasActiveWhatsAppWindow(
  userId: number,
  leadId: number,
  providerAccountId: string,
): Promise<boolean> {
  if (!providerAccountId.trim()) return false;

  const result = await db.execute(sql`
    SELECT 1
    FROM outreach_messages inbound
    JOIN outreach_conversations conversation ON conversation.id = inbound.conversation_id
    WHERE conversation.user_id = ${userId}
      AND conversation.lead_id = ${leadId}
      AND conversation.channel = 'whatsapp'
      AND (
        conversation.provider_account_id = ${providerAccountId}
        OR (conversation.provider_account_id IS NULL AND inbound.phone_number_id = ${providerAccountId})
      )
      AND inbound.direction = 'inbound'
      AND COALESCE(inbound.phone_number_id, inbound.provider_account_id) = ${providerAccountId}
      AND COALESCE(inbound.sent_at, inbound.created_at) >= NOW() - INTERVAL '24 hours'
    LIMIT 1
  `);
  return (result.rowCount ?? 0) > 0;
}

/** Composer list read: evaluate a whole page in one account-scoped query. */
export async function activeWhatsAppWindows(userId: number, leadIds: number[], providerAccountId: string): Promise<Set<number>> {
  if (!providerAccountId.trim() || !leadIds.length) return new Set();
  const ids = [...new Set(leadIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Set();
  const result = await db.execute(sql`
    SELECT DISTINCT conversation.lead_id
    FROM outreach_messages inbound
    JOIN outreach_conversations conversation ON conversation.id = inbound.conversation_id
    WHERE conversation.user_id = ${userId}
      AND conversation.lead_id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})
      AND conversation.channel = 'whatsapp'
      AND (conversation.provider_account_id = ${providerAccountId}
        OR (conversation.provider_account_id IS NULL AND inbound.phone_number_id = ${providerAccountId}))
      AND inbound.direction = 'inbound'
      AND COALESCE(inbound.phone_number_id, inbound.provider_account_id) = ${providerAccountId}
      AND COALESCE(inbound.sent_at, inbound.created_at) >= NOW() - INTERVAL '24 hours'
  `);
  return new Set(result.rows.map((row: { lead_id: unknown }) => Number(row.lead_id)));
}
