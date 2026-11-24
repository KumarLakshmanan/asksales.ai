/**
 * Durable, per-agent support notifications.
 *
 * This migration is deliberately repair-safe: an early development build
 * created only the legacy delivery table and JSON preference column. Every
 * statement below can therefore run against either a clean database or that
 * partial schema without discarding delivery history.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE team_members
      ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL
      DEFAULT '{
        "email":{"enabled":false,"recipient":""},
        "instagram":{"enabled":false,"recipient":""},
        "whatsapp":{"enabled":false,"recipient":""},
        "facebook":{"enabled":false,"recipient":""}
      }'::jsonb
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_destinations (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES support_teams(id) ON DELETE CASCADE,
      member_id INTEGER REFERENCES team_members(id) ON DELETE CASCADE,
      channel VARCHAR(20) NOT NULL
        CHECK (channel IN ('email', 'instagram', 'facebook', 'whatsapp')),
      destination_ciphertext TEXT NOT NULL,
      destination_hash VARCHAR(64) NOT NULL,
      destination_hint VARCHAR(255) NOT NULL,
      verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified'
        CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed')),
      verification_code_hash VARCHAR(64),
      verification_expires_at TIMESTAMP,
      verified_at TIMESTAMP,
      created_by_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_destination_member_uq
    ON support_notification_destinations(member_id, channel)
    WHERE member_id IS NOT NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_destination_team_uq
    ON support_notification_destinations(team_id, channel)
    WHERE member_id IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_preferences (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES support_teams(id) ON DELETE CASCADE,
      member_id INTEGER REFERENCES team_members(id) ON DELETE CASCADE,
      event_type VARCHAR(40) NOT NULL
        CHECK (event_type IN ('new_ticket_assignment', 'human_handoff')),
      channel VARCHAR(20) NOT NULL
        CHECK (channel IN ('email', 'instagram', 'facebook', 'whatsapp')),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      destination_id BIGINT REFERENCES support_notification_destinations(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_preference_member_uq
    ON support_notification_preferences(member_id, event_type, channel)
    WHERE member_id IS NOT NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_preference_team_uq
    ON support_notification_preferences(team_id, event_type, channel)
    WHERE member_id IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      handoff_id INTEGER REFERENCES handoff_queue(id) ON DELETE SET NULL,
      event_type VARCHAR(40) NOT NULL
        CHECK (event_type IN ('new_ticket_assignment', 'human_handoff')),
      event_key VARCHAR(180) NOT NULL,
      assigned_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, event_key)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_notification_events_ticket
    ON support_notification_events(ticket_id, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_receipts (
      id BIGSERIAL PRIMARY KEY,
      event_id BIGINT NOT NULL REFERENCES support_notification_events(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      read_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, member_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_notification_receipts_unread
    ON support_notification_receipts(member_id, created_at DESC)
    WHERE read_at IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_member_notification_deliveries (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      event_id BIGINT REFERENCES support_notification_events(id) ON DELETE CASCADE,
      event_type VARCHAR(40) NOT NULL,
      event_key VARCHAR(180) NOT NULL,
      channel VARCHAR(20) NOT NULL,
      destination_id BIGINT REFERENCES support_notification_destinations(id) ON DELETE SET NULL,
      recipient VARCHAR(255),
      recipient_ciphertext TEXT,
      destination_hint VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
      provider_message_id VARCHAR(255),
      provider_status VARCHAR(80),
      error_code VARCHAR(80),
      last_error TEXT,
      fallback_of_delivery_id BIGINT REFERENCES support_member_notification_deliveries(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMP,
      UNIQUE(event_key, member_id, channel)
    )
  `);
  await client.query(`
    ALTER TABLE support_member_notification_deliveries
      ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES support_notification_events(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS destination_id BIGINT REFERENCES support_notification_destinations(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS recipient_ciphertext TEXT,
      ADD COLUMN IF NOT EXISTS destination_hint VARCHAR(255),
      ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS provider_status VARCHAR(80),
      ADD COLUMN IF NOT EXISTS error_code VARCHAR(80),
      ADD COLUMN IF NOT EXISTS fallback_of_delivery_id BIGINT REFERENCES support_member_notification_deliveries(id) ON DELETE SET NULL
  `);
  await client.query(`
    ALTER TABLE support_member_notification_deliveries
      ALTER COLUMN recipient DROP NOT NULL
  `);
  await client.query(`
    ALTER TABLE support_member_notification_deliveries
      DROP CONSTRAINT IF EXISTS support_member_notification_deliveries_event_type_check,
      DROP CONSTRAINT IF EXISTS support_member_notification_deliveries_channel_check,
      DROP CONSTRAINT IF EXISTS support_member_notification_deliveries_status_check
  `);
  await client.query(`
    ALTER TABLE support_member_notification_deliveries
      ADD CONSTRAINT support_member_notification_deliveries_event_type_check
        CHECK (event_type IN ('ticket_created', 'new_ticket_assignment', 'human_handoff')),
      ADD CONSTRAINT support_member_notification_deliveries_channel_check
        CHECK (channel IN ('email', 'instagram', 'facebook', 'whatsapp')),
      ADD CONSTRAINT support_member_notification_deliveries_status_check
        CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed', 'cancelled', 'suppressed'))
  `);
  await client.query(`
    UPDATE support_member_notification_deliveries
    SET recipient_ciphertext = recipient,
        destination_hint = COALESCE(destination_hint, recipient)
    WHERE recipient_ciphertext IS NULL AND recipient IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_member_notification_delivery_status
    ON support_member_notification_deliveries(status, next_attempt_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_member_notification_delivery_member
    ON support_member_notification_deliveries(member_id, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      actor_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      actor_type VARCHAR(20) NOT NULL
        CHECK (actor_type IN ('owner', 'member', 'system')),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id BIGINT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_notification_audit_user
    ON support_notification_audit_logs(user_id, created_at DESC)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS support_notification_audit_logs`);
  await client.query(`DROP TABLE IF EXISTS support_member_notification_deliveries`);
  await client.query(`DROP TABLE IF EXISTS support_notification_receipts`);
  await client.query(`DROP TABLE IF EXISTS support_notification_events`);
  await client.query(`DROP TABLE IF EXISTS support_notification_preferences`);
  await client.query(`DROP TABLE IF EXISTS support_notification_destinations`);
  await client.query(`ALTER TABLE team_members DROP COLUMN IF EXISTS notification_preferences`);
}
