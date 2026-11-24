import crypto from 'node:crypto';
import { withLockedSupportTicket } from './SupportTicketMutation.js';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { supportTicketMessagesTable } from '../models/supportTicketMessages/schema.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
import { deliveryOutboxService, createDeliveryDecisionKey } from './agents/orchestration/DeliveryOutboxService.js';
import { getBrandInfo, renderSupportReplyEmail } from '../utils/emailTemplates.js';
import { escapeHtml } from '../utils/personalization.js';
import { logger } from '../utils/logger.js';
import { StorageService } from './StorageService.js';
import {
  supportDeliveryOutboxTable,
  type SupportDeliveryOutboxRecord,
} from '../models/supportOrchestration/schema.js';

type SupportTicket = typeof supportTicketsTable.$inferSelect;
type SupportAttachment = { fileId: number; name: string; url: string; type: string };

export class SupportReplyDeliveryError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 502,
  ) {
    super(message);
    this.name = 'SupportReplyDeliveryError';
  }
}

export interface DeliverSupportReplyInput {
  ticket: SupportTicket;
  content: string;
  isInternal: boolean;
  idempotencyKey?: string;
  actorMemberId?: number;
  actorUserId?: number;
  actorName?: string;
  attachments?: SupportAttachment[];
}

// PostgreSQL jsonb normalizes object key order. Compare attachment values, so
// a durable replay is independent of how the client serialized each object.
function sameAttachments(saved: unknown, expected: SupportAttachment[]) {
  if (!Array.isArray(saved)) return saved == null && expected.length === 0;
  return saved.length === expected.length && saved.every((item, index) => {
    if (!item || typeof item !== 'object') return false;
    const attachment = item as Partial<SupportAttachment>;
    return attachment.fileId === expected[index].fileId
      && attachment.name === expected[index].name
      && attachment.url === expected[index].url
      && attachment.type === expected[index].type;
  });
}

function normalizeMessageId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (id.startsWith('<') && id.endsWith('>')) return id;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return `<${id}@resend.dev>`;
  }
  return id.includes('@') ? `<${id}>` : undefined;
}

