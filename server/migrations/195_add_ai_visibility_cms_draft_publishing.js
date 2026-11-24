/**
 * Durable, owner-scoped CMS draft publishing intents for approved AI Visibility assets.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_cms_publish_attempts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      generated_asset_link_id INTEGER NOT NULL REFERENCES ai_visibility_generated_asset_links(id) ON DELETE CASCADE,
      content_asset_id INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
      credential_id INTEGER REFERENCES api_credentials(id) ON DELETE SET NULL,
      platform VARCHAR(24) NOT NULL CHECK (platform IN ('wordpress', 'shopify')),
      idempotency_key VARCHAR(80) NOT NULL,
      asset_version INTEGER NOT NULL,
      payload_fingerprint VARCHAR(64) NOT NULL,
      reviewed_payload JSONB NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      destination_id TEXT,
      destination_url TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      reconciliation_count INTEGER NOT NULL DEFAULT 0,
      error_code VARCHAR(100),
      error_message TEXT,
      last_reconciled_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_cms_publish_attempts_user_intent_uq
      ON ai_visibility_cms_publish_attempts(user_id, idempotency_key)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_cms_publish_attempts_project_idx
      ON ai_visibility_cms_publish_attempts(project_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_cms_publish_attempts_asset_idx
      ON ai_visibility_cms_publish_attempts(user_id, content_asset_id, created_at DESC)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ai_visibility_cms_publish_attempts');
}
