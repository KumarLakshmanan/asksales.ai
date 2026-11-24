/**
 * Makes public support-widget requests safely retryable.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE support_chat_messages
      ADD COLUMN IF NOT EXISTS request_id VARCHAR(160);

    CREATE UNIQUE INDEX IF NOT EXISTS support_chat_messages_session_request_uq
      ON support_chat_messages(session_id, request_id)
      WHERE request_id IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS support_chat_messages_session_request_uq;
    ALTER TABLE support_chat_messages
      DROP COLUMN IF EXISTS request_id;
  `);
}
