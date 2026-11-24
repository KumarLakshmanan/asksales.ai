import { TicketMutationError, withLockedSupportTicket } from '../services/SupportTicketMutation.js';
import { supportService } from '../services/SupportService.js';
import type { Request, Response } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { handoffQueueTable } from '../models/handoffQueue/schema.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { handoffService } from '../services/agents/pipeline/HandoffService.js';
import { privacyVaultService } from '../services/agents/orchestration/PrivacyVaultService.js';
import { supportPrivacyAccessLogsTable } from '../models/supportOrchestration/schema.js';
import { supportCannedResponsesTable } from '../models/supportOrchestration/schema.js';
import { logger } from '../utils/logger.js';
import { recordSupportAdminAudit } from '../services/agents/orchestration/SupportAdminAuditService.js';
import { redactPiiWithStableTokens } from '../services/agents/orchestration/PrivacyVaultService.js';
import { INTERNAL_SUPPORT_ASSIST_SCOPE } from '../services/agents/pipeline/InternalSupportAssistScope.js';
import { agentRouter } from '../services/agents/AgentRouter.js';

async function memberScope(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const member = (req as any).supportMember as typeof teamMembersTable.$inferSelect | undefined;
  if (!member) return null;
  const memberships = await db.select({ teamId: teamMembersTable.teamId })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.id, member.id));
  return { member, teamIds: memberships.map((row: { teamId: number }) => row.teamId) };
}

function activeStatuses() {
  return ['waiting', 'assigned', 'in_progress'] as const;
}

function canManageSupport(scope: NonNullable<Awaited<ReturnType<typeof memberScope>>>) {
  return scope.member.role === 'lead' || scope.member.role === 'admin';
}

async function accessibleHandoff(req: Request, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const scope = await memberScope(req);
  if (!scope || scope.teamIds.length === 0) return null;
  const [handoff] = await db.select().from(handoffQueueTable).where(and(
    eq(handoffQueueTable.id, id),
    eq(handoffQueueTable.userId, scope.member.userId),
    inArray(handoffQueueTable.teamId, scope.teamIds),
  )).limit(1);
  return handoff ? { scope, handoff } : null;
}

export async function listHandoffs(req: Request, res: Response) {
  try {
    const scope = await memberScope(req);
    if (!scope) return res.status(401).json({ error: 'Unauthorized' });
    if (scope.teamIds.length === 0) return res.json({ success: true, data: [] });
    const requested = String(req.query.status || 'active');
    const statusFilter = requested === 'active'
      ? sql`hq.status IN ('waiting', 'assigned', 'in_progress')`
      : sql`hq.status = ${requested}`;
    const result = await db.execute(sql`
      SELECT
        hq.id,
        hq.conversation_id AS "conversationId",
        hq.channel,
        hq.status,
        hq.priority,
        hq.reason,
        hq.trigger_type AS "triggerType",
        hq.assigned_member_id AS "assignedMemberId",
        hq.support_ticket_id AS "supportTicketId",
        hq.team_id AS "teamId",
        hq.ai_draft_reply AS "aiDraftReply",
        hq.conversation_context AS "conversationContext",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', ta.id,
            'toolName', ta.tool_name,
            'toolArgs', ta.tool_args,
            'expiresAt', ta.expires_at,
            'createdAt', ta.created_at
          ) ORDER BY ta.created_at ASC)
          FROM tool_approvals ta
          WHERE ta.user_id = hq.user_id
            AND ta.thread_id = hq.conversation_id
            AND ta.status = 'pending'
            AND COALESCE(ta.expires_at, NOW() + INTERVAL '1 minute') > NOW()
        ), '[]'::jsonb) AS "toolApprovals",
        hq.confidence_score AS "confidenceScore",
        hq.sla_deadline AS "slaDeadline",
        hq.accepted_at AS "acceptedAt",
        hq.last_customer_message_at AS "lastCustomerMessageAt",
        hq.ai_reply_enabled AS "aiReplyEnabled",
        hq.ai_paused_at AS "aiPausedAt",
        hq.ai_paused_by AS "aiPausedBy",
        hq.created_at AS "createdAt",
        st.ticket_number AS "ticketNumber",
        st.subject AS "ticketSubject"
      FROM handoff_queue hq
      LEFT JOIN support_tickets st ON st.id = hq.support_ticket_id
      WHERE hq.user_id = ${scope.member.userId}
        AND hq.team_id IN (${sql.join(scope.teamIds.map((id: number) => sql`${id}`), sql`, `)})
        AND ${statusFilter}
      ORDER BY
        CASE hq.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        hq.sla_deadline ASC NULLS LAST,
        hq.created_at ASC
      LIMIT 200
    `);
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to list handoffs');
    return res.status(500).json({ error: 'Failed to fetch handoffs' });
  }
}

