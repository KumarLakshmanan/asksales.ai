import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { supportTicketsTable } from "../models/supportTickets/schema.js";

export type LockedSupportTicket = typeof supportTicketsTable.$inferSelect;
export interface TicketMutationContext {
  expectedVersion?: number;
  allowClaim?: boolean;
  requireManage?: boolean;
  expectedTeamId?: number;
  actorMemberId?: number;
  actorUserId?: number;
  database?: typeof db;
  resumeAi?: boolean;
  handoffResolution?: string;
  expectedHandoffId?: number;
}

export class TicketMutationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 404 | 409,
    readonly code: string,
  ) {
    super(message);
    this.name = "TicketMutationError";
  }
}

/** All authorization reads and effects share the ticket lock. In particular,
 * an omitted client version never turns a stale assignment read into authority.
 * Lock tickets before handoffs everywhere to give recovery a consistent order. */
export async function withLockedSupportTicket<T>(
  userId: number,
  ticketId: number,
  context: TicketMutationContext,
  operation: (tx: typeof db, ticket: LockedSupportTicket) => Promise<T>,
): Promise<T> {
  const work = async (tx: typeof db) => {
    const [ticket] = await tx
      .select()
      .from(supportTicketsTable)
      .where(
        and(
          eq(supportTicketsTable.id, ticketId),
          eq(supportTicketsTable.userId, userId),
          isNull(supportTicketsTable.deletedAt),
        ),
      )
      .for("update");
    if (!ticket)
      throw new TicketMutationError(
        "Ticket not found",
        404,
        "TICKET_NOT_FOUND",
      );
    if (
      (context.expectedVersion !== undefined &&
        ticket.version !== context.expectedVersion) ||
      (context.expectedTeamId !== undefined &&
        ticket.teamId !== context.expectedTeamId)
    ) {
      throw new TicketMutationError(
        "This ticket changed before your update was saved",
        409,
        "TICKET_VERSION_CONFLICT",
      );
    }
    if (context.actorMemberId !== undefined) {
      const result = await tx.execute(sql`
        SELECT member.id, member.team_id, member.role
        FROM team_members member
        JOIN support_teams team ON team.id=member.team_id AND team.user_id=member.user_id
        WHERE member.id=${context.actorMemberId} AND member.user_id=${userId}
          AND member.is_active IS TRUE AND team.is_active IS TRUE
        FOR SHARE OF member, team
      `);
      const member = result.rows[0] as
        | { id: number; team_id: number; role: string }
        | undefined;
      if (
        !member ||
        (ticket.assignedMemberId !== member.id &&
          ticket.teamId !== member.team_id)
      ) {
        throw new TicketMutationError(
          "You do not have access to this ticket",
          403,
          "TICKET_ACCESS_REVOKED",
        );
      }
      if (context.requireManage && !["lead", "admin"].includes(member.role)) {
        throw new TicketMutationError(
          "Only support leads or admins can reassign tickets",
          403,
          "TICKET_ACCESS_REVOKED",
        );
      }
      if (
        ticket.assignedMemberId !== member.id &&
        !(
          context.allowClaim &&
          ticket.assignedMemberId === null &&
          ticket.teamId === member.team_id
        ) &&
        !["lead", "admin"].includes(member.role)
      ) {
        throw new TicketMutationError(
          "Claim this ticket before changing it",
          409,
          "TICKET_ASSIGNMENT_CONFLICT",
        );
      }
    }
    return operation(tx, ticket);
  };
  return context.database ? work(context.database) : db.transaction(work);
}

/** Reconcile the final ownership by ticket, including an already-resolved
 * retained-human handoff. Closing must not depend on an active queue row. */
