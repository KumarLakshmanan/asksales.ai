import { supportTicketOwnershipSql } from '../services/SupportTicketOwnership.js';
import { TicketMutationError, withLockedSupportTicket } from '../services/SupportTicketMutation.js';
import { withSystemScope, withBusinessScope } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../models/db';
import { teamMembersTable } from '../models/teamMembers/schema';
import { supportTicketsTable } from '../models/supportTickets/schema';
import { supportTicketMessagesTable } from '../models/supportTicketMessages/schema';
import { supportTeamsTable } from '../models/supportTeams/schema';
import { supportMemberKnowledgeService } from '../services/knowledge/SupportMemberKnowledgeService.js';
import { MemberResourceScopeError, resolveSupportMemberResourceScope } from '../services/SupportMemberResourceScope.js';
import { eq, and, desc, sql, ilike, isNull, or, inArray } from 'drizzle-orm';
import { generateToken } from '../utils/jwt';
import { logger } from '../utils/logger.js';
import { supportService, SupportValidationError } from '../services/SupportService.js';
import { getBrandInfo, renderSupportReplyEmail } from '../utils/emailTemplates';
import { AUTH_COOKIES, clearAuthCookie, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { escapeHtml } from '../utils/personalization.js';
import {
  SupportReplyDeliveryError,
  supportReplyDeliveryService,
} from '../services/SupportReplyDeliveryService.js';
import { supportPresenceService } from '../services/SupportPresenceService.js';
import { verifyToken } from '../utils/jwt.js';
import { supportTicketWorkspaceService } from '../services/SupportTicketWorkspaceService.js';

const TICKET_STATUSES = new Set(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']);
const TICKET_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent', 'critical']);

// ─── Auth ───────────────────────────────────────────────────────────

export const supportMemberLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [member] = await withSystemScope('Support login by email', () => db.select().from(teamMembersTable)
      .where(eq(teamMembersTable.email, email.toLowerCase().trim())));

    if (!member || !member.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!member.isActive) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.' });
    }

    const isValid = await bcrypt.compare(password, member.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!member.businessProfileId) return res.status(403).json({ error: 'Support business is unavailable' });
    return await withBusinessScope({ userId: member.userId, businessProfileId: member.businessProfileId }, async () => {
    // Get team info
    const [team] = await db.select().from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, member.teamId), eq(supportTeamsTable.userId, member.userId), eq(supportTeamsTable.isActive, true)));
    if (!team) return res.status(403).json({ error: 'Your support team is unavailable. Contact your administrator.' });

    const token = generateToken({
      supportMemberId: member.id,
      email: member.email || '',
      role: member.role,
    });
    setAuthCookie(res, AUTH_COOKIES.support, token);
    const sessionPayload = verifyToken(token) as { jti?: string } | null;
    if (sessionPayload?.jti) {
      await supportPresenceService.startOrTouch(member.userId, member.id, sessionPayload.jti);
    }

    return res.json({
      success: true,
      data: {
        member: {
          id: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
          teamId: member.teamId,
          teamName: team?.name || null,
          isActive: member.isActive !== false,
        },
      },
    });
    });
  } catch (error) {
    logger.error({ err: error }, 'Support member login failed');
    return res.status(500).json({ error: 'Login failed' });
  }
};

export const supportMemberLogout = async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : readAuthCookie(req, AUTH_COOKIES.support);
  if (token) {
    const payload = verifyToken(token) as { supportMemberId?: number; jti?: string } | null;
    // Preserve the session and presence when the revocation write fails.
    const { revokeToken } = await import('../utils/jwt.js');
    if (payload && !await revokeToken(token)) {
      return res.status(503).json({ message: 'Sign out could not be confirmed. Please try again.' });
    }
    if (payload?.supportMemberId && payload.jti) {
      const [member] = await withSystemScope('Resolve verified support logout', () => db.select().from(teamMembersTable).where(eq(teamMembersTable.id, payload.supportMemberId!)));
      if (member?.businessProfileId) await withBusinessScope({ userId:member.userId,businessProfileId:member.businessProfileId }, () => supportPresenceService.end(member.userId, member.id, payload.jti!, 'logout'));
    }
  }
  clearAuthCookie(res, AUTH_COOKIES.support);
  return res.status(204).send();
};

