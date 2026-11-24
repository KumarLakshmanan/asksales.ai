/**
 * Add secretless readiness metadata for documented API/OAuth delivery.
 *
 * Existing credentials deliberately remain unverified. An operator-controlled
 * credential rotation/re-authorization process must populate these fields
 * after confirming encryption, provider scopes, app approval, API version, and
 * account ownership. The migration never selects or emits secret contents.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE channel_credentials
      ADD COLUMN IF NOT EXISTS granted_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS provider_approval_status VARCHAR(24) NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS provider_api_version VARCHAR(32),
      ADD COLUMN IF NOT EXISTS provider_verified_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_readiness_check_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS readiness_error_code VARCHAR(64);

    ALTER TABLE channel_credentials
      DROP CONSTRAINT IF EXISTS channel_credentials_granted_scopes_array_check;
    ALTER TABLE channel_credentials
      ADD CONSTRAINT channel_credentials_granted_scopes_array_check
      CHECK (jsonb_typeof(granted_scopes) = 'array');

    ALTER TABLE channel_credentials
      DROP CONSTRAINT IF EXISTS channel_credentials_provider_approval_check;
    ALTER TABLE channel_credentials
      ADD CONSTRAINT channel_credentials_provider_approval_check
      CHECK (provider_approval_status IN (
        'unknown', 'pending', 'approved', 'denied', 'not_required'
      ));

    UPDATE channel_credentials
    SET readiness_error_code = COALESCE(
          readiness_error_code,
          'OFFICIAL_PROVIDER_REAUTHORIZATION_REQUIRED'
        ),
        last_readiness_check_at = COALESCE(last_readiness_check_at, NOW()),
        updated_at = NOW()
    WHERE is_active = true
      AND platform IN (
        'facebook_api',
        'instagram_api',
        'whatsapp',
        'twitter_api',
        'linkedin_api',
        'gmail_api'
      )
      AND (
        provider_verified_at IS NULL
        OR encryption_version IS NULL
        OR encryption_key_id IS NULL
        OR encrypted_at IS NULL
      );

    CREATE INDEX IF NOT EXISTS channel_credentials_official_readiness_idx
      ON channel_credentials(
        user_id,
        platform,
        is_active,
        provider_approval_status,
        provider_verified_at
      );
  `);
}

export async function down(client) {
  await client.query(`
    -- Security/forensic migration: deliberately irreversible.
    --
    -- Removing readiness evidence would make legacy or unverified credentials
    -- appear usable again. Use a forward migration after security review.
    SELECT 1;
  `);
}
