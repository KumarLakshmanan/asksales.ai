export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS support_preview_sessions (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id integer NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT NOW() + INTERVAL '2 hours',
    PRIMARY KEY (user_id, conversation_id)
  ); CREATE INDEX IF NOT EXISTS support_preview_expiry ON support_preview_sessions(expires_at);`);
}
export async function down(client) { await client.query('DROP TABLE IF EXISTS support_preview_sessions'); }
