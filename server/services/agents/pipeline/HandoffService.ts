import { db } from "../../../models/db.js";
import { sql } from "drizzle-orm";
import { getHandoffQueueByConversation, getOwnedHandoffQueueById, updateHandoffQueue } from "../../../models/handoffQueue/functions.js";
import { handoffQueueTable } from "../../../models/handoffQueue/schema.js";
import type { PipelineContext } from "./ChannelGateway.js";
import { logger } from "../../../utils/logger.js";
import { supportPresenceService } from '../../SupportPresenceService.js';
import { permittedHandoffReason } from '../orchestration/RestrictedHandoffPolicy.js';
import { hasCustomerHandoffConsent } from '../orchestration/HandoffConsent.js';

export class HandoffService {
  customerAcknowledgement(ctx: PipelineContext, reason: string, handoff?: {
    id?: number;
    slaDeadline?: Date | string | null;
    assignedMemberId?: number | null;
    status?: string | null;
  }): string {
    if (!handoff?.id || !['waiting', 'assigned', 'in_progress'].includes(String(handoff.status || ''))) {
      return 'I cannot complete this request automatically right now. Please try again shortly or contact the support team through the published support channel.';
    }
    const normalized = String(reason || '').toLowerCase();
    const lead = normalized.includes('classification') && normalized.includes('unavailable')
      ? 'I could not assess this request automatically right now, so I sent it to the support team.'
      : normalized.includes('unsupported_customer_factual_claim')
      || normalized.includes('evidence verification')
      || normalized.includes('enough verified information')
      ? 'I could not verify that information safely, so I sent your question to the support team.'
      : normalized.includes('retrieval') || normalized.includes('knowledge')
        ? 'The verified information service is temporarily unavailable, so I sent your question to the support team.'
        : normalized.includes('user explicitly requested')
          ? 'I have connected this conversation to the support team as requested.'
          : normalized.includes('policy') || normalized.includes('risk') || normalized.includes('sensitive')
            ? 'This request needs a support team member to review it safely, so I have queued it for them.'
            : 'I could not complete this request confidently, so I sent it to the support team.';
    const deadline = handoff?.slaDeadline ? new Date(handoff.slaDeadline) : null;
    const remainingMs = deadline && Number.isFinite(deadline.getTime())
      ? deadline.getTime() - Date.now()
      : null;
    const remainingMinutes = remainingMs !== null && remainingMs > 0
      ? Math.ceil(remainingMs / 60_000)
      : null;
    const targetDuration = remainingMinutes
      ? remainingMinutes >= 60
        ? `${Math.ceil(remainingMinutes / 60)} ${Math.ceil(remainingMinutes / 60) === 1 ? 'hour' : 'hours'}`
        : `${remainingMinutes} ${remainingMinutes === 1 ? 'minute' : 'minutes'}`
      : null;
    const target = remainingMinutes
      ? ` The team’s response target is within ${targetDuration}; they will reply here.`
      : ' They will reply here when a team member accepts the request.';
    return `${lead}${target}`;
  }