export async function getHandoff(req: Request, res: Response) {
  try {
    const access = await accessibleHandoff(req, Number(req.params.id));
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    return res.json({ success: true, data: access.handoff });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to fetch handoff');
    return res.status(500).json({ error: 'Failed to fetch handoff' });
  }
}

export async function claimHandoff(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const access = await accessibleHandoff(req, id);
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    const { member } = access.scope;
    if (access.handoff.supportTicketId) {
      await supportService.claimTicket(member.userId, access.handoff.supportTicketId, member.id);
      const [claimed] = await db.select().from(handoffQueueTable).where(and(eq(handoffQueueTable.id,id),eq(handoffQueueTable.userId,member.userId)));
      return res.json({ success: true, data: claimed });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claimed = await db.transaction(async (tx: any) => {
      // Unlinked handoffs have no ticket lock to authorize the mutation. Keep
      // current member/team authority stable until this transaction commits.
      const currentMember = await tx.execute(sql`
        SELECT member.id
        FROM team_members member
        JOIN support_teams team ON team.id = member.team_id AND team.user_id = member.user_id
        WHERE member.id = ${member.id} AND member.user_id = ${member.userId}
          AND member.team_id = ${access.handoff.teamId}
          AND member.is_active IS TRUE AND team.is_active IS TRUE
        FOR SHARE OF member, team
      `);
      if (!currentMember.rows.length) {
        throw new TicketMutationError('You no longer have access to this handoff', 403, 'TICKET_ACCESS_REVOKED');
      }
      const result = await tx.execute(sql`
        UPDATE handoff_queue
        SET assigned_member_id = ${member.id},
            status = 'in_progress',
            accepted_at = COALESCE(accepted_at, NOW()),
            version = version + 1,
            updated_at = NOW()
        WHERE id = ${id}
          AND user_id = ${member.userId}
          AND team_id = ${access.handoff.teamId}
          AND version = ${access.handoff.version}
          AND support_ticket_id IS NULL
          AND status IN ('waiting', 'assigned', 'in_progress')
          AND (assigned_member_id IS NULL OR assigned_member_id = ${member.id})
        RETURNING *
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return row;
    });
    if (!claimed) return res.status(409).json({ error: 'This handoff was claimed by another support member' });
    return res.json({ success: true, data: claimed });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, '[SupportHandoff] Failed to claim handoff');
    return res.status(500).json({ error: 'Failed to claim handoff' });
  }
}

export async function updateDraft(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const access = await accessibleHandoff(req, id);
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    if (access.handoff.assignedMemberId !== access.scope.member.id) {
      return res.status(409).json({ error: 'Claim the handoff before editing its draft' });
    }
    const aiDraftReply = String(req.body.aiDraftReply || '').trim().slice(0, 20_000);
    const [updated] = await db.update(handoffQueueTable).set({
      aiDraftReply,
      version: sql`${handoffQueueTable.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(handoffQueueTable.id, id),
      eq(handoffQueueTable.assignedMemberId, access.scope.member.id),
    )).returning();
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to update draft');
    return res.status(500).json({ error: 'Failed to update draft' });
  }
}

export async function setAiReplyEnabled(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const access = await accessibleHandoff(req, id);
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    if (typeof req.body?.enabled !== 'boolean' || Object.keys(req.body || {}).some((key) => key !== 'enabled')) {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (!activeStatuses().some((status) => status === access.handoff.status)) {
      return res.status(409).json({ error: 'AI reply control is available only while the handoff is active' });
    }
    const { member } = access.scope;
    if (access.handoff.assignedMemberId !== member.id && !canManageSupport(access.scope)) {
      return res.status(409).json({ error: 'Claim the handoff before changing AI reply control' });
    }

    const enabled = req.body.enabled as boolean;
    const changedAt = new Date();
    const control = {
      enabled,
      changedBy: member.id,
      changedAt: changedAt.toISOString(),
      reason: enabled ? 'support_member_enabled_ai' : 'support_member_takeover',
    };
    const mutate = async (tx: typeof db) => {
      const queue = await tx.execute(sql`
        UPDATE handoff_queue
        SET ai_reply_enabled = ${enabled},
            ai_paused_at = ${enabled ? null : changedAt},
            ai_paused_by = ${enabled ? null : member.id},
            version = version + 1,
            updated_at = NOW()
        WHERE id = ${id}
          AND user_id = ${member.userId}
          AND support_ticket_id IS NOT DISTINCT FROM ${access.handoff.supportTicketId}::integer
          AND version = ${access.handoff.version}
          AND status IN ('waiting', 'assigned', 'in_progress')
        RETURNING *
      `);
      const row = queue.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;

      const supportTicketId = Number(row.support_ticket_id || 0);
      if (supportTicketId) {
        await tx.execute(sql`
          UPDATE support_tickets
          SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'aiReplyControl')
                || ${JSON.stringify({ aiReplyControl: control })}::jsonb,
              version = version + 1, updated_at = NOW()
          WHERE id = ${supportTicketId} AND user_id = ${member.userId}
        `);
      }

      const conversationId = Number(row.conversation_id || 0);
      if (String(row.channel || '') === 'web' && conversationId < 0) {
        await tx.execute(sql`
          UPDATE support_chat_sessions session
          SET automation_mode = 'human_owned',
              metadata = (COALESCE(session.metadata, '{}'::jsonb) - 'aiReplyControl')
                || ${JSON.stringify({ aiReplyControl: control })}::jsonb,
              updated_at = NOW()
          FROM team_members team_member
          WHERE session.id = ${Math.abs(conversationId)}
            AND team_member.id = session.member_id
            AND team_member.user_id = ${member.userId}
            AND session.automation_mode NOT IN ('opted_out','closed')
        `);
      } else {
        await tx.execute(sql`
          UPDATE outreach_conversations
          SET automation_mode = 'human_owned',
              metadata = (COALESCE(metadata, '{}'::jsonb) - 'aiReplyControl')
                || ${JSON.stringify({ aiReplyControl: control })}::jsonb,
              updated_at = NOW()
          WHERE id = ${conversationId} AND user_id = ${member.userId}
            AND automation_mode NOT IN ('opted_out','closed') AND status<>'unsubscribed'
        `);
      }

      await recordSupportAdminAudit(tx, {
        userId: member.userId,
        actorType: 'support_member',
        actorId: member.id,
        action: enabled ? 'handoff.ai_replies_enabled' : 'handoff.human_takeover',
        entityType: 'handoff_queue',
        entityId: id,
        beforeState: { aiReplyEnabled: access.handoff.aiReplyEnabled !== false },
        afterState: { aiReplyEnabled: enabled },
        metadata: { supportTicketId: supportTicketId || null, conversationId },
      });
      return row;
    };
    const updated = access.handoff.supportTicketId
      ? await withLockedSupportTicket(member.userId, access.handoff.supportTicketId, {
          actorMemberId: member.id,
          requireManage: access.handoff.assignedMemberId !== member.id,
        }, mutate)
      : await db.transaction(mutate);
    if (!updated) return res.status(409).json({ error: 'The handoff changed before AI reply control could be updated' });
    return res.json({
      success: true,
      data: {
        handoffId: id,
        aiReplyEnabled: enabled,
        aiPausedAt: enabled ? null : changedAt.toISOString(),
        aiPausedBy: enabled ? null : member.id,
      },
    });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, '[SupportHandoff] Failed to update AI reply control');
    return res.status(500).json({ error: 'Failed to update AI reply control' });
  }
}

export async function resolveHandoff(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const access = await accessibleHandoff(req, id);
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    if (access.handoff.assignedMemberId !== access.scope.member.id) {
      return res.status(409).json({ error: 'Claim the handoff before resolving it' });
    }
    const resolution = String(req.body.resolution || 'manual_reply');
    const resumeAi = req.body?.resumeAi === true;
    if (!['approved', 'edited', 'manual_reply', 'closed'].includes(resolution)) {
      return res.status(400).json({ error: 'Invalid resolution' });
    }
    await handoffService.resolve(
      access.scope.member.userId,
      id,
      resolution as 'approved' | 'edited' | 'manual_reply' | 'closed',
      access.scope.member.id,
      { resumeAi },
    );
    return res.json({ success: true, data: { id, status: 'resolved' } });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, '[SupportHandoff] Failed to resolve handoff');
    return res.status(500).json({ error: 'Failed to resolve handoff' });
  }
}

