import { TicketMutationError } from '../services/SupportTicketMutation.js';
import { assertOwnedCampaignThread, CampaignWorkspaceError } from '../services/CampaignWorkspaceService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { SupportValidationError, supportService } from '../services/SupportService.js';
import { getBrandInfo, renderSupportReplyEmail } from '../utils/emailTemplates';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { escapeHtml } from '../utils/personalization.js';
import {
  SupportReplyDeliveryError,
  supportReplyDeliveryService,
} from '../services/SupportReplyDeliveryService.js';
import { supportTicketWorkspaceService } from '../services/SupportTicketWorkspaceService.js';
import { privacyVaultService } from '../services/agents/orchestration/PrivacyVaultService.js';
import { firstIssueMessage as firstIssue } from '../utils/zodIssue.js';

const positiveId = z.coerce.number().int().positive();
const ticketQuerySchema = z.object({
  chatThreadId: positiveId.optional(),
  status: z.enum(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  teamId: positiveId.optional(),
  channel: z.enum(['web', 'email', 'whatsapp', 'instagram', 'facebook']).optional(),
  ownership: z.enum(['ai_active', 'human_owned', 'unassigned']).optional(),
  sla: z.enum(['breached', 'at_risk', 'on_track', 'none']).optional(),
  unread: z.enum(['true']).optional(),
  sort: z.enum(['operational', 'updated', 'newest', 'oldest']).default('operational'),
  view: z.enum(['pipeline']).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const createTicketSchema = z.object({
  chatThreadId: positiveId.optional(),
  contactId: z.coerce.number().int().refine(value => value !== 0, 'Invalid contact ID').optional(),
  leadId: positiveId.optional(),
  outreachConversationId: positiveId.optional(),
  teamId: positiveId.optional(),
  assignedMemberId: positiveId.optional(),
  subject: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20_000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']).default('medium'),
  category: z.string().trim().min(1).max(50).default('support'),
  slaDeadline: z.coerce.date().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  autoAssign: z.boolean().default(false),
}).strict();
const updateTicketSchema = z.object({
  expectedVersion: positiveId.optional(),
  resumeAi: z.boolean().optional(),
  status: z.enum(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(20_000).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  teamId: positiveId.nullable().optional(),
  assignedMemberId: positiveId.nullable().optional(),
  slaDeadline: z.coerce.date().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
}).strict().refine((value) => Object.keys(value).some(key => !['expectedVersion','resumeAi'].includes(key)), 'No ticket changes provided.');
const messageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  isInternal: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
  attachments: z.array(z.object({
    fileId: positiveId,
    name: z.string().trim().min(1).max(255).optional(),
    type: z.string().trim().min(1).max(255).optional(),
  }).strict()).max(10).default([]),
}).strict();
const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(2_000).optional(),
}).strict();
const reviewTokenSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const getTickets = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = ticketQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
    const result = await supportService.getTickets(userId, parsed.data, {kind:'owner', id:req.user!.id});

    return res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof CampaignWorkspaceError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to get tickets');
    return res.status(500).json({ error: 'Failed to fetch tickets' });
  }
};

export const getTicket = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsedId = positiveId.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid ticket ID' });
    const ticket = await supportService.getTicketById(userId, parsedId.data);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    await supportService.markTicketRead(userId, ticket.id, 'owner', req.user!.id);
    const workspace = await supportService.getTicketWorkspace(userId, ticket.id, { kind: 'owner', id: req.user!.id });

    return res.json({ success: true, data: workspace });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get ticket');
    return res.status(500).json({ error: 'Failed to fetch ticket' });
  }
};

