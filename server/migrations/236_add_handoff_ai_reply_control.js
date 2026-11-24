/**
 * Separate ticket assignment from explicit human takeover.
 *
 * An assigned handoff may continue to receive bounded, ticket-aware AI
 * replies until the assigned support member deliberately pauses automation.
 * The pause actor and timestamp remain auditable on the queue row.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE handoff_queue
      ADD COLUMN IF NOT EXISTS ai_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS ai_paused_by INTEGER REFERENCES team_members(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS handoff_queue_active_ai_reply_idx
    ON handoff_queue(user_id, conversation_id, ai_reply_enabled)
    WHERE status IN ('waiting', 'assigned', 'in_progress')
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS handoff_queue_active_ai_reply_idx');
  await client.query(`
    ALTER TABLE handoff_queue
      DROP COLUMN IF EXISTS ai_paused_by,
      DROP COLUMN IF EXISTS ai_paused_at,
      DROP COLUMN IF EXISTS ai_reply_enabled
  `);
}
