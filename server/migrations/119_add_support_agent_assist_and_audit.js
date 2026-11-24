/**
 * Migration 119: Human-agent canned replies and immutable support configuration audit.
 *
 * Kept separate from migration 118 because 118 may already be registered as
 * applied in existing environments.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_rate_limit_buckets (
      bucket_key VARCHAR(96) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel VARCHAR(20) NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_rate_limit_expiry ON support_rate_limit_buckets(expires_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_rate_limit_owner ON support_rate_limit_buckets(user_id, channel, expires_at)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_canned_responses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES support_teams(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      content TEXT NOT NULL,
      channel VARCHAR(20),
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_canned_owner_team ON support_canned_responses(user_id, team_id, is_active)`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_canned_title_scope_uq
    ON support_canned_responses(user_id, COALESCE(team_id, 0), LOWER(title))
    WHERE is_active = TRUE
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_admin_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_type VARCHAR(30) NOT NULL,
      actor_id INTEGER,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(80) NOT NULL,
      entity_id VARCHAR(120),
      before_state JSONB,
      after_state JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_admin_audit_owner_created ON support_admin_audit_logs(user_id, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_admin_audit_entity ON support_admin_audit_logs(user_id, entity_type, entity_id)`);
  await client.query(`
    CREATE OR REPLACE FUNCTION reject_support_admin_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'support_admin_audit_logs is append-only';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_admin_audit_logs_append_only ON support_admin_audit_logs;
    CREATE TRIGGER support_admin_audit_logs_append_only
    BEFORE UPDATE OR DELETE ON support_admin_audit_logs
    FOR EACH ROW EXECUTE FUNCTION reject_support_admin_audit_mutation()
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS support_admin_audit_logs`);
  await client.query(`DROP FUNCTION IF EXISTS reject_support_admin_audit_mutation()`);
  await client.query(`DROP TABLE IF EXISTS support_canned_responses`);
  await client.query(`DROP TABLE IF EXISTS support_rate_limit_buckets`);
}
