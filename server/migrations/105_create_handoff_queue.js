/**
 * Migration 105: Create handoff_queue table
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS handoff_queue (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      channel VARCHAR(20) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'waiting',
      priority VARCHAR(15) NOT NULL DEFAULT 'medium',
      reason TEXT,
      trigger_type VARCHAR(30),
      assigned_to INTEGER,
      ai_draft_reply TEXT,
      conversation_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence_score REAL,
      sla_deadline TIMESTAMP,
      resolved_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_handoff_queue_user_status ON handoff_queue(user_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_handoff_queue_conversation ON handoff_queue(conversation_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_handoff_queue_sla ON handoff_queue(sla_deadline)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS handoff_queue`);
}
