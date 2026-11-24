/**
 * Immutable release-canary audit records. The table deliberately excludes all
 * provider secrets and response payloads; provider_verification_runs stores
 * only the reduced health evidence needed for a production go/no-go decision.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_canary_runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      platform VARCHAR(24) NOT NULL CHECK (platform IN ('facebook','instagram','whatsapp','youtube','gmail','resend')),
      credential_id INTEGER REFERENCES channel_credentials(id) ON DELETE SET NULL,
      requested_account_identifier VARCHAR(255),
      status VARCHAR(16) NOT NULL CHECK (status IN ('planned','passing','failing','blocked')),
      evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      executed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS provider_canary_runs_user_platform_created_idx
      ON provider_canary_runs(user_id, platform, created_at DESC);
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS provider_canary_runs');
}