async function getThreadingHeaders(ticket: SupportTicket, database = db) {
  try {
    if (ticket.outreachConversationId) {
      const [conversation, messages] = await Promise.all([
        database.execute(sql`
          SELECT external_thread_id
          FROM outreach_conversations
          WHERE id = ${ticket.outreachConversationId} AND user_id = ${ticket.userId}
          LIMIT 1
        `),
        database.execute(sql`
          SELECT external_message_id
          FROM outreach_messages
          WHERE conversation_id = ${ticket.outreachConversationId}
            AND user_id = ${ticket.userId}
            AND external_message_id IS NOT NULL
          ORDER BY created_at ASC
        `),
      ]);
      const normalized = (messages.rows as Array<{ external_message_id?: string }>)
        .map((row) => normalizeMessageId(row.external_message_id))
        .filter((id): id is string => Boolean(id));
      const lastMessageId = normalized.at(-1);
      const threadId = conversation.rows[0]?.external_thread_id as string | undefined;
      if (lastMessageId || threadId) {
        return {
          inReplyTo: lastMessageId,
          references: normalized.join(' ') || lastMessageId,
          threadId,
        };
      }
    }

    if (ticket.leadId) {
      const result = await database.execute(sql`
        SELECT message_id, gmail_thread_id, gmail_message_id
        FROM sent_messages
        WHERE lead_id = ${ticket.leadId}
          AND channel = 'email'
          AND (message_id IS NOT NULL OR gmail_thread_id IS NOT NULL)
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const messageId = normalizeMessageId((row?.message_id || row?.gmail_message_id) as string | undefined);
      const threadId = row?.gmail_thread_id as string | undefined;
      if (messageId || threadId) {
        return { inReplyTo: messageId, references: messageId, threadId };
      }
    }
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.id }, '[SupportReply] Failed to load email threading context');
  }
  return undefined;
}

async function loadEmailAttachments(userId: number, attachments: SupportAttachment[]) {
  if (attachments.length === 0) return undefined;
  const storage = StorageService.getInstance();
  return Promise.all(attachments.map(async (attachment) => {
    const downloaded = await storage.downloadFile(attachment.fileId, userId);
    if (!downloaded) throw new Error(`Attachment ${attachment.fileId} is no longer available.`);
    return {
      filename: attachment.name || downloaded.file.originalName || downloaded.file.fileName,
      content: downloaded.buffer,
      contentType: attachment.type || downloaded.file.mimeType || 'application/octet-stream',
    };
  }));
}

async function persistReplyWithTx(
  tx: typeof db,
  input: DeliverSupportReplyInput,
  deliveryActionId: number | null,
) {
  const { ticket, content, isInternal } = input;
  const attachments = input.attachments || [];
  const [created] = await tx.insert(supportTicketMessagesTable).values({
    ticketId: ticket.id,
    userId: ticket.userId,
    memberId: input.actorMemberId,
    actorUserId: input.actorUserId,
    content,
    direction: 'outbound',
    isInternal,
    attachments,
    deliveryActionId,
  }).onConflictDoNothing({
    target: supportTicketMessagesTable.deliveryActionId,
    where: sql`${supportTicketMessagesTable.deliveryActionId} IS NOT NULL`,
  }).returning();

  if (created) {
    const reopen = !isInternal && (ticket.status === 'resolved' || ticket.status === 'closed');
    await tx.update(supportTicketsTable).set({
      totalMessages: sql`${supportTicketsTable.totalMessages} + 1`,
      updatedAt: new Date(), version: sql`${supportTicketsTable.version} + 1`,
      ...(reopen ? { status: 'in_progress', resolvedAt: null, closedAt: null,
        metadata: { ...ticket.metadata, slaGeneration: crypto.randomUUID() },
        tags: (ticket.tags || []).filter(tag => !['sla_at_risk','sla_breached'].includes(tag)),
      } : {}),
    }).where(and(
      eq(supportTicketsTable.id, ticket.id),
      eq(supportTicketsTable.userId, ticket.userId),
    ));
    return created;
  }

  if (deliveryActionId) {
    const [existing] = await tx.select().from(supportTicketMessagesTable)
      .where(and(
        eq(supportTicketMessagesTable.deliveryActionId, deliveryActionId),
        eq(supportTicketMessagesTable.ticketId, ticket.id),
        eq(supportTicketMessagesTable.userId, ticket.userId),
      ))
      .limit(1);
    return existing || null;
  }
  return null;
}

class SupportReplyDeliveryService {
  async deliver(input: DeliverSupportReplyInput) {
    return withLockedSupportTicket(input.ticket.userId, input.ticket.id, {
      actorMemberId: input.actorMemberId, actorUserId: input.actorUserId,
    }, (tx, ticket) => this.deliverLocked({ ...input, ticket }, tx));
  }

  private async deliverLocked(input: DeliverSupportReplyInput, database: typeof db) {
    const content = input.content.trim();
    const attachments = input.attachments || [];
    for (const attachment of attachments) {
      const file = await StorageService.getInstance().getFile(attachment.fileId, input.ticket.userId);
      if (!file || file.referenceType !== 'support_ticket' || file.referenceId !== String(input.ticket.id)) {
        throw new SupportReplyDeliveryError('An attachment is no longer available for this ticket.', 409);
      }
    }
    if (input.isInternal) {
      return {
        message: await persistReplyWithTx(database, { ...input, content }, null),
        deliveryActionId: null,
        replayed: false,
      };
    }
    if (!input.idempotencyKey) {
      throw new SupportReplyDeliveryError('A valid idempotency key is required.', 409);
    }

    let linkedConversation: Record<string, unknown> | undefined;
    const widgetResult = await database.execute(sql`
      SELECT id, public_token, session_expires_at
      FROM support_chat_sessions
      WHERE ticket_id = ${input.ticket.id}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const widgetSession = widgetResult.rows[0] as {
      id?: number;
      public_token?: string;
      session_expires_at?: Date | null;
    } | undefined;
    if (input.ticket.outreachConversationId) {
      const result = await database.execute(sql`
        SELECT conversation.id, conversation.channel, conversation.external_thread_id,
               conversation.user_id, conversation.lead_id,
               conversation.provider_account_id
        FROM outreach_conversations AS conversation
        WHERE conversation.id = ${input.ticket.outreachConversationId}
          AND conversation.user_id = ${input.ticket.userId}
        LIMIT 1
      `);
      linkedConversation = result.rows[0] as Record<string, unknown> | undefined;
    }
    const channel = widgetSession?.id
      ? 'web'
      : String(linkedConversation?.channel || 'email').toLowerCase();
    const identity = {
      userId: input.ticket.userId,
      conversationId: widgetSession?.id ? -Number(widgetSession.id) : input.ticket.outreachConversationId || input.ticket.id,
      channel,
      inboundProviderMessageId: `manual:${input.idempotencyKey}`,
    };
    const decisionKey = createDeliveryDecisionKey(identity);
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${decisionKey},0))`);
    const [existingAction] = await database.select().from(supportDeliveryOutboxTable)
      .where(eq(supportDeliveryOutboxTable.decisionKey,decisionKey)).limit(1);
    if (existingAction && (existingAction.payload.text !== content
      || Number(existingAction.payload.metadata?.ticketId) !== input.ticket.id
      || !sameAttachments(existingAction.payload.metadata?.attachments, attachments))) {
      throw new SupportReplyDeliveryError('This reply identity was already used for different content. Reconcile it before sending a new reply.', 409);
    }
    const claim = await deliveryOutboxService.claim(identity, {
      text: content,
      recipient: String(widgetSession?.public_token || linkedConversation?.external_thread_id || input.ticket.leadId || input.ticket.contactId || ''),
      subject: input.ticket.subject,
      metadata: {
        dispatchKind: 'manual_support_reply',
        ticketId: input.ticket.id,
        supportMemberId: input.actorMemberId || null,
        actorUserId: input.actorUserId || null,
        manualReply: true,
        ...(typeof linkedConversation?.provider_account_id === 'string'
          ? { providerAccountId: linkedConversation.provider_account_id }
          : {}),
        attachments: attachments.map((attachment) => ({
          fileId: attachment.fileId,
          name: attachment.name,
          url: attachment.url,
          type: attachment.type,
        })),
      },
    });
    const deliveryActionId = claim.action.id;
    if (claim.action.payload && (claim.action.payload.text !== content
      || Number(claim.action.payload.metadata?.ticketId) !== input.ticket.id
      || !sameAttachments(claim.action.payload.metadata?.attachments, attachments))) {
      throw new SupportReplyDeliveryError('This reply identity was already used for different content. Reconcile it before sending a new reply.', 409);
    }

    if (claim.state === 'uncertain') {
      throw new SupportReplyDeliveryError(
        'The prior delivery outcome is uncertain. Verify the provider before retrying.',
        409,
      );
    }
    if (claim.state === 'already_sent') {
      const message = await persistReplyWithTx(database, { ...input, content }, deliveryActionId);
      return { message, deliveryActionId, replayed: true };
    }

    let providerMessageId: string | null = null;
    let deliveryError: string | null = null;
    let providerCallStarted = false;
    let deliveryUncertain = false;

    try {
      if (channel === 'email') {
        const recipientResult = input.ticket.leadId
          ? await database.execute(sql`
              SELECT email, COALESCE(NULLIF(full_name, ''), NULLIF(name, ''), 'Customer') AS name
              FROM leads
              WHERE id = ${input.ticket.leadId} AND user_id = ${input.ticket.userId}
              LIMIT 1
            `)
          : input.ticket.contactId
            ? await database.execute(sql`
                SELECT email,
                  COALESCE(NULLIF(CONCAT_WS(' ', first_name, last_name), ''), 'Customer') AS name
                FROM crm_contacts
                WHERE id = ${input.ticket.contactId} AND user_id = ${input.ticket.userId}
                LIMIT 1
              `)
            : { rows: [] };
        const recipient = recipientResult.rows[0] as { email?: string; name?: string } | undefined;
        if (!recipient?.email) {
          deliveryError = 'The ticket has no linked customer email address.';
        } else {
          const brand = await getBrandInfo(input.ticket.userId, input.ticket.brandToolkitId, input.ticket.businessProfileId);
          const body = content.split(/\n\n+/)
            .map((paragraph) => `<p style="margin:0 0 8px;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
            .join('');
          const html = renderSupportReplyEmail({
            brand,
            preheader: `Reply to your support request #${input.ticket.ticketNumber}`,
            agentName: input.actorName,
            body,
            ticketNumber: input.ticket.ticketNumber,
          });
          const threading = await getThreadingHeaders(input.ticket, database);
          const emailAttachments = await loadEmailAttachments(input.ticket.userId, attachments);
          const { emailService } = await import('./emailService.js');
          providerCallStarted = true;
          const result = await emailService.sendEmailWithUserCredentials(input.ticket.userId, {
            to: recipient.email,
            toName: recipient.name,
            subject: `Re: ${(input.ticket.subject || 'Support Request').replace(/^Re:\s*/i, '')}`,
            html,
            text: content,
            attachments: emailAttachments,
            leadId: input.ticket.leadId || undefined,
            userId: input.ticket.userId,
            inReplyTo: threading?.inReplyTo,
            references: threading?.references,
            threadId: threading?.threadId,
            isFollowUp: Boolean(threading?.inReplyTo),
          });
          if (result.success) {
            providerMessageId = result.messageId || null;
          } else {
            providerCallStarted = false;
            deliveryError = result.error || 'The email provider rejected the reply.';
          }
        }
      } else if (channel === 'web') {
        if (!widgetSession?.id) {
          deliveryError = 'The linked web support session no longer exists.';
        } else if (widgetSession.session_expires_at && new Date(widgetSession.session_expires_at) <= new Date()) {
          deliveryError = 'The linked web support session has expired.';
        } else if (attachments.length > 0) {
          deliveryError = 'Web support replies do not support file attachments yet. Remove the files and retry.';
        }
      } else if (['whatsapp', 'instagram', 'facebook'].includes(channel)) {
        if (attachments.length > 0) {
          deliveryError = `${channel} ticket replies do not support file attachments yet. Remove the files and retry.`;
        } else {
          const recipientId = String(linkedConversation?.external_thread_id || '');
          const ownerId = Number(linkedConversation?.user_id || input.ticket.userId);
          if (!recipientId) {
            deliveryError = `The linked ${channel} conversation has no recipient identifier.`;
          } else if (channel === 'whatsapp') {
            const { whatsappApiService } = await import('./whatsappApiService.js');
            providerCallStarted = true;
            const result = await whatsappApiService.sendText({ userId: ownerId, to: recipientId, text: content });
            providerMessageId = result?.messages?.[0]?.id || null;
          } else if (channel === 'instagram') {
            const { sendInstagramDM } = await import('./instagramService.js');
            providerCallStarted = true;
            const result = await sendInstagramDM({
              recipientId,
              message: content,
              userId: ownerId,
              conversationId: input.ticket.outreachConversationId!,
              messageId: deliveryActionId,
              providerAccountId: typeof linkedConversation?.provider_account_id === 'string'
                ? linkedConversation.provider_account_id
                : undefined,
            });
            if (!result.success) {
              providerCallStarted = false;
              deliveryError = result.error || 'Instagram rejected the reply.';
            } else {
              providerMessageId = (result as { externalMessageId?: string; messageId?: string }).externalMessageId
                || (result as { messageId?: string }).messageId
                || null;
            }
          } else {
            const { sendFacebookDM } = await import('./FacebookMessengerService.js');
            providerCallStarted = true;
            const result = await sendFacebookDM({
              conversationId: input.ticket.outreachConversationId || undefined,
              recipientId,
              message: content,
              userId: ownerId,
              providerAccountId: typeof linkedConversation?.provider_account_id === 'string'
                ? linkedConversation.provider_account_id
                : undefined,
            });
            if (!result.success) {
              providerCallStarted = false;
              deliveryError = result.error || 'Facebook rejected the reply.';
            } else {
              providerMessageId = (result as { messageId?: string }).messageId || null;
            }
          }
        }
      } else {
        deliveryError = `Replies cannot be delivered through the linked ${channel} channel.`;
      }
    } catch (error) {
      deliveryError = error instanceof Error ? error.message : 'Reply delivery failed.';
      deliveryUncertain = providerCallStarted;
      logger.warn({ err: error, ticketId: input.ticket.id, channel }, '[SupportReply] Provider delivery failed');
    }

    if (!deliveryError && channel !== 'web' && providerCallStarted && !providerMessageId) {
      deliveryError = 'The provider did not return a message acknowledgement.';
      deliveryUncertain = true;
    }
    if (deliveryError) {
      await deliveryOutboxService.markFailed(deliveryActionId, deliveryError, deliveryUncertain);
      throw new SupportReplyDeliveryError(
        deliveryUncertain
          ? 'Delivery outcome is uncertain. Verify the provider before retrying.'
          : deliveryError,
        deliveryUncertain ? 409 : 502,
      );
    }

    const message = await (async (tx: typeof db) => {
      let committedProviderMessageId = providerMessageId;
      if (channel === 'web' && widgetSession?.id) {
        const widgetRequestId = `manual-delivery:${deliveryActionId}`;
        const inserted = await tx.execute(sql`
          INSERT INTO support_chat_messages (session_id, role, request_id, content, created_at)
          VALUES (${widgetSession.id}, 'assistant', ${widgetRequestId}, ${content}, NOW())
          ON CONFLICT (session_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
          RETURNING id
        `);
        const existing = inserted.rows[0] || (await tx.execute(sql`
          SELECT id FROM support_chat_messages
          WHERE session_id = ${widgetSession.id}
            AND request_id = ${widgetRequestId}
          LIMIT 1
        `)).rows[0];
        const widgetMessageId = Number((existing as { id?: number } | undefined)?.id || 0);
        if (!widgetMessageId) throw new Error('Widget reply could not be durably persisted.');
        committedProviderMessageId = `widget:${widgetMessageId}`;
        await tx.execute(sql`
          UPDATE support_chat_sessions
          SET updated_at = NOW()
          WHERE id = ${widgetSession.id}
        `);
      } else if (['whatsapp', 'instagram', 'facebook'].includes(channel)) {
        if (committedProviderMessageId) {
          const { reconcileSocialSend } = await import('./SocialMessagePersistence.js');
          await reconcileSocialSend(tx, { userId: input.ticket.userId, conversationId: input.ticket.outreachConversationId!,
            providerId: committedProviderMessageId, deliveryActionId });
        }
        await tx.execute(sql`
          INSERT INTO outreach_messages
            (conversation_id, user_id, direction, content, status, is_read, is_ai_generated,
             external_message_id, provider_message_id, provider_account_id, phone_number_id, waba_message_id, provider_call_state, sent_at, confirmed_at, delivery_action_id, created_at)
          VALUES
            (${input.ticket.outreachConversationId}, ${input.ticket.userId}, 'outbound', ${content}, 'sent',
             true, false, ${committedProviderMessageId}, ${committedProviderMessageId}, ${linkedConversation?.provider_account_id || null},
             ${channel === 'whatsapp' ? linkedConversation?.provider_account_id || null : null}, ${channel === 'whatsapp' ? committedProviderMessageId : null},
             'confirmed',NOW(),NOW(), ${deliveryActionId}, NOW())
          ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO UPDATE SET is_ai_generated=FALSE,provider_call_state='confirmed',confirmed_at=COALESCE(outreach_messages.confirmed_at,NOW())
        `);
      }

      const [completedAction] = await tx.update(supportDeliveryOutboxTable).set({
        status: 'sent',
        providerMessageId: committedProviderMessageId,
        sentAt: new Date(),
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(
        eq(supportDeliveryOutboxTable.id, deliveryActionId),
        eq(supportDeliveryOutboxTable.userId, input.ticket.userId),
        eq(supportDeliveryOutboxTable.status, 'sending'),
      )).returning({ id: supportDeliveryOutboxTable.id });
      if (!completedAction) throw new Error('Manual delivery action changed before completion.');
      return persistReplyWithTx(tx, { ...input, content }, deliveryActionId);
    })(database);

    return { message, deliveryActionId, replayed: false };
  }

  async retryDeliveryAction(action: SupportDeliveryOutboxRecord) {
    if (action.userId <= 0 || action.payload.metadata?.dispatchKind !== 'manual_support_reply') {
      throw new Error('Delivery action is not a manual support reply.');
    }
    const ticketId = Number(action.payload.metadata.ticketId);
    const [ticket] = await db.select().from(supportTicketsTable).where(and(
      eq(supportTicketsTable.id, ticketId),
      eq(supportTicketsTable.userId, action.userId),
    )).limit(1);
    if (!ticket) throw new Error('The support ticket for this delivery action no longer exists.');
    const manualKey = String(action.inboundProviderMessageId || '');
    if (!manualKey.startsWith('manual:') || manualKey.length <= 7) {
      throw new Error('The manual reply idempotency identity is invalid.');
    }
    const rawAttachments = action.payload.metadata.attachments;
    const attachments = Array.isArray(rawAttachments)
      ? rawAttachments.filter((item): item is SupportAttachment => {
          if (!item || typeof item !== 'object') return false;
          const attachment = item as Partial<SupportAttachment>;
          return Number.isSafeInteger(attachment.fileId)
            && typeof attachment.name === 'string'
            && typeof attachment.url === 'string'
            && typeof attachment.type === 'string';
        })
      : [];
    return this.deliver({
      ticket,
      content: action.payload.text,
      isInternal: false,
      idempotencyKey: manualKey.slice(7),
      actorMemberId: Number(action.payload.metadata.supportMemberId) || undefined,
      actorUserId: Number(action.payload.metadata.actorUserId) || undefined,
      attachments,
    });
  }
}

export const supportReplyDeliveryService = new SupportReplyDeliveryService();
