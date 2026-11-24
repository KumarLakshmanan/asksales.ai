/**
 * Retire legacy Hermes browser credentials and make outreach provider side
 * effects durable and non-replayable.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_messages
      ADD COLUMN IF NOT EXISTS send_intent_id UUID DEFAULT gen_random_uuid(),
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200),
      ADD COLUMN IF NOT EXISTS provider_call_state VARCHAR(32) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS provider_account_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS confirmation_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS send_attempt_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS send_claimed_at TIMESTAMP;

    UPDATE outreach_messages
    SET send_intent_id = gen_random_uuid()
    WHERE send_intent_id IS NULL;

    ALTER TABLE outreach_messages
      ALTER COLUMN send_intent_id SET DEFAULT gen_random_uuid(),
      ALTER COLUMN send_intent_id SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_send_intent_uq
      ON outreach_messages(send_intent_id);

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_user_idempotency_uq
      ON outreach_messages(user_id, idempotency_key)
      WHERE user_id IS NOT NULL AND idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS outreach_messages_manual_review_idx
      ON outreach_messages(user_id, manual_review_required, created_at);

    ALTER TABLE outreach_messages
      DROP CONSTRAINT IF EXISTS outreach_messages_provider_call_state_check;
    ALTER TABLE outreach_messages
      ADD CONSTRAINT outreach_messages_provider_call_state_check
      CHECK (provider_call_state IN ('not_started', 'started', 'confirmed', 'rejected', 'unknown'));

    -- An in-flight pre-migration send cannot be proven safe to replay.
    UPDATE outreach_messages
    SET
      status = 'manual_review',
      provider_call_state = 'unknown',
      manual_review_required = true,
      error_message = COALESCE(
        error_message,
        'Delivery outcome predates durable send intents. Review provider history before reconciliation.'
      ),
      updated_at = NOW()
    WHERE direction = 'outbound'
      AND status = 'sending';

    ALTER TABLE channel_credentials
      ADD COLUMN IF NOT EXISTS encryption_version VARCHAR(32),
      ADD COLUMN IF NOT EXISTS encryption_key_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS encrypted_at TIMESTAMP;

    CREATE TABLE IF NOT EXISTS hermes_user_mediated_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(32) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      attestation_binding_hash VARCHAR(64),
      initiated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT hermes_user_mediated_sessions_platform_check
        CHECK (platform IN ('instagram', 'facebook', 'twitter', 'linkedin')),
      CONSTRAINT hermes_user_mediated_sessions_status_check
        CHECK (status IN ('pending', 'confirmed', 'expired', 'revoked'))
    );

    CREATE INDEX IF NOT EXISTS hermes_user_mediated_sessions_lookup_idx
      ON hermes_user_mediated_sessions(user_id, platform, status, expires_at);

    -- Disable server-held browser/session credentials without inspecting or
    -- copying secret values. User-mediated attestations above contain no
    -- credentials or provider session state.
    UPDATE channel_credentials
    SET
      is_active = false,
      deactivation_reason = 'legacy_browser_automation_retired',
      deactivated_at = COALESCE(deactivated_at, NOW()),
      updated_at = NOW()
    WHERE platform IN ('instagram', 'facebook', 'twitter', 'linkedin')
      AND (
        credential_type = 'session'
        OR session_cookies IS NOT NULL
        OR api_secret IS NOT NULL
      );
  `);
}

export async function down(client) {
  await client.query(`
    -- Safety/forensic migration: deliberately irreversible.
    --
    -- Do not reactivate retired browser credentials, delete provider-call
    -- evidence, remove idempotency constraints, or discard encryption
    -- migration metadata during an application rollback. A forward corrective
    -- migration requires separate security and data-owner review.
    SELECT 1;
  `);
}
