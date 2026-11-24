/**
 * Migration: add_retry_columns
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE content_assets 
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE content_assets 
    DROP COLUMN IF EXISTS retry_count,
    DROP COLUMN IF EXISTS last_error;
  `);
}