export const createTicket = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = createTicketSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
    if (parsed.data.chatThreadId) await assertOwnedCampaignThread(userId, parsed.data.chatThreadId);
    if (parsed.data.contactId && parsed.data.contactId < 0) {
      const { crmService } = await import('../services/CRMService.js');
      const contact = await crmService.materializeContactReference(userId, parsed.data.contactId, 'support_ticket');
      if (!contact) return res.status(400).json({ error: 'Invalid CRM contact.' });
      parsed.data.contactId = contact.id;
    }
    const ticket = await supportService.createTicket(userId, parsed.data);
    return res.status(201).json({ success: true, data: ticket });
  } catch (error) {
    if (error instanceof CampaignWorkspaceError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to create ticket');
    if (error instanceof SupportValidationError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to create ticket' });
  }
};

export const updateTicket = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) return res.status(400).json({ error: 'Invalid ticket ID' });

    const parsed = updateTicketSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
    const { expectedVersion, resumeAi, ...changes } = parsed.data;
    const updates: Record<string, unknown> = { ...changes };
    const current = await supportService.getTicketById(userId, ticketId);
    if (!current) return res.status(404).json({ error: 'Ticket not found' });
    const targetTeamId = parsed.data.teamId === undefined ? current.teamId : parsed.data.teamId;
    // Disabled queues cannot receive a new assignment. Owners must still be
    // able to close or move their existing work out of a disabled queue.
    if (parsed.data.teamId !== undefined && targetTeamId) {
      const team = await db.execute(sql`
        SELECT id FROM support_teams WHERE id = ${targetTeamId} AND user_id = ${userId} AND is_active IS TRUE LIMIT 1
      `);
      if (!team.rows[0]) return res.status(400).json({ error: 'Invalid support team' });
    }
    if (parsed.data.teamId === null) updates.assignedMemberId = null;
    if (parsed.data.assignedMemberId) {
      if (!targetTeamId) return res.status(400).json({ error: 'Choose a support team before assigning a member' });
      const member = await db.execute(sql`
        SELECT tm.id
        FROM team_members tm
        JOIN support_teams st ON st.id = tm.team_id
        WHERE tm.id = ${parsed.data.assignedMemberId}
          AND tm.team_id = ${targetTeamId}
          AND st.user_id = ${userId}
          AND tm.is_active = true
        LIMIT 1
      `);
      if (!member.rows[0]) return res.status(400).json({ error: 'Invalid or inactive support member' });
    }

    const ticket = await supportService.updateTicket(userId, ticketId, updates, { actorUserId: req.user!.id, expectedVersion, resumeAi });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Send a "ticket closed" email to the lead when status is changed to closed
    if (updates.status === 'closed' && current.status !== 'closed' && ticket.leadId) {
      try {
        const leadResult = await db.execute(sql`
          SELECT email, name, full_name FROM leads
          WHERE id = ${ticket.leadId} AND user_id = ${userId}
        `);
        const lead = leadResult.rows[0] as Record<string, unknown> | undefined;
        const leadEmail = lead?.email as string | undefined;

        if (leadEmail) {
          const brand = await getBrandInfo(userId, ticket.brandToolkitId);
          const closeHtml = renderSupportReplyEmail({
            brand,
            preheader: `Your support ticket ${ticket.ticketNumber} has been resolved`,
            agentName: undefined,
            body: `<p style="margin:0 0 8px;">Your support ticket <strong>#${escapeHtml(ticket.ticketNumber)}</strong> — <em>${escapeHtml(ticket.subject)}</em> — has been resolved and closed.</p><p style="margin:0 0 8px;">If you have any further questions or the issue persists, please don't hesitate to reach out. We're here to help!</p><p style="margin:0;">Thank you for contacting us.</p>`,
            ticketNumber: ticket.ticketNumber,
          });

          // Fetch threading headers so ticket-closed email threads properly (Issue #5 fix)
          let closeThreadingHeaders: { inReplyTo?: string; references?: string; threadId?: string } | undefined;
          try {
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const normalizeId = (id: string | undefined): string | undefined => {
              if (!id) return undefined;
              if (id.startsWith('<') && id.endsWith('>')) return id;
              if (uuidRegex.test(id)) return `<${id}@resend.dev>`;
              if (id.includes('@')) return `<${id}>`;
              return undefined;
            };

            if (ticket.outreachConversationId) {
              const convResult = await db.execute(sql`
                SELECT external_thread_id FROM outreach_conversations
                WHERE id = ${ticket.outreachConversationId} AND user_id = ${userId}
              `);
              const gmailThreadId = convResult.rows[0]?.external_thread_id as string | undefined;
              const msgResult = await db.execute(sql`
                SELECT external_message_id FROM outreach_messages
                WHERE conversation_id = ${ticket.outreachConversationId}
                  AND user_id = ${userId}
                  AND external_message_id IS NOT NULL
                ORDER BY sent_at DESC NULLS LAST, created_at DESC
                LIMIT 1
              `);
              const lastMessageId = msgResult.rows[0]?.external_message_id as string | undefined;
              const allMsgResult = await db.execute(sql`
                SELECT external_message_id FROM outreach_messages
                WHERE conversation_id = ${ticket.outreachConversationId}
                  AND user_id = ${userId}
                  AND external_message_id IS NOT NULL
                ORDER BY created_at ASC
              `);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fullChain = (allMsgResult.rows as any[])
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((r: any) => normalizeId(r.external_message_id))
                .filter(Boolean)
                .join(' ');
              if (gmailThreadId || lastMessageId) {
                closeThreadingHeaders = {
                  inReplyTo: normalizeId(lastMessageId) || undefined,
                  references: fullChain || normalizeId(lastMessageId) || undefined,
                  threadId: gmailThreadId || undefined,
                };
              }
            }
            if (!closeThreadingHeaders && ticket.leadId) {
              const smResult = await db.execute(sql`
                SELECT message_id, gmail_thread_id, gmail_message_id
                FROM sent_messages
                WHERE lead_id = ${ticket.leadId} AND channel = 'email'
                  AND (message_id IS NOT NULL OR gmail_thread_id IS NOT NULL)
                ORDER BY created_at DESC
                LIMIT 1
              `);
              const sm = smResult.rows[0] as Record<string, unknown> | undefined;
              const msgId = (sm?.message_id || sm?.gmail_message_id) as string | undefined;
              const threadId = sm?.gmail_thread_id as string | undefined;
              if (msgId || threadId) {
                closeThreadingHeaders = {
                  inReplyTo: normalizeId(msgId) || undefined,
                  references: normalizeId(msgId) || undefined,
                  threadId: threadId || undefined,
                };
              }
            }
          } catch (threadErr) {
            logger.warn({ err: threadErr, ticketId: ticket.id }, '[Support] Failed to fetch threading info for close email (non-blocking)');
          }

          const { emailService } = await import('../services/emailService.js');
          const subjectLine = `Re: ${(ticket.subject || 'Support Request').replace(/^Re:\s*/i, '').replace(/[\r\n]+/g, ' ')} [Resolved]`;
          const closeResult = await emailService.sendPersonalizedEmail(
            ticket.leadId, subjectLine, closeHtml,
            undefined, undefined, userId,
            closeThreadingHeaders,
          );
          if (closeResult.success) {
            logger.info({ ticketId: ticket.id, leadId: ticket.leadId, threaded: !!closeThreadingHeaders }, '[Support] Sent ticket-closed email to customer');
          } else {
            logger.warn({ ticketId: ticket.id, leadId: ticket.leadId, error: closeResult.error }, '[Support] Ticket closed but closure email was rejected');
          }
        }
      } catch (emailErr) {
        logger.warn({ err: emailErr, ticketId: ticket.id }, 'Failed to send ticket-closed email to lead (non-blocking)');
      }
    }

    const workspace = await supportService.getTicketWorkspace(userId, ticket.id, { kind: 'owner', id: req.user!.id });
    return res.json({ success: true, data: workspace || ticket });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to update ticket');
    if (error instanceof SupportValidationError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to update ticket' });
  }
};

