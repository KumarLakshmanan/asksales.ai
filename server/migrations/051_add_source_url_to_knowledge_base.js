/**
 * Migration: add_source_url_to_knowledge_base
 * Adds sourceUrl column for URL-type knowledge base entries.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE knowledge_base
    ADD COLUMN IF NOT EXISTS source_url VARCHAR(2048)
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE knowledge_base
    DROP COLUMN IF EXISTS source_url
  `);
}