export const supportMemberMe = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const [team] = await db.select().from(supportTeamsTable)
      .where(eq(supportTeamsTable.id, member.teamId));

    return res.json({
      success: true,
      data: {
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        teamId: member.teamId,
        teamName: team?.name || null,
        isActive: member.isActive,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support member profile');
    return res.status(500).json({ error: 'Failed to get profile' });
  }
};

export const supportMemberChangePassword = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    const isValid = await bcrypt.compare(currentPassword, member.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await db.update(teamMembersTable)
      .set({ passwordHash: hash, passwordChangedAt: new Date() })
      .where(eq(teamMembersTable.id, member.id));

    return res.json({ success: true, message: 'Password updated' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to change support member password');
    return res.status(500).json({ error: 'Failed to change password' });
  }
};

// ─── Assigned Tickets ───────────────────────────────────────────────

export const getAssignedTickets = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const {
      status, priority, search, page: pageStr, limit: limitStr,
      scope = 'my', handoff, ownership, sla, channel, assignee, unread,
    } = req.query;

    const page = pageStr ? Number(pageStr) : 1;
    const limit = limitStr ? Number(limitStr) : 20;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'Limit must be between 1 and 100' });
    }
    if (status && status !== 'all' && !TICKET_STATUSES.has(String(status))) {
      return res.status(400).json({ error: 'Invalid ticket status' });
    }
    if (priority && priority !== 'all' && !TICKET_PRIORITIES.has(String(priority))) {
      return res.status(400).json({ error: 'Invalid ticket priority' });
    }
    if (search && String(search).length > 200) {
      return res.status(400).json({ error: 'Search cannot exceed 200 characters' });
    }
    if (!['my', 'team', 'unassigned'].includes(String(scope))) return res.status(400).json({ error: 'Invalid ticket scope' });
    if (handoff && !['active', 'none'].includes(String(handoff))) return res.status(400).json({ error: 'Invalid handoff filter' });
    if (ownership && !['ai_active', 'human_owned'].includes(String(ownership))) return res.status(400).json({ error: 'Invalid ownership filter' });
    if (sla && !['breached', 'at_risk'].includes(String(sla))) return res.status(400).json({ error: 'Invalid SLA filter' });
    if (unread && !['true', 'false'].includes(String(unread))) return res.status(400).json({ error: 'Invalid unread filter' });
    if (channel && String(channel).length > 50) return res.status(400).json({ error: 'Invalid channel filter' });
    // Member IDs must fit PostgreSQL int4 before they reach the queue predicate.
    if (assignee && assignee !== 'unassigned' && (
      !Number.isSafeInteger(Number(assignee)) || Number(assignee) <= 0 || Number(assignee) > 2_147_483_647
    )) {
      return res.status(400).json({ error: 'Invalid assignee filter' });
    }
    const offset = (page - 1) * limit;

    // Get all team IDs this member belongs to
    const memberTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member.id));

    const teamIds = memberTeams.map((t: { teamId: number }) => t.teamId);

    // Build conditions: individually assigned to this support member or queued
    // to one of their teams. users.id identifies the workspace owner and is not
    // a valid per-agent assignment key.
    const baseCondition = scope === 'team'
      ? (teamIds.length ? inArray(supportTicketsTable.teamId, teamIds) : eq(supportTicketsTable.assignedMemberId, member.id))
      : scope === 'unassigned'
        ? (teamIds.length ? and(inArray(supportTicketsTable.teamId, teamIds), isNull(supportTicketsTable.assignedMemberId))! : sql`FALSE`)
        : eq(supportTicketsTable.assignedMemberId, member.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [baseCondition, eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)];
    if (status && status !== 'all') conditions.push(eq(supportTicketsTable.status, status as string));
    if (priority && priority !== 'all') conditions.push(eq(supportTicketsTable.priority, priority as string));
    if (search) {
      conditions.push(
        or(
          ilike(supportTicketsTable.subject, `%${search}%`),
          ilike(supportTicketsTable.ticketNumber, `%${search}%`)
        )!
      );
    }
    if (handoff === 'active') conditions.push(sql`EXISTS (SELECT 1 FROM handoff_queue h WHERE h.user_id=${supportTicketsTable.userId} AND h.support_ticket_id=${supportTicketsTable.id} AND h.status IN ('waiting','assigned','in_progress'))`);
    if (handoff === 'none') conditions.push(sql`NOT EXISTS (SELECT 1 FROM handoff_queue h WHERE h.user_id=${supportTicketsTable.userId} AND h.support_ticket_id=${supportTicketsTable.id} AND h.status IN ('waiting','assigned','in_progress'))`);
    if (ownership === 'human_owned') conditions.push(sql`${supportTicketOwnershipSql()} = ${String(ownership)}`);
    if (ownership === 'ai_active') conditions.push(sql`${supportTicketOwnershipSql()} = ${String(ownership)}`);
    if (sla === 'breached') conditions.push(sql`${supportTicketsTable.slaDeadline} IS NOT NULL AND ${supportTicketsTable.slaDeadline} < NOW() AND ${supportTicketsTable.status} NOT IN ('resolved','closed')`);
    if (sla === 'at_risk') conditions.push(sql`${supportTicketsTable.slaDeadline} BETWEEN NOW() AND NOW() + INTERVAL '30 minutes' AND ${supportTicketsTable.status} NOT IN ('resolved','closed')`);
    if (channel === 'web') {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM support_chat_sessions session
        JOIN team_members chat_member ON chat_member.id=session.member_id
        WHERE session.ticket_id=${supportTicketsTable.id} AND chat_member.user_id=${supportTicketsTable.userId}
      )`);
    } else if (channel) {
      conditions.push(sql`EXISTS (SELECT 1 FROM outreach_conversations c WHERE c.id=${supportTicketsTable.outreachConversationId} AND c.user_id=${supportTicketsTable.userId} AND LOWER(c.channel)=LOWER(${String(channel)}))`);
    }
    if (assignee === 'unassigned') conditions.push(isNull(supportTicketsTable.assignedMemberId));
    if (assignee && assignee !== 'unassigned') conditions.push(eq(supportTicketsTable.assignedMemberId, Number(assignee)));
    if (unread === 'true') conditions.push(sql`EXISTS (
      SELECT 1 FROM support_ticket_messages message
      WHERE message.ticket_id=${supportTicketsTable.id}
        AND message.direction='inbound'
        AND COALESCE(message.is_internal,FALSE)=FALSE
        AND message.id > COALESCE((
          SELECT receipt.last_read_message_id
          FROM support_ticket_read_receipts receipt
          WHERE receipt.user_id=${supportTicketsTable.userId}
            AND receipt.ticket_id=${supportTicketsTable.id}
            AND receipt.reader_kind='member'
            AND receipt.reader_id=${member.id}
        ), 0)
    )`);
    const whereClause = and(...conditions);

    const [ticketRows, countResult] = await Promise.all([
      db.select().from(supportTicketsTable)
        .where(whereClause)
        .orderBy(
          sql`CASE
            WHEN ${supportTicketsTable.status} IN ('open','in_progress','waiting_on_customer')
              AND ${supportTicketsTable.slaDeadline} IS NOT NULL
              AND ${supportTicketsTable.slaDeadline} < NOW() THEN 0
            WHEN ${supportTicketsTable.status} IN ('open','in_progress','waiting_on_customer') THEN 1
            ELSE 2
          END`,
          sql`CASE ${supportTicketsTable.priority}
            WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
            WHEN 'medium' THEN 3 ELSE 4 END`,
          desc(supportTicketsTable.updatedAt), desc(supportTicketsTable.id),
        )
        .limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` })
        .from(supportTicketsTable)
        .where(whereClause),
    ]);

    const tickets = await supportService.enrichTicketQueue(
      member.userId,
      ticketRows,
      { kind: 'member', id: member.id },
    );

    return res.json({
      success: true,
      data: {
        tickets,
        total: countResult[0]?.count || 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count || 0) / limit),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get assigned tickets');
    return res.status(500).json({ error: 'Failed to fetch tickets' });
  }
};

