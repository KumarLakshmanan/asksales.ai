import { supportSlaBreachCountSql } from './SupportSlaService.js';
import { currentSupportQueueQuery } from './SupportQueueMetrics.js';
import { mergeSupportPipelineDetails, supportPipelineDetailsQuery } from './SupportPipelineReadModel.js';
import { supportTicketOwnershipSql } from './SupportTicketOwnership.js';
import { withLockedSupportTicket, reconcileTicketLifecycle, TicketMutationError, type TicketMutationContext } from './SupportTicketMutation.js';
import { assertOwnedCampaignThread } from './CampaignWorkspaceService.js';
import { db } from '../models/db';
import { supportTicketsTable } from '../models/supportTickets/schema';
import { supportTicketMessagesTable } from '../models/supportTicketMessages/schema';
import { supportTicketReviewsTable } from '../models/supportTicketReviews/schema';
import { eq, and, desc, sql, ilike, isNull, or } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { sentimentAnalysisService } from './SentimentAnalysisService';
import { redactPii } from '../utils/piiRedactor.js';
import { eventBus } from '../events/EventBus.js';
import crypto from 'crypto';
import { supportPresenceService } from './SupportPresenceService.js';
import { serializeSupportTimestamp } from '../utils/supportTimestamp.js';
import { resolveRecordBrandToolkitId } from './outreach/WorkflowBrand.js';

const SUPPORT_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent', 'critical']);
const SUPPORT_STATUSES = new Set(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']);

type TicketReader = { kind: 'owner' | 'member'; id: number };

export class SupportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupportValidationError';
  }
}

// ─── Auto-ticket helpers (H7, H9, M8, M10) ──────────────────────────────

/**
 * H7 — Read per-user sentiment threshold from outreach_settings.
 * Falls back to safe defaults if column/row missing.
 */
