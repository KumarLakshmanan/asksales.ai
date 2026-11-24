export async function up(client) {
  // The runner owns the transaction. Existing ownership triggers require
  // explicit administrative scope even when the migration role owns the DB.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  // Old manual credentials were never bound to exact provider identities.
  // Require those connections to verify again before accepting callbacks.
  await client.query(`UPDATE meta_page_connections m SET is_active=false, facebook_active=false,
    instagram_active=false, updated_at=NOW() WHERE EXISTS (
      SELECT 1 FROM channel_credentials c WHERE c.user_id=m.user_id
      AND c.business_profile_id=m.business_profile_id AND c.credential_type='manual'
      AND c.platform IN ('facebook_api','instagram_api')
      AND (c.account_identifier=m.page_id OR c.account_identifier=m.instagram_account_id))`);
  await client.query(`UPDATE channel_credentials SET is_active=false, is_selected=false, updated_at=NOW()
    WHERE credential_type='manual' AND platform IN ('facebook_api','instagram_api')`);
  // Ambiguous legacy ownership is quarantined; do not silently choose a tenant.
  await client.query(`UPDATE meta_page_connections SET is_active=false, facebook_active=false,
    instagram_active=false, updated_at=NOW() WHERE is_active AND (
      page_id IN (SELECT page_id FROM meta_page_connections WHERE is_active GROUP BY page_id HAVING COUNT(*)>1)
      OR instagram_account_id IN (SELECT instagram_account_id FROM meta_page_connections
        WHERE is_active AND instagram_active AND instagram_account_id IS NOT NULL
        GROUP BY instagram_account_id HAVING COUNT(*)>1))`);
  await client.query(`CREATE UNIQUE INDEX meta_active_page_routing_unique
    ON meta_page_connections(page_id) WHERE is_active`);
  await client.query(`CREATE UNIQUE INDEX meta_active_instagram_routing_unique
    ON meta_page_connections(instagram_account_id) WHERE is_active AND instagram_active AND instagram_account_id IS NOT NULL`);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

// Deliberately irreversible: rollback must never reactivate unverified routes.
export const irreversible = true;