export const getTicketDetail = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID' });
    }

    const [ticket] = await db.select().from(supportTicketsTable)
      .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));

    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Verify member has access (assigned to them or in their team)
    const memberTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member.id));
    const teamIds = memberTeams.map((t: { teamId: number }) => t.teamId);

    const hasAccess = ticket.assignedMemberId === member.id ||
      (ticket.teamId && teamIds.includes(ticket.teamId));

    if (!hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this ticket' });
    }
    await supportService.markTicketRead(ticket.userId, ticketId, 'member', member.id);
    const [workspace, messages, summary] = await Promise.all([
      supportService.getTicketWorkspace(ticket.userId, ticketId, { kind: 'member', id: member.id }),
      supportService.getMessages(ticketId, ticket.userId),
      supportTicketWorkspaceService.getSummary(ticket.userId, ticketId),
    ]);
    if (!summary || summary.status === 'stale' || summary.status === 'failed') {
      supportTicketWorkspaceService.queueRefresh(ticket.userId, ticketId);
    }
    return res.json({ success: true, data: { ...workspace, unreadCount: 0, messages, summary } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get ticket detail');
    return res.status(500).json({ error: 'Failed to fetch ticket' });
  }
};

export const updateTicketStatus = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const { status, priority, expectedVersion, resumeAi } = req.body || {};
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID' });
    }
    if (
      !req.body
      || typeof req.body !== 'object'
      || Object.keys(req.body).some((key) => !['status', 'priority', 'expectedVersion', 'resumeAi'].includes(key))
      || (!status && !priority)
    ) {
      return res.status(400).json({ error: 'Provide a status or priority change only' });
    }
    if (status && !TICKET_STATUSES.has(String(status))) {
      return res.status(400).json({ error: 'Invalid ticket status' });
    }
    if (priority && !TICKET_PRIORITIES.has(String(priority))) {
      return res.status(400).json({ error: 'Invalid ticket priority' });
    }
    if (expectedVersion !== undefined && (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1)) {
      return res.status(400).json({ error: 'Invalid ticket version' });
    }
    if (resumeAi !== undefined && typeof resumeAi !== 'boolean') return res.status(400).json({ error: 'resumeAi must be a boolean' });

    const updated = await supportService.updateTicket(member.userId, ticketId, {
      ...(status ? { status } : {}), ...(priority ? { priority } : {}),
    }, { actorMemberId: member.id, expectedVersion: expectedVersion === undefined ? undefined : Number(expectedVersion), resumeAi });
    if (!updated) return res.status(404).json({ error: 'Ticket not found' });

    return res.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    if (error instanceof SupportValidationError) return res.status(400).json({ error: error.message });
    logger.error({ err: error }, 'Failed to update ticket');
    return res.status(500).json({ error: 'Failed to update ticket' });
  }
};

