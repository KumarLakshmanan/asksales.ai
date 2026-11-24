/**
 * Migration: add_unique_constraint_outreach_conversations
 * Adds a unique constraint on (user_id, lead_id, channel) to support upsert operations
 * for Instagram/Facebook outreach conversation tracking.
 */
export async function up(client) {
  // First, deduplicate any existing rows — keep the most recently updated one
  await client.query(`
    DELETE FROM outreach_conversations a
    USING outreach_conversations b
    WHERE a.id < b.id
      AND a.user_id = b.user_id
      AND a.lead_id = b.lead_id
      AND a.channel = b.channel;
  `);

  await client.query(`
    ALTER TABLE outreach_conversations
    ADD CONSTRAINT outreach_conversations_user_lead_channel_unique
    UNIQUE (user_id, lead_id, channel);
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE outreach_conversations
    DROP CONSTRAINT IF EXISTS outreach_conversations_user_lead_channel_unique;
  `);
}