export async function decideToolApproval(req: Request, res: Response) {
  try {
    const handoffId = Number(req.params.id);
    const approvalId = Number(req.params.approvalId);
    const access = await accessibleHandoff(req, handoffId);
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    if (!canManageSupport(access.scope)) {
      return res.status(403).json({ error: 'Only support leads and administrators can decide tool approvals' });
    }
    if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
      return res.status(400).json({ error: 'Invalid approval ID' });
    }
    if (access.handoff.assignedMemberId !== access.scope.member.id || !activeStatuses().some((status) => status === access.handoff.status)) {
      return res.status(403).json({ error: 'Only the assigned member can decide tool approvals' });
    }
    const decision = String(req.body.decision || '');
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ error: 'decision must be approved or rejected' });
    }
    const comment = String(req.body.comment || '').trim().slice(0, 1000) || null;
    const result = await db.execute(sql`
      UPDATE tool_approvals
      SET status = ${decision},
          user_decision = ${decision === 'approved' ? 'approve' : 'reject'},
          user_comment = ${comment},
          decided_at = NOW(),
          resume_status = ${decision === 'approved' ? 'ready' : 'cancelled'},
          resume_available_at = ${decision === 'approved' ? new Date() : null},
          updated_at = NOW()
      WHERE id = ${approvalId}
        AND user_id = ${access.scope.member.userId}
        AND thread_id = ${access.handoff.conversationId}
        AND status = 'pending'
        AND COALESCE(expires_at, NOW() + INTERVAL '1 minute') > NOW()
      RETURNING id, tool_name AS "toolName", status, resume_status AS "resumeStatus", decided_at AS "decidedAt"
    `);
    const approval = result.rows[0] as { id?: number; status?: string } | undefined;
    if (!approval) return res.status(409).json({ error: 'Approval is expired or was already decided' });
    let executionResult = null;
    if (decision === 'approved') {
      const { supportToolResumeService } = await import('../services/agents/orchestration/SupportToolResumeService.js');
      executionResult = await supportToolResumeService.resumeApproval(access.scope.member.userId, approvalId);
    }
    logger.info({ handoffId, approvalId, decision, memberId: access.scope.member.id }, '[SupportHandoff] Tool approval decided');
    return res.json({ success: true, data: { ...approval, executionResult } });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to decide tool approval');
    return res.status(500).json({ error: 'Failed to decide tool approval' });
  }
}

