// Keeps each send attempt in sent_messages linked to its outreach message, so
// the inbox shows it inside the conversation instead of again as a separate
// "Historical send · read only" thread.
//
// Two triggers from migration 297 recomputed the link from provider message
// IDs on every change and wrote NULL when no ID matched:
//  - outreach_inbox_sent_projection (BEFORE INSERT/UPDATE on sent_messages)
//    overwrote the link the app had just set explicitly, and dropped it again
//    when the attempt's status changed (for example to failed);
//  - outreach_inbox_link_receipts (AFTER UPDATE on outreach_messages) dropped
//    it when a WhatsApp retry cleared the provider IDs on the message
//    (WhatsAppProviderRetry), so every rejected-then-queued send showed twice.
// Both now keep an existing link when the provider IDs give no exact answer.
//
// Existing unlinked attempts are relinked to the latest outbound message in the
// same contact's conversation on the same channel with the same text, created
// no later than the attempt. When multiple conversations qualify, keep the
// attempt separate because this fallback cannot identify the sending account.
export async function up(client) {
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query(`
    CREATE OR REPLACE FUNCTION outreach_inbox_sent_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.message IS DISTINCT FROM OLD.message OR NEW.subject IS DISTINCT FROM OLD.subject THEN
        NEW.inbox_search_text := NULL;
      END IF;
      IF TG_OP = 'UPDATE' AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.lead_id IS DISTINCT FROM OLD.lead_id
        OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.business_profile_id IS DISTINCT FROM OLD.business_profile_id
      ) AND NEW.outreach_message_id IS NOT DISTINCT FROM OLD.outreach_message_id THEN
        NEW.outreach_message_id := NULL;
      END IF;
      NEW.outreach_message_id := COALESCE(outreach_inbox_exact_message(NEW), NEW.outreach_message_id);
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION outreach_inbox_link_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        UPDATE sent_messages s SET outreach_message_id = COALESCE(outreach_inbox_exact_message(s), s.outreach_message_id)
        FROM outreach_conversations c WHERE c.id = OLD.conversation_id AND s.user_id = c.user_id AND s.lead_id = c.lead_id
          AND ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[s.message_id, s.gmail_message_id], NULL), '')
            && ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[OLD.external_message_id, OLD.provider_message_id, OLD.rfc_message_id, OLD.waba_message_id], NULL), '');
      END IF;
      UPDATE sent_messages s SET outreach_message_id = COALESCE(outreach_inbox_exact_message(s), s.outreach_message_id)
      FROM outreach_conversations c WHERE c.id = NEW.conversation_id AND s.user_id = c.user_id AND s.lead_id = c.lead_id
        AND ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[s.message_id, s.gmail_message_id], NULL), '')
          && ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[NEW.external_message_id, NEW.provider_message_id, NEW.rfc_message_id, NEW.waba_message_id], NULL), '');
      RETURN NEW;
    END $$;

    WITH attempt AS (
      SELECT s.id, s.user_id, s.business_profile_id, s.lead_id, s.channel, s.sent_at, s.message
        FROM sent_messages s
       WHERE s.outreach_message_id IS NULL
         AND s.channel IN ('whatsapp','sms','instagram','facebook')
         AND s.business_profile_id IS NOT NULL AND s.lead_id IS NOT NULL
         AND s.message IS NOT NULL AND s.sent_at IS NOT NULL AND s.status <> 'received'
    ), candidates AS (
      SELECT a.id AS sent_id, m.id AS message_id, m.created_at,
        MIN(c.id) OVER (PARTITION BY a.id) AS first_conversation,
        MAX(c.id) OVER (PARTITION BY a.id) AS last_conversation
        FROM attempt a
        JOIN outreach_conversations c ON c.user_id = a.user_id AND c.lead_id = a.lead_id AND c.channel = a.channel
         AND c.business_profile_id = a.business_profile_id
        JOIN outreach_messages m ON m.conversation_id = c.id AND m.user_id = a.user_id
         AND m.direction = 'outbound' AND m.created_at <= a.sent_at AND m.content = a.message
    ), latest AS (
      SELECT DISTINCT ON (sent_id) sent_id, message_id FROM candidates
       WHERE first_conversation = last_conversation
       ORDER BY sent_id, created_at DESC, message_id DESC
    )
    UPDATE sent_messages s SET outreach_message_id = latest.message_id, updated_at = NOW()
      FROM latest
     WHERE s.id = latest.sent_id AND s.outreach_message_id IS NULL
  `);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

// Restores the migration 297 triggers. Links already written stay in place:
// removing them would bring the duplicate inbox threads back.
export async function down(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION outreach_inbox_sent_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.message IS DISTINCT FROM OLD.message OR NEW.subject IS DISTINCT FROM OLD.subject THEN
        NEW.inbox_search_text := NULL;
      END IF;
      NEW.outreach_message_id := outreach_inbox_exact_message(NEW);
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION outreach_inbox_link_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        UPDATE sent_messages s SET outreach_message_id = outreach_inbox_exact_message(s)
        FROM outreach_conversations c WHERE c.id = OLD.conversation_id AND s.user_id = c.user_id AND s.lead_id = c.lead_id
          AND ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[s.message_id, s.gmail_message_id], NULL), '')
            && ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[OLD.external_message_id, OLD.provider_message_id, OLD.rfc_message_id, OLD.waba_message_id], NULL), '');
      END IF;
      UPDATE sent_messages s SET outreach_message_id = outreach_inbox_exact_message(s)
      FROM outreach_conversations c WHERE c.id = NEW.conversation_id AND s.user_id = c.user_id AND s.lead_id = c.lead_id
        AND ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[s.message_id, s.gmail_message_id], NULL), '')
          && ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[NEW.external_message_id, NEW.provider_message_id, NEW.rfc_message_id, NEW.waba_message_id], NULL), '');
      RETURN NEW;
    END $$;
  `);
}