export const claimTicket = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const expectedVersion = req.body?.expectedVersion;
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0 || Object.keys(req.body || {}).some((key) => key !== 'expectedVersion')) {
      return res.status(400).json({ error: 'Invalid ticket claim' });
    }
    if (expectedVersion !== undefined && (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1)) {
      return res.status(400).json({ error: 'Invalid ticket version' });
    }
    const claimed = await supportService.claimTicket(member.userId, ticketId, member.id,
      expectedVersion === undefined ? undefined : Number(expectedVersion));
    return res.json({ success: true, data: claimed });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to claim support ticket');
    return res.status(500).json({ error: 'Failed to claim ticket' });
  }
};

export const getTicketTimeline = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const [ticket] = await db.select().from(supportTicketsTable).where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const memberships = await db.select({ teamId: teamMembersTable.teamId }).from(teamMembersTable).where(eq(teamMembersTable.id, member.id));
    if (ticket.assignedMemberId !== member.id && (!ticket.teamId || !memberships.some((row: { teamId: number }) => row.teamId === ticket.teamId))) {
      return res.status(403).json({ error: 'You do not have access to this ticket' });
    }
    const data = await supportTicketWorkspaceService.getTimeline(member.userId, ticketId, {
      cursor: String(req.query.cursor || '') || undefined,
      limit: Number(req.query.limit || 50),
      viewerMemberId: member.id,
    });
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get ticket timeline');
    return res.status(500).json({ error: 'Failed to fetch ticket conversation' });
  }
};

export const refreshTicketSummary = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const [ticket] = await db.select().from(supportTicketsTable).where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const memberships = await db.select({ teamId: teamMembersTable.teamId }).from(teamMembersTable).where(eq(teamMembersTable.id, member.id));
    if (ticket.assignedMemberId !== member.id && (!ticket.teamId || !memberships.some((row: { teamId: number }) => row.teamId === ticket.teamId))) {
      return res.status(403).json({ error: 'You do not have access to this ticket' });
    }
    const summary = await supportTicketWorkspaceService.refreshSummary(member.userId, ticketId);
    return res.json({ success: true, data: summary });
  } catch (error) {
    logger.error({ err: error }, 'Failed to refresh ticket summary');
    return res.status(500).json({ error: 'Failed to refresh ticket summary' });
  }
};

export const addTicketReply = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const { content, isInternal, idempotencyKey, attachments } = req.body || {};

    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID' });
    }
    if (typeof content !== 'string' || !content.trim() || content.trim().length > 20_000) {
      return res.status(400).json({ error: 'Message content must be between 1 and 20,000 characters' });
    }
    if (isInternal !== undefined && typeof isInternal !== 'boolean') {
      return res.status(400).json({ error: 'isInternal must be a boolean' });
    }
    if (Object.keys(req.body || {}).some((key) => !['content', 'isInternal', 'idempotencyKey', 'attachments'].includes(key))) {
      return res.status(400).json({ error: 'Unsupported reply field' });
    }
    if (
      attachments !== undefined
      && (
        !Array.isArray(attachments)
        || attachments.length > 10
        || attachments.some((attachment: unknown) => {
          if (!attachment || typeof attachment !== 'object') return true;
          const value = attachment as Record<string, unknown>;
          return !Number.isSafeInteger(value.fileId)
            || Number(value.fileId) <= 0
            || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255))
            || (value.type !== undefined && (typeof value.type !== 'string' || value.type.length > 255))
            || Object.keys(value).some((key) => !['fileId', 'name', 'type'].includes(key));
        })
      )
    ) {
      return res.status(400).json({ error: 'Invalid ticket attachments' });
    }
    if (!isInternal && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 160)) {
      return res.status(400).json({ error: 'A valid idempotencyKey is required for customer replies' });
    }

    // Verify access
    const [ticket] = await db.select().from(supportTicketsTable)
      .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const memberTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member.id));
    const teamIds = memberTeams.map((t: { teamId: number }) => t.teamId);

    const hasAccess = ticket.assignedMemberId === member.id ||
      (ticket.teamId && teamIds.includes(ticket.teamId));
    if (!hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this ticket' });
    }
    if (ticket.assignedMemberId !== member.id && !['lead', 'admin'].includes(member.role)) {
      return res.status(409).json({
        error: ticket.assignedMemberId ? 'Claimed by another support member' : 'Claim this ticket before replying',
        code: 'TICKET_ASSIGNMENT_CONFLICT',
      });
    }

    const { StorageService } = await import('../services/StorageService.js');
    const storage = StorageService.getInstance();
    const safeAttachments: Array<{ fileId: number; name: string; url: string; type: string }> = [];
    for (const attachment of (attachments || []) as Array<{ fileId: number; name?: string; type?: string }>) {
      const file = await storage.getFile(attachment.fileId, ticket.userId);
      if (
        !file
        || file.referenceType !== 'support_ticket'
        || file.referenceId !== String(ticketId)
      ) {
        return res.status(400).json({ error: `Attachment ${attachment.fileId} is not available for this ticket.` });
      }
      safeAttachments.push({
        fileId: file.id,
        name: attachment.name?.trim() || file.originalName || file.fileName,
        url: `/api/support-portal/tickets/${ticketId}/attachments/${file.id}`,
        type: attachment.type?.trim() || file.mimeType || 'application/octet-stream',
      });
    }

    const result = await supportReplyDeliveryService.deliver({
      ticket,
      content,
      isInternal: Boolean(isInternal),
      idempotencyKey,
      actorMemberId: member.id,
      actorName: member.name || undefined,
      attachments: safeAttachments,
    });
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: result.message || { deliveryActionId: result.deliveryActionId },
    });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to add ticket reply');
    if (error instanceof SupportReplyDeliveryError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to add reply' });
  }
};

