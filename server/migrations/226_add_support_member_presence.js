/**
 * Track support-portal presence independently from account enablement and add
 * tenant-scoped capacity settings used for queue-aware response targets.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_member_presence_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      session_fingerprint VARCHAR(64) NOT NULL,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMP,
      end_reason VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_presence_end_reason_chk CHECK (
        end_reason IS NULL OR end_reason IN ('logout', 'inactivity', 'revoked', 'disabled', 'expired')
      ),
      CONSTRAINT support_presence_time_order_chk CHECK (
        ended_at IS NULL OR ended_at >= started_at
      ),
      CONSTRAINT support_presence_fingerprint_length_chk CHECK (length(session_fingerprint) = 64)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_presence_member_last_seen
      ON support_member_presence_sessions(user_id, member_id, last_seen_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_presence_open
      ON support_member_presence_sessions(user_id, last_seen_at DESC)
      WHERE ended_at IS NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_presence_one_open_session_uq
      ON support_member_presence_sessions(user_id, member_id, session_fingerprint)
      WHERE ended_at IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_capacity_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      handling_minutes_per_ticket INTEGER NOT NULL DEFAULT 5,
      social_fallback_sla_minutes INTEGER NOT NULL DEFAULT 30,
      email_fallback_sla_minutes INTEGER NOT NULL DEFAULT 240,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_capacity_handling_chk CHECK (handling_minutes_per_ticket BETWEEN 1 AND 120),
      CONSTRAINT support_capacity_social_chk CHECK (social_fallback_sla_minutes BETWEEN 1 AND 1440),
      CONSTRAINT support_capacity_email_chk CHECK (email_fallback_sla_minutes BETWEEN 1 AND 10080)
    )
  `);
  await client.query(`ALTER TABLE support_ticket_messages ADD COLUMN IF NOT EXISTS member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_member_created ON support_ticket_messages(member_id, created_at DESC)`);

  // Historical moderation outages produced handoffs even for harmless greetings.
  // Preserve the rows and conversation ownership, but close only queue items that
  // were never claimed and received no human ticket reply.
  await client.query(`
    UPDATE handoff_queue h
    SET status = 'resolved',
        resolution = 'moderation_unavailable_reconciled',
        resolved_at = COALESCE(h.resolved_at, NOW()),
        updated_at = NOW(),
        version = h.version + 1
    WHERE h.status IN ('waiting', 'assigned', 'in_progress')
      AND h.accepted_at IS NULL
      AND LOWER(COALESCE(h.reason, '')) LIKE '%moderation_unavailable%'
      AND NOT EXISTS (
        SELECT 1 FROM support_ticket_messages stm
        WHERE stm.ticket_id = h.support_ticket_id
          AND stm.direction = 'outbound'
          AND COALESCE(stm.is_internal, FALSE) = FALSE
      )
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS idx_support_ticket_messages_member_created');
  await client.query('ALTER TABLE support_ticket_messages DROP COLUMN IF EXISTS member_id');
  await client.query('DROP INDEX IF EXISTS support_presence_one_open_session_uq');
  await client.query('DROP TABLE IF EXISTS support_member_presence_sessions');
  await client.query('DROP TABLE IF EXISTS support_capacity_settings');
}
