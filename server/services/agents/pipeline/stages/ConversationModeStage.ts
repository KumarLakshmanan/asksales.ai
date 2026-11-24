import { sql } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import { logger } from '../../../../utils/logger.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';
import { handoffService } from '../HandoffService.js';

export class ConversationModeStage implements PipelineStage {
  name = 'ConversationMode';

  private hasRetainedHumanOwnership(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const resolution = (metadata as Record<string, unknown>).ownershipResolution;
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return false;
    const record = resolution as Record<string, unknown>;
    return record.outcome === 'human_retained' && record.resumeAi === false;
  }

  private hasResumedAiOwnership(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const resolution = (metadata as Record<string, unknown>).ownershipResolution;
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return false;
    const record = resolution as Record<string, unknown>;
    return record.outcome === 'ai_resumed' && record.resumeAi === true;
  }

  private registerActiveHandoff(ctx: PipelineContext, handoff: {
    id: number;
    slaDeadline?: Date | string | null;
    assignedMemberId?: number | null;
    status?: string | null;
    reason?: string | null;
    aiReplyEnabled?: boolean;
  }): PipelineContext {
    ctx.metadata = {
      ...ctx.metadata,
      conversationMode: 'human_owned',
      handoffId: handoff.id,
      activeHandoff: handoff,
      suspendPlaybookForHandoff: true,
      suppressBusinessEffects: true,
      systemDirective: 'ticket_aware_follow_up',
    };
    return ctx;
  }

  private haltForHumanTakeover(ctx: PipelineContext, handoff: {
    id: number;
    assignedMemberId?: number | null;
    status?: string | null;
  }): never {
    ctx.metadata = {
      ...ctx.metadata,
      conversationMode: 'human_owned',
      handoffId: handoff.id,
      activeHandoff: handoff,
      aiReplyEnabled: false,
      humanTakeoverActive: true,
      suspendPlaybookForHandoff: true,
      suppressBusinessEffects: true,
      skipAgentGeneration: true,
      ticketFollowUpDisposition: 'human_takeover',
      systemDirective: 'human_takeover_no_automatic_reply',
    };
    throw new PipelineHalt('AI replies are paused because a support member has taken over this conversation.', ctx, 'no_op');
  }

