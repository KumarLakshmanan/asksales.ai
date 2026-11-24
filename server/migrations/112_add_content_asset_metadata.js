/**
 * Persist platform-specific publishing options (post type, tags, privacy,
 * and original cross-post targets) with a content asset so scheduled workers
 * use the same settings as immediate publishing.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE content_assets
    ADD COLUMN IF NOT EXISTS metadata JSONB
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE content_assets
    DROP COLUMN IF EXISTS metadata
  `);
}
