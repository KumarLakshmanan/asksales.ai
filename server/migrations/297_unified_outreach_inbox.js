/** Exact receipt links and a redacted search projection for the outreach inbox. */
export async function up(db) {
  await db.query(`
    SELECT set_config('app.business_system','on',true);
    ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS outreach_message_id INTEGER REFERENCES outreach_messages(id) ON DELETE SET NULL;
    ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS inbox_search_text TEXT;
    ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS inbox_search_text TEXT;
    CREATE INDEX IF NOT EXISTS sent_messages_outreach_message_idx ON sent_messages(outreach_message_id);
    CREATE INDEX IF NOT EXISTS outreach_inbox_activity_idx ON outreach_conversations(user_id, last_message_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS sent_inbox_activity_idx ON sent_messages(user_id, sent_at DESC, id DESC) WHERE outreach_message_id IS NULL;
    CREATE INDEX IF NOT EXISTS outreach_inbox_search_idx ON outreach_messages USING GIN(to_tsvector('simple', COALESCE(inbox_search_text, '')));
    CREATE INDEX IF NOT EXISTS sent_inbox_search_idx ON sent_messages USING GIN(to_tsvector('simple', COALESCE(inbox_search_text, '')));

    CREATE OR REPLACE FUNCTION outreach_inbox_exact_message(s sent_messages) RETURNS INTEGER LANGUAGE sql VOLATILE AS $$
      SELECT CASE WHEN COUNT(*) = 1 THEN MIN(m.id) END
      FROM outreach_messages m JOIN outreach_conversations c ON c.id = m.conversation_id
      WHERE c.user_id = s.user_id AND c.lead_id = s.lead_id
        AND (to_jsonb(c)->>'business_profile_id') IS NOT DISTINCT FROM (to_jsonb(s)->>'business_profile_id')
        AND (CASE WHEN c.channel = 'gmail' THEN 'email' ELSE c.channel END)
          = (CASE WHEN s.channel = 'gmail' THEN 'email' ELSE s.channel END)
        AND m.direction = CASE WHEN s.status = 'received' THEN 'inbound' ELSE 'outbound' END
        AND ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[s.message_id, s.gmail_message_id], NULL), '')
          && ARRAY_REMOVE(ARRAY_REMOVE(ARRAY[m.external_message_id, m.provider_message_id, m.rfc_message_id, m.waba_message_id], NULL), '')
        AND COALESCE(NULLIF(s.message_id, ''), NULLIF(s.gmail_message_id, '')) IS NOT NULL
    $$;
    CREATE OR REPLACE FUNCTION outreach_inbox_sent_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.message IS DISTINCT FROM OLD.message OR NEW.subject IS DISTINCT FROM OLD.subject THEN
        NEW.inbox_search_text := NULL;
      END IF;
      NEW.outreach_message_id := outreach_inbox_exact_message(NEW);
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS outreach_inbox_sent_projection ON sent_messages;
    CREATE TRIGGER outreach_inbox_sent_projection BEFORE INSERT OR UPDATE OF message, subject, message_id, gmail_message_id, user_id, lead_id, channel, status
      ON sent_messages FOR EACH ROW EXECUTE FUNCTION outreach_inbox_sent_projection();

    CREATE OR REPLACE FUNCTION outreach_inbox_message_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content OR NEW.subject IS DISTINCT FROM OLD.subject
        OR NEW.redacted_content IS DISTINCT FROM OLD.redacted_content THEN NEW.inbox_search_text := NULL; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS outreach_inbox_message_projection ON outreach_messages;
    CREATE TRIGGER outreach_inbox_message_projection BEFORE INSERT OR UPDATE OF content, subject, redacted_content
      ON outreach_messages FOR EACH ROW EXECUTE FUNCTION outreach_inbox_message_projection();

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
    DROP TRIGGER IF EXISTS outreach_inbox_link_receipts ON outreach_messages;
    CREATE TRIGGER outreach_inbox_link_receipts AFTER INSERT OR UPDATE OF external_message_id, provider_message_id, rfc_message_id, waba_message_id, conversation_id, direction
      ON outreach_messages FOR EACH ROW EXECUTE FUNCTION outreach_inbox_link_receipts();
    -- Preserve quarantined legacy receipts whose business identity is unresolved.
    UPDATE sent_messages s SET outreach_message_id = outreach_inbox_exact_message(s)
      WHERE outreach_message_id IS NULL
        AND (NOT (to_jsonb(s) ? 'business_profile_id')
          OR to_jsonb(s)->>'business_profile_id' IS NOT NULL);
  `);
}

export async function down(db) {
  await db.query(`
    DROP TRIGGER IF EXISTS outreach_inbox_link_receipts ON outreach_messages;
    DROP TRIGGER IF EXISTS outreach_inbox_message_projection ON outreach_messages;
    DROP TRIGGER IF EXISTS outreach_inbox_sent_projection ON sent_messages;
    DROP FUNCTION IF EXISTS outreach_inbox_link_receipts();
    DROP FUNCTION IF EXISTS outreach_inbox_message_projection();
    DROP FUNCTION IF EXISTS outreach_inbox_sent_projection();
    DROP FUNCTION IF EXISTS outreach_inbox_exact_message(sent_messages);
    DROP INDEX IF EXISTS outreach_inbox_activity_idx;
    DROP INDEX IF EXISTS sent_inbox_activity_idx;
    ALTER TABLE sent_messages DROP COLUMN IF EXISTS outreach_message_id, DROP COLUMN IF EXISTS inbox_search_text;
    ALTER TABLE outreach_messages DROP COLUMN IF EXISTS inbox_search_text;
  `);
}
