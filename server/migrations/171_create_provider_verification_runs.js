/**
 * Store secret-free evidence from provider, webhook, and DNS verification.
 * Evidence expires so a historical success can never masquerade as current
 * production readiness.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_verification_runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      platform VARCHAR(24) NOT NULL CHECK (platform IN ('facebook','instagram','whatsapp','youtube','gmail','resend')),
      credential_id INTEGER REFERENCES channel_credentials(id) ON DELETE SET NULL,
      provider_account_id VARCHAR(255),
      status VARCHAR(16) NOT NULL CHECK (status IN ('passing','failing','blocked')),
      checks JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
      provider_request_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(provider_request_ids) = 'array'),
      error_code VARCHAR(80),
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_verification_runs_user_platform_idx
      ON provider_verification_runs(user_id, platform, checked_at DESC);
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS provider_verification_runs');
}
