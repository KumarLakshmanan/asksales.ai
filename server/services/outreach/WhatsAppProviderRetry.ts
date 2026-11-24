import { requireBusinessScope } from "../../tenancy/businessContext.js";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { jobDispatcher } from "../../queues/JobDispatcher.js";
import {
  runBusinessJob,
  type JobBusinessPayload,
} from "../../tenancy/jobBusinessScope.js";
import { providerRetryTime } from "./providerRetry.js";

export const LEGACY_WHATSAPP_APP_LIMIT_ERROR = 'WhatsApp rate limit exceeded (max 100/min per tenant, 60/min per phone number). Try again in a minute.';

/** Explicit operator recovery only: retain the original message and send intent.
 * The legacy error alone is insufficient; require durable proof no call started.
 */
export async function planWhatsAppAppRateLimitRecovery(tx: typeof db, userId: number, messageIds: number[]) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId || !messageIds.length || !messageIds.every(id => Number.isSafeInteger(id) && id > 0))
    throw new Error('Explicit message IDs and matching business scope are required');
  const due = new Date(Date.now() + 61_000).toISOString();
  const result = await tx.execute(sql`UPDATE outreach_messages m SET metadata=jsonb_set(COALESCE(m.metadata,'{}'::jsonb),'{outreachQueue}',
    COALESCE(m.metadata->'outreachQueue','{}'::jsonb)||jsonb_build_object('reason','app_rate_limit','nextAttemptAt',${due}::text,
      'appRateLimitRecovery',true,'enqueueNeeded',true,'retryCount',COALESCE((m.metadata->'outreachQueue'->>'retryCount')::int,0))),updated_at=NOW()
    FROM outreach_conversations c
    WHERE m.id IN (${sql.join(messageIds.map(id => sql`${id}`),sql`, `)}) AND m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId}
      AND c.id=m.conversation_id AND c.user_id=m.user_id AND c.channel='whatsapp'
      AND m.status='failed' AND m.provider_call_state='not_started' AND NOT COALESCE(m.manual_review_required,false)
      AND m.error_message=${LEGACY_WHATSAPP_APP_LIMIT_ERROR} AND m.message_kind='outreach'
      AND m.external_message_id IS NULL AND m.provider_message_id IS NULL AND m.waba_message_id IS NULL AND m.rfc_message_id IS NULL
      AND m.send_intent_id IS NOT NULL AND m.sent_at IS NULL AND m.delivered_at IS NULL
      AND m.confirmation_expires_at>${due}::timestamptz
      AND m.metadata->'outreachQueuePolicy'->>'version'='1' AND m.metadata->'outreachQueueOrigin' IS NOT NULL
      AND m.metadata->'outreachCreation'->'delivery'->>'templateName' IS NOT NULL
      AND m.metadata->'outreachCreation'->>'whatsappOptInConfirmed'='true'
      AND COALESCE(m.metadata->'outreachQueue'->>'appRateLimitRecovery','false')!='true'
    RETURNING m.id,m.send_intent_id`);
  return result.rows;
}

/** Only newly reviewed template outreach opts into delayed marketing-limit retries. */
export async function planWhatsAppProviderRetry(
  tx: typeof db,
  userId: number,
  receipt: string,
  account: string,
  code: unknown,
) {
  if (Number(code) !== 131049) return [];
  const scope = requireBusinessScope();
  if (scope.userId !== userId)
    throw new Error("Retry owner does not match the business");
  const due = new Date(providerRetryTime(0, 131049)).toISOString();
  const result = await tx.execute(sql`UPDATE outreach_messages m SET metadata=COALESCE(m.metadata,'{}'::jsonb)||jsonb_build_object(
      'outreachQueue',jsonb_build_object('reason','provider_limit','providerCode',131049,'nextAttemptAt',${due}::text,
        'retryCount',COALESCE((m.metadata->'outreachQueue'->>'retryCount')::int,0)+1,
        'lastFailureReceipt',${receipt}::text,'enqueueNeeded',true))
    FROM outreach_conversations c
    WHERE m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId} AND c.id=m.conversation_id AND c.user_id=m.user_id
      AND c.channel='whatsapp' AND c.provider_account_id=${account}
      AND m.status='failed' AND m.message_kind='outreach'
      AND NOT COALESCE(m.manual_review_required,false) AND m.delivered_at IS NULL AND m.read_at IS NULL
      AND m.metadata->'outreachQueuePolicy'->>'version'='1'
      AND m.metadata->'outreachQueueOrigin' IS NOT NULL
      AND m.metadata->'outreachCreation'->'delivery'->>'templateName' IS NOT NULL
      AND m.metadata->'outreachCreation'->>'whatsappOptInConfirmed'='true'
      AND m.confirmation_expires_at>${due}::timestamptz
      AND COALESCE(m.metadata->'outreachQueue'->>'lastFailureReceipt','')<>${receipt}
      AND ${receipt} IN(m.external_message_id,m.provider_message_id,m.waba_message_id)
    RETURNING m.id,m.send_intent_id`);
  return result.rows;
}

/** Explicit recovery of failed marketing-limit sends. A matching provider failure
 * receipt is required; accepted or uncertain messages are never enrolled. */
