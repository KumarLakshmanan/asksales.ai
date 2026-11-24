import { sql } from "drizzle-orm";

/** Same precedence as ticket enrichment: the newest active handoff, then the
 * persisted conversation/widget ownership, including retained-human resolution. */
export function supportTicketOwnershipSql() {
  // Fixed identifiers preserve correlation when Drizzle builds a SELECT.
  const id = sql.raw('"support_tickets"."id"');
  const userId = sql.raw('"support_tickets"."user_id"');
  const conversationId = sql.raw(
    '"support_tickets"."outreach_conversation_id"',
  );
  return sql`COALESCE(
    (SELECT CASE WHEN handoff.ai_reply_enabled=FALSE THEN 'human_owned' ELSE 'ai_active' END
      FROM handoff_queue handoff WHERE handoff.support_ticket_id=${id} AND handoff.user_id=${userId}
        AND handoff.status IN ('waiting','assigned','in_progress') ORDER BY handoff.created_at DESC,handoff.id DESC LIMIT 1),
    (SELECT conversation.automation_mode FROM outreach_conversations conversation
      WHERE conversation.id=${conversationId} AND conversation.user_id=${userId}),
    (SELECT session.automation_mode FROM support_chat_sessions session JOIN team_members member ON member.id=session.member_id
      WHERE session.ticket_id=${id} AND member.user_id=${userId} ORDER BY session.created_at DESC,session.id DESC LIMIT 1),
    'ai_active')`;
}
