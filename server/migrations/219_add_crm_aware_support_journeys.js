/**
 * CRM-aware support journeys.
 *
 * Channel identities are encrypted and matched by a tenant-bound fingerprint.
 * Conversations retain a direct CRM contact reference so playbook hydration
 * never needs to infer identity from model-visible text.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_contact_channel_identities (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      channel VARCHAR(50) NOT NULL,
      identifier_type VARCHAR(50) NOT NULL,
      identifier_fingerprint VARCHAR(96) NOT NULL,
      encrypted_identifier JSONB,
      verification_level VARCHAR(32) NOT NULL DEFAULT 'provider',
      source VARCHAR(100) NOT NULL DEFAULT 'inbound',
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT crm_contact_channel_identities_verification_ck
        CHECK (verification_level IN ('provider', 'customer_verified', 'owner_verified')),
      CONSTRAINT crm_contact_channel_identities_user_channel_uq
        UNIQUE (user_id, channel, identifier_fingerprint)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS crm_contact_channel_identities_contact_idx
      ON crm_contact_channel_identities(user_id, contact_id, last_seen_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS crm_contact_channel_identities_identifier_idx
      ON crm_contact_channel_identities(user_id, identifier_type, identifier_fingerprint)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_contact_identity_conflicts (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES outreach_conversations(id) ON DELETE SET NULL,
      identifier_type VARCHAR(50) NOT NULL,
      identifier_fingerprint VARCHAR(96) NOT NULL,
      candidate_contact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(24) NOT NULL DEFAULT 'pending_review',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT crm_contact_identity_conflicts_status_ck
        CHECK (status IN ('pending_review', 'resolved', 'dismissed'))
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS crm_contact_identity_conflicts_pending_uq
      ON crm_contact_identity_conflicts(user_id, identifier_type, identifier_fingerprint)
      WHERE status = 'pending_review'
  `);
  await client.query(`
    ALTER TABLE outreach_conversations
      ADD COLUMN IF NOT EXISTS crm_contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS outreach_conversations_crm_contact_idx
      ON outreach_conversations(user_id, crm_contact_id)
  `);
  await client.query(`
    UPDATE outreach_conversations oc
    SET crm_contact_id = cc.id
    FROM crm_contacts cc
    WHERE oc.crm_contact_id IS NULL
      AND cc.user_id = oc.user_id
      AND cc.lead_id = oc.lead_id
      AND cc.deleted_at IS NULL
  `);
  await client.query(`
    ALTER TABLE support_playbooks
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE
  `);
  await client.query(`
    ALTER TABLE crm_activities
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS crm_activities_user_idempotency_uq
      ON crm_activities(user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS crm_activities_user_idempotency_uq');
  await client.query('ALTER TABLE crm_activities DROP COLUMN IF EXISTS idempotency_key');
  await client.query('ALTER TABLE support_playbooks DROP COLUMN IF EXISTS enabled');
  await client.query('DROP INDEX IF EXISTS outreach_conversations_crm_contact_idx');
  await client.query('ALTER TABLE outreach_conversations DROP COLUMN IF EXISTS crm_contact_id');
  await client.query('DROP TABLE IF EXISTS crm_contact_identity_conflicts');
  await client.query('DROP TABLE IF EXISTS crm_contact_channel_identities');
}
