/**
 * Migration 085: Add publishing fields to content_assets table
 * 
 * Adds columns needed to track when/where content has been published
 * to social media platforms (Facebook, Instagram, YouTube).
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE content_assets
      ADD COLUMN IF NOT EXISTS published_post_id TEXT,
      ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS published_url TEXT,
      ADD COLUMN IF NOT EXISTS publish_platform VARCHAR(50),
      ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_content_assets_publish_platform
      ON content_assets (publish_platform)
      WHERE publish_platform IS NOT NULL;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_content_assets_scheduled_publish_at
      ON content_assets (scheduled_publish_at)
      WHERE scheduled_publish_at IS NOT NULL AND published_at IS NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS idx_content_assets_publish_platform;
    DROP INDEX IF EXISTS idx_content_assets_scheduled_publish_at;
  `);

  await client.query(`
    ALTER TABLE content_assets
      DROP COLUMN IF EXISTS published_post_id,
      DROP COLUMN IF EXISTS published_at,
      DROP COLUMN IF EXISTS published_url,
      DROP COLUMN IF EXISTS publish_platform,
      DROP COLUMN IF EXISTS scheduled_publish_at;
  `);
}
