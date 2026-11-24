import { sql } from 'drizzle-orm';
import type { gmail_v1 } from 'googleapis';
import { db } from '../models/db.js';
import { gmailSendError } from '../utils/gmailSendError.js';
import type { GmailMailboxBinding } from './GmailMailboxSyncService.js';
import { assertCustomerDeliveryReady } from './assistants/CustomerDeliveryGate.js';
import { isInternalEmailDelivery } from './InternalEmailDelivery.js';

export class GmailCooldownError extends Error {
  readonly retryable = true;
  readonly outcomeUncertain = false;
  constructor(readonly retryAt: string, readonly deliveryAttempted = false) {
    super(`Gmail temporarily limited this account. Retry after ${retryAt}`);
    this.name = 'GmailCooldownError';
  }
}

export async function gmailRequest<T>(binding: GmailMailboxBinding, request: () => Promise<T>): Promise<T> {
  const state = await db.execute(sql`SELECT gmail_cooldown_until FROM channel_credentials
    WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND platform='gmail_api' AND is_active IS TRUE
      AND LOWER(TRIM(account_identifier))=${binding.emailAddress}`);
  if (!state.rows.length) throw new Error('Gmail mailbox is no longer active');
  const until = state.rows[0].gmail_cooldown_until;
  if (until && new Date(until as string | Date).getTime() > Date.now()) throw new GmailCooldownError(new Date(until as string | Date).toISOString());
  try { return await request(); } catch (error) {
    const failure = gmailSendError(error, true, false);
    if (!failure.retryable) throw error;
    const retryAt = failure.retryAt || new Date(Date.now() + 60_000).toISOString();
    const saved = await db.execute(sql`UPDATE channel_credentials SET gmail_cooldown_until=GREATEST(COALESCE(gmail_cooldown_until,NOW()),${retryAt}::timestamptz)
      WHERE id=${binding.credentialId} AND user_id=${binding.userId} AND platform='gmail_api'
        AND LOWER(TRIM(account_identifier))=${binding.emailAddress} RETURNING gmail_cooldown_until`);
    const persisted = saved.rows[0]?.gmail_cooldown_until as Date | string | undefined;
    throw new GmailCooldownError(persisted ? new Date(persisted).toISOString() : retryAt, true);
  }
}

/** Guard every actual mailbox request, including paginated reads and attachments. */
export function guardGmailClient(gmail: gmail_v1.Gmail, binding: GmailMailboxBinding, heartbeat?: () => Promise<void>): gmail_v1.Gmail {
  const resources: Array<[object, string[]]> = [
    [gmail.users, ['getProfile', 'watch', 'stop']],
    [gmail.users.history, ['list']], [gmail.users.messages, ['send','get','list','modify','batchModify']],
    [gmail.users.messages.attachments, ['get']], [gmail.users.threads, ['get']],
  ];
  for (const [resource, methods] of resources) {
    if (!resource) continue;
    const target = resource as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of methods) {
      const original = target[method];
      if (typeof original !== 'function') continue;
      target[method] = async (...args: unknown[]) => {
        if (heartbeat) await heartbeat();
        return gmailRequest(binding, async () => {
          if (resource === gmail.users.messages && method === 'send' && !isInternalEmailDelivery())
            await assertCustomerDeliveryReady({ userId: binding.userId, channel: 'email', accountId: binding.emailAddress });
          return original.apply(resource, args);
        });
      };
    }
  }
  return gmail;
}
