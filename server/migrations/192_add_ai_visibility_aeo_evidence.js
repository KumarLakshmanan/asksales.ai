/**
 * Stores a bounded visible-text excerpt alongside each audit crawl snapshot so
 * AEO coverage and generated assets can be grounded in verified page content.
 * Existing snapshots remain valid and simply have no excerpt evidence.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_crawled_pages
      ADD COLUMN IF NOT EXISTS content_excerpt TEXT
  `);
}

export async function down(client) {
  await client.query('ALTER TABLE ai_visibility_crawled_pages DROP COLUMN IF EXISTS content_excerpt');
}
