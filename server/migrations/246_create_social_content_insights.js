/** Cached provider content is separate from daily account totals: lifetime post
 * measurements must never be added to an account's daily trend. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS social_content_items (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id INTEGER NOT NULL REFERENCES channel_credentials(id) ON DELETE CASCADE,
    provider_id VARCHAR(255) NOT NULL,
    platform VARCHAR(24) NOT NULL CHECK (platform IN ('facebook', 'instagram')),
    content_type VARCHAR(24) NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    permalink TEXT,
    thumbnail_url TEXT,
    metrics JSONB NOT NULL DEFAULT '{}',
    metrics_updated_at TIMESTAMPTZ,
    limitations JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (credential_id, provider_id)
  )`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS social_content_window_idx ON social_content_items(user_id, credential_id, published_at DESC, provider_id)`,
  );
  await client.query(`CREATE TABLE IF NOT EXISTS social_content_syncs (
    credential_id INTEGER PRIMARY KEY REFERENCES channel_credentials(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(24) NOT NULL,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_succeeded_at TIMESTAMPTZ,
    window_start DATE,
    window_end DATE,
    limitations JSONB NOT NULL DEFAULT '[]'
  )`);
  if (process.env.DB_RUNTIME_USER) {
    const role = `"${process.env.DB_RUNTIME_USER.replaceAll('"', '""')}"`;
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON social_content_items, social_content_syncs TO ${role}`,
    );
  }
}
export async function down(client) {
  await client.query("DROP TABLE IF EXISTS social_content_syncs");
  await client.query("DROP TABLE IF EXISTS social_content_items");
}