export async function planWhatsAppMarketingRetryRecovery(
  tx: typeof db, userId: number, messageIds: number[],
) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId || !messageIds.length
    || !messageIds.every(id => Number.isSafeInteger(id) && id > 0))
    throw new Error('Explicit message IDs and matching business scope are required');
  const candidates = await tx.execute(sql`SELECT m.id,c.provider_account_id,
      COALESCE(m.provider_message_id,m.external_message_id,m.waba_message_id) AS receipt
    FROM outreach_messages m JOIN outreach_conversations c
      ON c.id=m.conversation_id AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
    WHERE m.id IN(${sql.join(messageIds.map(id => sql`${id}`),sql`, `)})
      AND m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId}
      AND c.channel='whatsapp' AND m.provider_account_id=c.provider_account_id
      AND m.status='failed' AND m.provider_call_state IN('confirmed','rejected')
      AND NOT COALESCE(m.manual_review_required,false)
      AND m.delivered_at IS NULL AND m.read_at IS NULL
      AND COALESCE(m.metadata->'outreachQueue'->>'enqueueNeeded','false')<>'true'
      AND EXISTS(SELECT 1 FROM instagram_webhook_events e
        WHERE e.user_id=m.user_id AND e.page_id=c.provider_account_id
          AND e.event_type='whatsapp_failed'
          AND e.message_id=COALESCE(m.provider_message_id,m.external_message_id,m.waba_message_id)
          AND e.raw_data#>>'{status,errors,0,code}'='131049')`);
  const recovered = [];
  for (const candidate of candidates.rows) {
    recovered.push(...await planWhatsAppProviderRetry(
      tx,userId,String(candidate.receipt),String(candidate.provider_account_id),131049,
    ));
  }
  return recovered;
}

/** Crash-recoverable DB-to-BullMQ handoff, called within each business's existing poll. */
export async function reconcileWhatsAppProviderRetries() {
  const scope = requireBusinessScope();
  const candidates =
    await db.execute(sql`SELECT id,user_id AS "userId",metadata->'outreachQueueOrigin' AS origin
    FROM outreach_messages WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND metadata->'outreachQueue'->>'enqueueNeeded'='true'
      AND status IN('failed','pending') ORDER BY updated_at LIMIT 100`);
  let firstError: unknown;
  for (const candidate of candidates.rows) {
    try {
      await runBusinessJob(candidate.origin as JobBusinessPayload, async () => {
        const claimed = await db.transaction(async (tx: typeof db) => {
          const result =
            await tx.execute(sql`SELECT * FROM outreach_messages WHERE id=${candidate.id} AND user_id=${candidate.userId}
          AND metadata->'outreachQueue'->>'enqueueNeeded'='true' AND status IN('failed','pending') FOR UPDATE`);
          const row = result.rows[0];
          if (!row) return;
          const metadata = row.metadata as {
            outreachQueue: {
              nextAttemptAt: string;
              retryCount: number;
              lastFailureReceipt: string;
              reason?: string;
            };
            outreachCreation: { delivery: Record<string, unknown> };
          };
          if (
            !row.confirmation_expires_at ||
            new Date(row.confirmation_expires_at as string).getTime() <=
              Date.now()
          ) {
            await tx.execute(
              sql`UPDATE outreach_messages SET metadata=metadata #- '{outreachQueue,enqueueNeeded}',status='failed',error_message='Queue lifetime expired. Review this outreach again.' WHERE id=${row.id}`,
            );
            return;
          }
          // Keep the failed receipt in metadata. Delayed copies of that webhook can
          // no longer overwrite this retry's status or the next provider receipt.
          await tx.execute(sql`UPDATE outreach_messages SET status='pending',provider_call_state='not_started',manual_review_required=false,
          external_message_id=NULL,provider_message_id=NULL,waba_message_id=NULL,send_claimed_at=NULL,
          error_message=${metadata.outreachQueue.reason === 'app_rate_limit' ? 'App sending capacity reached. Waiting for the rate-limit window to reset.' : 'Meta marketing limit reached. Queued to retry in 4 hours.'},updated_at=NOW() WHERE id=${row.id}`);
          return { row, metadata };
        });
        if (!claimed) return;
        const { row, metadata } = claimed;
        await jobDispatcher.dispatch(
          "send_outreach_message",
          {
            ...metadata.outreachCreation.delivery,
            ...(candidate.origin as JobBusinessPayload),
            messageId: Number(row.id),
            providerRateLimitRetries: metadata.outreachQueue.retryCount || 0,
          } as { userId: number },
          {
            jobId: metadata.outreachQueue.reason === 'app_rate_limit'
              ? `outreach-app-rate-recovery-${row.send_intent_id}`
              : `outreach-provider-retry-${row.send_intent_id}-${metadata.outreachQueue.retryCount}`,
            priority: 10,
            delay: Math.max(
              0,
              Date.parse(metadata.outreachQueue.nextAttemptAt) - Date.now(),
            ),
          },
        );
        await db.execute(sql`UPDATE outreach_messages SET metadata=metadata #- '{outreachQueue,enqueueNeeded}' WHERE id=${row.id}
        AND metadata->'outreachQueue'->>'retryCount'=${String(metadata.outreachQueue.retryCount)}`);
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (
        [
          "ORGANIZATION_FORBIDDEN",
          "JOB_ORIGIN_REQUIRED",
          "JOB_ACTOR_MISMATCH",
        ].includes(code || "")
      ) {
        await db.execute(
          sql`UPDATE outreach_messages SET status='setup_required',metadata=metadata #- '{outreachQueue,enqueueNeeded}',error_message='The original sending authority is unavailable. Review this outreach again.' WHERE id=${candidate.id} AND user_id=${candidate.userId} AND status IN('failed','pending')`,
        );
      } else firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}
