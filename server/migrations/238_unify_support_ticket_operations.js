/** Unifies ticket concurrency, durable summaries, and summary freshness. */
export async function up(client) {
  await client.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_summaries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      status VARCHAR(24) NOT NULL DEFAULT 'stale',
      summary JSONB,
      source_cursor VARCHAR(320),
      model VARCHAR(120),
      prompt_version VARCHAR(40) NOT NULL DEFAULT 'v1',
      error TEXT,
      generated_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_ticket_summaries_status_ck CHECK (status IN ('stale','generating','current','failed')),
      CONSTRAINT support_ticket_summaries_ticket_uq UNIQUE (user_id, ticket_id)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS support_ticket_summaries_status_idx ON support_ticket_summaries(status, updated_at)`);
  await client.query(`
    INSERT INTO support_ticket_summaries (user_id, ticket_id, status)
    SELECT user_id, id, 'stale' FROM support_tickets
    WHERE deleted_at IS NULL AND status NOT IN ('closed')
    ON CONFLICT (user_id, ticket_id) DO NOTHING
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION mark_support_ticket_summary_stale() RETURNS trigger AS $$
    DECLARE linked_ticket_id INTEGER;
    DECLARE linked_user_id INTEGER;
    BEGIN
      IF TG_TABLE_NAME = 'support_ticket_messages' THEN
        linked_ticket_id := NEW.ticket_id;
        SELECT user_id INTO linked_user_id FROM support_tickets WHERE id = linked_ticket_id;
      ELSIF TG_TABLE_NAME = 'outreach_messages' THEN
        SELECT id, user_id INTO linked_ticket_id, linked_user_id
        FROM support_tickets
        WHERE outreach_conversation_id = NEW.conversation_id AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1;
      ELSE
        SELECT session.ticket_id, member.user_id INTO linked_ticket_id, linked_user_id
        FROM support_chat_sessions session
        JOIN team_members member ON member.id = session.member_id
        WHERE session.id = NEW.session_id;
      END IF;
      IF linked_ticket_id IS NOT NULL AND linked_user_id IS NOT NULL THEN
        INSERT INTO support_ticket_summaries (user_id, ticket_id, status, created_at, updated_at)
        VALUES (linked_user_id, linked_ticket_id, 'stale', NOW(), NOW())
        ON CONFLICT (user_id, ticket_id) DO UPDATE SET status = 'stale', error = NULL, updated_at = NOW();
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`DROP TRIGGER IF EXISTS support_ticket_message_summary_stale_trg ON support_ticket_messages`);
  await client.query(`CREATE TRIGGER support_ticket_message_summary_stale_trg AFTER INSERT ON support_ticket_messages FOR EACH ROW EXECUTE FUNCTION mark_support_ticket_summary_stale()`);
  await client.query(`DROP TRIGGER IF EXISTS outreach_message_summary_stale_trg ON outreach_messages`);
  await client.query(`CREATE TRIGGER outreach_message_summary_stale_trg AFTER INSERT ON outreach_messages FOR EACH ROW EXECUTE FUNCTION mark_support_ticket_summary_stale()`);
  await client.query(`DROP TRIGGER IF EXISTS support_chat_message_summary_stale_trg ON support_chat_messages`);
  await client.query(`CREATE TRIGGER support_chat_message_summary_stale_trg AFTER INSERT ON support_chat_messages FOR EACH ROW EXECUTE FUNCTION mark_support_ticket_summary_stale()`);
}

export async function down(client) {
  await client.query('DROP TRIGGER IF EXISTS support_chat_message_summary_stale_trg ON support_chat_messages');
  await client.query('DROP TRIGGER IF EXISTS outreach_message_summary_stale_trg ON outreach_messages');
  await client.query('DROP TRIGGER IF EXISTS support_ticket_message_summary_stale_trg ON support_ticket_messages');
  await client.query('DROP FUNCTION IF EXISTS mark_support_ticket_summary_stale()');
  await client.query('DROP TABLE IF EXISTS support_ticket_summaries');
  await client.query('ALTER TABLE support_tickets DROP COLUMN IF EXISTS version');
}
