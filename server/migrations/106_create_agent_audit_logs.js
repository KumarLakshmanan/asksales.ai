/**
 * Migration 106: Create agent_audit_logs table
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      channel VARCHAR(20) NOT NULL,
      intent VARCHAR(50),
      risk_level VARCHAR(15),
      classification_confidence REAL,
      agent_type VARCHAR(50),
      tools_called JSONB NOT NULL DEFAULT '[]'::jsonb,
      kb_sources_used JSONB NOT NULL DEFAULT '[]'::jsonb,
      llm_model VARCHAR(50),
      llm_tokens_used INTEGER,
      reply_text TEXT,
      confidence REAL,
      guardrail_passed BOOLEAN,
      guardrail_violations JSONB NOT NULL DEFAULT '[]'::jsonb,
      policy_violations JSONB NOT NULL DEFAULT '[]'::jsonb,
      outcome VARCHAR(30) NOT NULL,
      duration_ms INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_user ON agent_audit_logs(user_id, created_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_conversation ON agent_audit_logs(conversation_id)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS agent_audit_logs`);
}
