/**
 * Repair outreach conversation and provider-message threading.
 *
 * Email conversations are application threads (many per contact). Non-email
 * channels remain one canonical conversation per contact and channel.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_conversations
      ADD COLUMN IF NOT EXISTS thread_key UUID DEFAULT gen_random_uuid();

    UPDATE outreach_conversations
    SET thread_key = gen_random_uuid()
    WHERE thread_key IS NULL;

    ALTER TABLE outreach_conversations
      ALTER COLUMN thread_key SET DEFAULT gen_random_uuid(),
      ALTER COLUMN thread_key SET NOT NULL;

    ALTER TABLE outreach_messages
      ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS rfc_message_id VARCHAR(998);

    UPDATE outreach_messages om
    SET rfc_message_id = om.external_message_id
    FROM outreach_conversations oc
    WHERE oc.id = om.conversation_id
      AND oc.channel IN ('email', 'gmail')
      AND om.rfc_message_id IS NULL
      AND om.external_message_id ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$';

    UPDATE outreach_messages om
    SET provider_message_id = om.external_message_id
    FROM outreach_conversations oc
    WHERE oc.id = om.conversation_id
      AND oc.channel IN ('email', 'gmail')
      AND om.provider_message_id IS NULL
      AND om.external_message_id IS NOT NULL
      AND om.external_message_id !~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$';

    ALTER TABLE outreach_conversations
      DROP CONSTRAINT IF EXISTS outreach_conversations_user_lead_channel_unique;
    DROP INDEX IF EXISTS outreach_conversations_user_lead_channel_uq;

    WITH ranked AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY user_id, lead_id, channel
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS winner_id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, lead_id, channel
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS row_number
      FROM outreach_conversations
      WHERE channel NOT IN ('email', 'gmail')
    )
    UPDATE outreach_messages om
    SET conversation_id = ranked.winner_id
    FROM ranked
    WHERE ranked.row_number > 1
      AND om.conversation_id = ranked.id;

    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, lead_id, channel
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS row_number
      FROM outreach_conversations
      WHERE channel NOT IN ('email', 'gmail')
    )
    DELETE FROM outreach_conversations oc
    USING ranked
    WHERE ranked.row_number > 1
      AND oc.id = ranked.id;

    UPDATE outreach_conversations oc
    SET
      total_messages = counts.total_messages,
      unread_count = counts.unread_count,
      updated_at = GREATEST(oc.updated_at, counts.last_message_at)
    FROM (
      SELECT
        conversation_id,
        COUNT(*)::integer AS total_messages,
        COUNT(*) FILTER (
          WHERE direction = 'inbound' AND COALESCE(is_read, false) = false
        )::integer AS unread_count,
        MAX(created_at) AS last_message_at
      FROM outreach_messages
      GROUP BY conversation_id
    ) counts
    WHERE oc.id = counts.conversation_id
      AND oc.channel NOT IN ('email', 'gmail');

    WITH ranked AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY user_id, lead_id, integration_provider, external_thread_id
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS winner_id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, lead_id, integration_provider, external_thread_id
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS row_number
      FROM outreach_conversations
      WHERE channel IN ('email', 'gmail')
        AND integration_provider IS NOT NULL
        AND external_thread_id IS NOT NULL
    )
    UPDATE outreach_messages om
    SET conversation_id = ranked.winner_id
    FROM ranked
    WHERE ranked.row_number > 1
      AND om.conversation_id = ranked.id;

    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, lead_id, integration_provider, external_thread_id
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS row_number
      FROM outreach_conversations
      WHERE channel IN ('email', 'gmail')
        AND integration_provider IS NOT NULL
        AND external_thread_id IS NOT NULL
    )
    DELETE FROM outreach_conversations oc
    USING ranked
    WHERE ranked.row_number > 1
      AND oc.id = ranked.id;

    UPDATE outreach_conversations oc
    SET
      total_messages = counts.total_messages,
      unread_count = counts.unread_count,
      updated_at = GREATEST(oc.updated_at, counts.last_message_at)
    FROM (
      SELECT
        conversation_id,
        COUNT(*)::integer AS total_messages,
        COUNT(*) FILTER (
          WHERE direction = 'inbound' AND COALESCE(is_read, false) = false
        )::integer AS unread_count,
        MAX(created_at) AS last_message_at
      FROM outreach_messages
      GROUP BY conversation_id
    ) counts
    WHERE oc.id = counts.conversation_id
      AND oc.channel IN ('email', 'gmail');

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_single_channel_uq
      ON outreach_conversations(user_id, lead_id, channel)
      WHERE channel NOT IN ('email', 'gmail');

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_email_thread_key_uq
      ON outreach_conversations(user_id, lead_id, thread_key)
      WHERE channel IN ('email', 'gmail');

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_provider_thread_uq
      ON outreach_conversations(user_id, lead_id, integration_provider, external_thread_id)
      WHERE channel IN ('email', 'gmail')
        AND integration_provider IS NOT NULL
        AND external_thread_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS outreach_messages_provider_message_id_idx
      ON outreach_messages(provider_message_id);
    CREATE INDEX IF NOT EXISTS outreach_messages_rfc_message_id_idx
      ON outreach_messages(rfc_message_id);

    ALTER TABLE followup_sequences
      ADD COLUMN IF NOT EXISTS conversation_id INTEGER;

    UPDATE followup_sequences fs
    SET conversation_id = (
      SELECT oc.id
      FROM outreach_conversations oc
      WHERE oc.user_id = fs.user_id
        AND oc.lead_id = fs.lead_id
        AND oc.channel IN ('email', 'gmail')
        AND (
          oc.subject = fs.initial_subject
          OR EXISTS (
            SELECT 1
            FROM outreach_messages om
            WHERE om.conversation_id = oc.id
              AND om.direction = 'outbound'
              AND om.subject = fs.initial_subject
          )
        )
      ORDER BY ABS(EXTRACT(EPOCH FROM (oc.created_at - fs.initial_sent_at))), oc.id DESC
      LIMIT 1
    )
    WHERE fs.conversation_id IS NULL;

    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'followup_sequences_conversation_id_fkey'
      ) THEN
        ALTER TABLE followup_sequences
          ADD CONSTRAINT followup_sequences_conversation_id_fkey
          FOREIGN KEY (conversation_id)
          REFERENCES outreach_conversations(id)
          ON DELETE SET NULL;
      END IF;
    END
    $migration$;

    CREATE INDEX IF NOT EXISTS followup_sequences_conversation_id_idx
      ON followup_sequences(conversation_id);
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS outreach_messages_rfc_message_id_idx;
    DROP INDEX IF EXISTS outreach_messages_provider_message_id_idx;
    DROP INDEX IF EXISTS outreach_conversations_provider_thread_uq;
    DROP INDEX IF EXISTS outreach_conversations_email_thread_key_uq;
    DROP INDEX IF EXISTS outreach_conversations_single_channel_uq;
    DROP INDEX IF EXISTS followup_sequences_conversation_id_idx;

    ALTER TABLE followup_sequences
      DROP CONSTRAINT IF EXISTS followup_sequences_conversation_id_fkey,
      DROP COLUMN IF EXISTS conversation_id;

    ALTER TABLE outreach_messages
      DROP COLUMN IF EXISTS rfc_message_id,
      DROP COLUMN IF EXISTS provider_message_id;

    ALTER TABLE outreach_conversations
      DROP COLUMN IF EXISTS thread_key;

    -- The previous global uniqueness constraint cannot be restored without
    -- deleting valid multi-thread email data. A rollback intentionally leaves
    -- conversation cardinality unconstrained for operator reconciliation.
  `);
}
