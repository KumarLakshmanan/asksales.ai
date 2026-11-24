export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS social_comment_workflows (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id INTEGER NOT NULL REFERENCES channel_credentials(id) ON DELETE CASCADE,
    post_id VARCHAR(255) NOT NULL, comment_id VARCHAR(255) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK(status IN ('open','follow_up','escalated','resolved')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,credential_id,comment_id)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS social_comment_actions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id INTEGER NOT NULL REFERENCES channel_credentials(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(100) NOT NULL, post_id VARCHAR(255) NOT NULL, comment_id VARCHAR(255) NOT NULL,
    action VARCHAR(16) NOT NULL CHECK(action IN ('reply','hide','unhide')),
    request_hash VARCHAR(64) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','rejected','uncertain')),
    result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,idempotency_key)
  )`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS social_comment_actions_target_idx ON social_comment_actions(user_id,credential_id,comment_id,request_hash)`,
  );
  if (process.env.DB_RUNTIME_USER) {
    const role = `"${process.env.DB_RUNTIME_USER.replaceAll('"', '""')}"`;
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON social_comment_workflows,social_comment_actions TO ${role}`,
    );
  }
}
export async function down(client) {
  await client.query("DROP TABLE IF EXISTS social_comment_actions");
  await client.query("DROP TABLE IF EXISTS social_comment_workflows");
}