export async function revealMessage(req: Request, res: Response) {
  try {
    const access = await accessibleHandoff(req, Number(req.params.id));
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    if (access.handoff.assignedMemberId !== access.scope.member.id || !activeStatuses().some((status) => status === access.handoff.status)) {
      return res.status(403).json({ error: 'Only the assigned member can reveal restricted customer data' });
    }
    const messageId = Number(req.params.messageId);
    const reason = String(req.body?.reason || req.query.reason || '').trim();
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || reason.length < 8 || reason.length > 240) {
      return res.status(400).json({ error: 'Choose a message and provide a reason of 8–240 characters.' });
    }
    const result = access.handoff.channel === 'web' && access.handoff.conversationId < 0
      ? await db.execute(sql`
          SELECT scm.privacy_vault_id
          FROM support_chat_messages scm
          JOIN support_chat_sessions scs ON scs.id = scm.session_id
          JOIN team_members tm ON tm.id = scs.member_id
          WHERE scm.id = ${messageId}
            AND scs.id = ${Math.abs(access.handoff.conversationId)}
            AND tm.user_id = ${access.scope.member.userId}
          LIMIT 1
        `)
      : await db.execute(sql`
          SELECT privacy_vault_id
          FROM outreach_messages
          WHERE id = ${messageId}
            AND conversation_id = ${access.handoff.conversationId}
            AND user_id = ${access.scope.member.userId}
          LIMIT 1
        `);
    const vaultId = Number((result.rows[0] as { privacy_vault_id?: number } | undefined)?.privacy_vault_id || 0);
    if (!vaultId) return res.status(404).json({ error: 'No retained restricted content exists for this message' });
    const revealed = await privacyVaultService.reveal(access.scope.member.userId, vaultId, {
      conversationId: access.handoff.conversationId, actor: `member:${access.scope.member.id}`,
      memberId: access.scope.member.id, purpose: reason,
    });
    if (!revealed) return res.status(410).json({ error: 'Restricted content has expired' });
    await db.insert(supportPrivacyAccessLogsTable).values({
      userId: access.scope.member.userId,
      vaultId,
      handoffId: access.handoff.id,
      messageId,
      memberId: access.scope.member.id,
      action: 'reveal',
      reason,
      metadata: { channel: access.handoff.channel },
    });
    logger.info({ handoffId: access.handoff.id, messageId, memberId: access.scope.member.id }, '[SupportHandoff] PII reveal authorized');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, data: { ...revealed, content: revealed.rawText,
      revealExpiresAt: new Date(Math.min(revealed.expiresAt.getTime(), Date.now() + 5 * 60_000)).toISOString() } });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to reveal message');
    return res.status(500).json({ error: 'Failed to reveal restricted content' });
  }
}

