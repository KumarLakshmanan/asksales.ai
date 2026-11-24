/**
 * Make email follow-up ownership, cancellation, and per-step idempotency durable.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_messages
      ADD COLUMN IF NOT EXISTS message_kind VARCHAR(24) NOT NULL DEFAULT 'outreach',
      ADD COLUMN IF NOT EXISTS follow_up_origin_message_id INTEGER,
      ADD COLUMN IF NOT EXISTS follow_up_step INTEGER,
      ADD COLUMN IF NOT EXISTS follow_up_cancelled_at TIMESTAMP;

    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'outreach_messages_follow_up_origin_message_id_fkey'
      ) THEN
        ALTER TABLE outreach_messages
          ADD CONSTRAINT outreach_messages_follow_up_origin_message_id_fkey
          FOREIGN KEY (follow_up_origin_message_id)
          REFERENCES outreach_messages(id)
          ON DELETE SET NULL;
      END IF;
    END
    $migration$;

    UPDATE outreach_messages
    SET message_kind = 'reply'
    WHERE direction = 'inbound';

    -- Legacy follow-ups were explicitly persisted in sent_messages as
    -- is_reply=true + follow_up_step. Keep them non-eligible without inventing
    -- a parent when historical data cannot prove one.
    UPDATE outreach_messages message
    SET message_kind = 'reply'
    FROM sent_messages legacy
    WHERE message.direction = 'outbound'
      AND message.message_kind = 'outreach'
      AND legacy.user_id = message.user_id
      AND legacy.is_reply = true
      AND legacy.follow_up_step IS NOT NULL
      AND (
        legacy.message_id = message.provider_message_id
        OR legacy.message_id = message.external_message_id
        OR legacy.message_id = message.rfc_message_id
      );

    -- Preserve the progress of legacy originals so an already delivered step
    -- is not sent again after the scheduler switches to outreach_messages.
    UPDATE outreach_messages origin
    SET follow_up_step = legacy.follow_up_step
    FROM sent_messages legacy
    WHERE origin.direction = 'outbound'
      AND origin.message_kind = 'outreach'
      AND legacy.user_id = origin.user_id
      AND legacy.is_reply = false
      AND legacy.follow_up_step BETWEEN 1 AND 9998
      AND (
        legacy.message_id = origin.provider_message_id
        OR legacy.message_id = origin.external_message_id
        OR legacy.message_id = origin.rfc_message_id
      );

    UPDATE outreach_messages origin
    SET follow_up_cancelled_at = COALESCE(origin.follow_up_cancelled_at, NOW())
    WHERE origin.direction = 'outbound'
      AND origin.message_kind = 'outreach'
      AND (
        EXISTS (
          SELECT 1
          FROM outreach_messages reply
          WHERE reply.conversation_id = origin.conversation_id
            AND reply.direction = 'inbound'
            AND reply.created_at > COALESCE(origin.sent_at, origin.created_at)
        )
        OR EXISTS (
          SELECT 1
          FROM sent_messages legacy
          WHERE legacy.user_id = origin.user_id
            AND legacy.is_reply = false
            AND legacy.follow_up_step >= 9999
            AND (
              legacy.message_id = origin.provider_message_id
              OR legacy.message_id = origin.external_message_id
              OR legacy.message_id = origin.rfc_message_id
            )
        )
      );

    CREATE INDEX IF NOT EXISTS outreach_messages_follow_up_origin_idx
      ON outreach_messages(follow_up_origin_message_id);

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_follow_up_origin_step_uq
      ON outreach_messages(follow_up_origin_message_id, follow_up_step)
      WHERE message_kind = 'follow_up'
        AND follow_up_origin_message_id IS NOT NULL
        AND follow_up_step IS NOT NULL;

    ALTER TABLE outreach_messages
      DROP CONSTRAINT IF EXISTS outreach_messages_follow_up_kind_check;
    ALTER TABLE outreach_messages
      ADD CONSTRAINT outreach_messages_follow_up_kind_check
      CHECK (
        (message_kind = 'follow_up'
          AND follow_up_origin_message_id IS NOT NULL
          AND follow_up_step IS NOT NULL
          AND follow_up_step > 0)
        OR
        (message_kind IN ('outreach', 'reply')
          AND follow_up_origin_message_id IS NULL)
      ) NOT VALID;
    ALTER TABLE outreach_messages
      VALIDATE CONSTRAINT outreach_messages_follow_up_kind_check;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE outreach_messages
      DROP CONSTRAINT IF EXISTS outreach_messages_follow_up_kind_check;
    DROP INDEX IF EXISTS outreach_messages_follow_up_origin_step_uq;
    DROP INDEX IF EXISTS outreach_messages_follow_up_origin_idx;
    ALTER TABLE outreach_messages
      DROP CONSTRAINT IF EXISTS outreach_messages_follow_up_origin_message_id_fkey,
      DROP COLUMN IF EXISTS follow_up_cancelled_at,
      DROP COLUMN IF EXISTS follow_up_step,
      DROP COLUMN IF EXISTS follow_up_origin_message_id,
      DROP COLUMN IF EXISTS message_kind;
  `);
}
