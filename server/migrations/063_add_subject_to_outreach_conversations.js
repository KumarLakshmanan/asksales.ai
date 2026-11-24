/**
 * Migration: add_subject_to_outreach_conversations
 * Adds a subject column to outreach_conversations so that replies can compute
 * "Re: <original subject>" without querying outreach_messages.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_conversations
    ADD COLUMN IF NOT EXISTS subject TEXT
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE outreach_conversations
    DROP COLUMN IF EXISTS subject
  `);
}
