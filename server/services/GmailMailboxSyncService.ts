import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { queueRegistry, QUEUE_NAMES } from '../queues/index.js';
import { logger } from '../utils/logger.js';
import { GmailCooldownError, guardGmailClient } from './GmailCooldownService.js';
import { google } from 'googleapis';

export interface GmailMailboxBinding {
  userId: number;
  credentialId: number;
  emailAddress: string;
}
export interface GmailSyncCredential {
  id: number;
  user_id: number;
  business_profile_id: number;
  account_identifier: string;
  session_data: { lastHistoryId?: string } | string | null;
  gmail_sync_history_id: string;
  gmail_sync_failures: number;
}

/** Manual refresh uses the same account-bound, cursor-based path as Pub/Sub. */
export async function requestGmailMailboxSync(userId: number): Promise<number> {
  const credentials = await db.execute(sql`SELECT id,account_identifier FROM channel_credentials
    WHERE user_id=${userId} AND platform='gmail_api' AND is_active IS TRUE`);
  const { getGmailClientForUser } = await import('../controllers/gmailOAuthController.js');
  let queued = 0;
  for (const row of credentials.rows as Array<{ id: number; account_identifier: string }>) {
    const binding = { credentialId: row.id, accountIdentifier: row.account_identifier.trim().toLowerCase() };
    const authorized = await getGmailClientForUser(userId, binding);
    if (!authorized) continue;
    const gmail = guardGmailClient(google.gmail({ version: 'v1', auth: authorized.client, retry: false, timeout: 30_000 }), { userId, credentialId: row.id, emailAddress: binding.accountIdentifier });
    const { data } = await gmail.users.getProfile({ userId: 'me' });
    if (String(data.emailAddress || '').trim().toLowerCase() !== binding.accountIdentifier || !/^\d+$/.test(String(data.historyId || ''))) {
      throw new Error('The connected Gmail mailbox identity could not be verified.');
    }
    await queueGmailNotification({ userId, credentialId: row.id, emailAddress: binding.accountIdentifier }, String(data.historyId));
    queued += 1;
  }
  return queued;
}

/** PostgreSQL is the durable inbox. Redis only wakes a worker. */
export async function queueGmailNotification(binding: GmailMailboxBinding, historyId: string): Promise<void> {
  const saved = await db.execute(sql`UPDATE channel_credentials
    SET gmail_sync_history_id=GREATEST(COALESCE(gmail_sync_history_id,0),${historyId}::numeric),
        gmail_sync_due_at=COALESCE(gmail_sync_due_at,NOW()), updated_at=NOW()
    WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND platform='gmail_api' AND is_active IS TRUE
      AND LOWER(TRIM(account_identifier))=${binding.emailAddress}
      AND (CASE WHEN session_data->>'lastHistoryId' ~ '^[0-9]+$'
        THEN (session_data->>'lastHistoryId')::numeric ELSE 0 END)<${historyId}::numeric
    RETURNING id, (gmail_sync_due_at<=NOW()
      AND (gmail_cooldown_until IS NULL OR gmail_cooldown_until<=NOW())
      AND (gmail_sync_lease_until IS NULL OR gmail_sync_lease_until<=NOW())) AS should_wake`);
  // Redis retries can wait indefinitely during an outage. Acknowledgement must
  // depend only on the durable PostgreSQL write; the recovery sweep also wakes it.
  if (saved.rows.some((row: { should_wake?: boolean }) => row.should_wake === true)) void wakeGmailMailbox(binding);
}

const wakeUps = new Map<number, Promise<void>>();
function wakeGmailMailbox(binding: GmailMailboxBinding): Promise<void> {
  const pending = wakeUps.get(binding.credentialId);
  if (pending) return pending;
  const wake = (async () => {
    try {
      await queueRegistry.addJob(QUEUE_NAMES.GENERAL, 'gmail-mailbox-sync', {
        ...binding, type: 'gmail-mailbox-sync', createdAt: new Date().toISOString(), correlationId: randomUUID(),
      }, { jobId: `gmail-mailbox-sync-${binding.credentialId}`, removeOnComplete: true, removeOnFail: true });
    } catch (error) {
      logger.warn({ credentialId: binding.credentialId, err: error }, '[GmailSync] Notification saved; recovery will wake the worker');
    }
  })().finally(() => { wakeUps.delete(binding.credentialId); });
  wakeUps.set(binding.credentialId, wake);
  return wake;
}

