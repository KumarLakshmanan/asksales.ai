/** Preserve MIME semantics for Gmail receipts; unknown historical formats remain null. */
export async function up(db) {
  await db.query(`
    SELECT set_config('app.business_system','on',true);
    ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS message_format VARCHAR(4)
      CHECK (message_format IN ('text','html'));
    CREATE OR REPLACE FUNCTION outreach_inbox_format_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.message_format IS DISTINCT FROM OLD.message_format THEN NEW.inbox_search_text := NULL; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS outreach_inbox_format_projection ON sent_messages;
    CREATE TRIGGER outreach_inbox_format_projection BEFORE UPDATE OF message_format
      ON sent_messages FOR EACH ROW EXECUTE FUNCTION outreach_inbox_format_projection();
    CREATE OR REPLACE FUNCTION outreach_inbox_html_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.html_content IS DISTINCT FROM OLD.html_content THEN NEW.inbox_search_text := NULL; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS outreach_inbox_html_projection ON outreach_messages;
    CREATE TRIGGER outreach_inbox_html_projection BEFORE UPDATE OF html_content
      ON outreach_messages FOR EACH ROW EXECUTE FUNCTION outreach_inbox_html_projection();
    -- Only derived search fields change. The text conversion contract applies to
    -- all inbox channels, so invalidate both existing projections for rebuilding.
    UPDATE sent_messages SET inbox_search_text=NULL WHERE inbox_search_text IS NOT NULL;
    UPDATE outreach_messages SET inbox_search_text=NULL WHERE inbox_search_text IS NOT NULL;
  `);
}

export async function down(db) {
  await db.query(`
    DROP TRIGGER IF EXISTS outreach_inbox_html_projection ON outreach_messages;
    DROP FUNCTION IF EXISTS outreach_inbox_html_projection();
    DROP TRIGGER IF EXISTS outreach_inbox_format_projection ON sent_messages;
    DROP FUNCTION IF EXISTS outreach_inbox_format_projection();
    ALTER TABLE sent_messages DROP COLUMN IF EXISTS message_format;
  `);
}
