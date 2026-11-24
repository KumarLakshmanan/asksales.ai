import { sql } from "drizzle-orm";

/** Ticket locks precede queue locks, matching member mutations and claims.
 * Only release the canonical owner if it is still the stale handoff's owner. */
export function recoverStaleSupportHandoffsQuery() {
  return sql`
    WITH candidates AS (
      SELECT ticket.id,ticket.user_id,ticket.assigned_member_id AS previous_member_id
      FROM support_tickets ticket
      WHERE ticket.deleted_at IS NULL AND ticket.status IN ('open','in_progress','waiting_on_customer')
        AND EXISTS (SELECT 1 FROM handoff_queue handoff WHERE handoff.user_id=ticket.user_id
          AND handoff.support_ticket_id=ticket.id AND handoff.status='in_progress'
          AND handoff.assigned_member_id IS NOT DISTINCT FROM ticket.assigned_member_id
          AND COALESCE(handoff.last_customer_message_at,handoff.accepted_at,handoff.updated_at)<NOW()-INTERVAL '30 minutes')
      ORDER BY ticket.id LIMIT 200 FOR UPDATE OF ticket SKIP LOCKED
    ), recovered AS (
      UPDATE handoff_queue handoff SET status='waiting',assigned_member_id=NULL,accepted_at=NULL,
        priority='urgent',version=handoff.version+1,updated_at=NOW()
      FROM candidates ticket WHERE handoff.support_ticket_id=ticket.id AND handoff.user_id=ticket.user_id
        AND handoff.status='in_progress' AND handoff.assigned_member_id IS NOT DISTINCT FROM ticket.previous_member_id
        AND COALESCE(handoff.last_customer_message_at,handoff.accepted_at,handoff.updated_at)<NOW()-INTERVAL '30 minutes'
      RETURNING handoff.support_ticket_id,handoff.user_id
    ), released AS (
      UPDATE support_tickets ticket SET assigned_member_id=NULL,version=ticket.version+1,
        priority=CASE WHEN ticket.priority='critical' THEN 'critical' ELSE 'urgent' END,
        updated_at=NOW(),total_messages=COALESCE(ticket.total_messages,0)+1
      FROM candidates previous WHERE ticket.id=previous.id AND ticket.user_id=previous.user_id
        AND ticket.assigned_member_id IS NOT DISTINCT FROM previous.previous_member_id
        AND EXISTS (SELECT 1 FROM recovered WHERE support_ticket_id=ticket.id AND user_id=ticket.user_id)
      RETURNING ticket.id,ticket.user_id,previous.previous_member_id
    ), history AS (
      INSERT INTO support_ticket_messages(ticket_id,user_id,direction,is_internal,content)
      SELECT id,user_id,'outbound',TRUE,
        'Support claim expired; the ticket returned to the team queue. Previous member: '
          || COALESCE(previous_member_id::text,'Unassigned') FROM released RETURNING id
    ), legacy_candidates AS (
      SELECT id FROM handoff_queue
      WHERE support_ticket_id IS NULL AND status='in_progress'
        AND COALESCE(last_customer_message_at,accepted_at,updated_at)<NOW()-INTERVAL '30 minutes'
      ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED
    ), legacy_recovered AS (
      UPDATE handoff_queue handoff SET status='waiting',assigned_member_id=NULL,accepted_at=NULL,
        priority='urgent',version=handoff.version+1,updated_at=NOW()
      FROM legacy_candidates candidate WHERE handoff.id=candidate.id
        AND handoff.support_ticket_id IS NULL AND handoff.status='in_progress'
      RETURNING handoff.id
    ) SELECT ((SELECT COUNT(*) FROM history)+(SELECT COUNT(*) FROM legacy_recovered))::int AS recovered
  `;
}