  /**
   * Enqueue a conversation for live human assistance
   */
  async enqueue(ctx: PipelineContext, reason: string, triggerType: string) {
    if (!hasCustomerHandoffConsent(ctx)) throw new Error('The customer must accept human assistance before this conversation can be transferred.');
    if (!permittedHandoffReason(ctx)) throw new Error('This request is not eligible for automatic human handoff.');
    const { sealSupportTurn } = await import('../orchestration/SupportConversationTurn.js');
    await sealSupportTurn();
    const { userId, conversationId, channel, inboundText, leadId } = ctx.message;

    logger.info({ userId, conversationId, reason, triggerType }, '[HandoffService] Enqueuing conversation for human handoff');

    // 1. Fetch last 10 messages for conversation context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messages: any[] = [];
    try {
      const res = channel === 'web' && conversationId < 0
        ? await db.execute(sql`
            SELECT scm.id,
                   CASE WHEN scm.role = 'user' THEN 'inbound' ELSE 'outbound' END AS direction,
                   scm.content,
                   scm.privacy_vault_id,
                   scm.created_at
            FROM support_chat_messages scm
            JOIN support_chat_sessions scs ON scs.id = scm.session_id
            JOIN team_members tm ON tm.id = scs.member_id
            WHERE scs.id = ${Math.abs(conversationId)}
              AND tm.user_id = ${userId}
            ORDER BY scm.created_at DESC
            LIMIT 10
          `)
        : await db.execute(sql`
            SELECT id, direction, content, privacy_vault_id, created_at
            FROM outreach_messages
            WHERE conversation_id = ${conversationId} AND user_id = ${userId}
            ORDER BY created_at DESC
            LIMIT 10
          `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages = res.rows.map((r: any) => ({
        id: Number(r.id),
        direction: r.direction,
        content: r.content,
        hasRestrictedContent: Boolean(r.privacy_vault_id),
        timestamp: r.created_at,
      })).reverse();
    } catch (err) {
      logger.warn({ err }, '[HandoffService] Failed to load recent messages for handoff context');
    }

    // 2. Calculate a tenant-scoped, presence-aware response target. If nobody
    // is online, the estimate carries the configured channel SLA fallback.
    const routingEstimate = await supportPresenceService.estimateRouting(userId, channel);
    const slaDeadline = new Date(Date.now() + routingEstimate.estimatedMinutes * 60000);

    // 3. Determine priority from risk and urgency
    let priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium';
    if (ctx.nlu?.riskLevel === 'critical' || ctx.nlu?.urgency === 'high') {
      priority = 'urgent';
    } else if (ctx.nlu?.riskLevel === 'high') {
      priority = 'high';
    } else if (ctx.nlu?.riskLevel === 'low') {
      priority = 'low';
    }

    // 4. Construct context payload
    const conversationContext = {
      recentMessages: messages,
      inboundText,
      nlu: ctx.nlu ? {
        intent: ctx.nlu.intent,
        urgency: ctx.nlu.urgency,
        summary: ctx.nlu.summary,
        riskLevel: ctx.nlu.riskLevel,
        riskFactors: ctx.nlu.riskFactors,
      } : null,
      sentiment: ctx.sentiment ? {
        sentiment: ctx.sentiment.sentiment,
        score: ctx.sentiment.score,
      } : null,
      leadId,
      responseEstimate: routingEstimate,
    };

    // 5. Reuse the existing support portal as the operator control plane. Link
    // the handoff to an open ticket and its team instead of creating a second,
    // unoperated queue.
    let teamId: number | undefined;
    let supportTicketId: number | undefined;
    let assignedMemberId: number | undefined;
    const existingOpen = (await getHandoffQueueByConversation(userId, conversationId))
      .find((item: { status: string }) => ['waiting', 'assigned', 'in_progress'].includes(item.status));
    try {
      if (existingOpen?.supportTicketId) {
        const ticketCheck = await db.execute(sql`
          SELECT id, team_id, assigned_member_id
          FROM support_tickets
          WHERE id=${existingOpen.supportTicketId} AND user_id=${userId}
            AND deleted_at IS NULL AND status NOT IN ('resolved', 'closed')
          LIMIT 1
        `);
        const validTicket = ticketCheck.rows[0] as { id?: number; team_id?: number; assigned_member_id?: number } | undefined;
        if (validTicket?.id) {
          supportTicketId = Number(validTicket.id);
          teamId = validTicket.team_id ? Number(validTicket.team_id) : undefined;
          assignedMemberId = validTicket.assigned_member_id ? Number(validTicket.assigned_member_id) : undefined;
        }
      }
      const existingTicket = supportTicketId
        ? { rows: [] }
        : channel === 'web' && conversationId < 0
          ? await db.execute(sql`
              SELECT t.id, t.team_id, t.assigned_member_id
              FROM support_chat_sessions s
              JOIN support_tickets t ON t.id = s.ticket_id
              WHERE s.id = ${Math.abs(conversationId)}
                AND t.user_id = ${userId}
                AND t.status NOT IN ('resolved', 'closed')
              LIMIT 1
            `)
          : await db.execute(sql`
              SELECT id, team_id, assigned_member_id
              FROM support_tickets
              WHERE user_id = ${userId}
                AND outreach_conversation_id = ${conversationId}
                AND status NOT IN ('resolved', 'closed')
              ORDER BY created_at DESC
              LIMIT 1
            `);
      const current = existingTicket.rows[0] as { id?: number; team_id?: number; assigned_member_id?: number } | undefined;
      if (current?.id) {
        supportTicketId = Number(current.id);
        teamId = current.team_id ? Number(current.team_id) : undefined;
        assignedMemberId = current.assigned_member_id ? Number(current.assigned_member_id) : undefined;
      } else if (!supportTicketId) {
        const teamResult = channel === 'web' && conversationId < 0
          ? await db.execute(sql`
              SELECT tm.team_id AS id, tm.id AS member_id
              FROM support_chat_sessions s
              JOIN team_members tm ON tm.id = s.member_id
              JOIN support_teams st ON st.id = tm.team_id
              WHERE s.id = ${Math.abs(conversationId)}
                AND tm.user_id = ${userId}
                AND st.user_id = ${userId}
                AND tm.is_active IS TRUE
                AND st.is_active IS TRUE
              LIMIT 1
            `)
          : routingEstimate.active && routingEstimate.teamId
            ? { rows: [{ id: routingEstimate.teamId, member_id: routingEstimate.memberId }] }
            : await db.execute(sql`
                SELECT st.id, NULL::integer AS member_id
                FROM support_teams st
                WHERE st.user_id = ${userId} AND st.is_active = TRUE
                ORDER BY st.created_at ASC, st.id ASC LIMIT 1
              `);
        const route = teamResult.rows[0] as { id?: number; member_id?: number } | undefined;
        teamId = route?.id ? Number(route.id) : undefined;
        assignedMemberId = route?.member_id ? Number(route.member_id) : undefined;
        if (!teamId) {
          throw new Error('No enabled support team is available for human handoff.');
        }
        const { supportService } = await import('../../SupportService.js');
        const ticket = await supportService.createTicket(userId, {
          leadId: leadId || undefined,
          outreachConversationId: channel === 'web' || conversationId < 1 ? undefined : conversationId,
          teamId,
          assignedMemberId,
          subject: ctx.nlu?.summary || `AI handoff from ${channel}`,
          description: inboundText,
          priority,
          category: 'ai_handoff',
          handoffKey: `${channel}:${conversationId}`,
          slaDeadline,
          tags: ['ai-handoff', channel, triggerType],
          autoAssign: false,
        });
        supportTicketId = ticket.id;
        assignedMemberId = ticket.assignedMemberId || undefined;
        await db.execute(sql`
          UPDATE support_tickets
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ responseEstimate: routingEstimate })}::jsonb,
              updated_at = NOW()
          WHERE id=${supportTicketId} AND user_id=${userId}
        `);
        if (channel === 'web' && conversationId < 0) {
          await db.execute(sql`
            UPDATE support_chat_sessions scs
            SET ticket_id = ${supportTicketId}, updated_at = NOW()
            FROM team_members tm
            WHERE scs.id = ${Math.abs(conversationId)}
              AND tm.id = scs.member_id
              AND tm.user_id = ${userId}
          `);
        }
      }
    } catch (error) {
      logger.error({ err: error, userId, conversationId }, '[HandoffService] Failed to create or link support ticket');
      // A handoff without an operator-visible ticket is not considered safely
      // queued. Propagate so the caller does not claim successful escalation.
      throw error;
    }

    const handoffValues = {
      reason,
      triggerType,
      aiDraftReply: ctx.agentResult?.replyText || null,
      conversationContext,
      confidenceScore: ctx.confidence,
      slaDeadline,
      priority,
      supportTicketId,
      teamId,
      assignedMemberId,
      lastCustomerMessageAt: new Date(),
    };
    // Commit the operator-visible queue identity and human ownership together.
    // A ticket may have been created immediately beforehand, but AI is never
    // suppressed without a durable queue row that an operator can claim.
    const handoff = await db.transaction(async (tx: typeof db) => {
      const ownership = channel === 'web' && conversationId < 0
        ? await tx.execute(sql`
            UPDATE support_chat_sessions scs
            SET automation_mode = 'human_owned', updated_at = NOW()
            FROM team_members tm
            WHERE scs.id = ${Math.abs(conversationId)}
              AND tm.id = scs.member_id
              AND tm.user_id = ${userId}
            RETURNING scs.id
          `)
        : await tx.execute(sql`
            UPDATE outreach_conversations
            SET automation_mode = 'human_owned', updated_at = NOW()
            WHERE id = ${conversationId}
              AND user_id = ${userId}
            RETURNING id
          `);
      if (ownership.rows.length !== 1) {
        throw new Error('Conversation ownership could not be atomically transferred to support.');
      }

      let queueRecord;
      if (existingOpen) {
        [queueRecord] = await tx.update(handoffQueueTable).set({
          ...handoffValues,
          updatedAt: new Date(),
        }).where(sql`
          ${handoffQueueTable.id} = ${existingOpen.id}
          AND ${handoffQueueTable.userId} = ${userId}
          AND ${handoffQueueTable.status} IN ('waiting', 'assigned', 'in_progress')
        `).returning();
      } else {
        [queueRecord] = await tx.insert(handoffQueueTable).values({
          userId,
          conversationId,
          channel,
          status: 'waiting',
          ...handoffValues,
        }).onConflictDoNothing().returning();
        if (!queueRecord) {
          [queueRecord] = await tx.select().from(handoffQueueTable).where(sql`
            ${handoffQueueTable.userId} = ${userId}
            AND ${handoffQueueTable.conversationId} = ${conversationId}
            AND ${handoffQueueTable.status} IN ('waiting', 'assigned', 'in_progress')
          `).limit(1);
          if (queueRecord) {
            [queueRecord] = await tx.update(handoffQueueTable).set({
              ...handoffValues,
              updatedAt: new Date(),
            }).where(sql`
              ${handoffQueueTable.id} = ${queueRecord.id}
              AND ${handoffQueueTable.userId} = ${userId}
              AND ${handoffQueueTable.status} IN ('waiting', 'assigned', 'in_progress')
            `).returning();
          }
        }
      }
      if (!queueRecord) throw new Error('Human handoff queue row could not be created or reclaimed.');

      if (!(channel === 'web' && conversationId < 0)) {
        const metadataUpdate = await tx.execute(sql`
          UPDATE outreach_conversations
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            escalated: true,
            handoffId: queueRecord.id,
            escalatedAt: new Date().toISOString(),
            escalationReason: reason,
          })}::jsonb,
          updated_at = NOW()
          WHERE id = ${conversationId}
            AND user_id = ${userId}
          RETURNING id
        `);
        if (metadataUpdate.rows.length !== 1) throw new Error('Handoff metadata could not be committed.');
      }
      return queueRecord;
    });

    // 6. Non-transactional follow-up cancellation is recoverable and cannot
    // weaken the already-committed human ownership invariant.
    if (!(channel === 'web' && conversationId < 0)) {
      const { cancelSocialFollowUpsForConversation } = await import('../../socialFollowUpService.js');
      await cancelSocialFollowUpsForConversation(conversationId, 'human_takeover').catch((error) => {
        logger.warn({ err: error, conversationId }, '[HandoffService] Follow-up cancellation needs reconciliation');
      });
    }

    if (supportTicketId) {
      const { supportMemberNotificationService } = await import('../../SupportMemberNotificationService.js');
      await supportMemberNotificationService.queueHumanHandoff({
        id: handoff.id,
        userId,
        supportTicketId,
        teamId,
        assignedMemberId,
        channel,
        priority,
      });
      const { supportTicketWorkspaceService } = await import('../../SupportTicketWorkspaceService.js');
      supportTicketWorkspaceService.queueRefresh(userId, supportTicketId);
    }

    return handoff;
  }

  /**
   * Resolve an outstanding handoff request
   */
  async resolve(
    userId: number,
    id: number,
    resolution: 'approved' | 'edited' | 'manual_reply' | 'resolved' | 'closed',
    resolvedBy?: number,
    options: { resumeAi?: boolean; actorUserId?: number } = {},
  ) {
    logger.info({ userId, id, resolution }, '[HandoffService] Resolving handoff');

    const handoff = await getOwnedHandoffQueueById(userId, id);
    if (!handoff) {
      throw new Error(`Handoff record with ID ${id} not found.`);
    }

    if (handoff.supportTicketId) {
      const { supportService } = await import('../../SupportService.js');
      const ticket = await supportService.updateTicket(userId, handoff.supportTicketId, {
        status: resolution === 'closed' ? 'closed' : 'resolved',
      }, { actorMemberId: resolvedBy, actorUserId: options.actorUserId, resumeAi: options.resumeAi,
        handoffResolution: resolution, expectedHandoffId: id });
      if (!ticket) throw new Error('Linked support ticket is unavailable.');
      return;
    }

    // Closing a support ticket ends the active human-ownership interval and
    // deterministically restores AI for the next inbound message. Other
    // resolutions retain human ownership unless the operator explicitly opts in.
    const nextMode = resolution === 'closed' || options.resumeAi === true
      ? 'ai_active'
      : 'human_owned';
    const ownershipResolution = {
      handoffId: id,
      supportTicketId: handoff.supportTicketId || null,
      resolution,
      outcome: nextMode === 'ai_active' ? 'ai_resumed' : 'human_retained',
      resumeAi: nextMode === 'ai_active',
      resumeReason: resolution === 'closed' ? 'ticket_closed' : options.resumeAi === true ? 'operator_requested' : null,
      resolvedBy: resolvedBy || null,
      resolvedAt: new Date().toISOString(),
    };
    await db.transaction(async (tx: typeof db) => {
      const queueResult = await tx.execute(sql`
        UPDATE handoff_queue
        SET status = 'resolved',
            resolution = ${resolution},
            resolved_at = NOW(),
            ai_reply_enabled = TRUE,
            ai_paused_at = NULL,
            ai_paused_by = NULL,
            assigned_member_id = COALESCE(${resolvedBy || null}, assigned_member_id),
            updated_at = NOW(),
            version = version + 1
        WHERE id = ${id}
          AND user_id = ${userId}
          AND support_ticket_id IS NULL
          AND status IN ('waiting', 'assigned', 'in_progress')
        RETURNING id
      `);
      if (queueResult.rows.length !== 1) throw new Error('Handoff was already resolved or changed concurrently.');

      if (handoff.channel === 'web' && handoff.conversationId < 0) {
        const sessionResult = await tx.execute(sql`
          UPDATE support_chat_sessions scs
          SET automation_mode = ${nextMode},
              metadata = (COALESCE(scs.metadata, '{}'::jsonb) - 'pendingApproval' - 'ownershipResolution' - 'aiReplyControl')
                || ${JSON.stringify({ ownershipResolution })}::jsonb,
              updated_at = NOW()
          FROM team_members tm
          WHERE scs.id = ${Math.abs(handoff.conversationId)}
            AND tm.id = scs.member_id
            AND tm.user_id = ${handoff.userId}
          RETURNING scs.id
        `);
        if (sessionResult.rows.length !== 1) throw new Error('Widget ownership state could not be resolved.');
      } else {
        const conversationResult = await tx.execute(sql`
          UPDATE outreach_conversations
          SET automation_mode = ${nextMode},
              status = CASE
                WHEN ${nextMode} = 'ai_active' AND status = 'needs_human' THEN 'active'
                ELSE status
              END,
              metadata = (COALESCE(metadata, '{}'::jsonb)
                - 'escalated' - 'handoffId' - 'escalatedAt' - 'escalationReason' - 'pendingApproval' - 'ownershipResolution' - 'aiReplyControl')
                || ${JSON.stringify({ ownershipResolution })}::jsonb,
              updated_at = NOW()
          WHERE id = ${handoff.conversationId} AND user_id = ${handoff.userId}
          RETURNING id
        `);
        if (conversationResult.rows.length !== 1) throw new Error('Conversation ownership state could not be resolved.');
      }


    });
  }

  /**
   * Check for SLA breaches and upgrade priority of delayed tickets
   */
  async checkSLABreaches() {
    try {
      // Reclaim abandoned in-progress claims and upgrade unclaimed work. A
      // breach remains in the human queue; it never silently resumes AI.
      const { recoverStaleSupportHandoffsQuery } = await import('../../SupportTicketRecovery.js');
      await db.execute(recoverStaleSupportHandoffsQuery());

      // Find waiting/assigned items past SLA deadline which aren't already urgent
      const result = await db.execute(sql`
        SELECT id, user_id FROM handoff_queue
        WHERE status IN ('waiting', 'assigned')
          AND sla_deadline < NOW()
          AND priority != 'urgent'
      `);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of result.rows as any[]) {
        logger.info({ handoffId: row.id }, '[HandoffService] SLA breached. Upgrading to urgent priority.');
        await updateHandoffQueue(Number(row.user_id), Number(row.id), {
          priority: 'urgent',
        });
      }
    } catch (err) {
      logger.error({ err }, '[HandoffService] SLA breach check failed');
      throw err;
    }
  }
}

export const handoffService = new HandoffService();