// ─── Close Ticket & Request Review ──────────────────────────────────

export const closeTicketAndRequestReview = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const { reviewMessage, expectedVersion } = req.body || {};
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID' });
    }
    if (
      Object.keys(req.body || {}).some((key) => !['reviewMessage', 'expectedVersion'].includes(key))
      || (reviewMessage !== undefined && (typeof reviewMessage !== 'string' || reviewMessage.trim().length > 2_000))
      || (expectedVersion !== undefined && (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1))
    ) {
      return res.status(400).json({ error: 'Review message cannot exceed 2,000 characters' });
    }

    const reviewClaim = await supportService.claimReviewRequest(member.userId, ticketId, {
      actorMemberId: member.id, expectedVersion: expectedVersion === undefined ? undefined : Number(expectedVersion),
    });
    if (!reviewClaim) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = reviewClaim.ticket;
    if (reviewClaim.state === 'already_sent') {
      return res.json({
        success: true,
        data: { ...reviewClaim.ticket, reviewDeliveryStatus: 'already_sent' },
      });
    }
    if (reviewClaim.state === 'in_progress') {
      return res.json({ success: true, data: { ...reviewClaim.ticket, reviewDeliveryStatus: 'in_progress' } });
    }
    const updated = reviewClaim.ticket;
    // The ticket status mutation creates the canonical durable lifecycle event.
    const recipientRows = ticket.leadId
      ? await db.execute(sql`
          SELECT email, COALESCE(NULLIF(full_name, ''), NULLIF(name, ''), 'Customer') AS name
          FROM leads
          WHERE id = ${ticket.leadId} AND user_id = ${ticket.userId}
          LIMIT 1
        `)
      : ticket.contactId
        ? await db.execute(sql`
            SELECT email,
              COALESCE(NULLIF(CONCAT_WS(' ', first_name, last_name), ''), 'Customer') AS name
            FROM crm_contacts
            WHERE id = ${ticket.contactId} AND user_id = ${ticket.userId}
            LIMIT 1
          `)
        : { rows: [] };
    const recipient = recipientRows.rows[0] as { email?: string; name?: string } | undefined;
    let reviewDeliveryStatus: 'sent' | 'failed' | 'recipient_missing' = 'recipient_missing';
    let reviewDeliveryError: string | null = null;

    if (recipient?.email && updated.reviewToken) {
      try {
        reviewDeliveryStatus = await withLockedSupportTicket(ticket.userId, ticketId, { actorMemberId: member.id }, async (_tx, current) => {
          if (current.status !== 'closed') throw new TicketMutationError('Ticket was reopened before review delivery', 409, 'TICKET_VERSION_CONFLICT');
        const configuredBase = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'https://asksales.ai';
        const clientUrl = new URL(configuredBase);
        if (clientUrl.protocol !== 'https:' && clientUrl.hostname !== 'localhost') {
          throw new Error('Client URL must use HTTPS.');
        }
        const reviewLink = new URL(`/review/${updated.reviewToken}`, clientUrl).toString();
        const brand = await getBrandInfo(ticket.userId, ticket.brandToolkitId, ticket.businessProfileId);
        const [memberInfo] = await db.select({ name: teamMembersTable.name })
          .from(teamMembersTable)
          .where(eq(teamMembersTable.id, member.id));
        const customMessage = reviewMessage?.trim()
          ? `<p style="margin:0 0 12px;">${escapeHtml(reviewMessage.trim()).replace(/\n/g, '<br>')}</p>`
          : '';
        const closeHtml = renderSupportReplyEmail({
          brand,
          preheader: `Ticket ${ticket.ticketNumber} is closed — share your feedback`,
          agentName: memberInfo?.name || undefined,
          body: `<p style="margin:0 0 8px;">Hello ${escapeHtml(recipient.name || 'Customer')},</p>
            <p style="margin:0 0 12px;">Your ticket <strong>${escapeHtml(ticket.ticketNumber)}</strong> — ${escapeHtml(ticket.subject)} — has been closed.</p>
            ${customMessage}
            <p style="margin:0 0 12px;">Please share your experience using the secure link below.</p>
            <p style="margin:0;"><a href="${escapeHtml(reviewLink)}">Rate your support experience</a></p>`,
          ticketNumber: ticket.ticketNumber,
        });
        const { emailService } = await import('../services/emailService.js');
        const result = await emailService.sendEmailWithUserCredentials(ticket.userId, {
          to: recipient.email!,
          subject: `Review your support experience — ${ticket.ticketNumber}`,
          html: closeHtml,
          userId: ticket.userId,
        });
        if (!result.success) throw new Error(result.error || 'Email provider rejected the review request.');
        return 'sent' as const;
        });
      } catch (emailError) {
        reviewDeliveryStatus = 'failed';
        reviewDeliveryError = emailError instanceof Error ? emailError.message : 'Review request delivery failed.';
        logger.warn({ err: emailError, ticketId }, '[SupportMember] Review request delivery failed');
      }
    }
    if (reviewDeliveryStatus === 'sent') {
      await supportService.completeReviewRequest(ticket.userId, ticketId, { success: true });
    } else {
      const failure = reviewDeliveryError
        || (reviewDeliveryStatus === 'recipient_missing'
          ? 'No linked customer email address is available.'
          : 'Review request delivery failed.');
      await supportService.completeReviewRequest(ticket.userId, ticketId, { success: false, error: failure });
    }

    const systemMessage = reviewDeliveryStatus === 'sent'
      ? 'Ticket closed. A review request was sent to the linked customer.'
      : reviewDeliveryStatus === 'recipient_missing'
        ? 'Ticket closed. No linked customer email was available for a review request.'
        : 'Ticket closed. The review request could not be delivered and needs attention.';
    await db.transaction(async (tx: typeof db) => {
      await tx.insert(supportTicketMessagesTable).values({
        ticketId,
        userId: member.userId,
        content: systemMessage,
        direction: 'outbound',
        isInternal: true,
      });
      await tx.update(supportTicketsTable)
        .set({ totalMessages: sql`${supportTicketsTable.totalMessages} + 1`, updatedAt: new Date() })
        .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, ticket.userId)));
    });

    return res.json({
      success: true,
      data: { ...updated, reviewDeliveryStatus, reviewDeliveryError },
    });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to close ticket and request review');
    return res.status(500).json({ error: 'Failed to close ticket' });
  }
};

