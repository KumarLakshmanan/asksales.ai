/**
 * 081_add_ad_campaign_versioning_and_connector_type
 *
 * - Adds `version` column to `performance_ad_campaigns` for optimistic locking
 *   on concurrent budget/status updates (LOW-22).
 * - Adds `connector_type` column to `outreach_settings` to make the connection
 *   method (oauth | manual_credentials | env_fallback) introspectable per user
 *   without parsing JSONB blobs (LOW-18).
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE performance_ad_campaigns
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_performance_ad_campaigns_version
      ON performance_ad_campaigns (id, version);
  `);

  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS connector_type VARCHAR(32);
  `);
  // Backfill: existing rows default to 'env_fallback' so they remain queryable.
  await client.query(`
    UPDATE outreach_settings
    SET connector_type = 'env_fallback'
    WHERE connector_type IS NULL;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE performance_ad_campaigns
    DROP COLUMN IF EXISTS version;
  `);
  await client.query(`
    DROP INDEX IF EXISTS idx_performance_ad_campaigns_version;
  `);
  await client.query(`
    ALTER TABLE outreach_settings
    DROP COLUMN IF EXISTS connector_type;
  `);
}