export const deleteTicket = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsedId = positiveId.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid ticket ID' });
    const deleted = await supportService.deleteTicket(userId, parsedId.data);
    if (!deleted) return res.status(404).json({ error: 'Ticket not found' });
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete ticket');
    return res.status(500).json({ error: 'Failed to delete ticket' });
  }
};

export const createTicketFromConversation = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const conversationId = positiveId.safeParse(req.params.conversationId);
    const parsed = z.object({
      subject: z.string().trim().min(1).max(500),
      description: z.string().trim().max(20_000).optional(),
    }).strict().safeParse(req.body);
    if (!conversationId.success) return res.status(400).json({ error: 'Invalid conversation ID' });
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });

    const ticket = await supportService.createTicketFromConversation(
      userId, conversationId.data, parsed.data.subject, parsed.data.description
    );
    return res.status(201).json({ success: true, data: ticket });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create ticket from conversation');
    if (error instanceof SupportValidationError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to create ticket' });
  }
};

export const addMessage = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) return res.status(400).json({ error: 'Invalid ticket ID' });
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
    const { content: msgContent, isInternal, idempotencyKey, attachments } = parsed.data;
    if (!isInternal && !idempotencyKey) {
      return res.status(400).json({ error: 'A valid idempotencyKey is required for customer replies.' });
    }
    const ticket = await supportService.getTicketById(userId, ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const { StorageService } = await import('../services/StorageService.js');
    const storage = StorageService.getInstance();
    const safeAttachments: Array<{ fileId: number; name: string; url: string; type: string }> = [];
    for (const attachment of attachments) {
      const file = await storage.getFile(attachment.fileId, userId);
      if (
        !file
        || file.referenceType !== 'support_ticket'
        || file.referenceId !== String(ticketId)
      ) {
        return res.status(400).json({ error: `Attachment ${attachment.fileId} is not available for this ticket.` });
      }
      safeAttachments.push({
        fileId: file.id,
        name: attachment.name || file.originalName || file.fileName,
        url: `/api/support/${ticketId}/attachments/${file.id}`,
        type: attachment.type || file.mimeType || 'application/octet-stream',
      });
    }

    const result = await supportReplyDeliveryService.deliver({
      ticket,
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      content: msgContent,
      isInternal,
      idempotencyKey,
      attachments: safeAttachments,
    });
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: result.message || { deliveryActionId: result.deliveryActionId },
    });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to add message');
    if (error instanceof SupportReplyDeliveryError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to add message' });
  }
};

