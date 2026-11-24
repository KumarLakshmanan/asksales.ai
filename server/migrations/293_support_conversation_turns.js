/** Additive, opt-in coordination for private support conversations. */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_conversation_turns (
      scope_key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      channel VARCHAR(20) NOT NULL,
      provider_account_id TEXT NOT NULL DEFAULT '',
      revision BIGINT NOT NULL DEFAULT 0,
      consumed_revision BIGINT NOT NULL DEFAULT 0,
      lease_token UUID,
      lease_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS support_conversation_turn_inputs (
      scope_key TEXT NOT NULL REFERENCES support_conversation_turns(scope_key) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      revision BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      job_name TEXT NOT NULL,
      payload JSONB NOT NULL,
      ready BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(scope_key, source_key),
      UNIQUE(scope_key, revision)
    );
    CREATE TABLE IF NOT EXISTS support_conversation_turn_runs (
      id UUID PRIMARY KEY,
      scope_key TEXT NOT NULL REFERENCES support_conversation_turns(scope_key) ON DELETE CASCADE,
      first_revision BIGINT NOT NULL,
      last_revision BIGINT NOT NULL,
      message_ids JSONB NOT NULL,
      playbook_baseline JSONB NOT NULL DEFAULT '[]',
      ownership_snapshot TEXT NOT NULL DEFAULT '{}',
      status VARCHAR(24) NOT NULL DEFAULT 'processing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(scope_key, first_revision, last_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_support_turn_recovery ON support_conversation_turns(updated_at)
      WHERE revision > consumed_revision;
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS support_conversation_turn_runs;
    DROP TABLE IF EXISTS support_conversation_turn_inputs;
    DROP TABLE IF EXISTS support_conversation_turns;`);
}
