/**
 * Migration: add_last_activity_at_to_leads
 * Adds the last_activity_at column to the leads table, used by EmailSentimentService
 * to track when a lead last had activity (e.g., email reply received).
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE leads
    DROP COLUMN IF EXISTS last_activity_at
  `);
}
