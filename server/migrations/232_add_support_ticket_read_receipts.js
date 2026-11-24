/**
 * Migration 232: reader-scoped support ticket cursors.
 *
 * The legacy support_tickets.unread_count value is shared by every owner and
 * support member. Opening a ticket in one surface therefore cleared the badge
 * for everybody else. Reader cursors preserve the legacy column for rollback
 * while making the operational queue truthful for each viewer.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_read_receipts (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      reader_kind VARCHAR(16) NOT NULL,
      reader_id INTEGER NOT NULL,
      last_read_message_id INTEGER REFERENCES support_ticket_messages(id) ON DELETE SET NULL,
      last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_ticket_read_receipts_reader_kind_ck
        CHECK (reader_kind IN ('owner', 'member')),
      CONSTRAINT support_ticket_read_receipts_reader_id_ck CHECK (reader_id > 0),
      UNIQUE (user_id, ticket_id, reader_kind, reader_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_ticket_read_receipts_reader
    ON support_ticket_read_receipts(user_id, reader_kind, reader_id, last_read_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_ticket_read_receipts_ticket
    ON support_ticket_read_receipts(ticket_id, reader_kind, reader_id)
  `);
  await client.query(`
    INSERT INTO support_ticket_read_receipts (
      user_id, ticket_id, reader_kind, reader_id, last_read_message_id, last_read_at, created_at, updated_at
    )
    SELECT ticket.user_id, ticket.id, 'owner', ticket.user_id, cursor.id,
      COALESCE(ticket.updated_at, NOW()), NOW(), NOW()
    FROM support_tickets ticket
    LEFT JOIN LATERAL (
      SELECT message.id
      FROM support_ticket_messages message
      WHERE message.ticket_id = ticket.id
        AND message.direction = 'inbound'
        AND COALESCE(message.is_internal, FALSE) = FALSE
      ORDER BY message.id DESC
      OFFSET GREATEST(COALESCE(ticket.unread_count, 0), 0)
      LIMIT 1
    ) cursor ON TRUE
    WHERE ticket.deleted_at IS NULL
      AND cursor.id IS NOT NULL
    ON CONFLICT (user_id, ticket_id, reader_kind, reader_id) DO NOTHING
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_ticket_read_receipts');
}
