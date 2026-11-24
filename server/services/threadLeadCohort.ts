import { sql, type SQL } from 'drizzle-orm';

/**
 * Subquery of the active lead ids that belong to a campaign thread, for use as
 * `l.id IN (${threadLeadIds(...)})`.
 *
 * A lead belongs to a thread through an ICP profile of that thread
 * (`leads.prompt_id`) or through legacy campaign metadata. The legacy half reads
 * the stored `legacy_campaign_thread_key` column from migration 587, which is
 * indexed on (business_profile_id, user_id, key); comparing
 * `campaign_data->>'threadId'` directly, or OR-ing it with the ICP match,
 * forces a scan of every lead the account owns. UNION (not UNION ALL) keeps a
 * lead that matches both halves from being counted twice.
 *
 * Call only after the thread has been authorized for this user and profile.
 */
export function threadLeadIds(userId: number, businessProfileId: number, threadId: number): SQL {
  return sql`SELECT tl.id FROM icp_profiles tip
      JOIN leads tl ON tl.prompt_id = tip.id AND tl.user_id = ${userId}
        AND tl.business_profile_id = ${businessProfileId} AND tl.deleted_at IS NULL
      WHERE tip.thread_id = ${threadId} AND tip.user_id = ${userId}
        AND tip.business_profile_id = ${businessProfileId}
    UNION
    SELECT tl.id FROM leads tl
      WHERE tl.legacy_campaign_thread_key = ${String(threadId)} AND tl.user_id = ${userId}
        AND tl.business_profile_id = ${businessProfileId} AND tl.deleted_at IS NULL`;
}
