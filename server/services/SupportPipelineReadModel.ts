import { sql } from 'drizzle-orm';

/** Only fields displayed on pipeline cards; full reply/delivery audits belong to the ticket workspace. */
export function supportPipelineDetailsQuery(userId: number, ticketIds: number[], reader: { kind: 'owner' | 'member'; id: number }) {
  return sql`
    SELECT ticket.id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', contact.first_name, contact.last_name)), ''),
        NULLIF(lead.full_name, ''), NULLIF(lead.name, ''),
        NULLIF(conversation.lead_name, ''), 'Unlinked customer') AS customer_name,
      member.name AS assigned_member_name,
      COALESCE(unread.count, 0)::int AS operational_unread_count
    FROM support_tickets ticket
    LEFT JOIN crm_contacts contact ON contact.id=ticket.contact_id AND contact.user_id=ticket.user_id
    LEFT JOIN leads lead ON lead.id=ticket.lead_id AND lead.user_id=ticket.user_id
    LEFT JOIN outreach_conversations conversation ON conversation.id=ticket.outreach_conversation_id AND conversation.user_id=ticket.user_id
    LEFT JOIN team_members member ON member.id=ticket.assigned_member_id AND member.user_id=ticket.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS count FROM support_ticket_messages message
      WHERE message.ticket_id=ticket.id AND message.direction='inbound'
        AND COALESCE(message.is_internal, FALSE)=FALSE
        AND message.id>COALESCE((SELECT receipt.last_read_message_id
          FROM support_ticket_read_receipts receipt
          WHERE receipt.user_id=ticket.user_id AND receipt.ticket_id=ticket.id
            AND receipt.reader_kind=${reader.kind} AND receipt.reader_id=${reader.id}), 0)
    ) unread ON TRUE
    WHERE ticket.user_id=${userId} AND ticket.deleted_at IS NULL
      AND ticket.id IN (${sql.join(ticketIds.map(id => sql`${id}`), sql`, `)})
  `;
}

export function mergeSupportPipelineDetails<T extends { id: number }>(tickets: T[], rows: Array<Record<string, unknown>>) {
  const details = new Map(rows.map(row => [Number(row.id), row]));
  return tickets.map(ticket => {
    const row = details.get(ticket.id);
    return { ...ticket, customerName: row?.customer_name || 'Unlinked customer',
      assignedMemberName: row?.assigned_member_name || null,
      operationalUnreadCount: Number(row?.operational_unread_count || 0) };
  });
}
