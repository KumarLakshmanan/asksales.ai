import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { businessCacheKey } from "../../tenancy/businessContext.js";
import { CHANNEL_THROTTLE_CONFIGS } from "../../utils/rateLimitConstants.js";
import { logger } from "../../utils/logger.js";

export async function getEffectiveDailyLimit(
  userId: number,
  channel: string,
  executor: Pick<typeof db,'execute'> = db,
): Promise<number> {
  channel = channel === "gmail" ? "email" : channel;
  const fallback = CHANNEL_THROTTLE_CONFIGS[channel]?.dailyLimit ?? 0;
  try {
    if (channel === "email" || channel === "gmail") {
      const result = await executor.execute(
        sql`SELECT daily_email_limit FROM outreach_settings WHERE user_id = ${userId} LIMIT 1`,
      );
      const value = Number(result.rows[0]?.daily_email_limit);
      return Number.isInteger(value) && value >= 0
        ? Math.min(value, fallback)
        : fallback;
    }
    if (channel === "instagram" || channel === "facebook") {
      const result = await executor.execute(sql`
        SELECT session_data FROM channel_credentials WHERE user_id=${userId}
          AND platform IN (${channel}, ${`${channel}_api`}) AND is_active=true ORDER BY updated_at DESC
      `);
      for (const row of result.rows) {
        const value = Number(
          (row.session_data as { dailyOutreachLimit?: number } | null)
            ?.dailyOutreachLimit,
        );
        if (Number.isInteger(value) && value >= 0)
          return Math.min(value, fallback);
      }
    }
    if (["twitter", "linkedin", "instagram", "facebook"].includes(channel))
      return Math.min(20, fallback);
  } catch (error) {
    logger.warn(
      { err: error, userId, channel },
      "[OutreachLimits] Daily allowance unavailable; refusing dispatch",
    );
    throw error;
  }
  return fallback;
}

/** Future reservations use their planned UTC day; successful sends use their actual day. */
export async function getOutboundCountForDay(
  userId: number,
  channel: string,
  date = new Date(),
): Promise<number> {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  const result = await db.execute(sql`
    SELECT COUNT(om.id)::int AS count FROM outreach_messages om
    JOIN outreach_conversations oc ON oc.id=om.conversation_id
    WHERE oc.user_id=${userId} AND (oc.channel=${channel} OR (${channel}='email' AND oc.channel='gmail')) AND om.direction='outbound'
      AND om.status IN ('sent','delivered','read','pending','queued','sending')
      AND COALESCE(om.sent_at,(om.metadata->>'scheduledAt')::timestamptz AT TIME ZONE 'UTC',om.created_at) >= ${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      AND COALESCE(om.sent_at,(om.metadata->>'scheduledAt')::timestamptz AT TIME ZONE 'UTC',om.created_at) < ${end.toISOString()}::timestamptz AT TIME ZONE 'UTC'
  `);
  return Number(result.rows[0]?.count) || 0;
}

/** Serialize the provider boundary so concurrently due scheduled sends cannot exceed the day’s allowance. */
export async function withCreationDailyQuota<T>(
  userId: number,
  channel: string,
  startDelivery: (tx: typeof db) => Promise<T>,
): Promise<T | null> {
  channel = channel === "gmail" ? "email" : channel;
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${businessCacheKey(`outreach-daily:${userId}:${channel}`)}))`,
    );
    const limit = await getEffectiveDailyLimit(userId, channel, tx);
    const result = await tx.execute(sql`
      SELECT COUNT(om.id)::int AS count FROM outreach_messages om
      JOIN outreach_conversations oc ON oc.id=om.conversation_id
      WHERE oc.user_id=${userId} AND (oc.channel=${channel} OR (${channel}='email' AND oc.channel='gmail')) AND om.direction='outbound'
        AND (
          (om.status IN ('sent','delivered','read') AND om.sent_at >= date_trunc('day',NOW() AT TIME ZONE 'UTC'))
          OR (om.provider_call_state IN ('started','unknown') AND om.send_claimed_at >= date_trunc('day',NOW() AT TIME ZONE 'UTC'))
        )
    `);
    const available=await tx.execute(sql`SELECT to_regclass('crm_automation_run_steps') AS automation_steps`);
    const automationFixedCount=available.rows[0]?.automation_steps ? await tx.execute(sql`SELECT count(*)::int AS count FROM crm_automation_run_steps
      WHERE user_id=${userId} AND channel=${channel} AND message_id IS NULL AND dispatch_started
        AND status IN ('running','success','uncertain') AND claimed_at >= date_trunc('day',now() AT TIME ZONE 'UTC')`) : null;
    // Campaign jobs can exist without an inbox projection. Count their starts,
    // excluding exact projected receipts already included above.
    const campaignTable=await tx.execute(sql`SELECT to_regclass('outreach_jobs') AS jobs`);
    const campaignCount=campaignTable.rows[0]?.jobs ? await tx.execute(sql`SELECT COUNT(*)::int AS count FROM outreach_jobs job
      WHERE job.user_id=${userId} AND job.channel=${channel}
        AND (job.sent_at>=date_trunc('day',NOW() AT TIME ZONE 'UTC') OR
          (job.metadata->>'providerCallStarted'='true' AND (job.metadata->>'providerStartedAt')::timestamptz AT TIME ZONE 'UTC'>=date_trunc('day',NOW() AT TIME ZONE 'UTC')))
        AND NOT EXISTS(SELECT 1 FROM outreach_messages om JOIN outreach_conversations oc ON oc.id=om.conversation_id
          WHERE oc.user_id=job.user_id AND (oc.channel=job.channel OR (job.channel='email' AND oc.channel='gmail'))
            AND om.direction='outbound' AND job.external_message_id IN(om.external_message_id,om.provider_message_id,om.rfc_message_id)
            AND om.status IN ('sent','delivered','read') AND om.sent_at>=date_trunc('day',NOW() AT TIME ZONE 'UTC'))`) : null;
    if ((Number(result.rows[0]?.count) || 0)+(Number(automationFixedCount?.rows[0]?.count) || 0)+(Number(campaignCount?.rows[0]?.count) || 0) >= limit) return null;
    return startDelivery(tx);
  });
}
