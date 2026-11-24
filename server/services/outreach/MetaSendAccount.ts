import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

/** Resolve a conversation's durable identity before acquiring any provider token. */
export async function resolveMetaSendAccount(
  userId: number,
  channel: 'facebook' | 'instagram',
  options: { conversationId?: number; providerAccountId?: string },
): Promise<string> {
  let accountId = options.providerAccountId;
  if (options.conversationId) {
    const result = await db.execute(sql`
      SELECT provider_account_id FROM outreach_conversations
      WHERE id = ${options.conversationId} AND user_id = ${userId} AND channel = ${channel}
      LIMIT 1
    `);
    const bound = String(result.rows[0]?.provider_account_id || '');
    if (!bound) throw new Error('This conversation has no unambiguous provider account.');
    if (accountId && accountId !== bound) throw new Error('The sending account does not match this conversation.');
    accountId = bound;
  }
  const accounts = await db.execute(sql`
    SELECT account_identifier FROM channel_credentials
    WHERE user_id = ${userId} AND platform = ${`${channel}_api`} AND is_active = TRUE
      AND account_identifier IS NOT NULL
      ${accountId ? sql`AND account_identifier = ${accountId}` : sql``}
    LIMIT 2
  `);
  if (accounts.rows.length !== 1) throw new Error(accountId
    ? 'The account bound to this conversation is no longer available. Reconnect the same account.'
    : 'Choose an explicit connected sending account.');
  return String(accounts.rows[0].account_identifier);
}
