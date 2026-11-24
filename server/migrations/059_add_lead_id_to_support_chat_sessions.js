/**
 * Migration: add_lead_id_to_support_chat_sessions
 * Adds lead_id column to support_chat_sessions so widget conversations
 * can be linked to CRM leads.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE support_chat_sessions
    ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_sessions_lead
    ON support_chat_sessions(lead_id);
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_support_chat_sessions_lead;`);
  await client.query(`ALTER TABLE support_chat_sessions DROP COLUMN IF EXISTS lead_id;`);
}