// ─── Get ticket review ──────────────────────────────────────────────

export const getTicketReview = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID' });
    }
    const [ticket] = await db.select({
      assignedMemberId: supportTicketsTable.assignedMemberId,
      teamId: supportTicketsTable.teamId,
    }).from(supportTicketsTable)
      .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const memberTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member.id));
    const hasAccess = ticket.assignedMemberId === member.id
      || (!!ticket.teamId && memberTeams.some((team: { teamId: number }) => team.teamId === ticket.teamId));
    if (!hasAccess) return res.status(403).json({ error: 'You do not have access to this ticket' });
    const review = await supportService.getReview(ticketId);
    return res.json({ success: true, data: review });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get ticket review');
    return res.status(500).json({ error: 'Failed to get review' });
  }
};

export const getSupportMemberStats = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;

    const memberTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member.id));
    const teamIds = memberTeams.map((t: { teamId: number }) => t.teamId);

    const baseCondition = teamIds.length > 0
      ? or(
          eq(supportTicketsTable.assignedMemberId, member.id),
          inArray(supportTicketsTable.teamId, teamIds)
        )!
      : eq(supportTicketsTable.assignedMemberId, member.id);

    const [stats] = await db.select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where status = 'open')::int`,
      inProgress: sql<number>`count(*) filter (where status = 'in_progress')::int`,
      waitingOnCustomer: sql<number>`count(*) filter (where status = 'waiting_on_customer')::int`,
      resolved: sql<number>`count(*) filter (where status = 'resolved')::int`,
      closed: sql<number>`count(*) filter (where status = 'closed')::int`,
      highPriority: sql<number>`count(*) filter (where priority IN ('high', 'urgent', 'critical') AND status NOT IN ('resolved', 'closed'))::int`,
      totalReviews: sql<number>`count(rating)::int`,
      avgRating: sql<number>`coalesce(avg(rating), 0)`,
    }).from(supportTicketsTable).where(and(baseCondition, eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));

    const [myWork, handoffMetrics] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE assigned_member_id=${member.id} AND status IN ('open','in_progress','waiting_on_customer'))::int AS my_active,
          COUNT(*) FILTER (WHERE assigned_member_id IS NULL AND status IN ('open','in_progress'))::int AS team_unassigned,
          COUNT(*) FILTER (WHERE status IN ('open','in_progress','waiting_on_customer') AND sla_deadline IS NOT NULL AND sla_deadline < NOW() + INTERVAL '30 minutes')::int AS sla_risk,
          COUNT(*) FILTER (WHERE status IN ('open','in_progress','waiting_on_customer') AND EXISTS (
            SELECT 1 FROM handoff_queue h WHERE h.user_id=support_tickets.user_id AND h.support_ticket_id=support_tickets.id AND h.status IN ('waiting','assigned','in_progress')
          ))::int AS needs_human
        FROM support_tickets
        WHERE user_id=${member.userId} AND deleted_at IS NULL
          ${teamIds.length ? sql`AND team_id IN (${sql.join(teamIds.map((id: number) => sql`${id}`), sql`,`)})` : sql`AND assigned_member_id=${member.id}`}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS handoff_volume,
          COALESCE(AVG(EXTRACT(EPOCH FROM (handoff.accepted_at-handoff.created_at))/60) FILTER (WHERE handoff.accepted_at IS NOT NULL),0)::float AS avg_claim_minutes,
          COALESCE(AVG(EXTRACT(EPOCH FROM (handoff.resolved_at-COALESCE(handoff.accepted_at,handoff.created_at)))/60) FILTER (WHERE handoff.resolved_at IS NOT NULL),0)::float AS avg_human_minutes,
          COALESCE(100.0*COUNT(*) FILTER (WHERE handoff.resolved_at IS NOT NULL AND CASE
            WHEN ticket.metadata->'ownershipResolution'->>'resumeAi' IN ('true','false')
              THEN (ticket.metadata->'ownershipResolution'->>'resumeAi')::boolean
            ELSE FALSE END)/NULLIF(COUNT(*) FILTER (WHERE handoff.resolved_at IS NOT NULL),0),0)::float AS ai_resume_rate
        FROM handoff_queue handoff
        LEFT JOIN support_tickets ticket ON ticket.id=handoff.support_ticket_id AND ticket.user_id=handoff.user_id
        WHERE handoff.user_id=${member.userId}
          ${teamIds.length ? sql`AND handoff.team_id IN (${sql.join(teamIds.map((id: number) => sql`${id}`), sql`,`)})` : sql`AND handoff.assigned_member_id=${member.id}`}
      `),
    ]);
    const work = myWork.rows[0] as Record<string, unknown> | undefined;
    const handoffs = handoffMetrics.rows[0] as Record<string, unknown> | undefined;

    return res.json({
      success: true,
      data: {
        ...stats,
        avgRating: Number(Number(stats?.avgRating || 0).toFixed(1)),
        myActive: Number(work?.my_active || 0),
        teamUnassigned: Number(work?.team_unassigned || 0),
        slaRisk: Number(work?.sla_risk || 0),
        needsHuman: Number(work?.needs_human || 0),
        handoffVolume: Number(handoffs?.handoff_volume || 0),
        avgClaimMinutes: Number(Number(handoffs?.avg_claim_minutes || 0).toFixed(1)),
        avgHumanMinutes: Number(Number(handoffs?.avg_human_minutes || 0).toFixed(1)),
        aiResumeRate: Number(Number(handoffs?.ai_resume_rate || 0).toFixed(1)),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support member stats');
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

export const getMyTeamMembers = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const memberships = await db.select({ teamId: teamMembersTable.teamId }).from(teamMembersTable).where(eq(teamMembersTable.id, member.id));
    const teamIds = memberships.map((row: { teamId: number }) => row.teamId);
    if (!teamIds.length) return res.json({ success: true, data: [] });
    const rows = await db.select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      email: teamMembersTable.email,
      role: teamMembersTable.role,
      teamId: teamMembersTable.teamId,
    }).from(teamMembersTable).where(and(
      inArray(teamMembersTable.teamId, teamIds),
      eq(teamMembersTable.userId, member.userId),
      eq(teamMembersTable.isActive, true),
    )).orderBy(teamMembersTable.name);
    return res.json({ success: true, data: rows });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support team members');
    return res.status(500).json({ error: 'Failed to fetch team members' });
  }
};

