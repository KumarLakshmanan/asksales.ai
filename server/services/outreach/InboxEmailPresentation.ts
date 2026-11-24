import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { logger } from '../../utils/logger.js';
import { privacyVaultService, redactSensitiveInboxEmailText } from '../agents/orchestration/PrivacyVaultService.js';

/** Only an authenticated business owner can request this human-only projection.
 * Resolve the exact persisted message rather than inferring token values from
 * a contact profile (quoted email can belong to a different person). */
export async function inboxEmailDisplayText(
  userId: number, actorUserId: number | undefined, conversationId: number, messageId: number | undefined,
): Promise<string | null> {
  const scope = currentBusinessScope();
  if (!actorUserId || actorUserId !== userId || !messageId
    || (scope && (scope.userId !== userId || (scope.actorUserId ?? scope.userId) !== actorUserId))) return null;
  try {
    const result = await db.execute(sql`
      SELECT v.id FROM outreach_messages m
      JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
      JOIN support_privacy_vault v ON v.id=m.privacy_vault_id AND v.user_id=m.user_id
        AND v.conversation_id=m.conversation_id AND v.message_id=m.id
      WHERE c.user_id=${userId} AND c.id=${conversationId} AND m.id=${messageId}
        AND c.channel IN ('email','gmail') AND m.direction='inbound'
      LIMIT 1
    `);
    const vault = result.rows[0] as { id: number } | undefined;
    if (!vault) return null;
    const retained = await privacyVaultService.reveal(userId, vault.id, {
      conversationId, messageId, actor: `user:${actorUserId}`, purpose: 'outreach_inbox_email_contact_display',
    });
    return retained ? redactSensitiveInboxEmailText(retained.rawText, { userId, conversationId }) : null;
  } catch {
    logger.warn({ userId, conversationId, messageId }, '[OutreachInbox] Retained email display unavailable');
    return null;
  }
}
