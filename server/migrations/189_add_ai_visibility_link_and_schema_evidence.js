/**
 * Persists bounded link-verification and JSON-LD validation evidence for
 * audit-specific crawl snapshots. Existing snapshots remain valid and receive
 * empty evidence arrays.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_crawled_pages
      ADD COLUMN IF NOT EXISTS link_checks JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS json_ld_errors JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
}

export async function down(client) {
  await client.query('ALTER TABLE ai_visibility_crawled_pages DROP COLUMN IF EXISTS json_ld_errors');
  await client.query('ALTER TABLE ai_visibility_crawled_pages DROP COLUMN IF EXISTS link_checks');
}
