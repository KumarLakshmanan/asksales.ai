/**
 * When a customer disconnects WhatsApp, take our Meta credit line off the WABAs
 * they no longer use, so Meta stops billing their messages to us. A WABA still
 * connected in another of the owner's businesses keeps the credit line.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { decryptChannelCredentialSession } from '../../utils/channelCredentialSecrets.js';
import { withSystemScope } from '../../tenancy/businessContext.js';

/** WhatsApp Business Account IDs on the owner's active WhatsApp Cloud API credentials (in the caller's scope). */
export async function activeWhatsAppWabaIds(executor: typeof db, userId: number): Promise<string[]> {
  const result = await executor.execute(sql`
    SELECT session_data FROM channel_credentials WHERE user_id = ${userId} AND platform = 'whatsapp' AND is_active = true`);
  const rows = ((result as { rows?: Array<{ session_data: unknown }> }).rows ?? []) as Array<{ session_data: unknown }>;
  return rows.map(row => {
    try {
      const session = decryptChannelCredentialSession((row.session_data || {}) as Record<string, unknown>) as Record<string, unknown>;
      return String(session.businessAccountId || session.wabaId || '').trim();
    } catch { return ''; }
  }).filter(Boolean);
}

/** Call after the disconnect has committed. Never throws. */
export async function revokeWhatsAppCreditLinesAfterDisconnect(userId: number, wabaIds: string[]): Promise<void> {
  const ids = [...new Set(wabaIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return;
  try {
    const stillUsed = new Set(await withSystemScope('WhatsApp credit line revoke check', () => activeWhatsAppWabaIds(db, userId)));
    const released = ids.filter(id => !stillUsed.has(id));
    if (!released.length) return;
    const { revokeCreditLinesForUser } = await import('./WhatsAppCreditLine.js');
    await withSystemScope('WhatsApp credit line revoke', () => revokeCreditLinesForUser(userId, released));
  } catch (error) {
    logger.error({ err: error, userId }, '[WhatsAppCreditLine] Revoke after disconnect failed');
  }
}
