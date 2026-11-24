/**
 * Migration 082: Concurrency safety — sentinel unique constraints
 *
 * Adds DB-level guards that prevent the rare race condition where two inbound
 * email/DM webhooks arrive simultaneously for the same external message_id and
 * both succeed in inserting a duplicate row before the application-level
 * "already exists" check runs.
 *
 * - sent_messages.reply_message_id (per-user) unique partial index
 * - outreach_messages.external_message_id (per-conversation) unique partial index
 *
 * Also adds DB schema scaffolding consumed by other Sprint-1 fixes:
 * - support_inbound_settings.sentiment_threshold (H7)
 * - reminders.timezone (C8)
 * - reminders.last_sent_at (C7 idempotency marker)
 * - support_tickets.deleted_at (M23 soft-delete)
 * - outreach_conversations.closed_at (M4)
 * - outreach_conversations.metadata_pending_offer_at (M2 — TTL marker)
 */

export async function up(client) {
  // C2 — sent_messages reply_message_id uniqueness per user
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS sent_messages_reply_message_id_user_uniq
    ON sent_messages (user_id, reply_message_id)
    WHERE reply_message_id IS NOT NULL;
  `);

  // C2 — outreach_messages external_message_id uniqueness per conversation
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_external_id_conv_uniq
    ON outreach_messages (conversation_id, external_message_id)
    WHERE external_message_id IS NOT NULL;
  `);

  // H7 — Per-user sentiment threshold for auto-ticket creation
  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS auto_ticket_sentiment_threshold REAL DEFAULT -0.5;
  `);
  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS auto_ticket_urgent_threshold REAL DEFAULT -0.8;
  `);

  // C8 + C7 — Reminder timezone + idempotency
  // Both reminder tables get the same columns
  await client.query(`
    ALTER TABLE crm_activity_reminders
    ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC';
  `);
  await client.query(`
    ALTER TABLE crm_activity_reminders
    ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP;
  `);
  await client.query(`
    ALTER TABLE crm_activity_reminders
    ADD COLUMN IF NOT EXISTS recurrence VARCHAR(32);
  `);

  await client.query(`
    ALTER TABLE proposal_reminders
    ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC';
  `);
  await client.query(`
    ALTER TABLE proposal_reminders
    ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP;
  `);

  // M23 — Soft delete on tickets / conversations
  await client.query(`
    ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_tickets_deleted_at_idx
    ON support_tickets (deleted_at) WHERE deleted_at IS NOT NULL;
  `);

  await client.query(`
    ALTER TABLE outreach_conversations
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
  `);
  await client.query(`
    ALTER TABLE outreach_conversations
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
  `);

  // H11 — Single-use review token tracking
  await client.query(`
    ALTER TABLE support_ticket_reviews
    ADD COLUMN IF NOT EXISTS token_consumed_at TIMESTAMP;
  `);

  // H10 — Widget lead double-opt-in confirmation
  await client.query(`
    ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMP;
  `);
  await client.query(`
    ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS confirmation_token VARCHAR(128);
  `);

  // M5 — User-configurable smart reply tone / brand voice
  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS smart_reply_tone VARCHAR(32) DEFAULT 'professional';
  `);
  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS smart_reply_extra_instructions TEXT;
  `);

  // M16 — Widget chat session expiry
  await client.query(`
    ALTER TABLE support_chat_sessions
    ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMP;
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS sent_messages_reply_message_id_user_uniq;`);
  await client.query(`DROP INDEX IF EXISTS outreach_messages_external_id_conv_uniq;`);
  await client.query(`DROP INDEX IF EXISTS support_tickets_deleted_at_idx;`);

  await client.query(`ALTER TABLE outreach_settings DROP COLUMN IF EXISTS auto_ticket_sentiment_threshold;`);
  await client.query(`ALTER TABLE outreach_settings DROP COLUMN IF EXISTS auto_ticket_urgent_threshold;`);
  await client.query(`ALTER TABLE outreach_settings DROP COLUMN IF EXISTS smart_reply_tone;`);
  await client.query(`ALTER TABLE outreach_settings DROP COLUMN IF EXISTS smart_reply_extra_instructions;`);

  await client.query(`ALTER TABLE crm_activity_reminders DROP COLUMN IF EXISTS timezone;`);
  await client.query(`ALTER TABLE crm_activity_reminders DROP COLUMN IF EXISTS last_sent_at;`);
  await client.query(`ALTER TABLE crm_activity_reminders DROP COLUMN IF EXISTS recurrence;`);
  await client.query(`ALTER TABLE proposal_reminders DROP COLUMN IF EXISTS timezone;`);
  await client.query(`ALTER TABLE proposal_reminders DROP COLUMN IF EXISTS last_sent_at;`);

  await client.query(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS deleted_at;`);
  await client.query(`ALTER TABLE outreach_conversations DROP COLUMN IF EXISTS deleted_at;`);
  await client.query(`ALTER TABLE outreach_conversations DROP COLUMN IF EXISTS closed_at;`);
  await client.query(`ALTER TABLE support_ticket_reviews DROP COLUMN IF EXISTS token_consumed_at;`);
  await client.query(`ALTER TABLE leads DROP COLUMN IF EXISTS email_confirmed_at;`);
  await client.query(`ALTER TABLE leads DROP COLUMN IF EXISTS confirmation_token;`);
  await client.query(`ALTER TABLE support_chat_sessions DROP COLUMN IF EXISTS session_expires_at;`);
}