export async function reconcileTicketLifecycle(
  tx: typeof db,
  ticket: LockedSupportTicket,
  context: TicketMutationContext,
) {
  if (!["resolved", "closed"].includes(ticket.status)) return;
  const active = await tx.execute(sql`
    SELECT id, assigned_member_id, conversation_id, channel FROM handoff_queue
    WHERE user_id=${ticket.userId} AND support_ticket_id=${ticket.id}
      AND status IN ('waiting','assigned','in_progress')
    ORDER BY id FOR UPDATE
  `);
  if (
    context.expectedHandoffId &&
    !active.rows.some(
      (row: { id: number }) => row.id === context.expectedHandoffId,
    )
  ) {
    throw new TicketMutationError(
      "Handoff was already resolved or changed",
      409,
      "TICKET_VERSION_CONFLICT",
    );
  }
  if (ticket.status === "resolved" && !active.rows.length) return;
  if (
    context.actorMemberId &&
    active.rows.some(
      (row: { assigned_member_id: number | null }) =>
        row.assigned_member_id &&
        row.assigned_member_id !== ticket.assignedMemberId,
    )
  ) {
    throw new TicketMutationError(
      "Ticket and handoff ownership changed",
      409,
      "TICKET_ASSIGNMENT_CONFLICT",
    );
  }
  const resumeAi = ticket.status === "closed" || context.resumeAi === true;
  const nextMode = resumeAi ? "ai_active" : "human_owned";
  const resolution = context.handoffResolution || ticket.status;
  const ownershipResolution = {
    supportTicketId: ticket.id,
    resolution,
    outcome: resumeAi ? "ai_resumed" : "human_retained",
    resumeAi,
    resumeReason:
      ticket.status === "closed"
        ? "ticket_closed"
        : resumeAi
          ? "operator_requested"
          : null,
    resolvedBy: context.actorMemberId || context.actorUserId || null,
    resolvedAt: new Date().toISOString(),
  };
  await tx.execute(sql`
    UPDATE handoff_queue SET status='resolved', resolution=${resolution},
      resolved_at=NOW(), ai_reply_enabled=TRUE, ai_paused_at=NULL, ai_paused_by=NULL,
      version=version+1, updated_at=NOW()
    WHERE user_id=${ticket.userId} AND support_ticket_id=${ticket.id}
      AND status IN ('waiting','assigned','in_progress')
  `);
  const widgetResult = await tx.execute(sql`
    UPDATE support_chat_sessions session SET automation_mode=${nextMode},
      metadata=(COALESCE(session.metadata,'{}'::jsonb)-'ownershipResolution'-'aiReplyControl')
        || ${JSON.stringify({ ownershipResolution })}::jsonb, updated_at=NOW()
    FROM team_members member
    WHERE session.ticket_id=${ticket.id} AND member.id=session.member_id AND member.user_id=${ticket.userId}
      AND session.automation_mode NOT IN ('opted_out','closed')
      AND NOT EXISTS (SELECT 1 FROM handoff_queue other WHERE other.user_id=${ticket.userId}
        AND other.conversation_id=-session.id AND other.support_ticket_id IS DISTINCT FROM ${ticket.id}
        AND other.status IN ('waiting','assigned','in_progress'))
    RETURNING session.id
  `);
  let ownershipApplied = widgetResult.rows.length > 0;
  if (ticket.outreachConversationId) {
    const conversationResult = await tx.execute(sql`
      UPDATE outreach_conversations conversation SET automation_mode=${nextMode},
        status=CASE WHEN ${resumeAi} AND status='needs_human' THEN 'active' ELSE status END,
        metadata=(COALESCE(conversation.metadata,'{}'::jsonb)-'ownershipResolution'-'aiReplyControl'
          -'escalated'-'handoffId'-'escalatedAt'-'escalationReason')
          || ${JSON.stringify({ ownershipResolution })}::jsonb, updated_at=NOW()
      WHERE conversation.id=${ticket.outreachConversationId} AND conversation.user_id=${ticket.userId}
        AND conversation.automation_mode NOT IN ('opted_out','closed') AND conversation.status<>'unsubscribed'
        AND NOT EXISTS (SELECT 1 FROM handoff_queue other WHERE other.user_id=${ticket.userId}
          AND other.conversation_id=conversation.id AND other.support_ticket_id IS DISTINCT FROM ${ticket.id}
          AND other.status IN ('waiting','assigned','in_progress'))
      RETURNING conversation.id
    `);
    ownershipApplied ||= conversationResult.rows.length > 0;
  }
  // Record only an ownership change that actually happened. Opt-outs, closed
  // source conversations and another active ticket must never be called resumed.
  const metadata = { ...ticket.metadata };
  if (ownershipApplied) metadata.ownershipResolution = ownershipResolution;
  else delete metadata.ownershipResolution;
  await tx.execute(sql`UPDATE support_tickets SET metadata=${JSON.stringify(metadata)}::jsonb
    WHERE id=${ticket.id} AND user_id=${ticket.userId}`);
  ticket.metadata = metadata;
}