export async function generateHandoffAssist(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const access = await accessibleHandoff(req, id);
    if (!access) return res.status(404).json({ error: 'Handoff not found' });
    if (access.handoff.assignedMemberId !== access.scope.member.id || !activeStatuses().some((status) => status === access.handoff.status)) {
      return res.status(403).json({ error: 'Claim the handoff before generating agent assistance' });
    }

    const history = access.handoff.channel === 'web' && access.handoff.conversationId < 0
      ? await db.execute(sql`
          SELECT CASE WHEN scm.role = 'user' THEN 'inbound' ELSE 'outbound' END AS direction,
                 scm.content,
                 scm.created_at
          FROM support_chat_messages scm
          JOIN support_chat_sessions scs ON scs.id = scm.session_id
          JOIN team_members tm ON tm.id = scs.member_id
          WHERE scs.id = ${Math.abs(access.handoff.conversationId)}
            AND tm.user_id = ${access.scope.member.userId}
          ORDER BY scm.created_at DESC
          LIMIT 20
        `)
      : await db.execute(sql`
          SELECT direction, COALESCE(redacted_content, content) AS content, created_at
          FROM outreach_messages
          WHERE user_id = ${access.scope.member.userId}
            AND conversation_id = ${access.handoff.conversationId}
          ORDER BY created_at DESC
          LIMIT 20
        `);
    const messages = [...history.rows].reverse().map((row: { direction?: unknown; content?: unknown }) => ({
      direction: String(row.direction),
      content: String(row.content || '').slice(0, 4000),
    }));
    if (messages.length === 0) return res.status(409).json({ error: 'No redacted conversation history is available' });

    const latestInbound = [...messages].reverse().find((message) => message.direction === 'inbound')?.content || '';
    const currentInboundIndex = messages.map((message) => message.direction).lastIndexOf('inbound');
    const generated = await agentRouter.handle({
      userId: access.scope.member.userId,
      conversationId: access.handoff.conversationId,
      channel: access.handoff.channel,
      // Classifiers, policies, playbooks, and KB retrieval must evaluate the
      // customer's request, not an internal meta-prompt.
      inboundText: latestInbound,
      recipientPhone: `support-member:${access.scope.member.id}`,
      rawMessageId: `handoff-assist:${id}:${access.handoff.version}`,
      metadata: {
        executionMode: 'advisory',
        conversationKind: 'handoff_assist',
        handoffId: id,
        conversationHistory: messages.filter((_, index) => index !== currentInboundIndex).map((message) => ({
          role: message.direction === 'inbound' ? 'user' as const : 'assistant' as const,
          content: message.content,
        })),
        platformInstructions: `This is an internal advisory surface. Prepare exactly three distinct customer-ready reply suggestions for a human support agent. Separate them with ||| and output nothing else. Do not make promises or invent facts. Handoff reason: ${String(access.handoff.reason || 'Human review required').slice(0, 1000)}.`,
      },
    });
    if (!generated?.replyText || generated.deliveryOutcome !== 'auto_sent') {
      return res.status(409).json({ error: 'The active agent requires human review before assistance can be generated.' });
    }
    const suggestions = generated.replyText.split('|||')
      .map((item) => redactPiiWithStableTokens(item).redactedText.trim().slice(0, 4000))
      .filter(Boolean)
      .slice(0, 3);
    if (suggestions.length !== 3) {
      return res.status(502).json({ error: 'The active agent did not return three usable reply suggestions.' });
    }
    const summary = redactPiiWithStableTokens(`Latest customer request: ${latestInbound}`).redactedText.trim().slice(0, 3000);

    const previousContext = access.handoff.conversationContext && typeof access.handoff.conversationContext === 'object'
      ? access.handoff.conversationContext as Record<string, unknown>
      : {};
    const assist = {
      summary,
      suggestions,
      ...INTERNAL_SUPPORT_ASSIST_SCOPE,
      generatedAt: new Date().toISOString(),
      generatedByMemberId: access.scope.member.id,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.transaction(async (tx: any) => {
      await tx.update(handoffQueueTable).set({
        conversationContext: { ...previousContext, aiAssist: assist },
        aiDraftReply: access.handoff.aiDraftReply || suggestions[0],
        version: sql`${handoffQueueTable.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(handoffQueueTable.id, id),
        eq(handoffQueueTable.assignedMemberId, access.scope.member.id),
      ));
      await recordSupportAdminAudit(tx, {
        userId: access.scope.member.userId,
        actorType: 'support_member',
        actorId: access.scope.member.id,
        action: 'handoff.ai_assist.generate',
        entityType: 'handoff_queue',
        entityId: id,
        afterState: assist,
      });
    });
    return res.json({ success: true, data: assist });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to generate agent assistance');
    return res.status(500).json({ error: 'Failed to generate agent assistance' });
  }
}

export async function listCannedResponses(req: Request, res: Response) {
  try {
    const scope = await memberScope(req);
    if (!scope) return res.status(401).json({ error: 'Unauthorized' });
    if (scope.teamIds.length === 0) return res.json({ success: true, data: [] });
    const channel = String(req.query.channel || '').trim();
    const rows = await db.select().from(supportCannedResponsesTable).where(and(
      eq(supportCannedResponsesTable.userId, scope.member.userId),
      inArray(supportCannedResponsesTable.teamId, scope.teamIds),
      eq(supportCannedResponsesTable.isActive, true),
      channel ? sql`(${supportCannedResponsesTable.channel} IS NULL OR ${supportCannedResponsesTable.channel} = ${channel})` : undefined,
    )).orderBy(supportCannedResponsesTable.title);
    return res.json({ success: true, data: rows });
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to list canned responses');
    return res.status(500).json({ error: 'Failed to list canned responses' });
  }
}

export async function createCannedResponse(req: Request, res: Response) {
  try {
    const scope = await memberScope(req);
    if (!scope) return res.status(401).json({ error: 'Unauthorized' });
    if (!canManageSupport(scope)) {
      return res.status(403).json({ error: 'Only support leads and administrators can create canned responses' });
    }
    const teamId = Number(req.body.teamId || scope.member.teamId);
    if (!scope.teamIds.includes(teamId)) return res.status(403).json({ error: 'Team is outside your support scope' });
    const title = String(req.body.title || '').trim();
    const content = String(req.body.content || '').trim();
    const channel = req.body.channel == null ? null : String(req.body.channel);
    if (!title || title.length > 120) return res.status(400).json({ error: 'Title must be between 1 and 120 characters' });
    if (!content || content.length > 10_000) return res.status(400).json({ error: 'Content must be between 1 and 10000 characters' });
    if (channel && !['email', 'whatsapp', 'instagram', 'facebook', 'web'].includes(channel)) return res.status(400).json({ error: 'Unsupported channel' });
    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.filter((tag: unknown): tag is string => typeof tag === 'string').map((tag: string) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 20)
      : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await db.transaction(async (tx: any) => {
      const [row] = await tx.insert(supportCannedResponsesTable).values({
        userId: scope.member.userId, teamId, title, content, channel, tags,
        createdByMemberId: scope.member.id,
      }).returning();
      await recordSupportAdminAudit(tx, {
        userId: scope.member.userId, actorType: 'support_member', actorId: scope.member.id,
        action: 'canned_response.create', entityType: 'support_canned_response', entityId: row.id,
        afterState: row,
      });
      return row;
    });
    return res.status(201).json({ success: true, data: created });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'An active canned response with this title already exists for the team' });
    logger.error({ err: error }, '[SupportHandoff] Failed to create canned response');
    return res.status(500).json({ error: 'Failed to create canned response' });
  }
}

export async function updateCannedResponse(req: Request, res: Response) {
  try {
    const scope = await memberScope(req);
    if (!scope) return res.status(401).json({ error: 'Unauthorized' });
    if (!canManageSupport(scope)) {
      return res.status(403).json({ error: 'Only support leads and administrators can update canned responses' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid canned response ID' });
    const [current] = await db.select().from(supportCannedResponsesTable).where(and(
      eq(supportCannedResponsesTable.id, id),
      eq(supportCannedResponsesTable.userId, scope.member.userId),
      inArray(supportCannedResponsesTable.teamId, scope.teamIds),
    )).limit(1);
    if (!current) return res.status(404).json({ error: 'Canned response not found' });
    const title = req.body.title === undefined ? current.title : String(req.body.title).trim();
    const content = req.body.content === undefined ? current.content : String(req.body.content).trim();
    const channel = req.body.channel === undefined ? current.channel : req.body.channel == null ? null : String(req.body.channel);
    if (!title || title.length > 120 || !content || content.length > 10_000) return res.status(400).json({ error: 'Invalid title or content' });
    if (channel && !['email', 'whatsapp', 'instagram', 'facebook', 'web'].includes(channel)) return res.status(400).json({ error: 'Unsupported channel' });
    const tags = req.body.tags === undefined ? current.tags : Array.isArray(req.body.tags)
      ? req.body.tags.filter((tag: unknown): tag is string => typeof tag === 'string').map((tag: string) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 20)
      : current.tags;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await db.transaction(async (tx: any) => {
      const [row] = await tx.update(supportCannedResponsesTable).set({ title, content, channel, tags, updatedAt: new Date() })
        .where(eq(supportCannedResponsesTable.id, id)).returning();
      await recordSupportAdminAudit(tx, {
        userId: scope.member.userId, actorType: 'support_member', actorId: scope.member.id,
        action: 'canned_response.update', entityType: 'support_canned_response', entityId: id,
        beforeState: current, afterState: row,
      });
      return row;
    });
    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'An active canned response with this title already exists for the team' });
    logger.error({ err: error }, '[SupportHandoff] Failed to update canned response');
    return res.status(500).json({ error: 'Failed to update canned response' });
  }
}

export async function deleteCannedResponse(req: Request, res: Response) {
  try {
    const scope = await memberScope(req);
    if (!scope) return res.status(401).json({ error: 'Unauthorized' });
    if (!canManageSupport(scope)) {
      return res.status(403).json({ error: 'Only support leads and administrators can archive canned responses' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid canned response ID' });
    const [current] = await db.select().from(supportCannedResponsesTable).where(and(
      eq(supportCannedResponsesTable.id, id),
      eq(supportCannedResponsesTable.userId, scope.member.userId),
      inArray(supportCannedResponsesTable.teamId, scope.teamIds),
      eq(supportCannedResponsesTable.isActive, true),
    )).limit(1);
    if (!current) return res.status(404).json({ error: 'Canned response not found' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const archived = await db.transaction(async (tx: any) => {
      const [row] = await tx.update(supportCannedResponsesTable).set({ isActive: false, updatedAt: new Date() }).where(and(
        eq(supportCannedResponsesTable.id, id),
        eq(supportCannedResponsesTable.userId, scope.member.userId),
        inArray(supportCannedResponsesTable.teamId, scope.teamIds),
        eq(supportCannedResponsesTable.isActive, true),
      )).returning();
      if (row) await recordSupportAdminAudit(tx, {
        userId: scope.member.userId, actorType: 'support_member', actorId: scope.member.id,
        action: 'canned_response.archive', entityType: 'support_canned_response', entityId: id,
        beforeState: current, afterState: row,
      });
      return row;
    });
    if (!archived) return res.status(409).json({ error: 'Canned response was already archived' });
    return res.status(204).send();
  } catch (error) {
    logger.error({ err: error }, '[SupportHandoff] Failed to archive canned response');
    return res.status(500).json({ error: 'Failed to archive canned response' });
  }
}