  private acknowledgeRetainedHumanOwnership(ctx: PipelineContext): PipelineContext {
    ctx.agentResult = {
      replyText: 'This conversation still belongs to the support team, and AI automation remains paused. Your latest message is available to the human operator.',
      escalated: false,
      confidence: 1,
      groundingStatus: 'not_required',
      toolCallsExecuted: [],
      effectProposals: [],
    };
    ctx.metadata = {
      ...ctx.metadata,
      conversationMode: 'human_owned',
      skipAgentGeneration: true,
      suppressBusinessEffects: true,
      suspendPlaybookForHandoff: true,
      systemDirective: 'retained_human_ownership_acknowledgement',
      ticketFollowUpDisposition: 'human_queue',
    };
    return ctx;
  }

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    if (ctx.message.metadata?.dryRun === true) return ctx;
    try {
      if (ctx.message.channel === 'web' && ctx.message.conversationId < 0) {
        const widget = await db.execute(sql`
          SELECT scs.automation_mode, scs.metadata
          FROM support_chat_sessions scs
          JOIN team_members tm ON tm.id = scs.member_id
          WHERE scs.id = ${Math.abs(ctx.message.conversationId)}
            AND tm.user_id = ${ctx.message.userId}
          LIMIT 1
        `);
        const widgetConversation = widget.rows[0] as { automation_mode?: string; metadata?: unknown } | undefined;
        const widgetMode = String(widgetConversation?.automation_mode || 'ai_active');
        ctx.metadata = { ...ctx.metadata, conversationMode: widgetMode };
        if (widgetMode === 'opted_out' || widgetMode === 'closed') {
          throw new PipelineHalt('The customer has opted out of automated messages.', ctx, 'no_op');
        }
        if (widgetMode === 'human_owned' || widgetMode === 'approval_pending' || widgetMode === 'resolved') {
          await db.execute(sql`
            UPDATE handoff_queue
            SET last_customer_message_at = NOW(), updated_at = NOW(), version = version + 1
            WHERE user_id = ${ctx.message.userId}
              AND conversation_id = ${ctx.message.conversationId}
              AND status IN ('waiting', 'assigned', 'in_progress')
          `);
          const active = await db.execute(sql`
            SELECT h.id, h.sla_deadline, h.assigned_member_id, h.status, h.reason,
              h.ai_reply_enabled
            FROM handoff_queue h
            JOIN support_tickets t
              ON t.id = h.support_ticket_id
             AND t.user_id = h.user_id
             AND t.deleted_at IS NULL
             AND t.status NOT IN ('resolved', 'closed')
            WHERE h.user_id = ${ctx.message.userId}
              AND h.conversation_id = ${ctx.message.conversationId}
              AND h.status IN ('waiting', 'assigned', 'in_progress')
            ORDER BY h.id DESC LIMIT 1
          `);
          const row = active.rows[0] as Record<string, unknown> | undefined;
          if (row) {
            const handoff = {
              id: Number(row.id), slaDeadline: row.sla_deadline as Date | string | null,
              assignedMemberId: row.assigned_member_id ? Number(row.assigned_member_id) : null,
              status: String(row.status || ''), reason: String(row.reason || ''),
              aiReplyEnabled: row.ai_reply_enabled !== false,
            };
            if (!handoff.aiReplyEnabled) return this.haltForHumanTakeover(ctx, handoff);
            return this.registerActiveHandoff(ctx, handoff);
          }
          if (widgetMode === 'approval_pending') {
            if (this.hasRetainedHumanOwnership(widgetConversation?.metadata)) return this.acknowledgeRetainedHumanOwnership(ctx);
            // Review belongs to the unsent draft, not every future turn.
            // Keep pending approvals intact; all tool/public/safety gates run
            // again on the customer's new request.
            await db.execute(sql`UPDATE support_chat_sessions scs
              SET automation_mode='ai_active', updated_at=NOW()
              FROM team_members tm WHERE scs.id=${Math.abs(ctx.message.conversationId)}
                AND tm.id=scs.member_id AND tm.user_id=${ctx.message.userId}
                AND scs.automation_mode='approval_pending'`);
            ctx.metadata = { ...ctx.metadata, conversationMode: 'ai_active', pendingDraftReview: true };
            return ctx;
          }
          if (this.hasRetainedHumanOwnership(widgetConversation?.metadata)) {
            return this.acknowledgeRetainedHumanOwnership(ctx);
          }
          logger.warn({ conversationId: ctx.message.conversationId, mode: widgetMode }, '[ConversationModeStage] Ignoring stale widget ownership without an active ticket-backed handoff');
          ctx.metadata = { ...ctx.metadata, staleConversationMode: widgetMode, conversationMode: 'ai_active' };
        }
      }
      const openHandoff = await db.execute(sql`
        SELECT h.id, h.sla_deadline, h.assigned_member_id, h.status, h.reason,
          h.ai_reply_enabled
        FROM handoff_queue h
        JOIN support_tickets t
          ON t.id = h.support_ticket_id
         AND t.user_id = h.user_id
         AND t.deleted_at IS NULL
         AND t.status NOT IN ('resolved', 'closed')
        WHERE h.user_id = ${ctx.message.userId}
          AND h.conversation_id = ${ctx.message.conversationId}
          AND h.status IN ('waiting', 'assigned', 'in_progress')
        LIMIT 1
      `);
      if (openHandoff.rows.length > 0) {
        const handoffId = Number((openHandoff.rows[0] as { id: number }).id);
        await db.execute(sql`
          UPDATE handoff_queue SET last_customer_message_at = NOW(), updated_at = NOW(), version = version + 1
          WHERE id = ${handoffId}
        `);
        const row = openHandoff.rows[0] as Record<string, unknown>;
        const handoff = {
          id: handoffId, slaDeadline: row.sla_deadline as Date | string | null,
          assignedMemberId: row.assigned_member_id ? Number(row.assigned_member_id) : null,
          status: String(row.status || ''), reason: String(row.reason || ''),
          aiReplyEnabled: row.ai_reply_enabled !== false,
        };
        if (!handoff.aiReplyEnabled) return this.haltForHumanTakeover(ctx, handoff);
        return this.registerActiveHandoff(ctx, handoff);
      }
      const result = await db.execute(sql`
        SELECT automation_mode, status, metadata
        FROM outreach_conversations
        WHERE id = ${ctx.message.conversationId}
          AND user_id = ${ctx.message.userId}
        LIMIT 1
      `);
      const conversation = result.rows[0] as { automation_mode?: string; status?: string; metadata?: unknown } | undefined;
      const mode = String(conversation?.automation_mode || 'ai_active');
      ctx.metadata = { ...ctx.metadata, conversationMode: mode };

      if (mode === 'ai_active' && this.hasResumedAiOwnership(conversation?.metadata)) {
        ctx.metadata = { ...ctx.metadata, ownershipResumed: true };
      }

      if (conversation?.status === 'unsubscribed') {
        throw new PipelineHalt('The customer has opted out of automated messages.', ctx, 'no_op');
      }

      if (mode === 'approval_pending') {
        if (this.hasRetainedHumanOwnership(conversation?.metadata)) return this.acknowledgeRetainedHumanOwnership(ctx);
        await db.execute(sql`UPDATE outreach_conversations
          SET automation_mode='ai_active', updated_at=NOW()
          WHERE id=${ctx.message.conversationId} AND user_id=${ctx.message.userId}
            AND automation_mode='approval_pending'
            AND NOT EXISTS (SELECT 1 FROM handoff_queue h
              WHERE h.user_id=${ctx.message.userId} AND h.conversation_id=${ctx.message.conversationId}
                AND h.status IN ('waiting','assigned','in_progress'))`);
        ctx.metadata = { ...ctx.metadata, conversationMode: 'ai_active', pendingDraftReview: true };
        return ctx;
      }
      if (mode === 'human_owned' || mode === 'resolved') {
        if (this.hasRetainedHumanOwnership(conversation?.metadata)) {
          return this.acknowledgeRetainedHumanOwnership(ctx);
        }
        // A stale ownership flag cannot suppress AI or promise a human reply.
        // Historical ownership remains auditable in the database; runtime
        // suppression requires a current queue row linked to an open ticket.
        logger.warn({ conversationId: ctx.message.conversationId, mode }, '[ConversationModeStage] Ignoring stale human ownership without an active ticket-backed handoff');
        ctx.metadata = { ...ctx.metadata, staleConversationMode: mode, conversationMode: 'ai_active' };
        return ctx;
      }
      if (mode === 'closed' || mode === 'opted_out') {
        throw new PipelineHalt(
          mode === 'closed' ? 'This conversation is closed.' : 'The customer has opted out of automated messages.',
          ctx,
          'no_op',
        );
      }

    } catch (error) {
      if (error instanceof PipelineHalt) throw error;
      logger.error({ err: error, conversationId: ctx.message.conversationId }, '[ConversationModeStage] Could not verify conversation ownership mode');
      throw new PipelineHalt('Conversation ownership could not be verified.', ctx, 'no_op');
    }
    return ctx;
  }
}