// ─── Knowledge Base (read-only) ─────────────────────────────────────

export const getSupportKnowledgeBase = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;

    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 24);
    const search = String(req.query.search || '').trim();
    const type = String(req.query.type || 'all').trim();
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'Limit must be between 1 and 100' });
    }
    if (search.length > 200) return res.status(400).json({ error: 'Search cannot exceed 200 characters' });
    if (!['all', 'document', 'file', 'qa', 'url'].includes(type)) {
      return res.status(400).json({ error: 'Invalid knowledge-base type' });
    }
    if (!member) return res.status(401).json({ error: 'A valid support member is required.' });
    const resolvedScope = await resolveSupportMemberResourceScope(member, req.query.ticketId);
    const data = await supportMemberKnowledgeService.list({ ...member, businessProfileId: resolvedScope.businessProfileId }, { page, limit, search, type });
    if (!data) return res.status(404).json({ error: 'Team not found' });
    return res.json({ success: true, data: { ...data, resolvedScope } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support knowledge base');
    if (error instanceof MemberResourceScopeError) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to fetch knowledge base' });
  }
};

export const getSupportKnowledgeBaseExtractedText = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const rawId = req.params.id;
    const entryId = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(entryId)) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    if (!member) return res.status(401).json({ error: 'A valid support member is required.' });
    const resolvedScope = await resolveSupportMemberResourceScope(member, req.query.ticketId);
    const data = await supportMemberKnowledgeService.extractedText({ ...member, businessProfileId: resolvedScope.businessProfileId }, entryId);
    if (!data) return res.status(404).json({ error: 'Entry not found' });
    return res.json({ success: true, ...data });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support KB extracted text');
    if (error instanceof MemberResourceScopeError) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to fetch extracted text' });
  }
};

