/**
 * Give AI handoff tickets a tenant-scoped business idempotency key. The
 * existing open-handoff queue is unique per conversation, but ticket creation
 * happens first so concurrent provider deliveries could otherwise leave an
 * extra operator-visible ticket behind.
 */
export async function up(client) {
  await client.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS handoff_key VARCHAR(160)`);
  await client.query(`
    UPDATE support_tickets t
    SET handoff_key = CONCAT(h.channel, ':', h.conversation_id)
    FROM handoff_queue h
    WHERE h.support_ticket_id = t.id
      AND t.category = 'ai_handoff'
      AND t.handoff_key IS NULL
      AND h.status IN ('waiting', 'assigned', 'in_progress')
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_ticket_one_open_handoff_key_uq
    ON support_tickets(user_id, handoff_key)
    WHERE handoff_key IS NOT NULL
      AND deleted_at IS NULL
      AND status NOT IN ('resolved', 'closed')
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS support_ticket_one_open_handoff_key_uq');
  await client.query('ALTER TABLE support_tickets DROP COLUMN IF EXISTS handoff_key');
}
