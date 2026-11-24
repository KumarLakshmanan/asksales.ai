/**
 * Adds hashed, expiring and revocable public links for completed AI Visibility
 * reports. Raw bearer tokens are never stored in PostgreSQL.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_report_shares (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES ai_visibility_reports(id) ON DELETE CASCADE,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL,
      token_prefix VARCHAR(12) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_accessed_at TIMESTAMPTZ,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_report_shares_token_uq
      ON ai_visibility_report_shares(token_hash)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_report_shares_project_idx
      ON ai_visibility_report_shares(project_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_report_shares_expiry_idx
      ON ai_visibility_report_shares(expires_at)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ai_visibility_report_shares');
}