// ─── M11 — Team queue (unassigned + mine, scoped to my teams) ───
export const getTeamQueue = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const memberTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member.id));
    const teamIds = memberTeams.map((t: { teamId: number }) => t.teamId);
    if (teamIds.length === 0) {
      return res.json({ success: true, data: { unassigned: [], assignedToMe: [] } });
    }
    const inMyTeams = inArray(supportTicketsTable.teamId, teamIds);
    const [unassigned, assignedToMe] = await Promise.all([
      db.select().from(supportTicketsTable)
        .where(and(inMyTeams, eq(supportTicketsTable.userId, member.userId), sql`${supportTicketsTable.assignedMemberId} IS NULL`,
          sql`${supportTicketsTable.status} IN ('open','in_progress')`,
          isNull(supportTicketsTable.deletedAt)))
        .orderBy(desc(supportTicketsTable.priority), desc(supportTicketsTable.createdAt))
        .limit(100),
      db.select().from(supportTicketsTable)
        .where(and(inMyTeams, eq(supportTicketsTable.userId, member.userId), eq(supportTicketsTable.assignedMemberId, member.id),
          sql`${supportTicketsTable.status} IN ('open','in_progress')`,
          isNull(supportTicketsTable.deletedAt)))
        .orderBy(desc(supportTicketsTable.priority), desc(supportTicketsTable.createdAt))
        .limit(100),
    ]);
    return res.json({ success: true, data: { unassigned, assignedToMe } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get team queue');
    return res.status(500).json({ error: 'Failed to fetch team queue' });
  }
};

// ─── M12 — Reassign ticket to a teammate ────────────────────────
export const reassignTicket = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = (req as any).supportMember;
    const ticketId = Number(req.params.id);
    const { newAssigneeId } = req.body || {};
    if (!['lead', 'admin'].includes(member.role)) {
      return res.status(403).json({ error: 'Only support leads or admins can reassign tickets' });
    }
    if (
      !Number.isSafeInteger(ticketId)
      || ticketId <= 0
      || !Number.isSafeInteger(Number(newAssigneeId))
      || Number(newAssigneeId) <= 0
      || Object.keys(req.body || {}).some((key) => key !== 'newAssigneeId')
    ) {
      return res.status(400).json({ error: 'ticketId and newAssigneeId are required' });
    }
    const [ticket] = await db.select().from(supportTicketsTable)
      .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, member.userId), isNull(supportTicketsTable.deletedAt)));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!ticket.teamId) return res.status(400).json({ error: 'Assign the ticket to a team before choosing a member' });

    // Verify caller is on the same team as the ticket
    const myTeams = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable).where(eq(teamMembersTable.id, member.id));
    const myTeamIds = new Set(myTeams.map((t: { teamId: number }) => t.teamId));
    if (!myTeamIds.has(ticket.teamId)) {
      return res.status(403).json({ error: 'You are not on this ticket\u2019s team' });
    }

    // Verify new assignee is on the ticket\u2019s team
    const [assigneeMembership] = await db.select({ id: teamMembersTable.id })
      .from(teamMembersTable)
      .where(and(
        eq(teamMembersTable.id, Number(newAssigneeId)),
        eq(teamMembersTable.teamId, ticket.teamId),
        eq(teamMembersTable.userId, member.userId),
        eq(teamMembersTable.isActive, true),
      ));
    if (!assigneeMembership) {
      return res.status(400).json({ error: 'Target user is not an active member of this team' });
    }

    // Use the same transactional assignment path as the owner panel so the
    // active handoff and ticket never point to different members. A team or
    // ticket change since the authorization read must not be overwritten.
    const updated = await supportService.updateTicket(member.userId, ticketId,
      { assignedMemberId: Number(newAssigneeId) },
      { expectedVersion: ticket.version, expectedTeamId: ticket.teamId, actorMemberId: member.id, requireManage: true });
    if (!updated) return res.status(409).json({ error: 'This ticket changed before reassignment', code: 'TICKET_VERSION_CONFLICT' });

    return res.json({ success: true });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to reassign ticket');
    if (error instanceof SupportValidationError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to reassign ticket' });
  }
};
