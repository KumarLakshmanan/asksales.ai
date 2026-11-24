import { and, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
import {
  supportTicketSummariesTable,
  type SupportTicketSummaryPayload,
} from '../models/supportTicketSummaries/schema.js';
import { agentRouter } from './agents/AgentRouter.js';
import { INTERNAL_SUPPORT_ASSIST_SCOPE } from './agents/pipeline/InternalSupportAssistScope.js';
import { logger } from '../utils/logger.js';
import { serializeSupportTimestamp } from '../utils/supportTimestamp.js';

export type SupportTimelineEventType = 'customer' | 'agent' | 'internal_note' | 'system';

export interface SupportTimelineEvent {
  key: string;
  id: number;
  source: 'conversation' | 'support_chat' | 'ticket' | 'handoff';
  type: SupportTimelineEventType;
  direction: 'inbound' | 'outbound' | 'system';
  content: string;
  actorName: string | null;
  attachments: unknown[];
  deliveryStatus: string | null;
  deliveryError: string | null;
  providerMessageId: string | null;
  deliveryActionId: number | null;
  restricted: boolean;
  createdAt: string;
}

const encodeCursor = (offset: number) => Buffer.from(String(offset), 'utf8').toString('base64url');
const decodeCursor = (cursor?: string) => {
  if (!cursor) return 0;
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
};

function safeContent(content: unknown, restricted: boolean) {
  if (restricted) return '[Restricted content — reveal with an audited support action]';
  return String(content || '').trim();
}

function parseSummary(text: string): SupportTicketSummaryPayload | null {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(cleaned) as Partial<SupportTicketSummaryPayload>;
    if (!value || typeof value.issue !== 'string' || typeof value.customerIntent !== 'string') return null;
    const strings = (input: unknown) => Array.isArray(input) ? input.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8) : [];
    const refs = Array.isArray(value.sourceReferences) ? value.sourceReferences.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const ref = item as { source?: unknown; messageId?: unknown; label?: unknown };
      const messageId = Number(ref.messageId);
      return Number.isSafeInteger(messageId) && messageId > 0
        ? [{ source: String(ref.source || 'ticket'), messageId, label: String(ref.label || `Message ${messageId}`).slice(0, 120) }]
        : [];
    }).slice(0, 12) : [];
    return {
      issue: value.issue.trim().slice(0, 1500),
      customerIntent: value.customerIntent.trim().slice(0, 1500),
      importantFacts: strings(value.importantFacts),
      actionsAttempted: strings(value.actionsAttempted),
      unresolvedQuestions: strings(value.unresolvedQuestions),
      recommendedNextAction: String(value.recommendedNextAction || '').trim().slice(0, 1500),
      sentiment: value.sentiment == null ? null : String(value.sentiment).slice(0, 120),
      risk: value.risk == null ? null : String(value.risk).slice(0, 240),
      sourceReferences: refs,
    };
  } catch {
    return null;
  }
}