export async function recoverGmailMailboxSync(): Promise<number> {
  const due = await db.execute(sql`SELECT id,user_id,account_identifier FROM channel_credentials
    WHERE platform='gmail_api' AND is_active IS TRUE AND gmail_sync_history_id IS NOT NULL
      AND gmail_sync_due_at<=NOW() AND (gmail_cooldown_until IS NULL OR gmail_cooldown_until<=NOW())
      AND (gmail_sync_lease_until IS NULL OR gmail_sync_lease_until<=NOW())
    ORDER BY gmail_sync_due_at,id LIMIT 50`);
  for (const row of due.rows as Array<{ id: number; user_id: number; account_identifier: string }>) {
    await wakeGmailMailbox({ credentialId: row.id, userId: row.user_id, emailAddress: row.account_identifier.trim().toLowerCase() });
  }
  return due.rows.length;
}

export async function processGmailMailboxSync(binding: GmailMailboxBinding): Promise<void> {
  const token = randomUUID();
  const claim = await db.execute(sql`UPDATE channel_credentials
    SET gmail_sync_lease_token=${token}::uuid, gmail_sync_lease_until=NOW()+INTERVAL '5 minutes'
    WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND platform='gmail_api' AND is_active IS TRUE
      AND LOWER(TRIM(account_identifier))=${binding.emailAddress} AND gmail_sync_history_id IS NOT NULL
      AND gmail_sync_due_at<=NOW() AND (gmail_cooldown_until IS NULL OR gmail_cooldown_until<=NOW())
      AND (gmail_sync_lease_until IS NULL OR gmail_sync_lease_until<=NOW())
    RETURNING id,user_id,business_profile_id,account_identifier,session_data,
      gmail_sync_history_id::text,gmail_sync_failures`);
  if (!claim.rows.length) return;
  const credential = claim.rows[0] as unknown as GmailSyncCredential;
  const heartbeat = async () => {
    const renewed = await db.execute(sql`UPDATE channel_credentials SET gmail_sync_lease_until=NOW()+INTERVAL '5 minutes'
      WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND is_active IS TRUE
        AND LOWER(TRIM(account_identifier))=${binding.emailAddress} AND gmail_sync_lease_token=${token}::uuid RETURNING id`);
    if (!renewed.rows.length) throw new Error('Gmail sync lease or mailbox ownership changed');
  };
  try {
    const { syncGmailMailboxHistory } = await import('../controllers/gmailWebhookController.js');
    await syncGmailMailboxHistory(credential, heartbeat);
    await db.execute(sql`UPDATE channel_credentials SET
      session_data=jsonb_set(COALESCE(session_data,'{}'::jsonb),'{lastHistoryId}',
        to_jsonb(GREATEST(CASE WHEN session_data->>'lastHistoryId' ~ '^[0-9]+$'
          THEN (session_data->>'lastHistoryId')::numeric ELSE 0 END,${credential.gmail_sync_history_id}::numeric)::text)),
      gmail_sync_history_id=CASE WHEN gmail_sync_history_id>${credential.gmail_sync_history_id}::numeric THEN gmail_sync_history_id ELSE NULL END,
      gmail_sync_due_at=CASE WHEN gmail_sync_history_id>${credential.gmail_sync_history_id}::numeric THEN NOW() ELSE NULL END,
      gmail_sync_lease_token=NULL,gmail_sync_lease_until=NULL,gmail_sync_failures=0,updated_at=NOW()
      WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND is_active IS TRUE
        AND LOWER(TRIM(account_identifier))=${binding.emailAddress} AND gmail_sync_lease_token=${token}::uuid`);
  } catch (error) {
    const failures = Number(credential.gmail_sync_failures || 0);
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failures, 7));
    const retryAt = error instanceof GmailCooldownError ? error.retryAt : new Date(Date.now() + delay).toISOString();
    await db.execute(sql`UPDATE channel_credentials SET gmail_sync_due_at=GREATEST(${retryAt}::timestamptz,COALESCE(gmail_cooldown_until,NOW())),
      gmail_sync_lease_token=NULL,gmail_sync_lease_until=NULL,gmail_sync_failures=gmail_sync_failures+1,updated_at=NOW()
      WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND gmail_sync_lease_token=${token}::uuid`);
    logger.warn({ credentialId: binding.credentialId, retryAt, errorType: error instanceof Error ? error.name : 'UnknownError' }, '[GmailSync] Sync deferred; cursor retained');
  }
}
