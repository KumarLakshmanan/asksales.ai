/**
 * Conversation-scoped follow-up schedules for canonical social threads.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS social_follow_up_schedules (
      id BIGSERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL
        REFERENCES outreach_conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
      channel VARCHAR(24) NOT NULL,
      anchor_message_id INTEGER NOT NULL
        REFERENCES outreach_messages(id) ON DELETE CASCADE,
      steps JSONB NOT NULL,
      next_step INTEGER NOT NULL DEFAULT 1,
      next_run_at TIMESTAMP NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      delivery_message_id INTEGER
        REFERENCES outreach_messages(id) ON DELETE SET NULL,
      cancelled_at TIMESTAMP,
      cancellation_reason VARCHAR(64),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT social_follow_up_schedules_conversation_uq UNIQUE (conversation_id),
      CONSTRAINT social_follow_up_schedules_channel_check
        CHECK (channel IN ('instagram', 'facebook', 'whatsapp')),
      CONSTRAINT social_follow_up_schedules_status_check
        CHECK (status IN ('active', 'queued', 'sending', 'completed', 'cancelled')),
      CONSTRAINT social_follow_up_schedules_next_step_check
        CHECK (next_step > 0),
      CONSTRAINT social_follow_up_schedules_steps_check
        CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) > 0)
    );

    CREATE INDEX IF NOT EXISTS social_follow_up_schedules_due_idx
      ON social_follow_up_schedules(status, next_run_at)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS social_follow_up_schedules_user_channel_idx
      ON social_follow_up_schedules(user_id, channel);

    -- The existing outreach-message invariant applies to social follow-ups too:
    -- a follow-up has an explicit origin and unique origin/step identity.
    COMMENT ON TABLE social_follow_up_schedules IS
      'At most one active or historical automated follow-up schedule per canonical social conversation';
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE IF EXISTS social_follow_up_schedules;
  `);
}