export class SupportTicketWorkspaceService {
  async getTimeline(userId: number, ticketId: number, options: { cursor?: string; limit?: number; latest?: boolean; viewerMemberId?: number; viewerOwnerId?: number } = {}) {
    const [ticket] = await db.select({
      id: supportTicketsTable.id,
      outreachConversationId: supportTicketsTable.outreachConversationId,
    }).from(supportTicketsTable).where(and(
      eq(supportTicketsTable.id, ticketId),
      eq(supportTicketsTable.userId, userId),
      sql`${supportTicketsTable.deletedAt} IS NULL`,
    ));
    if (!ticket) return null;

    const [ticketMessages, conversationMessages, chatMessages, handoffs] = await Promise.all([
      db.execute(sql`
        SELECT message.id, message.direction, message.content, message.is_internal,
          message.attachments, message.delivery_action_id, message.created_at,
          COALESCE(staff.name,member.name) AS actor_name, delivery.status AS delivery_status,
          delivery.last_error AS delivery_error, delivery.provider_message_id
        FROM support_ticket_messages message
        LEFT JOIN team_members member ON member.id = message.member_id AND member.user_id = ${userId}
        LEFT JOIN users staff ON staff.id = message.actor_user_id
        LEFT JOIN support_delivery_outbox delivery ON delivery.id = message.delivery_action_id
        WHERE message.ticket_id = ${ticketId}
        ORDER BY message.created_at, message.id
      `),
      ticket.outreachConversationId ? db.execute(sql`
        SELECT id, direction, COALESCE(redacted_content, content) AS content,
          privacy_vault_id, attachments, delivery_action_id, status,
          error_message, provider_message_id, metadata->'supportTicketRouting' AS ticket_routing, created_at
        FROM outreach_messages
        WHERE user_id = ${userId} AND conversation_id = ${ticket.outreachConversationId}
        ORDER BY created_at, id
      `) : Promise.resolve({ rows: [] }),
      db.execute(sql`
        SELECT message.id,
          CASE WHEN message.role = 'user' THEN 'inbound' ELSE 'outbound' END AS direction,
          message.content, message.privacy_vault_id, message.created_at
        FROM support_chat_messages message
        JOIN support_chat_sessions session ON session.id = message.session_id
        JOIN team_members member ON member.id = session.member_id
        WHERE session.ticket_id = ${ticketId} AND member.user_id = ${userId}
        ORDER BY message.created_at, message.id
      `),
      db.execute(sql`
        SELECT id, status, reason, assigned_member_id, accepted_at, resolved_at, created_at
        FROM handoff_queue
        WHERE user_id = ${userId} AND support_ticket_id = ${ticketId}
        ORDER BY created_at, id
      `),
    ]);

    const events: SupportTimelineEvent[] = [];
    const nativeTicketMessageIds = new Set<number>();
    for (const raw of conversationMessages.rows as Array<Record<string, unknown>>) {
      const routing = raw.ticket_routing as { ticketId?: unknown; ticketMessageId?: unknown } | null;
      if (raw.direction === 'inbound' && Number(routing?.ticketId) === ticketId
        && Number.isSafeInteger(Number(routing?.ticketMessageId)) && Number(routing?.ticketMessageId) > 0) {
        nativeTicketMessageIds.add(Number(routing?.ticketMessageId));
      }
      const eventKey = `conversation:${raw.id}`;
      const vaultId = Number(raw.privacy_vault_id) || 0;
      const restricted = vaultId > 0;
      events.push({
        key: eventKey, id: Number(raw.id), source: 'conversation',
        type: raw.direction === 'inbound' ? 'customer' : 'agent',
        direction: raw.direction === 'inbound' ? 'inbound' : 'outbound',
        content: safeContent(raw.content, restricted), actorName: null,
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        deliveryStatus: raw.status ? String(raw.status) : null,
        deliveryError: raw.error_message ? String(raw.error_message) : null,
        providerMessageId: raw.provider_message_id ? String(raw.provider_message_id) : null,
        deliveryActionId: raw.delivery_action_id ? Number(raw.delivery_action_id) : null,
        restricted, createdAt: serializeSupportTimestamp(raw.created_at) || '',
      });
    }
    for (const raw of chatMessages.rows as Array<Record<string, unknown>>) {
      const eventKey = `support_chat:${raw.id}`;
      const vaultId = Number(raw.privacy_vault_id) || 0;
      const restricted = vaultId > 0;
      events.push({
        key: eventKey, id: Number(raw.id), source: 'support_chat',
        type: raw.direction === 'inbound' ? 'customer' : 'agent',
        direction: raw.direction === 'inbound' ? 'inbound' : 'outbound',
        content: safeContent(raw.content, restricted), actorName: null, attachments: [],
        deliveryStatus: null, deliveryError: null, providerMessageId: null,
        deliveryActionId: null, restricted, createdAt: serializeSupportTimestamp(raw.created_at) || '',
      });
    }
    const nativeDeliveryIds = new Set(events.map((event) => event.deliveryActionId).filter((id): id is number => Boolean(id)));
    for (const raw of ticketMessages.rows as Array<Record<string, unknown>>) {
      const deliveryActionId = raw.delivery_action_id ? Number(raw.delivery_action_id) : null;
      if (!raw.is_internal && deliveryActionId && nativeDeliveryIds.has(deliveryActionId)) continue;
      if (!raw.is_internal && raw.direction === 'inbound' && nativeTicketMessageIds.has(Number(raw.id))) continue;
      events.push({
        key: `ticket:${raw.id}`, id: Number(raw.id), source: 'ticket',
        type: raw.is_internal ? 'internal_note' : raw.direction === 'inbound' ? 'customer' : 'agent',
        direction: raw.direction === 'inbound' ? 'inbound' : 'outbound',
        content: String(raw.content || ''), actorName: raw.actor_name ? String(raw.actor_name) : null,
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        deliveryStatus: raw.delivery_status ? String(raw.delivery_status) : null,
        deliveryError: raw.delivery_error ? String(raw.delivery_error) : null,
        providerMessageId: raw.provider_message_id ? String(raw.provider_message_id) : null,
        deliveryActionId, restricted: false, createdAt: serializeSupportTimestamp(raw.created_at) || '',
      });
    }
    for (const raw of handoffs.rows as Array<Record<string, unknown>>) {
      events.push({
        key: `handoff:${raw.id}`, id: Number(raw.id), source: 'handoff', type: 'system', direction: 'system',
        content: `AI requested human support${raw.reason ? `: ${String(raw.reason)}` : '.'}`,
        actorName: null, attachments: [], deliveryStatus: String(raw.status), deliveryError: null,
        providerMessageId: null, deliveryActionId: null, restricted: false,
        createdAt: serializeSupportTimestamp(raw.created_at) || '',
      });
      if (raw.accepted_at) events.push({
        key: `handoff-accepted:${raw.id}`, id: Number(raw.id), source: 'handoff', type: 'system', direction: 'system',
        content: 'A support member claimed the conversation.', actorName: null, attachments: [],
        deliveryStatus: 'in_progress', deliveryError: null, providerMessageId: null,
        deliveryActionId: null, restricted: false, createdAt: serializeSupportTimestamp(raw.accepted_at) || '',
      });
      if (raw.resolved_at) events.push({
        key: `handoff-resolved:${raw.id}`, id: Number(raw.id), source: 'handoff', type: 'system', direction: 'system',
        content: 'Human handoff resolved.', actorName: null, attachments: [],
        deliveryStatus: 'resolved', deliveryError: null, providerMessageId: null,
        deliveryActionId: null, restricted: false, createdAt: serializeSupportTimestamp(raw.resolved_at) || '',
      });
    }
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.source.localeCompare(b.source) || a.id - b.id || a.key.localeCompare(b.key));
    const limit = Math.max(1, Math.min(Number(options.limit || 50), 200));
    const offset = options.latest ? Math.max(0, events.length - limit) : decodeCursor(options.cursor);
    const page = events.slice(offset, offset + limit);
    return {
      events: page,
      canRevealRestrictedContent: Boolean(options.viewerMemberId && handoffs.rows.some((row: any) =>
        Number(row.assigned_member_id) === options.viewerMemberId && ['waiting', 'assigned', 'in_progress'].includes(row.status))),
      revealBlockedReason: 'Claim the active handoff to view protected customer details.',
      nextCursor: offset + limit < events.length ? encodeCursor(offset + limit) : null,
      total: events.length,
      sourceCursor: events.at(-1)?.key || null,
    };
  }

  async getSummary(userId: number, ticketId: number) {
    const [summary] = await db.select().from(supportTicketSummariesTable).where(and(
      eq(supportTicketSummariesTable.userId, userId),
      eq(supportTicketSummariesTable.ticketId, ticketId),
    ));
    return summary || null;
  }

  queueRefresh(userId: number, ticketId: number) {
    setImmediate(() => {
      void this.refreshSummary(userId, ticketId).catch((error) => {
        logger.warn({ err: error, userId, ticketId }, '[SupportTicketSummary] Background refresh failed');
      });
    });
  }

  async refreshSummary(userId: number, ticketId: number) {
    const claimed = await db.execute(sql`
      INSERT INTO support_ticket_summaries (user_id, ticket_id, status, created_at, updated_at)
      SELECT ${userId}, ${ticketId}, 'generating', NOW(), NOW()
      FROM support_tickets WHERE id = ${ticketId} AND user_id = ${userId} AND deleted_at IS NULL
      ON CONFLICT (business_profile_id, user_id, ticket_id) DO UPDATE SET
        status = 'generating', error = NULL, updated_at = NOW()
      WHERE support_ticket_summaries.status <> 'generating'
         OR support_ticket_summaries.updated_at < NOW() - INTERVAL '2 minutes'
      RETURNING ticket_id
    `);
    if (claimed.rows.length === 0) return this.getSummary(userId, ticketId);
    try {
      const timeline = await this.getTimeline(userId, ticketId, { limit: 200, latest: true });
      if (!timeline) throw new Error('Ticket not found');
      const usable = timeline.events.filter((event) => event.type !== 'system' && event.content.trim()).slice(-80);
      const lastCustomer = [...usable].reverse().find((event) => event.type === 'customer');
      const transcript = usable.map((event) => `[${event.source}:${event.id}] ${event.type}: ${event.content.slice(0, 3000)}`).join('\n');
      const fallback: SupportTicketSummaryPayload = {
        issue: lastCustomer?.content || 'No customer message is available yet.',
        customerIntent: lastCustomer?.content || 'Awaiting customer context.',
        importantFacts: [], actionsAttempted: [], unresolvedQuestions: [],
        recommendedNextAction: lastCustomer ? 'Review the full conversation and respond to the latest customer request.' : 'Wait for customer context or add an internal note.',
        sentiment: null, risk: null,
        sourceReferences: lastCustomer ? [{ source: lastCustomer.source, messageId: lastCustomer.id, label: 'Latest customer message' }] : [],
      };
      let payload = fallback;
      if (lastCustomer && transcript) {
        const generated = await agentRouter.handle({
          userId, conversationId: -2_000_000_000 + ticketId, channel: 'web',
          inboundText: lastCustomer.content,
          recipientPhone: `support-ticket-summary:${ticketId}`,
          rawMessageId: `support-ticket-summary:${ticketId}:${timeline.sourceCursor || 'empty'}`,
          metadata: {
            executionMode: 'advisory', conversationKind: 'support_ticket_summary', ticketId,
            ...INTERNAL_SUPPORT_ASSIST_SCOPE,
            conversationHistory: [],
            platformInstructions: `Return one JSON object only. Summarize this internal support transcript without inventing facts. Schema: {"issue":"string","customerIntent":"string","importantFacts":["string"],"actionsAttempted":["string"],"unresolvedQuestions":["string"],"recommendedNextAction":"string","sentiment":"string|null","risk":"string|null","sourceReferences":[{"source":"conversation|support_chat|ticket","messageId":1,"label":"string"}]}. Source references must use IDs present in the transcript. Transcript:\n${transcript.slice(0, 24_000)}`,
          },
        });
        payload = generated?.replyText ? parseSummary(generated.replyText) || fallback : fallback;
      }
      const validSources = new Set(usable.map((event) => `${event.source}:${event.id}`));
      payload = {
        ...payload,
        sourceReferences: payload.sourceReferences.filter((reference) =>
          validSources.has(`${reference.source}:${reference.messageId}`),
        ),
      };
      const latestTimeline = await this.getTimeline(userId, ticketId, { limit: 200, latest: true });
      const sourceChanged = latestTimeline?.sourceCursor !== timeline.sourceCursor;
      const [saved] = await db.insert(supportTicketSummariesTable).values({
        userId, ticketId, status: sourceChanged ? 'stale' : 'current', summary: payload,
        sourceCursor: timeline.sourceCursor, model: 'support-agent-router', promptVersion: 'v1',
        generatedAt: new Date(), updatedAt: new Date(), error: null,
      }).onConflictDoUpdate({
        target: [supportTicketSummariesTable.businessProfileId, supportTicketSummariesTable.userId, supportTicketSummariesTable.ticketId],
        set: { status: sourceChanged ? 'stale' : 'current', summary: payload, sourceCursor: timeline.sourceCursor,
          model: 'support-agent-router', promptVersion: 'v1', generatedAt: new Date(), updatedAt: new Date(), error: null },
      }).returning();
      if (sourceChanged) this.queueRefresh(userId, ticketId);
      return saved;
    } catch (error) {
      await db.update(supportTicketSummariesTable).set({
        status: 'failed', error: error instanceof Error ? error.message.slice(0, 2000) : 'Summary generation failed', updatedAt: new Date(),
      }).where(and(eq(supportTicketSummariesTable.userId, userId), eq(supportTicketSummariesTable.ticketId, ticketId)));
      throw error;
    }
  }
}

export const supportTicketWorkspaceService = new SupportTicketWorkspaceService();
