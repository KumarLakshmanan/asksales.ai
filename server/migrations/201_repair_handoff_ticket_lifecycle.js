/**
 * Link legacy handoffs to the single open ticket for the same tenant and
 * conversation. Ambiguous matches are deliberately left untouched.
 */
export async function up(client) {
  await client.query(`
    WITH unambiguous AS (
      SELECT h.id AS handoff_id, MIN(t.id) AS ticket_id
      FROM handoff_queue h
      JOIN support_tickets t
        ON t.user_id = h.user_id
       AND t.outreach_conversation_id = h.conversation_id
       AND t.status NOT IN ('resolved', 'closed')
       AND t.deleted_at IS NULL
      WHERE h.support_ticket_id IS NULL
        AND h.status IN ('waiting', 'assigned', 'in_progress')
        AND h.conversation_id > 0
      GROUP BY h.id
      HAVING COUNT(*) = 1
    )
    UPDATE handoff_queue h
    SET support_ticket_id = u.ticket_id,
        updated_at = NOW(),
        version = h.version + 1
    FROM unambiguous u
    WHERE h.id = u.handoff_id;
  `);
}

// This repair establishes missing ownership links and is intentionally
// irreversible; removing them would restore the split lifecycle defect.
export async function down() {}