export const getMessages = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Verify ticket ownership first
    const ticket = await supportService.getTicketById(userId, Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const messages = await supportService.getMessages(Number(req.params.id), userId);
    return res.json({ success: true, data: messages });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get messages');
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

export const revealOwnerTicketMessage = async (req: Request, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const ticketId = positiveId.safeParse(req.params.id);
  const messageId = positiveId.safeParse(req.params.messageId);
  const reason = z.string().trim().min(8).max(240).safeParse(req.body?.reason);
  const source = req.params.source;
  if (!ticketId.success || !messageId.success || !reason.success || !['conversation', 'support_chat'].includes(source)) {
    return res.status(400).json({ error: 'Choose a message and provide a reason of 8–240 characters.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = source === 'conversation' ? await db.execute(sql`
      SELECT vault.id, vault.conversation_id FROM support_tickets ticket
      JOIN outreach_messages message ON message.conversation_id=ticket.outreach_conversation_id AND message.user_id=ticket.user_id
      JOIN support_privacy_vault vault ON vault.id=message.privacy_vault_id AND vault.user_id=ticket.user_id AND vault.conversation_id=message.conversation_id
      WHERE ticket.id=${ticketId.data} AND ticket.user_id=${userId} AND ticket.deleted_at IS NULL AND message.id=${messageId.data} LIMIT 1
    `) : await db.execute(sql`
      SELECT vault.id, vault.conversation_id FROM support_tickets ticket
      JOIN support_chat_sessions session ON session.ticket_id=ticket.id
      JOIN team_members member ON member.id=session.member_id AND member.user_id=ticket.user_id
      JOIN support_chat_messages message ON message.session_id=session.id
      JOIN support_privacy_vault vault ON vault.id=message.privacy_vault_id AND vault.user_id=ticket.user_id
      WHERE ticket.id=${ticketId.data} AND ticket.user_id=${userId} AND ticket.deleted_at IS NULL AND message.id=${messageId.data} LIMIT 1
    `);
    const row = result.rows[0] as { id: number; conversation_id: number } | undefined;
    if (!row) return res.status(404).json({ error: 'Retained message not found in this ticket.' });
    const revealed = await privacyVaultService.reveal(userId, row.id, {
      conversationId: row.conversation_id, actor: `user:${req.user!.id}`, purpose: reason.data,
    });
    if (!revealed) return res.status(410).json({ error: 'Restricted content has expired.' });
    return res.json({ success: true, data: { content: revealed.rawText,
      revealExpiresAt: new Date(Math.min(Date.now() + 300_000, revealed.expiresAt.getTime())).toISOString() } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to reveal support message');
    return res.status(500).json({ error: 'Restricted content could not be revealed.' });
  }
};

export const getTicketTimeline = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ticketId = Number(req.params.id);
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID' });
    }
    const ticket = await supportService.getTicketById(userId, ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const timeline = await supportTicketWorkspaceService.getTimeline(userId, ticketId, {
      cursor: String(req.query.cursor || '') || undefined,
      limit: Number(req.query.limit || 200),
      latest: req.query.latest === 'true',
      viewerOwnerId: req.user!.id,
    });
    return res.json({ success: true, data: timeline });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get owner ticket timeline');
    return res.status(500).json({ error: 'Failed to fetch ticket conversation' });
  }
};

export const getSupportAnalytics = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = z.object({
      days: z.coerce.number().int().min(7).max(365).default(30),
    }).strict().safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
    const analytics = await supportService.getAnalytics(userId, parsed.data.days);
    return res.json({ success: true, data: analytics });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support analytics');
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};

export const resolveTicketOwnership = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    const ticketId = Number(req.params.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return res.status(400).json({ error: 'Invalid ticket ID' });
    const parsed = z.object({
      resolution: z.enum(['approved', 'edited', 'manual_reply', 'closed']).default('manual_reply'),
      resumeAi: z.boolean().default(false),
    }).strict().safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });

    const handoffResult = await db.execute(sql`
      SELECT handoff.id
      FROM handoff_queue handoff
      JOIN support_tickets ticket ON ticket.id = handoff.support_ticket_id
      WHERE handoff.user_id = ${userId}
        AND handoff.support_ticket_id = ${ticketId}
        AND ticket.user_id = ${userId}
        AND ticket.deleted_at IS NULL
        AND handoff.status IN ('waiting', 'assigned', 'in_progress')
      ORDER BY handoff.created_at DESC
      LIMIT 1
    `);
    const handoffId = Number((handoffResult.rows[0] as { id?: number } | undefined)?.id || 0);
    if (!handoffId) return res.status(404).json({ error: 'No active handoff exists for this ticket' });

    const { handoffService } = await import('../services/agents/pipeline/HandoffService.js');
    await handoffService.resolve(userId, handoffId, parsed.data.resolution, undefined, { resumeAi: parsed.data.resumeAi, actorUserId: req.user!.id });
    const workspace = await supportService.getTicketWorkspace(userId, ticketId, { kind: 'owner', id: req.user!.id });
    return res.json({ success: true, data: workspace });
  } catch (error) {
    if (error instanceof TicketMutationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    logger.error({ err: error }, 'Failed to resolve ticket ownership');
    return res.status(500).json({ error: 'Failed to resolve ticket ownership' });
  }
};

// ─── Reviews ────────────────────────────────────────────────────────

export const submitReview = async (_req: Request, res: Response) => {
  // Workspace owners must not be able to manufacture customer ratings. Keep
  // the legacy route as an explicit deprecation response while the secure,
  // expiring public capability is the sole review-submission path.
  res.setHeader('Deprecation', 'true');
  return res.status(410).json({
    error: 'Customer reviews must be submitted through the secure review link.',
    replacement: '/api/support/review-public/:token',
  });
};

export const getTicketReview = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Verify ticket belongs to user
    const ticket = await supportService.getTicketById(userId, Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const review = await supportService.getReview(Number(req.params.id));
    return res.json({ success: true, data: review });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get review');
    return res.status(500).json({ error: 'Failed to get review' });
  }
};

export const getMyReviews = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const reviews = await supportService.getReviewsByUser(userId);
    return res.json({ success: true, data: reviews });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get reviews');
    return res.status(500).json({ error: 'Failed to get reviews' });
  }
};

export const getReviewStats = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const stats = await supportService.getReviewStats(userId);
    return res.json({ success: true, data: stats });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get review stats');
    return res.status(500).json({ error: 'Failed to get review stats' });
  }
};

// ─── Public Review (Token-Based, No Auth) ───────────────────────────

export const getPublicReview = async (req: Request, res: Response) => {
  try {
    const parsedToken = reviewTokenSchema.safeParse(req.params.token);
    if (!parsedToken.success) return res.status(404).json({ error: 'Invalid or expired review link' });

    const ticket = await supportService.getTicketByReviewToken(parsedToken.data);
    if (!ticket) return res.status(404).json({ error: 'Invalid or expired review link' });

    return res.json({
      success: true,
      data: {
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        alreadyReviewed: !!ticket.reviewSubmittedAt,
        rating: ticket.rating,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get public review info');
    return res.status(500).json({ error: 'Failed to retrieve review info' });
  }
};

export const submitPublicReview = async (req: Request, res: Response) => {
  try {
    const parsedToken = reviewTokenSchema.safeParse(req.params.token);
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsedToken.success) return res.status(404).json({ error: 'Invalid or expired review link' });
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });

    const result = await supportService.submitReviewByToken(parsedToken.data, parsed.data);
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(201).json({ success: true, data: result.review });
  } catch (error) {
    logger.error({ err: error }, 'Failed to submit public review');
    return res.status(500).json({ error: 'Failed to submit review' });
  }
};
