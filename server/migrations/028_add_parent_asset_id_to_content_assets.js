/**
 * Migration: add_parent_asset_id_to_content_assets
 * Adds parent_asset_id column to content_assets for linking images/videos to their parent content.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE content_assets
    ADD COLUMN IF NOT EXISTS parent_asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_assets_parent_asset_idx ON content_assets(parent_asset_id)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS content_assets_parent_asset_idx`);
  await client.query(`ALTER TABLE content_assets DROP COLUMN IF EXISTS parent_asset_id`);
}
