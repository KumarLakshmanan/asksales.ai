import { sql } from "drizzle-orm";
import { db } from "../models/db.js";

export function supportSlaBreachCountSql() {
  return sql<number>`count(*) filter (where sla_deadline is not null and
    (CASE WHEN status IN ('resolved','closed') THEN COALESCE(resolved_at,closed_at) > sla_deadline
      ELSE sla_deadline < now() END))`;
}

/** Preserve the current queue policy: waiting_on_customer has an active
 * absolute deadline. Business calendars and pause budgets need product policy. */
export function supportSlaEventQuery(
  kind: "at_risk" | "breached",
  limit = 200,
) {
  const batch = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : 200;
  const eventType = kind === "breached" ? "sla_breached" : "sla_at_risk";
  const tag = JSON.stringify([eventType]);
  const eventKey = sql`${kind === "breached" ? "sla-breached:" : "sla-at-risk:"} || ticket.id || ':'
    || EXTRACT(EPOCH FROM ticket.sla_deadline)::text || ':'
    || COALESCE(ticket.metadata->>'slaGeneration','initial')`;
  return sql`
    WITH due AS (
      SELECT ticket.*,
        ${eventKey} AS sla_event_key
      FROM support_tickets ticket
      WHERE ticket.deleted_at IS NULL AND ticket.status IN ('open','in_progress','waiting_on_customer')
        AND ticket.sla_deadline IS NOT NULL
        AND ${kind === "breached" ? sql`ticket.sla_deadline < NOW()` : sql`ticket.sla_deadline >= NOW() AND ticket.sla_deadline <= NOW()+INTERVAL '30 minutes'`}
        AND (ticket.metadata->'slaEventReceipts'->>${eventType}) IS DISTINCT FROM ${eventKey}
        AND NOT EXISTS (SELECT 1 FROM support_notification_events event
          WHERE event.business_profile_id=ticket.business_profile_id AND event.user_id=ticket.user_id
            AND (event.event_key=${eventKey} OR (
              COALESCE(ticket.metadata->>'slaGeneration','initial')='initial'
              AND event.event_type=${eventType} AND event.ticket_id=ticket.id AND event.sla_deadline=ticket.sla_deadline)))
      ORDER BY ticket.sla_deadline, ticket.id
      LIMIT ${batch} FOR UPDATE OF ticket SKIP LOCKED
    ), pending AS (
      SELECT due.* FROM due WHERE NOT EXISTS (
        SELECT 1 FROM support_notification_events event
        WHERE event.business_profile_id=due.business_profile_id AND event.user_id=due.user_id
          AND event.event_key=due.sla_event_key
      )
    ), events AS (
      INSERT INTO support_notification_events
        (business_profile_id,user_id,ticket_id,event_type,event_key,assigned_member_id,team_id,
         payload,severity,safe_summary,required_action,sla_deadline,processing_status)
      SELECT business_profile_id,user_id,id,${eventType},sla_event_key,assigned_member_id,team_id,
        jsonb_build_object('ticketId',id,'ticketNumber',ticket_number,'priority',priority,'ticketPath','/support/tickets/'||id),
        ${kind === "breached" ? "urgent" : "high"},
        ${kind === "breached" ? "The response target for this support ticket has been missed." : "The response target for this ticket is approaching."},
        ${kind === "breached" ? "Review, acknowledge, and respond immediately." : "Review and respond before the SLA deadline."},
        sla_deadline,'pending' FROM pending
      ON CONFLICT (business_profile_id,user_id,event_key) DO NOTHING RETURNING ticket_id,event_key
    ), tagged AS (
      UPDATE support_tickets ticket SET tags=CASE
        WHEN COALESCE(ticket.tags,'[]'::jsonb) @> ${tag}::jsonb THEN ticket.tags
        ELSE COALESCE(ticket.tags,'[]'::jsonb)||${tag}::jsonb END,
        metadata=COALESCE(ticket.metadata,'{}'::jsonb)||jsonb_build_object('slaEventReceipts',
          COALESCE(ticket.metadata->'slaEventReceipts','{}'::jsonb)||jsonb_build_object(${eventType}::text,events.event_key))
      FROM events WHERE ticket.id=events.ticket_id RETURNING ticket.id
    ) SELECT COUNT(*)::int AS created FROM tagged
  `;
}

export async function enqueueSupportSlaEvents(database = db) {
  // Each statement commits its event and display tag together. Tags are never
  // authorization/deduplication state, so retries can heal a missing event.
  let created = 0;
  for (const kind of ["at_risk", "breached"] as const) {
    const result = await database.execute(supportSlaEventQuery(kind));
    created += Number(result.rows[0]?.created || 0);
  }
  return created;
}
