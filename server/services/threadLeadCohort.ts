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

/**
 * For campaign counts only: the thread's own leads plus account leads the user
 * selected for this campaign (thread metadata `selectedLeadIds`), so a campaign
 * that works with existing leads does not show "Leads 0".
 *
 * Not for recipient pools, CRM or the Leads tab list: those keep
 * `threadLeadIds`, so selecting leads never changes who can be messaged.
 * Selected IDs are re-checked against the owner and business profile.
 */
export function reportingThreadLeadIds(userId: number, businessProfileId: number, threadId: number): SQL {
  return sql`${threadLeadIds(userId, businessProfileId, threadId)}
    UNION
    SELECT sl.id FROM chat_threads st
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(st.metadata->'selectedLeadIds') = 'array' THEN st.metadata->'selectedLeadIds' ELSE '[]'::jsonb END
      ) AS selected(lead_id)
      -- CASE keeps the cast from running on text that is not a lead ID.
      JOIN leads sl ON sl.id = CASE WHEN selected.lead_id ~ '^[1-9][0-9]{0,8}$' THEN selected.lead_id::int END
        AND sl.user_id = ${userId} AND sl.business_profile_id = ${businessProfileId} AND sl.deleted_at IS NULL
      WHERE st.id = ${threadId} AND st.user_id = ${userId}`;
}