async function getAutoTicketSettings(userId: number): Promise<{
  negative: number;
  urgent: number;
  dedupWindow: number;
  blockOnZeroCredit: boolean;
}> {
  try {
    const r = await db.execute(sql`
      SELECT 
        auto_ticket_sentiment_threshold AS neg, 
        auto_ticket_urgent_threshold AS urg,
        auto_ticket_dedup_window_minutes AS dedup,
        block_on_zero_credit AS block_credit
      FROM outreach_settings WHERE user_id = ${userId} LIMIT 1
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = (r.rows as any)?.[0];
    return {
      negative: typeof row?.neg === 'number' ? row.neg : -0.5,
      urgent: typeof row?.urg === 'number' ? row.urg : -0.8,
      dedupWindow: typeof row?.dedup === 'number' ? row.dedup : 30,
      blockOnZeroCredit: !!row?.block_credit,
    };
  } catch {
    return { negative: -0.5, urgent: -0.8, dedupWindow: 30, blockOnZeroCredit: false };
  }
}

/**
 * H9 — Look up an open ticket created from the same lead within the past N
 * minutes. If found, we append rather than spawning a duplicate ticket.
 */
async function findRecentOpenTicketForLead(userId: number, leadId: number | null | undefined, windowMinutes = 30) {
  if (!leadId) return null;
  const r = await db.execute(sql`
    SELECT id, ticket_number FROM support_tickets
    WHERE user_id = ${userId}
      AND lead_id = ${leadId}
      AND status IN ('open', 'in_progress', 'waiting_on_customer')
      AND created_at > NOW() - (${windowMinutes} || ' minutes')::interval
      AND (deleted_at IS NULL)
    ORDER BY created_at DESC LIMIT 1
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (r.rows as any)?.[0] ?? null;
}

/** Resolve one canonical active support team so unassigned tickets still have
 * an accountable queue. The configured default wins, followed by the oldest
 * active team. This is intentionally industry-neutral. */
async function resolveCanonicalTeam(userId: number, requestedTeamId?: number | null, database = db): Promise<number | null> {
  if (requestedTeamId) return requestedTeamId;
  try {
    const result = await database.execute(sql`
      SELECT id FROM support_teams
      WHERE user_id = ${userId} AND is_active IS TRUE
      ORDER BY created_at ASC, id ASC
      LIMIT 1 FOR SHARE
    `);
    return Number((result.rows[0] as { id?: number } | undefined)?.id || 0) || null;
  } catch (error) {
    logger.warn({ err: error, userId }, '[SupportService] Canonical team resolution failed');
    return null;
  }
}


class SupportService {
  private static instance: SupportService;

  static getInstance(): SupportService {
    if (!this.instance) this.instance = new SupportService();
    return this.instance;
  }

  private generateTicketNumber(userId: number): string {
    // ticket_number is globally unique, while support data is tenant scoped.
    // A per-tenant counter therefore collided as soon as two workspaces created
    // their first ticket. Include the tenant and cryptographically random suffix
    // rather than relying on a non-atomic MAX()+1 sequence.
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `TKT-${userId}-${Date.now().toString(36).toUpperCase()}-${suffix}`;
  }

  async createTicket(userId: number, data: {
    chatThreadId?: number;
    contactId?: number;
    leadId?: number;
    outreachConversationId?: number;
    teamId?: number;
    assignedMemberId?: number;
    subject: string;
    description?: string;
    priority?: string;
    category?: string;
    /** Tenant-scoped deterministic key for exactly-once AI handoff tickets. */
    handoffKey?: string;
    slaDeadline?: Date;
    tags?: string[];
    /** When true, auto-assign to least-loaded team member (M10). */
    autoAssign?: boolean;
  }, context: { database?: typeof db; deferNotificationWakeup?: boolean } = {}) {
    if (!context.database) {
      const ticket = await db.transaction((tx: typeof db) => this.createTicket(userId, data,
        { ...context, database: tx, deferNotificationWakeup: true }));
      if (data.category !== 'ai_handoff' && !context.deferNotificationWakeup) {
        const { supportMemberNotificationService } = await import('./SupportMemberNotificationService.js');
        await supportMemberNotificationService.queueTicketCreated({ id: ticket.id, userId,
          ticketNumber: ticket.ticketNumber, subject: ticket.subject, priority: ticket.priority,
          teamId: ticket.teamId, assignedMemberId: ticket.assignedMemberId })
          .catch((error: unknown) => logger.warn({err:error,ticketId:ticket.id}, 'Support notification wake-up deferred to maintenance'));
      }
      return ticket;
    }
    const database = context.database || db;
    const subject = String(data.subject || '').trim();
    if (!subject || subject.length > 500) {
      throw new SupportValidationError('Subject must be between 1 and 500 characters.');
    }
    const description = data.description === undefined ? null : String(data.description).trim();
    if (description && description.length > 20_000) {
      throw new SupportValidationError('Description cannot exceed 20,000 characters.');
    }
    const priority = data.priority || 'medium';
    if (!SUPPORT_PRIORITIES.has(priority)) {
      throw new SupportValidationError('Invalid support ticket priority.');
    }
    const category = String(data.category || 'support').trim();
    if (!category || category.length > 50) {
      throw new SupportValidationError('Category must be between 1 and 50 characters.');
    }
    const handoffKey = data.handoffKey === undefined ? null : String(data.handoffKey).trim();
    if (handoffKey && (category !== 'ai_handoff' || handoffKey.length > 160)) {
      throw new SupportValidationError('Invalid AI handoff idempotency key.');
    }
    const tags = [...new Set((data.tags || []).map((tag) => String(tag).trim()).filter(Boolean))];
    if (tags.length > 20 || tags.some((tag) => tag.length > 50)) {
      throw new SupportValidationError('Use at most 20 tags of 50 characters each.');
    }
    if (data.slaDeadline && Number.isNaN(data.slaDeadline.getTime())) {
      throw new SupportValidationError('Invalid SLA deadline.');
    }

    if (data.chatThreadId) await assertOwnedCampaignThread(userId, data.chatThreadId, database);

    if (data.contactId) {
      const { crmContactsTable } = await import("../models/crmContacts/schema");
      const { eq, and, isNull } = await import("drizzle-orm");
      const [contact] = await database
        .select()
        .from(crmContactsTable)
        .where(
          and(
            eq(crmContactsTable.id, data.contactId),
            eq(crmContactsTable.userId, userId),
            isNull(crmContactsTable.deletedAt)
          )
        )
        .limit(1);
      if (!contact) {
        throw new SupportValidationError('Invalid CRM contact.');
      }
    }

    if (data.leadId) {
      const { leadsTable } = await import("../models/leads/schema");
      const { eq, and, isNull } = await import("drizzle-orm");
      const [lead] = await database
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, data.leadId),
            eq(leadsTable.userId, userId),
            isNull(leadsTable.deletedAt)
          )
        )
        .limit(1);
      if (!lead) {
        throw new SupportValidationError('Invalid CRM lead.');
      }
    }

    if (data.teamId) {
      const team = await database.execute(sql`
        SELECT id FROM support_teams
        WHERE id = ${data.teamId} AND user_id = ${userId} AND is_active IS TRUE
        LIMIT 1 FOR SHARE
      `);
      if (!team.rows[0]) throw new SupportValidationError('Invalid or inactive support team.');
    }

    if (data.assignedMemberId) {
      if (!data.teamId) throw new SupportValidationError('An assigned support member requires a team.');
      const member = await database.execute(sql`
        SELECT tm.id
        FROM team_members tm
        JOIN support_teams st ON st.id = tm.team_id
        WHERE tm.id = ${data.assignedMemberId}
          AND tm.team_id = ${data.teamId}
          AND tm.user_id = ${userId}
          AND st.user_id = ${userId}
          AND tm.is_active IS TRUE
          AND st.is_active IS TRUE
        LIMIT 1
      `);
      if (!member.rows[0]) throw new SupportValidationError('Invalid or inactive assigned support member.');
    }

    let resolvedContactId = data.contactId || null;
    let resolvedLeadId = data.leadId || null;
    if (data.outreachConversationId) {
      const conversation = await database.execute(sql`
        SELECT conversation.id, conversation.lead_id, contact.id AS crm_contact_id
        FROM outreach_conversations conversation
        LEFT JOIN crm_contacts contact ON contact.id = conversation.crm_contact_id
          AND contact.user_id = ${userId}
          AND contact.deleted_at IS NULL
        WHERE conversation.id = ${data.outreachConversationId} AND conversation.user_id = ${userId}
        LIMIT 1
      `);
      const linkedConversation = conversation.rows[0] as { id: number; lead_id?: number | null; crm_contact_id?: number | null } | undefined;
      if (!linkedConversation) throw new SupportValidationError('Invalid outreach conversation.');
      const conversationContactId = Number(linkedConversation.crm_contact_id) || null;
      if (resolvedContactId && conversationContactId && resolvedContactId !== conversationContactId) {
        throw new SupportValidationError('CRM contact does not match the outreach conversation.');
      }
      const conversationLeadId = Number(linkedConversation.lead_id) || null;
      if (resolvedLeadId && conversationLeadId && resolvedLeadId !== conversationLeadId) {
        throw new SupportValidationError('CRM lead does not match the outreach conversation.');
      }
      // Only inherit an existing, tenant-authorized identity. Never infer or
      // merge contacts from the ticket subject, display name, or message text.
      resolvedContactId ||= conversationContactId;
      resolvedLeadId ||= conversationLeadId;
    }

    const ticketNumber = this.generateTicketNumber(userId);
    // The ticket keeps the brand of the conversation or chat it came from (else
    // today's default), so later default changes do not rebrand its emails.
    const brandToolkitId = await resolveRecordBrandToolkitId(userId, {
      conversationId: data.outreachConversationId, threadId: data.chatThreadId,
    }, database);

    // Every support ticket enters a canonical team queue. Auto-assignment is
    // optional, but an absent assignee is now a first-class notified event.
    const resolvedTeamId = await resolveCanonicalTeam(userId, data.teamId, database);
    let assignedMemberId: number | null = data.assignedMemberId || null;
    let responseEstimate: Awaited<ReturnType<typeof supportPresenceService.estimateRouting>> | null = null;
    if (!assignedMemberId && data.autoAssign && resolvedTeamId) {
      responseEstimate = await supportPresenceService.estimateRouting(userId, 'web', resolvedTeamId, database);
      assignedMemberId = responseEstimate.active ? responseEstimate.memberId : null;
    }
    const effectiveSlaDeadline = data.slaDeadline || (responseEstimate
      ? new Date(Date.now() + responseEstimate.estimatedMinutes * 60_000)
      : null);

    const [insertedTicket] = await database.insert(supportTicketsTable).values({
      userId,
      ticketNumber,
      chatThreadId: data.chatThreadId || null,
      subject,
      description: description || null,
      contactId: resolvedContactId,
      leadId: resolvedLeadId,
      outreachConversationId: data.outreachConversationId || null,
      teamId: resolvedTeamId,
      brandToolkitId,
      assignedMemberId: assignedMemberId ?? undefined,
      priority,
      category,
      handoffKey,
      slaDeadline: effectiveSlaDeadline,
      tags,
      metadata: responseEstimate ? { responseEstimate } : {},
    }).onConflictDoNothing().returning();
    const ticket = insertedTicket || (handoffKey
      ? (await database.select().from(supportTicketsTable).where(and(
          eq(supportTicketsTable.userId, userId),
          eq(supportTicketsTable.handoffKey, handoffKey),
          isNull(supportTicketsTable.deletedAt),
          sql`${supportTicketsTable.status} NOT IN ('resolved', 'closed')`,
        )).limit(1))[0]
      : null);
    if (!ticket) throw new Error('Support ticket could not be created or reconciled.');

    logger.info({ userId, ticketId: ticket.id, ticketNumber, assignedMemberId }, 'Support ticket created');

    // Migration 220 installs the transactional outbox trigger. This call only
    // wakes the worker; it does not create a second event or owner alert.
    if (category !== 'ai_handoff' && !context.deferNotificationWakeup) {
      const { supportMemberNotificationService } = await import('./SupportMemberNotificationService.js');
      await supportMemberNotificationService.queueTicketCreated({
        id: ticket.id,
        userId,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        priority: ticket.priority || priority,
        teamId: ticket.teamId,
        assignedMemberId: ticket.assignedMemberId,
      });
    }

    return ticket;
  }

  async createTicketFromConversation(userId: number, conversationId: number, subject: string, description?: string) {
    return this.createTicket(userId, {
      outreachConversationId: conversationId,
      subject,
      description,
      category: 'conversation',
    });
  }

  async autoCreateTicketOnNegativeSentiment(userId: number, messageText: string, contactId?: number, conversationId?: number, leadId?: number) {
    const sentiment = await sentimentAnalysisService.analyzeSentiment(userId, messageText);

    // H7 — per-user thresholds & settings
    const settings = await getAutoTicketSettings(userId);
    if (sentiment.sentiment !== 'negative' || sentiment.score > settings.negative) return null;

    // Credit limit pre-check if configured
    if (settings.blockOnZeroCredit) {
      try {
        const { getBalance } = await import('../models/wallets/functions.js');
        const balance = await getBalance(userId);
        if (balance <= 0) {
          logger.warn({ userId }, '[SupportService] Blocked auto-ticket creation due to zero/negative credits');
          await eventBus.publish({
            channel: 'events:notification' as never,
            userId,
            timestamp: new Date().toISOString(),
            data: {
              type: 'support_ticket_blocked_credits',
              severity: 'high',
              message: 'Auto-ticket creation blocked due to insufficient credits.',
            },
          });
          return null;
        }
      } catch (creditsErr) {
        logger.error({ err: creditsErr, userId }, '[SupportService] Credit pre-check threw error');
      }
    }

    // H9 — Dedup: append to recent open ticket from same lead instead of
    // spawning a duplicate. Returns the existing ticket if reused.
    if (leadId) {
      const existing = await findRecentOpenTicketForLead(userId, leadId, settings.dedupWindow);
      if (existing) {
        try {
          await db.insert(supportTicketMessagesTable).values({
            ticketId: existing.id,
            userId,
            content: redactPii(messageText), // M9 redact PII
            direction: 'inbound',
            isInternal: false,
          });
          await db.update(supportTicketsTable)
            .set({ totalMessages: sql`${supportTicketsTable.totalMessages} + 1`, updatedAt: new Date() })
            .where(eq(supportTicketsTable.id, existing.id));
          logger.info({ userId, ticketId: existing.id, leadId }, '[SupportService] H9: appended to existing open ticket (dedup)');
        } catch (appendErr) {
          logger.warn({ err: appendErr, ticketId: existing.id }, '[SupportService] H9 append failed — fall through to create new');
          return this.autoCreateTicketOnNegativeSentiment_create(userId, messageText, sentiment, settings, contactId, conversationId, leadId);
        }
        return existing;
      }
    }

    return this.autoCreateTicketOnNegativeSentiment_create(userId, messageText, sentiment, settings, contactId, conversationId, leadId);
  }

  private async autoCreateTicketOnNegativeSentiment_create(
    userId: number,
    messageText: string,
    sentiment: { sentiment: string; score: number; keywords: string[] },
    settings: { negative: number; urgent: number },
    contactId?: number,
    conversationId?: number,
    leadId?: number,
  ) {
    const ticket = await this.createTicket(userId, {
      contactId,
      leadId,
      outreachConversationId: conversationId,
      subject: `Negative sentiment detected: ${sentiment.keywords.slice(0, 3).join(', ') || 'Review needed'}`,
      // M9 — redact PII from raw customer message before storing in description
      description: `Auto-created ticket due to negative sentiment (score: ${sentiment.score}).\n\nOriginal message:\n${redactPii(messageText)}`,
      priority: sentiment.score < settings.urgent ? 'urgent' : 'high',
      category: 'sentiment',
      tags: ['auto-created', 'negative-sentiment'],
      autoAssign: true,
    });

    // H13 — Charge credits BEFORE returning success. If deduction fails, log
    // critical so finance reconciliation can flag. We do not delete the ticket
    // (customer should still be served) but we surface the failure loudly.
    try {
      const { deductCreditsForSupportTicketAI } = await import('./CreditDeductionHooks.js');
      await deductCreditsForSupportTicketAI(userId, { ticketId: ticket.id, service: 'SupportService' });
    } catch (creditErr) {
      logger.error({ err: creditErr, userId, ticketId: ticket.id }, '[SupportService] H13: credit deduction threw for auto-ticket');
    }

    return ticket;
  }

  /**
   * L3 — Detect sales-intent on positive-sentiment inbound messages and create
   * a low-priority "sales lead" ticket so the SDR team can follow up. Looks for
   * upsell / pricing / demo / enterprise keywords. Conservative — only fires
   * when sentiment is positive (>= 0.4) AND keywords match.
   */
  async autoCreateSalesTicketOnPositiveIntent(userId: number, messageText: string, contactId?: number, conversationId?: number, leadId?: number) {
    const sentiment = await sentimentAnalysisService.analyzeSentiment(userId, messageText);
    if (sentiment.sentiment !== 'positive' || sentiment.score < 0.4) return null;

    const intentRe = /\b(pricing|price|cost|quote|enterprise|demo|trial|upgrade|buy|purchase|invoice|onboard)\b/i;
    if (!intentRe.test(messageText)) return null;

    // Dedup against existing open sales ticket from same lead
    if (leadId) {
      const existing = await db.execute(sql`
        SELECT id FROM support_tickets
        WHERE user_id = ${userId} AND lead_id = ${leadId}
          AND category = 'sales_intent'
          AND status IN ('open', 'in_progress')
          AND created_at > NOW() - interval '60 minutes'
        LIMIT 1
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((existing.rows as any)?.[0]) return null;
    }

    return this.createTicket(userId, {
      contactId,
      leadId,
      outreachConversationId: conversationId,
      subject: `Sales intent detected: ${sentiment.keywords.slice(0, 3).join(', ') || 'Follow up'}`,
      description: `Auto-created from positive-sentiment inbound message with sales intent (score: ${sentiment.score}).\n\nMessage:\n${redactPii(messageText)}`,
      priority: 'medium',
      category: 'sales_intent',
      tags: ['auto-created', 'sales-intent', 'positive-sentiment'],
      autoAssign: true,
    });
  }
  

  async getTickets(userId: number, filters?: {
    chatThreadId?: number;
    status?: string;
    priority?: string;
    category?: string;
    teamId?: number;
    channel?: string;
    ownership?: 'ai_active' | 'human_owned' | 'unassigned';
    sla?: 'breached' | 'at_risk' | 'on_track' | 'none';
    unread?: 'true';
    sort?: 'operational' | 'updated' | 'newest' | 'oldest';
    view?: 'pipeline';
    search?: string;
    page?: number;
    limit?: number;
  }, reader: TicketReader = {kind:'owner',id:userId}) {
    const page = Number.isSafeInteger(filters?.page) && Number(filters?.page) > 0
      ? Math.min(Number(filters?.page), 100_000)
      : 1;
    const limit = Number.isSafeInteger(filters?.limit) && Number(filters?.limit) > 0
      ? Math.min(Number(filters?.limit), 100)
      : 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(supportTicketsTable.userId, userId), isNull(supportTicketsTable.deletedAt)];
    if (filters?.chatThreadId) {
      await assertOwnedCampaignThread(userId, filters.chatThreadId);
      conditions.push(eq(supportTicketsTable.chatThreadId, filters.chatThreadId));
    }
    if (filters?.status && SUPPORT_STATUSES.has(filters.status)) conditions.push(eq(supportTicketsTable.status, filters.status));
    if (filters?.priority && SUPPORT_PRIORITIES.has(filters.priority)) conditions.push(eq(supportTicketsTable.priority, filters.priority));
    if (filters?.category) conditions.push(eq(supportTicketsTable.category, filters.category));
    if (filters?.teamId) conditions.push(eq(supportTicketsTable.teamId, filters.teamId));
    if (filters?.channel) {
      conditions.push(sql`(
        (${filters.channel} = 'web' AND EXISTS (
          SELECT 1 FROM support_chat_sessions session WHERE session.ticket_id = ${supportTicketsTable.id}
        )) OR EXISTS (
          SELECT 1 FROM outreach_conversations conversation
          WHERE conversation.id = ${supportTicketsTable.outreachConversationId}
            AND conversation.user_id = ${userId}
            AND LOWER(conversation.channel) = ${filters.channel}
        )
      )`);
    }
    if (filters?.ownership === 'unassigned') {
      conditions.push(isNull(supportTicketsTable.assignedMemberId));
    } else if (filters?.ownership === 'human_owned' || filters?.ownership === 'ai_active') {
      conditions.push(sql`${supportTicketOwnershipSql()} = ${filters.ownership}`);
    }
    if (filters?.sla === 'breached') {
      conditions.push(sql`${supportTicketsTable.slaDeadline} < NOW() AND ${supportTicketsTable.status} IN ('open','in_progress','waiting_on_customer')`);
    } else if (filters?.sla === 'at_risk') {
      conditions.push(sql`${supportTicketsTable.slaDeadline} >= NOW() AND ${supportTicketsTable.slaDeadline} <= NOW() + INTERVAL '30 minutes' AND ${supportTicketsTable.status} IN ('open','in_progress','waiting_on_customer')`);
    } else if (filters?.sla === 'on_track') {
      conditions.push(sql`${supportTicketsTable.slaDeadline} > NOW() + INTERVAL '30 minutes' AND ${supportTicketsTable.status} IN ('open','in_progress','waiting_on_customer')`);
    } else if (filters?.sla === 'none') {
      conditions.push(isNull(supportTicketsTable.slaDeadline));
    }
    if (filters?.unread === 'true') {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM support_ticket_messages message
        WHERE message.ticket_id = ${supportTicketsTable.id}
          AND message.direction = 'inbound'
          AND COALESCE(message.is_internal, FALSE) = FALSE
          AND message.id > COALESCE((
            SELECT receipt.last_read_message_id
            FROM support_ticket_read_receipts receipt
            WHERE receipt.user_id = ${userId}
              AND receipt.ticket_id = ${supportTicketsTable.id}
              AND receipt.reader_kind = ${reader.kind}
              AND receipt.reader_id = ${reader.id}
          ), 0)
      )`);
    }
    if (filters?.search) {
      conditions.push(
        or(
          ilike(supportTicketsTable.subject, `%${filters.search}%`),
          ilike(supportTicketsTable.ticketNumber, `%${filters.search}%`)
        )!
      );
    }

    const orderBy = filters?.sort === 'oldest'
      ? [supportTicketsTable.createdAt, supportTicketsTable.id]
      : filters?.sort === 'newest'
        ? [desc(supportTicketsTable.createdAt), desc(supportTicketsTable.id)]
        : filters?.sort === 'updated'
          ? [desc(supportTicketsTable.updatedAt), desc(supportTicketsTable.id)]
          : [
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
            ];
    const [ticketRows, countResult] = await Promise.all([
      db.select().from(supportTicketsTable)
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(supportTicketsTable)
        .where(and(...conditions)),
    ]);

    const tickets = filters?.view === 'pipeline'
      ? await this.enrichTicketPipeline(userId, ticketRows, reader)
      : await this.enrichTicketQueue(userId, ticketRows, reader);
    return {
      tickets,
      total: countResult[0]?.count || 0,
      page,
      totalPages: Math.ceil((countResult[0]?.count || 0) / limit),
    };
  }

  async getTicketById(userId: number, ticketId: number) {
    const [ticket] = await db.select().from(supportTicketsTable)
      .where(and(
        eq(supportTicketsTable.id, ticketId),
        eq(supportTicketsTable.userId, userId),
        isNull(supportTicketsTable.deletedAt),
      ));
    return ticket || null;
  }

  async markTicketRead(
    userId: number,
    ticketId: number,
    readerKind: TicketReader['kind'],
    readerId: number,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO support_ticket_read_receipts (
        user_id, ticket_id, reader_kind, reader_id, last_read_message_id, last_read_at, created_at, updated_at
      )
      SELECT ${userId}, ${ticketId}, ${readerKind}, ${readerId}, MAX(message.id), NOW(), NOW(), NOW()
      FROM support_ticket_messages message
      JOIN support_tickets ticket ON ticket.id = message.ticket_id
      WHERE message.ticket_id = ${ticketId} AND ticket.user_id = ${userId} AND ticket.deleted_at IS NULL
      ON CONFLICT (business_profile_id, user_id, ticket_id, reader_kind, reader_id) DO UPDATE SET
        last_read_message_id = EXCLUDED.last_read_message_id,
        last_read_at = NOW(),
        updated_at = NOW()
    `);
  }

  async getTicketWorkspace(userId: number, ticketId: number, reader: TicketReader) {
    const ticket = await this.getTicketById(userId, ticketId);
    if (!ticket) return null;
    return (await this.enrichTicketQueue(userId, [ticket], reader))[0] || null;
  }

  async enrichTicketPipeline<T extends { id: number }>(userId: number, tickets: T[], reader: TicketReader) {
    if (tickets.length === 0) return [];
    const result = await db.execute(supportPipelineDetailsQuery(userId, tickets.map(ticket => ticket.id), reader));
    return mergeSupportPipelineDetails(tickets, result.rows as Array<Record<string, unknown>>);
  }

  async enrichTicketQueue<T extends { id: number }>(
    userId: number,
    tickets: T[],
    reader: TicketReader,
  ): Promise<Array<T & Record<string, unknown>>> {
    if (tickets.length === 0) return [];
    const ticketIds = tickets.map((ticket) => ticket.id);
    const result = await db.execute(sql`
      SELECT ticket.id,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', contact.first_name, contact.last_name)), ''),
          NULLIF(lead.full_name, ''), NULLIF(lead.name, ''),
          NULLIF(conversation.lead_name, ''), 'Unlinked customer'
        ) AS customer_name,
        COALESCE(contact.email, lead.email, conversation.lead_email) AS customer_email,
        COALESCE(NULLIF(LOWER(conversation.channel), ''), CASE WHEN widget.id IS NOT NULL THEN 'web' ELSE 'email' END) AS channel,
        conversation.id AS conversation_id,
        team.name AS team_name,
        member.name AS assigned_member_name,
        member.email AS assigned_member_email,
        COALESCE(member.is_active, FALSE) AS assigned_member_enabled,
        COALESCE(presence.active, FALSE) AS assigned_member_present,
        presence.last_seen_at AS assigned_member_last_seen_at,
        latest_message.content AS last_message_preview,
        latest_message.created_at AS last_message_at,
        latest_message.direction AS last_message_direction,
        latest_message.is_internal AS last_message_internal,
        COALESCE(unread.count, 0)::int AS operational_unread_count,
        handoff.id AS handoff_id,
        handoff.status AS handoff_status,
        handoff.reason AS handoff_reason,
        handoff.trigger_type AS handoff_trigger_type,
        handoff.confidence_score AS handoff_confidence_score,
        handoff.sla_deadline AS handoff_sla_deadline,
        COALESCE(handoff.ai_reply_enabled, TRUE) AS ai_reply_enabled,
        handoff.ai_paused_at,
        handoff.ai_paused_by,
        handoff.assigned_member_id AS handoff_assigned_member_id,
        handoff.accepted_at AS handoff_accepted_at,
        COALESCE(
          CASE
            WHEN handoff.id IS NOT NULL AND handoff.ai_reply_enabled = FALSE THEN 'human_owned'
            WHEN handoff.id IS NOT NULL THEN 'ai_active'
          END,
          conversation.automation_mode,
          widget.automation_mode,
          'ai_active'
        ) AS ownership_mode,
        delivery.id AS delivery_action_id,
        delivery.status AS delivery_status,
        delivery.provider_message_id,
        delivery.last_error AS delivery_error,
        delivery.updated_at AS delivery_updated_at,
        automation.id AS latest_ticket_automation_id,
        automation.reply_text AS latest_ticket_automation_reply,
        automation.delivery_status AS latest_ticket_automation_delivery_status,
        automation.provider_message_id AS latest_ticket_automation_provider_message_id,
        automation.created_at AS latest_ticket_automation_at,
        automation.trace->>'ticketFollowUpDisposition' AS latest_ticket_automation_disposition,
        COALESCE((automation.trace->>'ticketReadOnlyVerified')::boolean, FALSE) AS latest_ticket_automation_verified,
        COALESCE((automation.trace->>'ownershipResumed')::boolean, FALSE) AS latest_ticket_automation_resumed
      FROM support_tickets ticket
      LEFT JOIN crm_contacts contact ON contact.id = ticket.contact_id AND contact.user_id = ticket.user_id
      LEFT JOIN leads lead ON lead.id = ticket.lead_id AND lead.user_id = ticket.user_id
      LEFT JOIN outreach_conversations conversation
        ON conversation.id = ticket.outreach_conversation_id AND conversation.user_id = ticket.user_id
      LEFT JOIN support_teams team ON team.id = ticket.team_id AND team.user_id = ticket.user_id
      LEFT JOIN team_members member ON member.id = ticket.assigned_member_id AND member.user_id = ticket.user_id
      LEFT JOIN LATERAL (
        SELECT BOOL_OR(session.ended_at IS NULL AND session.last_seen_at > NOW() - INTERVAL '5 minutes') AS active,
          MAX(session.last_seen_at) AS last_seen_at
        FROM support_member_presence_sessions session
        WHERE session.user_id = ticket.user_id AND session.member_id = ticket.assigned_member_id
      ) presence ON TRUE
      LEFT JOIN LATERAL (
        SELECT message.content, message.created_at, message.direction, message.is_internal
        FROM support_ticket_messages message
        WHERE message.ticket_id = ticket.id
        ORDER BY message.created_at DESC, message.id DESC LIMIT 1
      ) latest_message ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS count
        FROM support_ticket_messages message
        WHERE message.ticket_id = ticket.id
          AND message.direction = 'inbound'
          AND COALESCE(message.is_internal, FALSE) = FALSE
          AND message.id > COALESCE((
            SELECT receipt.last_read_message_id
            FROM support_ticket_read_receipts receipt
            WHERE receipt.user_id = ticket.user_id
              AND receipt.ticket_id = ticket.id
              AND receipt.reader_kind = ${reader.kind}
              AND receipt.reader_id = ${reader.id}
          ), 0)
      ) unread ON TRUE
      LEFT JOIN LATERAL (
        SELECT queue.id, queue.status, queue.reason, queue.trigger_type,
          queue.confidence_score, queue.sla_deadline, queue.ai_reply_enabled,
          queue.ai_paused_at, queue.ai_paused_by, queue.assigned_member_id, queue.accepted_at
        FROM handoff_queue queue
        WHERE queue.user_id = ticket.user_id AND queue.support_ticket_id = ticket.id
          AND queue.status IN ('waiting', 'assigned', 'in_progress')
        ORDER BY queue.created_at DESC, queue.id DESC LIMIT 1
      ) handoff ON TRUE
      LEFT JOIN LATERAL (
        SELECT session.id, session.automation_mode
        FROM support_chat_sessions session
        WHERE session.ticket_id = ticket.id
        ORDER BY session.created_at DESC, session.id DESC LIMIT 1
      ) widget ON TRUE
      LEFT JOIN LATERAL (
        SELECT action.id, action.status, action.provider_message_id,
          action.last_error, action.updated_at
        FROM support_ticket_messages message
        JOIN support_delivery_outbox action ON action.id = message.delivery_action_id
        WHERE message.ticket_id = ticket.id
        ORDER BY message.created_at DESC, message.id DESC LIMIT 1
      ) delivery ON TRUE
      LEFT JOIN LATERAL (
        SELECT audit.id, audit.reply_text, audit.delivery_status,
          audit.provider_message_id, audit.created_at, audit.trace
        FROM agent_audit_logs audit
        WHERE audit.user_id = ticket.user_id
          AND audit.conversation_id = COALESCE(conversation.id, -widget.id)
          AND audit.created_at >= ticket.created_at
          AND audit.trace->>'ticketFollowUpDisposition' IN ('read_only_ai', 'human_queue')
        ORDER BY audit.created_at DESC, audit.id DESC LIMIT 1
      ) automation ON TRUE
      WHERE ticket.user_id = ${userId}
        AND ticket.deleted_at IS NULL
        AND ticket.id IN (${sql.join(ticketIds.map((id) => sql`${id}`), sql`, `)})
    `);
    const details = new Map((result.rows as Array<Record<string, unknown>>).map((row) => [Number(row.id), row]));
    return tickets.map((ticket) => {
      const row = details.get(ticket.id) || {};
      return {
        ...ticket,
        customerName: row.customer_name || 'Unlinked customer',
        customerEmail: row.customer_email || null,
        channel: row.channel || 'email',
        conversationId: row.conversation_id ? Number(row.conversation_id) : null,
        teamName: row.team_name || null,
        assignedMemberName: row.assigned_member_name || null,
        assignedMemberEmail: row.assigned_member_email || null,
        assignedMemberEnabled: row.assigned_member_enabled === true,
        assignedMemberPresent: row.assigned_member_present === true,
        assignedMemberLastSeenAt: serializeSupportTimestamp(row.assigned_member_last_seen_at),
        lastMessagePreview: row.last_message_preview || null,
        lastMessageAt: serializeSupportTimestamp(row.last_message_at),
        lastMessageDirection: row.last_message_direction || null,
        lastMessageInternal: row.last_message_internal === true,
        unreadCount: Number(row.operational_unread_count || 0),
        handoffId: row.handoff_id ? Number(row.handoff_id) : null,
        handoffStatus: row.handoff_status || null,
        handoffReason: row.handoff_reason || null,
        handoffTriggerType: row.handoff_trigger_type || null,
        handoffConfidenceScore: row.handoff_confidence_score == null ? null : Number(row.handoff_confidence_score),
        handoffSlaDeadline: serializeSupportTimestamp(row.handoff_sla_deadline),
        aiReplyEnabled: row.ai_reply_enabled !== false,
        aiPausedAt: serializeSupportTimestamp(row.ai_paused_at),
        aiPausedBy: row.ai_paused_by ? Number(row.ai_paused_by) : null,
        handoffAssignedMemberId: row.handoff_assigned_member_id ? Number(row.handoff_assigned_member_id) : null,
        handoffAcceptedAt: serializeSupportTimestamp(row.handoff_accepted_at),
        claimable: !(ticket as T & { assignedMemberId?: number | null }).assignedMemberId || (Boolean(row.handoff_id) && !row.handoff_assigned_member_id),
        ownershipMode: row.ownership_mode || 'ai_active',
        deliveryActionId: row.delivery_action_id ? Number(row.delivery_action_id) : null,
        deliveryStatus: row.delivery_status || null,
        providerMessageId: row.provider_message_id || null,
        deliveryError: row.delivery_error || null,
        deliveryUpdatedAt: serializeSupportTimestamp(row.delivery_updated_at),
        latestTicketAutomation: row.latest_ticket_automation_id ? {
          id: Number(row.latest_ticket_automation_id),
          disposition: row.latest_ticket_automation_disposition || 'human_queue',
          replyText: row.latest_ticket_automation_reply || null,
          deliveryStatus: row.latest_ticket_automation_delivery_status || null,
          providerMessageId: row.latest_ticket_automation_provider_message_id || null,
          createdAt: serializeSupportTimestamp(row.latest_ticket_automation_at),
          verified: row.latest_ticket_automation_verified === true,
          ownershipResumed: row.latest_ticket_automation_resumed === true,
        } : null,
      };
    });
  }

  async updateTicket(userId: number, ticketId: number, data: Partial<{
    subject: string; description: string; status: string; priority: string; category: string;
    teamId: number | null; assignedTo: number; assignedMemberId: number | null;
    slaDeadline: Date | null; tags: string[];
  }>, context: TicketMutationContext = {}) {
    if (data.status && !SUPPORT_STATUSES.has(data.status)) throw new SupportValidationError('Invalid support ticket status.');
    if (data.priority && !SUPPORT_PRIORITIES.has(data.priority)) throw new SupportValidationError('Invalid support ticket priority.');
    let result;
    try {
      result = await withLockedSupportTicket(userId, ticketId, context, async (tx, before) => {
        const updateData: Record<string, unknown> = { ...data, version: sql`${supportTicketsTable.version} + 1`, updatedAt: new Date() };
        if (data.teamId !== undefined && data.teamId !== before.teamId && data.assignedMemberId === undefined) updateData.assignedMemberId = null;
        if (data.teamId !== undefined && data.teamId !== null) {
          const team = await tx.execute(sql`SELECT id FROM support_teams WHERE id=${data.teamId} AND user_id=${userId} AND is_active IS TRUE FOR SHARE`);
          if (!team.rows[0]) throw new SupportValidationError('Invalid or inactive support team.');
        }
        if (data.assignedMemberId) {
          const teamId = data.teamId === undefined ? before.teamId : data.teamId;
          if (!teamId) throw new SupportValidationError('An assigned support member requires a team.');
          const member = await tx.execute(sql`
            SELECT tm.id FROM team_members tm JOIN support_teams st ON st.id=tm.team_id
            WHERE tm.id=${data.assignedMemberId} AND tm.team_id=${teamId}
              AND tm.user_id=${userId} AND st.user_id=${userId}
              AND tm.is_active IS TRUE AND st.is_active IS TRUE FOR SHARE OF tm, st
          `);
          if (!member.rows[0]) throw new SupportValidationError('Invalid or inactive assigned support member.');
        }
        if (data.status === 'resolved' || data.status === 'closed') updateData.resolvedAt = before.resolvedAt || new Date();
        if (data.status === 'closed') updateData.closedAt = before.closedAt || new Date();
        const reopening = Boolean(data.status && ['open','in_progress','waiting_on_customer'].includes(data.status));
        if (reopening) { updateData.resolvedAt = null; updateData.closedAt = null; }
        const deadlineChanged = data.slaDeadline !== undefined
          && (data.slaDeadline?.getTime() ?? null) !== (before.slaDeadline?.getTime() ?? null);
        if (deadlineChanged || (reopening && ['resolved','closed'].includes(before.status))) {
          updateData.metadata = { ...before.metadata, slaGeneration: crypto.randomUUID() };
          updateData.tags = (data.tags || before.tags || []).filter((tag: string) => !['sla_at_risk','sla_breached'].includes(tag));
        }
        const [ticket] = await tx.update(supportTicketsTable).set(updateData).where(and(
          eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, userId),
          isNull(supportTicketsTable.deletedAt), eq(supportTicketsTable.version, before.version),
        )).returning();
        if (!ticket) throw new TicketMutationError('This ticket changed before your update was saved', 409, 'TICKET_VERSION_CONFLICT');
        if (data.status) await reconcileTicketLifecycle(tx, ticket, context);
        if (updateData.assignedMemberId !== undefined || data.teamId !== undefined) {
          await tx.execute(sql`
            UPDATE handoff_queue SET team_id=${ticket.teamId},
              status=CASE WHEN assigned_member_id IS NOT DISTINCT FROM ${ticket.assignedMemberId}
                AND team_id IS NOT DISTINCT FROM ${ticket.teamId} THEN status
                WHEN ${ticket.assignedMemberId}::integer IS NULL THEN 'waiting' ELSE 'assigned' END,
              accepted_at=CASE WHEN assigned_member_id IS NOT DISTINCT FROM ${ticket.assignedMemberId}
                AND team_id IS NOT DISTINCT FROM ${ticket.teamId} THEN accepted_at ELSE NULL END,
              assigned_member_id=${ticket.assignedMemberId}, version=version+1, updated_at=NOW()
            WHERE user_id=${userId} AND support_ticket_id=${ticketId}
              AND status IN ('waiting', 'assigned', 'in_progress')
          `);
        }
        if (context.actorMemberId || context.actorUserId) {
          const changes = ['status','priority','teamId','assignedMemberId','slaDeadline'].filter(key =>
            String(before[key as keyof typeof before] ?? '') !== String(ticket[key] ?? ''));
          if (changes.length) {
            await tx.insert(supportTicketMessagesTable).values({
              ticketId, userId, memberId: context.actorMemberId, actorUserId: context.actorUserId,
              direction: 'outbound', isInternal: true,
              content: changes.map(key => `${({status:'Status',priority:'Priority',teamId:'Team',assignedMemberId:'Assigned member',slaDeadline:'Response deadline'} as Record<string,string>)[key]}: ${before[key as keyof typeof before] ?? 'Unassigned'} → ${ticket[key] ?? 'Unassigned'}`).join('\n'),
              attachments: [],
            });
            await tx.update(supportTicketsTable).set({ totalMessages: sql`${supportTicketsTable.totalMessages} + 1` })
              .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, userId)));
            ticket.totalMessages = Number(ticket.totalMessages || 0) + 1;
          }
        }
        return { before, ticket };
      });
    } catch (error) {
      if (error instanceof TicketMutationError && error.statusCode === 404) return null;
      throw error;
    }
    const { before, ticket } = result;
    if (!context.database && ticket.assignedMemberId && ticket.assignedMemberId !== before.assignedMemberId) {
      const { supportMemberNotificationService } = await import('./SupportMemberNotificationService.js');
      await supportMemberNotificationService.queueTicketCreated({ id: ticket.id, userId,
        ticketNumber: ticket.ticketNumber, subject: ticket.subject, priority: ticket.priority,
        teamId: ticket.teamId, assignedMemberId: ticket.assignedMemberId })
        .catch((error: unknown) => logger.warn({err:error,ticketId:ticket.id}, 'Support notification wake-up deferred to maintenance'));
    }
    return ticket;
  }

  async claimTicket(userId: number, ticketId: number, memberId: number, expectedVersion?: number) {
    return withLockedSupportTicket(userId, ticketId, { actorMemberId: memberId, allowClaim: true, expectedVersion }, async (tx, ticket) => {
      if (['resolved','closed'].includes(ticket.status) || (ticket.assignedMemberId && ticket.assignedMemberId !== memberId)) {
        throw new TicketMutationError('This ticket was claimed or changed by another member', 409, 'TICKET_CLAIM_CONFLICT');
      }
      const handoffs = await tx.execute(sql`SELECT id,assigned_member_id FROM handoff_queue
        WHERE user_id=${userId} AND support_ticket_id=${ticketId} AND status IN ('waiting','assigned','in_progress') ORDER BY id FOR UPDATE`);
      if (handoffs.rows.some((row: { assigned_member_id: number | null }) => row.assigned_member_id && row.assigned_member_id !== memberId)) {
        throw new TicketMutationError('The linked handoff belongs to another member', 409, 'TICKET_CLAIM_CONFLICT');
      }
      const [claimed] = await tx.update(supportTicketsTable).set({
        assignedMemberId: memberId, status: ticket.status === 'open' ? 'in_progress' : ticket.status,
        version: sql`${supportTicketsTable.version} + 1`, updatedAt: new Date(),
      }).where(and(eq(supportTicketsTable.id,ticketId),eq(supportTicketsTable.userId,userId),isNull(supportTicketsTable.deletedAt),eq(supportTicketsTable.version,ticket.version))).returning();
      if (!claimed) throw new TicketMutationError('This ticket changed before it was claimed', 409, 'TICKET_CLAIM_CONFLICT');
      await tx.execute(sql`UPDATE handoff_queue SET assigned_member_id=${memberId},status='in_progress',
        accepted_at=COALESCE(accepted_at,NOW()),version=version+1,updated_at=NOW()
        WHERE user_id=${userId} AND support_ticket_id=${ticketId} AND status IN ('waiting','assigned','in_progress')`);
      return claimed;
    });
  }

  async deleteTicket(userId: number, ticketId: number) {
    const [deleted] = await db.update(supportTicketsTable)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(supportTicketsTable.id, ticketId),
        eq(supportTicketsTable.userId, userId),
        isNull(supportTicketsTable.deletedAt),
      ))
      .returning({ id: supportTicketsTable.id });
    return !!deleted;
  }

  async addMessage(userId: number, ticketId: number, data: {
    content: string;
    direction?: string;
    isInternal?: boolean;
    attachments?: Array<{ fileId: number; name: string; url: string; type: string }>;
  }) {
    // Verify ticket belongs to user
    const ticket = await this.getTicketById(userId, ticketId);
    if (!ticket) return null;

    return db.transaction(async (tx: typeof db) => {
      const [message] = await tx.insert(supportTicketMessagesTable).values({
        ticketId,
        userId,
        content: data.content,
        direction: data.direction || 'outbound',
        isInternal: data.isInternal || false,
        attachments: data.attachments || [],
      }).returning();

      // An external reply means the issue is active again. Internal notes must
      // not change the customer-facing state.
      const reopensTicket = data.direction === 'outbound'
        && !data.isInternal
        && (ticket.status === 'resolved' || ticket.status === 'closed');

      await tx.update(supportTicketsTable)
        .set({
          totalMessages: sql`${supportTicketsTable.totalMessages} + 1`,
          updatedAt: new Date(),
          ...(reopensTicket ? { status: 'in_progress', resolvedAt: null, closedAt: null } : {}),
        })
        .where(and(
          eq(supportTicketsTable.id, ticketId),
          eq(supportTicketsTable.userId, userId),
          isNull(supportTicketsTable.deletedAt),
        ));
      return message;
    });
  }

  async getMessages(ticketId: number, userId?: number) {
    const result = await db.execute(sql`
      SELECT message.id, message.ticket_id, message.user_id, message.member_id,
        message.direction, message.content, message.is_internal, message.attachments,
        message.delivery_action_id, message.created_at,
        member.name AS actor_name, member.email AS actor_email,
        delivery.status AS delivery_status,
        delivery.provider_message_id, delivery.last_error AS delivery_error,
        delivery.attempt_count AS delivery_attempt_count,
        delivery.reconciled_at AS delivery_reconciled_at
      FROM support_ticket_messages message
      JOIN support_tickets ticket ON ticket.id = message.ticket_id
      LEFT JOIN team_members member ON member.id = message.member_id AND member.user_id = ticket.user_id
      LEFT JOIN support_delivery_outbox delivery ON delivery.id = message.delivery_action_id
      WHERE message.ticket_id = ${ticketId}
        ${userId ? sql`AND ticket.user_id = ${userId}` : sql``}
      ORDER BY message.created_at, message.id
    `);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id), ticketId: Number(row.ticket_id), userId: row.user_id ? Number(row.user_id) : null,
      memberId: row.member_id ? Number(row.member_id) : null,
      direction: row.direction, content: row.content, isInternal: row.is_internal === true,
      attachments: row.attachments || [], deliveryActionId: row.delivery_action_id ? Number(row.delivery_action_id) : null,
      createdAt: row.created_at, actorName: row.actor_name || null, actorEmail: row.actor_email || null,
      deliveryStatus: row.delivery_status || null, providerMessageId: row.provider_message_id || null,
      deliveryError: row.delivery_error || null, deliveryAttemptCount: Number(row.delivery_attempt_count || 0),
      deliveryReconciledAt: row.delivery_reconciled_at || null,
    }));
  }

  async getAnalytics(userId: number, days = 30) {
    const queueResult = await db.execute(currentSupportQueueQuery(userId));
    const queue = queueResult.rows[0] as Record<string, unknown>;
    const cutoff = new Date(Date.now() - Math.max(7, Math.min(days, 365)) * 86_400_000);
    const analyticsConditions = and(
      eq(supportTicketsTable.userId, userId),
      isNull(supportTicketsTable.deletedAt),
      sql`${supportTicketsTable.createdAt} >= ${cutoff}`,
    );
    const [statusDist] = await db.select({
      open: sql<number>`count(*) filter (where status = 'open')`,
      inProgress: sql<number>`count(*) filter (where status = 'in_progress')`,
      waitingOnCustomer: sql<number>`count(*) filter (where status = 'waiting_on_customer')`,
      resolved: sql<number>`count(*) filter (where status = 'resolved')`,
      closed: sql<number>`count(*) filter (where status = 'closed')`,
      total: sql<number>`count(*)`,
    }).from(supportTicketsTable).where(analyticsConditions);

    const [priorityDist] = await db.select({
      low: sql<number>`count(*) filter (where priority = 'low')`,
      medium: sql<number>`count(*) filter (where priority = 'medium')`,
      high: sql<number>`count(*) filter (where priority = 'high')`,
      urgent: sql<number>`count(*) filter (where priority = 'urgent')`,
      critical: sql<number>`count(*) filter (where priority = 'critical')`,
    }).from(supportTicketsTable).where(analyticsConditions);

    const [avgRes] = await db.select({
      avgHours: sql<number>`coalesce(avg(extract(epoch from (COALESCE(resolved_at,closed_at) - created_at)) / 3600), 0)`,
    }).from(supportTicketsTable)
      .where(and(analyticsConditions, sql`COALESCE(resolved_at,closed_at) is not null`));

    const [slaBreachCount] = await db.select({
      count: supportSlaBreachCountSql(),
    }).from(supportTicketsTable).where(analyticsConditions);

    const firstResponseResult = await db.execute(sql`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (first_reply.created_at - ticket.created_at)) / 3600), 0) AS avg_hours
      FROM support_tickets ticket
      JOIN LATERAL (
        SELECT message.created_at FROM support_ticket_messages message
        WHERE message.ticket_id = ticket.id AND message.direction = 'outbound'
          AND COALESCE(message.is_internal, FALSE) = FALSE
        ORDER BY message.created_at ASC, message.id ASC LIMIT 1
      ) first_reply ON TRUE
      WHERE ticket.user_id = ${userId} AND ticket.deleted_at IS NULL AND ticket.created_at >= ${cutoff}
    `);
    const firstResponse = (firstResponseResult.rows as Array<Record<string, unknown>>)[0];
    const operations = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM handoff_queue
          WHERE user_id = ${userId} AND created_at >= ${cutoff}) AS handoffs,
        (SELECT COUNT(*)::int FROM support_delivery_outbox
          WHERE user_id = ${userId} AND created_at >= ${cutoff}
            AND status IN ('failed','uncertain','dead_letter')) AS delivery_failures,
        (SELECT COUNT(*)::int FROM support_ticket_reviews
          WHERE user_id = ${userId} AND created_at >= ${cutoff}) AS review_count,
        (SELECT COALESCE(AVG(rating), 0) FROM support_ticket_reviews
          WHERE user_id = ${userId} AND created_at >= ${cutoff}) AS average_rating
    `);

    const ticketsByDay = await db.select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    }).from(supportTicketsTable)
      .where(and(
        eq(supportTicketsTable.userId, userId),
        isNull(supportTicketsTable.deletedAt),
        sql`created_at >= ${cutoff}`
      ))
      .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`);

    const total = Number(statusDist?.total || 0);
    const resolved = Number(statusDist?.resolved || 0) + Number(statusDist?.closed || 0);

    // Build statusDistribution as Record<string, number>
    const statusDistribution: Record<string, number> = {};
    if (statusDist) {
      if (Number(statusDist.open) > 0) statusDistribution.open = Number(statusDist.open);
      if (Number(statusDist.inProgress) > 0) statusDistribution.in_progress = Number(statusDist.inProgress);
      if (Number(statusDist.waitingOnCustomer) > 0) statusDistribution.waiting_on_customer = Number(statusDist.waitingOnCustomer);
      if (Number(statusDist.resolved) > 0) statusDistribution.resolved = Number(statusDist.resolved);
      if (Number(statusDist.closed) > 0) statusDistribution.closed = Number(statusDist.closed);
    }

    // Build priorityDistribution as Record<string, number>
    const priorityDistribution: Record<string, number> = {};
    if (priorityDist) {
      if (Number(priorityDist.low) > 0) priorityDistribution.low = Number(priorityDist.low);
      if (Number(priorityDist.medium) > 0) priorityDistribution.medium = Number(priorityDist.medium);
      if (Number(priorityDist.high) > 0) priorityDistribution.high = Number(priorityDist.high);
      if (Number(priorityDist.urgent) > 0) priorityDistribution.urgent = Number(priorityDist.urgent);
      if (Number(priorityDist.critical) > 0) priorityDistribution.critical = Number(priorityDist.critical);
    }

    return {
      currentQueue: {
        openTickets: Number(queue?.open_tickets || 0),
        activeTickets: Number(queue?.active_tickets || 0),
        waitingOnCustomerTickets: Number(queue?.waiting_tickets || 0),
        slaBreaches: Number(queue?.sla_breaches || 0),
        ticketsWithSla: Number(queue?.tickets_with_sla || 0),
      },
      totalTickets: total,
      openTickets: Number(statusDist?.open || 0),
      activeTickets: Number(statusDist?.open || 0) + Number(statusDist?.inProgress || 0) + Number(statusDist?.waitingOnCustomer || 0),
      waitingOnCustomerTickets: Number(statusDist?.waitingOnCustomer || 0),
      resolvedTickets: resolved,
      avgResolutionHours: Number(avgRes?.avgHours || 0),
      slaBreaches: Number(slaBreachCount?.count || 0),
      avgFirstResponseHours: Number(firstResponse?.avg_hours || 0),
      handoffs: Number((operations.rows[0] as Record<string, unknown> | undefined)?.handoffs || 0),
      deliveryFailures: Number((operations.rows[0] as Record<string, unknown> | undefined)?.delivery_failures || 0),
      reviewCount: Number((operations.rows[0] as Record<string, unknown> | undefined)?.review_count || 0),
      averageRating: Number((operations.rows[0] as Record<string, unknown> | undefined)?.average_rating || 0),
      days,
      statusDistribution,
      priorityDistribution,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ticketsByDay: ticketsByDay.map((r: any) => ({ date: r.date, count: Number(r.count) })),
    };
  }

  async claimReviewRequest(userId: number, ticketId: number, context: TicketMutationContext = {}): Promise<{
    state: 'claimed' | 'already_sent' | 'in_progress';
    ticket: typeof supportTicketsTable.$inferSelect;
  } | null> {
    return withLockedSupportTicket(userId, ticketId, context, async (tx, before) => {
    await this.updateTicket(userId, ticketId, { status: 'closed' }, { ...context, database: tx, expectedVersion: before.version });
      const now = new Date();
      const newToken = crypto.randomBytes(32).toString('hex');
      const newExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const claimed = await tx.execute(sql`
        UPDATE support_tickets
        SET review_token = CASE
              WHEN review_token IS NOT NULL AND review_token_expires_at > NOW() THEN review_token
              ELSE ${newToken}
            END,
            review_token_expires_at = CASE
              WHEN review_token IS NOT NULL AND review_token_expires_at > NOW() THEN review_token_expires_at
              ELSE ${newExpiry}
            END,
            review_request_delivery_status = 'sending',
            review_request_delivery_error = NULL,
            review_request_started_at = NOW(),
            updated_at = NOW()
        WHERE id = ${ticketId}
          AND user_id = ${userId}
          AND deleted_at IS NULL
          AND review_request_sent_at IS NULL
          AND (
            review_request_delivery_status IS NULL
            OR review_request_delivery_status = 'failed'
            OR (
              review_request_delivery_status = 'sending'
              AND review_request_started_at < NOW() - INTERVAL '10 minutes'
            )
          )
        RETURNING id
      `);

      const [ticket] = await tx.select().from(supportTicketsTable).where(and(
        eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, userId), isNull(supportTicketsTable.deletedAt),
      ));
      if (!ticket) return null;
      if (claimed.rows[0]) {
        if (ticket.leadId) {
            await tx.execute(sql`
              UPDATE followup_sequences
              SET completed = true, replied_at = NOW(), updated_at = NOW()
              WHERE lead_id = ${ticket.leadId}
                AND user_id = ${userId}
                AND completed = false
            `);
            await tx.execute(sql`
              UPDATE sequence_executions
              SET status = 'paused', updated_at = NOW()
              WHERE lead_id = ${ticket.leadId} AND status = 'active'
            `);
        }
        return { state: 'claimed', ticket };
      }
      if (ticket.reviewRequestSentAt || ticket.reviewRequestDeliveryStatus === 'sent') {
        return { state: 'already_sent', ticket };
      }
      return { state: 'in_progress', ticket };
    });
  }

  async completeReviewRequest(
    userId: number,
    ticketId: number,
    result: { success: true } | { success: false; error: string },
  ) {
    const [updated] = await db.update(supportTicketsTable).set({
      reviewRequestDeliveryStatus: result.success ? 'sent' : 'failed',
      reviewRequestDeliveryError: result.success ? null : result.error.slice(0, 2_000),
      reviewRequestSentAt: result.success ? new Date() : null,
      updatedAt: new Date(),
    }).where(and(
      eq(supportTicketsTable.id, ticketId),
      eq(supportTicketsTable.userId, userId),
      eq(supportTicketsTable.reviewRequestDeliveryStatus, 'sending'),
    )).returning();
    return updated || null;
  }

  /**
   * Get the review for a ticket (if it exists).
   */
  async getReview(ticketId: number) {
    const [review] = await db.select().from(supportTicketReviewsTable)
      .where(eq(supportTicketReviewsTable.ticketId, ticketId));
    return review || null;
  }

  /**
   * Get all reviews for a user's tickets (for display on user page).
   */
  async getReviewsByUser(userId: number) {
    const reviews = await db
      .select({
        id: supportTicketReviewsTable.id,
        ticketId: supportTicketReviewsTable.ticketId,
        rating: supportTicketReviewsTable.rating,
        comment: supportTicketReviewsTable.comment,
        createdAt: supportTicketReviewsTable.createdAt,
        ticketNumber: supportTicketsTable.ticketNumber,
        subject: supportTicketsTable.subject,
      })
      .from(supportTicketReviewsTable)
      .innerJoin(supportTicketsTable, eq(supportTicketReviewsTable.ticketId, supportTicketsTable.id))
      .where(eq(supportTicketReviewsTable.userId, userId))
      .orderBy(desc(supportTicketReviewsTable.createdAt));
    return reviews;
  }

  /**
   * Get review stats for a team/member (average rating, total reviews).
   */
  async getReviewStats(userId: number) {
    const [stats] = await db.select({
      totalReviews: sql<number>`count(*)::int`,
      avgRating: sql<number>`coalesce(avg(${supportTicketReviewsTable.rating}), 0)`,
    })
      .from(supportTicketReviewsTable)
      .innerJoin(supportTicketsTable, eq(supportTicketReviewsTable.ticketId, supportTicketsTable.id))
      .where(eq(supportTicketsTable.userId, userId));

    return {
      totalReviews: stats?.totalReviews || 0,
      avgRating: Number(Number(stats?.avgRating || 0).toFixed(1)),
    };
  }

  /**
   * Get ticket details by review token (for public review page).
   */
  async getTicketByReviewToken(token: string) {
    if (!token) return null;
    const [ticket] = await db.select({
      id: supportTicketsTable.id,
      ticketNumber: supportTicketsTable.ticketNumber,
      subject: supportTicketsTable.subject,
      status: supportTicketsTable.status,
      rating: supportTicketsTable.rating,
      reviewSubmittedAt: supportTicketsTable.reviewSubmittedAt,
      userId: supportTicketsTable.userId,
    })
      .from(supportTicketsTable)
      .where(and(
        eq(supportTicketsTable.reviewToken, token),
        isNull(supportTicketsTable.deletedAt),
        sql`${supportTicketsTable.reviewTokenExpiresAt} IS NOT NULL
          AND ${supportTicketsTable.reviewTokenExpiresAt} > NOW()`,
      ));
    return ticket || null;
  }

  /**
   * Submit a review via token (public, no auth required).
   */
  async submitReviewByToken(token: string, data: { rating: number; comment?: string }) {
    const rating = Math.min(5, Math.max(1, Math.round(data.rating)));
    const result = await db.transaction(async (tx: typeof db) => {
      const locked = await tx.execute(sql`
        SELECT id, user_id, status, review_submitted_at
        FROM support_tickets
        WHERE review_token = ${token}
          AND review_token_expires_at IS NOT NULL
          AND review_token_expires_at > NOW()
          AND deleted_at IS NULL
        FOR UPDATE
      `);
      const ticket = locked.rows[0] as {
        id?: number;
        user_id?: number;
        status?: string;
        review_submitted_at?: Date | null;
      } | undefined;
      if (!ticket?.id || !ticket.user_id) return { error: 'Invalid or expired review link' } as const;
      if (ticket.status !== 'closed') return { error: 'This ticket is not closed yet' } as const;
      if (ticket.review_submitted_at) return { error: 'Review already submitted for this ticket' } as const;

      const now = new Date();
      const [review] = await tx.insert(supportTicketReviewsTable).values({
        ticketId: ticket.id,
        userId: ticket.user_id,
        rating,
        comment: data.comment || null,
        tokenConsumedAt: now,
      }).onConflictDoNothing().returning();
      if (!review) return { error: 'Review already submitted for this ticket' } as const;

      await tx.update(supportTicketsTable).set({
        rating,
        reviewComment: data.comment || null,
        reviewSubmittedAt: now,
        updatedAt: now,
      }).where(eq(supportTicketsTable.id, ticket.id));
      return { success: true, review, ticketId: ticket.id } as const;
    });

    if ('ticketId' in result) {
      logger.info({ ticketId: result.ticketId, rating }, 'Public review submitted via token');
    }
    return result;
  }
}

export const supportService = SupportService.getInstance();
