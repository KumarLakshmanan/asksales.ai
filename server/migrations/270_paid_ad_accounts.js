/** Verified reporting accounts; credentials stay in their original encrypted stores. */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS paid_ad_accounts (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(20) NOT NULL CHECK (platform IN ('meta', 'google')),
      provider_account_id VARCHAR(40) NOT NULL, name TEXT NOT NULL,
      currency VARCHAR(3), timezone TEXT, manager_account_id VARCHAR(40),
      credential_source VARCHAR(30) NOT NULL, credential_id INTEGER,
      is_manager BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      reporting_available BOOLEAN NOT NULL DEFAULT FALSE,
      publishing_available BOOLEAN NOT NULL DEFAULT FALSE,
      verified_at TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ, last_succeeded_at TIMESTAMPTZ,
      data_available_through DATE, error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, platform, provider_account_id)
    );
    ALTER TABLE campaign_performance_cache ADD COLUMN IF NOT EXISTS ad_account_id VARCHAR(40) NOT NULL DEFAULT '';
    UPDATE campaign_performance_cache SET ad_account_id=REGEXP_REPLACE(COALESCE(raw_data->'accountIdentity'->>'adAccountId',''),'^act_','') WHERE ad_account_id='';
    UPDATE campaign_performance_cache child SET ad_account_id=parent.ad_account_id FROM campaign_performance_cache parent
      WHERE child.user_id=parent.user_id AND child.platform=parent.platform AND child.parent_entity_id=parent.platform_entity_id
        AND parent.entity_type='campaign' AND child.ad_account_id='' AND parent.ad_account_id<>'';
    UPDATE campaign_performance_cache child SET ad_account_id=parent.ad_account_id FROM campaign_performance_cache parent
      WHERE child.user_id=parent.user_id AND child.platform=parent.platform AND child.parent_entity_id=parent.platform_entity_id
        AND parent.entity_type IN ('adset','ad_group') AND child.ad_account_id='' AND parent.ad_account_id<>'';
    CREATE INDEX IF NOT EXISTS campaign_cache_account_lookup ON campaign_performance_cache(user_id,platform,ad_account_id,entity_type,platform_entity_id);
    ALTER TABLE campaign_performance_cache ALTER COLUMN conversions TYPE NUMERIC(18,6);
    ALTER TABLE performance_metrics ALTER COLUMN conversions TYPE NUMERIC(18,6);
    ALTER TABLE ad_unit_metrics ALTER COLUMN conversions TYPE NUMERIC(18,6);
    ALTER TABLE performance_ad_campaigns ALTER COLUMN conversions TYPE NUMERIC(18,6);
    ALTER TABLE performance_sync_state ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE performance_sync_state DROP CONSTRAINT IF EXISTS performance_sync_state_kind_check;
    ALTER TABLE performance_sync_state ADD CONSTRAINT performance_sync_state_kind_check CHECK(kind IN ('paid_meta','paid_google','social'));
  `);
  const runtimeRole = process.env.DB_RUNTIME_USER;
  if (runtimeRole) {
    const role = `"${runtimeRole.replaceAll('"', '""')}"`;
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON paid_ad_accounts TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE paid_ad_accounts_id_seq TO ${role}`);
  }
}
export async function down(client) {
  await client.query('DROP TABLE IF EXISTS paid_ad_accounts');
}
