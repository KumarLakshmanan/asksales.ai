import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';

/** A watch receipt is not a receipt for processing the mailbox's messages. */
export async function persistGmailWatch(
  userId: number,
  credentialId: number,
  expiration: string | null | undefined,
  historyId: string | null | undefined,
): Promise<void> {
  if (!Number.isSafeInteger(credentialId) || credentialId <= 0
    || !expiration || !/^\d+$/.test(expiration)
    || !historyId || !/^\d+$/.test(historyId)) {
    throw new Error('Gmail returned an incomplete watch receipt');
  }

  const result = await db.execute(sql`
    UPDATE channel_credentials
    SET session_data = (
      COALESCE(session_data, '{}'::jsonb) || jsonb_build_object(
        'watchExpiration', ${expiration}::text,
        'lastHistoryId', CASE
          WHEN session_data->>'lastHistoryId' ~ '^[0-9]+$'
            THEN session_data->>'lastHistoryId'
          ELSE ${historyId}::text
        END
      )
    ) - 'watchRenewalStatus' - 'watchRenewalRetryAfter' - 'watchRenewalError',
    updated_at = NOW()
    WHERE id = ${credentialId} AND user_id = ${userId}
      AND platform = 'gmail_api' AND is_active IS TRUE
    RETURNING id
  `);
  if (result.rows.length !== 1) throw new Error('The Gmail account is no longer active');
}

/** Initial watch failures need durable retry metadata even without an expiration.
 * This does not restart explicitly stopped watches. */
export async function persistGmailWatchFailure(userId: number, credentialId: number): Promise<void> {
  await db.execute(sql`UPDATE channel_credentials SET session_data=COALESCE(session_data,'{}'::jsonb)
    || jsonb_build_object('watchRenewalStatus','failed','watchRenewalRetryAfter',NOW()+INTERVAL '6 hours','watchRenewalError','GMAIL_WATCH_RENEWAL_FAILED'),updated_at=NOW()
    WHERE id=${credentialId} AND user_id=${userId} AND platform='gmail_api' AND is_active IS TRUE`);
}
