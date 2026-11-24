export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_effect_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      effect_key VARCHAR(255) NOT NULL UNIQUE,
      effect_type VARCHAR(80) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'success', 'failed', 'reconciliation_required')),
      attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      last_error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_effect_ledger_conversation
      ON support_effect_ledger(user_id, conversation_id, created_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_effect_ledger_status
      ON support_effect_ledger(status, updated_at)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_effect_ledger');
}
