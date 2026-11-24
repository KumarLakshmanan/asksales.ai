import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";

/** Reconcile one confirmed platform outcome without erasing sibling state.
 * The caller supplies its existing transaction/authority fence. */
export async function reconcileCampaignProviderState(
  tx: typeof db,
  action: {
    id: number;
    campaign_id: number;
    user_id: number;
    platform: string;
  },
  localStatus: string,
  providerStatus: string,
): Promise<void> {
  // Serialize platform completions before reading sibling allocations.
  // Otherwise simultaneous stops can each observe the other as active.
  await tx.execute(sql`SELECT id FROM performance_ad_campaigns
        WHERE id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)} FOR UPDATE`);
  await tx.execute(sql`
        UPDATE ad_campaign_allocations
        SET status = ${localStatus}, updated_at = NOW()
        WHERE campaign_id = ${Number(action.campaign_id)}
          AND user_id = ${Number(action.user_id)}
          AND platform = ${String(action.platform)}
      `);
  await tx.execute(sql`
        WITH latest_publish AS (
          SELECT DISTINCT ON (platform) * FROM ad_action_queue
          WHERE campaign_id = ${Number(action.campaign_id)}
            AND user_id = ${Number(action.user_id)} AND action_type = 'publish'
          ORDER BY platform, id DESC
        )
        UPDATE performance_ad_campaigns campaign
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM latest_publish other
                WHERE other.campaign_id = campaign.id
                  AND other.user_id = campaign.user_id
                  AND other.action_type = 'publish'
                  AND other.id <> ${Number(action.id)}
                  AND other.status = 'failed'
              ) THEN 'partial_success'
              WHEN EXISTS (
                SELECT 1 FROM latest_publish other
                WHERE other.campaign_id = campaign.id
                  AND other.user_id = campaign.user_id
                  AND other.action_type = 'publish'
                  AND other.id <> ${Number(action.id)}
                  AND other.status IN ('pending', 'processing')
              ) THEN 'running'
              WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.status = 'active'
              ) THEN 'active'
              ELSE ${localStatus}
            END,
            local_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM latest_publish other
                WHERE other.campaign_id = campaign.id
                  AND other.user_id = campaign.user_id
                  AND other.action_type = 'publish'
                  AND other.id <> ${Number(action.id)}
                  AND other.status = 'failed'
              ) THEN 'partial_success'
              WHEN EXISTS (
                SELECT 1 FROM latest_publish other
                WHERE other.campaign_id = campaign.id
                  AND other.user_id = campaign.user_id
                  AND other.action_type = 'publish'
                  AND other.id <> ${Number(action.id)}
                  AND other.status IN ('pending', 'processing')
              ) THEN 'running'
              WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.status = 'active'
              ) THEN 'active'
              ELSE ${localStatus}
            END,
            provider_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.status = 'active'
              ) THEN ${localStatus === "active" ? providerStatus : "ACTIVE"}
              WHEN EXISTS (
                SELECT 1 FROM latest_publish other
                WHERE other.campaign_id = campaign.id
                  AND other.user_id = campaign.user_id
                  AND other.action_type = 'publish'
                  AND other.id <> ${Number(action.id)}
                  AND other.status IN ('pending', 'processing', 'failed')
              ) THEN provider_status
              ELSE ${providerStatus}
            END,
            is_active = EXISTS (
              SELECT 1 FROM ad_campaign_allocations allocation
              WHERE allocation.campaign_id = campaign.id
                AND allocation.user_id = campaign.user_id AND allocation.status = 'active'
            ),
            launched_at = CASE
              WHEN ${localStatus === "active"} THEN COALESCE(launched_at, NOW())
              ELSE launched_at
            END,
            last_provider_error = (
              SELECT other.last_error FROM latest_publish other
              WHERE other.id <> ${Number(action.id)} AND other.status = 'failed'
              ORDER BY other.id DESC LIMIT 1
            ),
            updated_at = NOW()
        WHERE campaign.id = ${Number(action.campaign_id)}
          AND campaign.user_id = ${Number(action.user_id)}
      `);
}
