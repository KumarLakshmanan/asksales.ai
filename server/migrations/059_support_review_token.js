/**
 * Migration: support_review_token
 * Add a unique review_token column to support_tickets for public review links.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS review_token VARCHAR(128) UNIQUE;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_review_token
    ON support_tickets(review_token) WHERE review_token IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_support_tickets_review_token`);
  await client.query(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS review_token`);
}
