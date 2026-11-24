export async function up(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_request_scopes (
      scope_key TEXT PRIMARY KEY, lease_token UUID, lease_expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS conversation_requests (
      id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope_key TEXT NOT NULL REFERENCES conversation_request_scopes(scope_key) ON DELETE CASCADE,
      kind TEXT NOT NULL, conversation_id INTEGER NOT NULL, request_id VARCHAR(160) NOT NULL,
      input_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', response JSONB,
      cancel_requested BOOLEAN NOT NULL DEFAULT FALSE, error_code TEXT, resolution_note TEXT, resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(scope_key, request_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_requests_owner ON conversation_requests(user_id,kind,conversation_id,id);
    CREATE INDEX IF NOT EXISTS conversation_requests_queue ON conversation_requests(scope_key,status,id);
    ALTER TABLE support_chat_sessions ADD COLUMN IF NOT EXISTS client_session_key VARCHAR(200);
    CREATE UNIQUE INDEX IF NOT EXISTS support_chat_session_client_key
      ON support_chat_sessions(client_session_key) WHERE client_session_key IS NOT NULL;
    ALTER TABLE support_chat_messages ADD COLUMN IF NOT EXISTS deferred_commit JSONB;
    ALTER TABLE support_chat_messages ADD COLUMN IF NOT EXISTS commit_token UUID;
    ALTER TABLE IF EXISTS support_effect_ledger ALTER COLUMN status TYPE VARCHAR(32);
  `);
}
export async function down(db) {
  await db.query(`DROP TABLE IF EXISTS conversation_requests; DROP TABLE IF EXISTS conversation_request_scopes;
    DROP INDEX IF EXISTS support_chat_session_client_key;
    ALTER TABLE support_chat_sessions DROP COLUMN IF EXISTS client_session_key;
    ALTER TABLE support_chat_messages DROP COLUMN IF EXISTS deferred_commit;
    ALTER TABLE support_chat_messages DROP COLUMN IF EXISTS commit_token;`);
}
