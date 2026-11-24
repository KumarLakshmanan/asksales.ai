/**
 * Migration: add_widget_token_to_support_teams
 * Adds a unique widget_token column to support_teams for public embed authentication.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE support_teams
    ADD COLUMN IF NOT EXISTS widget_token VARCHAR(64) UNIQUE;
  `);

  // Generate tokens for existing teams
  await client.query(`
    UPDATE support_teams
    SET widget_token = encode(gen_random_bytes(32), 'hex')
    WHERE widget_token IS NULL;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE support_teams
    DROP COLUMN IF EXISTS widget_token;
  `);
}
