/**
 * Outreach Conversations Functions
 * Database operations for outreach conversations and messages
 */

import { db } from '../db';
import { eq, desc, and, sql, or, inArray } from 'drizzle-orm';
import { deliveryStatusesProtectedFrom } from './deliveryStatus.js';
import { logger } from '../../utils/logger.js';
import {
  outreachConversationsTable,
  outreachMessagesTable,
  type OutreachConversationRecord,
  type InsertOutreachConversation,
  type OutreachMessageRecord,
  type InsertOutreachMessage,
} from './schema';

// ===== CONVERSATION FUNCTIONS =====

/**
 * Create a new outreach conversation
 */
export async function createOutreachConversation(
  data: InsertOutreachConversation
): Promise<OutreachConversationRecord> {
  const [conversation] = await db
    .insert(outreachConversationsTable)
    .values(data)
    .returning();
  return conversation;
}

/**
 * Get conversation by ID
 */
export async function getOutreachConversationById(
  id: number
): Promise<OutreachConversationRecord | undefined> {
  const [conversation] = await db
    .select()
    .from(outreachConversationsTable)
    .where(eq(outreachConversationsTable.id, id));
  return conversation;
}

/**
 * Get all conversations for a user by channel
 */
export async function getOutreachConversationsByChannel(
  userId: number,
  channel: string,
  limit = 50,
  offset = 0
): Promise<OutreachConversationRecord[]> {
  return db
    .select()
    .from(outreachConversationsTable)
    .where(
      and(
        eq(outreachConversationsTable.userId, userId),
        eq(outreachConversationsTable.channel, channel)
      )
    )
    .orderBy(desc(outreachConversationsTable.lastMessageAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get conversation by user, lead, and channel
 */
export async function getConversationByLeadAndChannel(
  userId: number,
  leadId: number,
  channel: string,
  providerAccountId?: string | null
): Promise<OutreachConversationRecord | undefined> {
  const [conversation] = await db
    .select()
    .from(outreachConversationsTable)
    .where(
      and(
        eq(outreachConversationsTable.userId, userId),
        eq(outreachConversationsTable.leadId, leadId),
        eq(outreachConversationsTable.channel, channel),
        ...(['facebook', 'instagram', 'whatsapp'].includes(channel) ? [
          sql`COALESCE(${outreachConversationsTable.providerAccountId}, '') = ${providerAccountId || ''}`,
          sql`${outreachConversationsTable.sessionEndedAt} IS NULL`,
          sql`${outreachConversationsTable.status} NOT IN ('closed', 'resolved')`,
          sql`${outreachConversationsTable.automationMode} NOT IN ('closed', 'resolved')`,
        ] : [])
      )
    )
    .orderBy(desc(outreachConversationsTable.lastMessageAt), desc(outreachConversationsTable.createdAt))
    .limit(1);
  return conversation;
}

export function isEmailConversationChannel(channel: string): boolean {
  return channel === 'email' || channel === 'gmail';
}

export async function getConversationByThreadKey(
  userId: number,
  leadId: number,
  threadKey: string
): Promise<OutreachConversationRecord | undefined> {
  const [conversation] = await db
    .select()
    .from(outreachConversationsTable)
    .where(and(
      eq(outreachConversationsTable.userId, userId),
      eq(outreachConversationsTable.leadId, leadId),
      eq(outreachConversationsTable.threadKey, threadKey),
      or(
        eq(outreachConversationsTable.channel, 'email'),
        eq(outreachConversationsTable.channel, 'gmail')
      )
    ))
    .limit(1);
  return conversation;
}

export async function getConversationByProviderThread(
  userId: number,
  leadId: number,
  integrationProvider: string,
  externalThreadId: string
): Promise<OutreachConversationRecord | undefined> {
  const [conversation] = await db
    .select()
    .from(outreachConversationsTable)
    .where(and(
      eq(outreachConversationsTable.userId, userId),
      eq(outreachConversationsTable.leadId, leadId),
      eq(outreachConversationsTable.integrationProvider, integrationProvider),
      eq(outreachConversationsTable.externalThreadId, externalThreadId),
      or(
        eq(outreachConversationsTable.channel, 'email'),
        eq(outreachConversationsTable.channel, 'gmail')
      )
    ))
    .limit(1);
  return conversation;
}

/**
 * Get or create conversation
 * Social chats are canonical per contact/account/current session. Email
 * callers that need a distinct thread use createOutreachConversation; this
 * helper resolves an explicitly identified thread or the latest legacy thread.
 */
export async function getOrCreateConversation(
  data: InsertOutreachConversation
): Promise<OutreachConversationRecord> {
  if (['whatsapp', 'instagram', 'facebook'].includes(data.channel)) {
    // Serializes session creation for the same tenant/contact/receiving account.
    // A new ID naturally isolates playbook runs, slots, and short-term context.
    return db.transaction(async (tx: typeof db) => {
      const identity = `${data.userId}:${data.leadId}:${data.channel}:${data.providerAccountId || ''}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
      const identityFilters = and(
        eq(outreachConversationsTable.userId, data.userId),
        eq(outreachConversationsTable.leadId, data.leadId),
        eq(outreachConversationsTable.channel, data.channel),
        sql`COALESCE(${outreachConversationsTable.providerAccountId}, '') = ${data.providerAccountId || ''}`,
      );
      const filters = and(
        identityFilters,
        sql`${outreachConversationsTable.sessionEndedAt} IS NULL`,
      );
      const [current] = await tx.select().from(outreachConversationsTable).where(filters).limit(1).for('update');
      if (current?.automationMode === 'opted_out') return current;
      if (current && !['closed', 'resolved'].includes(current.status)
        && !['closed', 'resolved'].includes(current.automationMode)) return current;
      const previous = current || (await tx.select().from(outreachConversationsTable)
        .where(identityFilters).orderBy(desc(outreachConversationsTable.id)).limit(1))[0];
      if (current) {
        await tx.update(outreachConversationsTable).set({ sessionEndedAt: new Date(), updatedAt: new Date() })
          .where(eq(outreachConversationsTable.id, current.id));
      }
      const [created] = await tx.insert(outreachConversationsTable).values({
        ...data, crmContactId: data.crmContactId || previous?.crmContactId,
        automationMode: previous?.automationMode === 'opted_out' ? 'opted_out' : 'ai_active', sessionEndedAt: null,
      }).onConflictDoNothing().returning();
      if (created) return created;
      const [winner] = await tx.select().from(outreachConversationsTable).where(filters).limit(1);
      if (!winner) throw new Error('Could not resolve the active social conversation session');
      return winner;
    });
  }
  const isEmail = isEmailConversationChannel(data.channel);
  const hasExplicitEmailIdentity = isEmail && Boolean(
    data.threadKey || (data.integrationProvider && data.externalThreadId)
  );
  if (isEmail) {
    if (data.threadKey) {
      const byThreadKey = await getConversationByThreadKey(data.userId, data.leadId, data.threadKey);
      if (byThreadKey) return byThreadKey;
    }
    if (data.integrationProvider && data.externalThreadId) {
      const byProviderThread = await getConversationByProviderThread(
        data.userId,
        data.leadId,
        data.integrationProvider,
        data.externalThreadId
      );
      if (byProviderThread) return byProviderThread;
    }
  }

  // Legacy email callers without an explicit identity retain latest-thread
  // behavior. Explicit email identities must never collapse into another row.
  const existing = hasExplicitEmailIdentity
    ? undefined
    : await getConversationByLeadAndChannel(
        data.userId,
        data.leadId,
        data.channel,
        data.providerAccountId
      );

  if (existing) {
    const updates: Partial<InsertOutreachConversation> = {};
    if (data.subject && !existing.subject) updates.subject = data.subject;
    if (data.externalThreadId && data.externalThreadId !== existing.externalThreadId) {
      updates.externalThreadId = data.externalThreadId;
    }
    if (data.integrationProvider && data.integrationProvider !== existing.integrationProvider) {
      updates.integrationProvider = data.integrationProvider;
    }
    if (data.leadInstagram && data.leadInstagram !== existing.leadInstagram) {
      const isNewUsername = !/^\d+$/.test(data.leadInstagram);
      const isExistingNumeric = /^\d+$/.test(existing.leadInstagram || '');
      if (!existing.leadInstagram || isNewUsername || isExistingNumeric) {
        updates.leadInstagram = data.leadInstagram;
      }
    }
    if (Object.keys(updates).length > 0) {
      try {
        const updated = await updateOutreachConversation(existing.id, updates);
        if (updated) return updated;
      } catch (_e) {
        // A stale denormalized identifier must not prevent queueing; the worker
        // still receives the validated recipient in its job payload.
      }
    }
    return existing;
  }

  // Race-free insert: rely on the (user_id, lead_id, channel) unique constraint
  // (migration 074 + schema unique index) to absorb concurrent creators
  try {
    const [inserted] = await db
      .insert(outreachConversationsTable)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
  } catch (err) {
    logger.warn({ err, data }, '[getOrCreateConversation] insert failed, falling back to lookup');
  }

  // If we lost the race, fetch the winning row
  const afterRace = data.threadKey
    ? await getConversationByThreadKey(data.userId, data.leadId, data.threadKey)
    : isEmail && data.integrationProvider && data.externalThreadId
      ? await getConversationByProviderThread(
          data.userId,
          data.leadId,
          data.integrationProvider,
          data.externalThreadId
        )
      : await getConversationByLeadAndChannel(
          data.userId,
          data.leadId,
          data.channel,
        data.providerAccountId
        );
  if (afterRace) return afterRace;

  // Should be unreachable if the unique index is in place
  throw new Error('Failed to create or fetch outreach conversation');
}

/**
 * Update conversation
 */
export async function updateOutreachConversation(
  id: number,
  data: Partial<InsertOutreachConversation>
): Promise<OutreachConversationRecord | undefined> {
  const [updated] = await db
    .update(outreachConversationsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(outreachConversationsTable.id, id))
    .returning();
  return updated;
}

/**
 * Update conversation with new message info
 */
export async function updateConversationWithMessage(
  conversationId: number,
  direction: 'outbound' | 'inbound',
  messagePreview: string
): Promise<void> {
  await db
    .update(outreachConversationsTable)
    .set({
      lastMessageAt: new Date(),
      lastMessageBy: direction === 'outbound' ? 'user' : 'lead',
      lastMessagePreview: messagePreview.substring(0, 200),
      totalMessages: sql`${outreachConversationsTable.totalMessages} + 1`,
      unreadCount: direction === 'inbound' 
        ? sql`${outreachConversationsTable.unreadCount} + 1` 
        : outreachConversationsTable.unreadCount,
      status: direction === 'inbound' ? 'replied' : outreachConversationsTable.status,
      updatedAt: new Date(),
    })
    .where(eq(outreachConversationsTable.id, conversationId));
}

/**
 * Mark conversation as read
 */
export async function markConversationAsRead(
  conversationId: number
): Promise<void> {
  await db
    .update(outreachConversationsTable)
    .set({
      unreadCount: 0,
      updatedAt: new Date(),
    })
    .where(eq(outreachConversationsTable.id, conversationId));
}

/**
 * Get unread count for user by channel
 */
export async function getUnreadCountByChannel(
  userId: number,
  channel: string
): Promise<number> {
  const channelCondition =
    channel === 'email'
      ? or(
          eq(outreachConversationsTable.channel, 'email'),
          eq(outreachConversationsTable.channel, 'gmail')
        )
      : eq(outreachConversationsTable.channel, channel);

  const result = await db
    .select({ 
      totalUnread: sql<number>`COALESCE(SUM(${outreachConversationsTable.unreadCount}), 0)` 
    })
    .from(outreachConversationsTable)
    .where(
      and(
        eq(outreachConversationsTable.userId, userId),
        channelCondition
      )
    );
  return result[0]?.totalUnread || 0;
}

// ===== MESSAGE FUNCTIONS =====

/**
 * Create a new outreach message
 */
export async function createOutreachMessage(
  data: InsertOutreachMessage
): Promise<OutreachMessageRecord> {
  const insertData: InsertOutreachMessage = data.direction === 'inbound'
    ? { ...data, messageKind: 'reply' }
    : data;
  const insert = db.insert(outreachMessagesTable).values(insertData);
  const [message] = await (data.idempotencyKey ? insert.onConflictDoNothing() : insert).returning();
  if (!message && data.idempotencyKey && data.userId) {
    const existing = await getOutreachMessageByIdempotencyKey(data.userId, data.idempotencyKey);
    if (existing) return existing;
  }
  if (!message) throw new Error('The message could not be persisted.');

  if (data.direction === 'inbound') {
    const { cancelConversationEmailFollowUps } = await import('../../services/emailFollowUpService.js');
    await cancelConversationEmailFollowUps(data.conversationId, message.createdAt);
    const { cancelSocialFollowUpsForConversation } = await import('../../services/socialFollowUpService.js');
    await cancelSocialFollowUpsForConversation(data.conversationId, 'reply_received');
  }
  
  // Update conversation
  if (data.conversationId) {
    await updateConversationWithMessage(
      data.conversationId,
      data.direction as 'outbound' | 'inbound',
      data.content
    );
  }
  
  return message;
}

/**
 * Get message by ID
 */
export async function getOutreachMessageById(
  id: number
): Promise<OutreachMessageRecord | undefined> {
  const [message] = await db
    .select()
    .from(outreachMessagesTable)
    .where(eq(outreachMessagesTable.id, id));
  return message;
}

export async function getOutreachMessageByIdempotencyKey(
  userId: number,
  idempotencyKey: string,
): Promise<OutreachMessageRecord | undefined> {
  const [message] = await db
    .select()
    .from(outreachMessagesTable)
    .where(and(
      eq(outreachMessagesTable.userId, userId),
      eq(outreachMessagesTable.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  return message;
}

/**
 * Get all messages for a conversation
 */
export async function getMessagesByConversationId(
  conversationId: number,
  limit = 100,
  offset = 0,
  beforeMessageId?: number,
): Promise<OutreachMessageRecord[]> {
  return db
    .select()
    .from(outreachMessagesTable)
    .where(and(eq(outreachMessagesTable.conversationId, conversationId), beforeMessageId ? sql`
      (COALESCE(${outreachMessagesTable.sentAt},${outreachMessagesTable.createdAt}),${outreachMessagesTable.id}) <
      (SELECT COALESCE(anchor.sent_at,anchor.created_at),anchor.id FROM outreach_messages anchor WHERE anchor.id=${beforeMessageId} AND anchor.conversation_id=${conversationId})
    ` : undefined))
    .orderBy(desc(sql`COALESCE(${outreachMessagesTable.sentAt},${outreachMessagesTable.createdAt})`), desc(outreachMessagesTable.id))
    .limit(limit)
    .offset(offset);
}

/**
 * Get the last exact RFC Message-ID for email threading.
 * Provider API IDs are deliberately excluded.
 */
export async function getLastMessageExternalId(
  conversationId: number
): Promise<string | null> {
  const [lastMessage] = await db
    .select({ rfcMessageId: outreachMessagesTable.rfcMessageId })
    .from(outreachMessagesTable)
    .where(
      and(
        eq(outreachMessagesTable.conversationId, conversationId),
        sql`${outreachMessagesTable.rfcMessageId} IS NOT NULL`
      )
    )
    .orderBy(desc(outreachMessagesTable.createdAt))
    .limit(1);
  
  return lastMessage?.rfcMessageId || null;
}

/**
 * Build the full RFC5322 References chain for email threading.
 * Returns exact RFC Message-ID values in chronological order (oldest first).
 */
export async function getFullReferenceChain(
  conversationId: number
): Promise<string | null> {
  const messages = await db
    .select({ rfcMessageId: outreachMessagesTable.rfcMessageId })
    .from(outreachMessagesTable)
    .where(
      and(
        eq(outreachMessagesTable.conversationId, conversationId),
        sql`${outreachMessagesTable.rfcMessageId} IS NOT NULL`
      )
    )
    .orderBy(outreachMessagesTable.createdAt); // ASC — oldest first per RFC5322

  if (messages.length === 0) return null;

  const exactIds = messages
    .map((message: { rfcMessageId: string | null }) => message.rfcMessageId)
    .filter((id: string | null): id is string => Boolean(id));

  return exactIds.length > 0 ? exactIds.join(' ') : null;
}

/**
 * Update message status
 */
export async function updateOutreachMessageStatus(
  id: number,
  status: string,
  additionalData?: Partial<InsertOutreachMessage>
): Promise<OutreachMessageRecord | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: any = {
    status,
    updatedAt: new Date(),
    ...additionalData,
  };
  
  // Set appropriate timestamp based on status
  if (status === 'sent' && !additionalData?.sentAt) {
    updateData.sentAt = new Date();
  } else if (status === 'delivered' && !additionalData?.deliveredAt) {
    updateData.deliveredAt = new Date();
  } else if (status === 'read' && !additionalData?.readAt) {
    updateData.readAt = new Date();
  } else if (status === 'failed' && !additionalData?.failedAt) {
    updateData.failedAt = new Date();
  }
  
  const providerId = additionalData?.providerMessageId || additionalData?.externalMessageId || additionalData?.wabaMessageId;
  if (status === 'sent' && providerId) {
    return db.transaction(async (tx: typeof db) => {
      const [message] = await tx.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, id)).limit(1);
      if (!message?.userId) return undefined;
      const [conversation] = await tx.select().from(outreachConversationsTable).where(eq(outreachConversationsTable.id, message.conversationId)).limit(1);
      const receiptAccount = conversation?.channel === 'whatsapp' ? conversation.providerAccountId || message.phoneNumberId : null;
      if (receiptAccount) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`wa-receipt:${message.userId}:${receiptAccount}:${providerId}`}))`);
      const { reconcileSocialSend } = await import('../../services/SocialMessagePersistence.js');
      await reconcileSocialSend(tx, { userId: message.userId, conversationId: message.conversationId, providerId, messageId: id });
      const [reconciled] = await tx.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, id)).limit(1);
      if (reconciled?.sentAt) updateData.sentAt = reconciled.sentAt;
      if (['delivered','read','failed'].includes(reconciled?.status || '')) updateData.status = reconciled.status;
      if (reconciled?.status === 'failed') {
        updateData.failedAt = reconciled.failedAt;
        updateData.errorMessage = reconciled.errorMessage;
      }
      const [updated] = await tx.update(outreachMessagesTable).set(updateData).where(eq(outreachMessagesTable.id, id)).returning();
      if (receiptAccount) {
        // A callback may precede the HTTP acknowledgement that first attaches the
        // provider ID. Replay the persisted receipt under the same callback lock.
        const receipts = await tx.execute(sql`SELECT event_type, timestamp, raw_data
          FROM instagram_webhook_events WHERE user_id=${message.userId}
            AND page_id=${receiptAccount} AND message_id=${providerId}
            AND event_type IN ('whatsapp_sent','whatsapp_failed','whatsapp_delivered','whatsapp_read')`);
        const { applyWhatsAppReceipts } = await import('./whatsappReceipts.js');
        const receiptUpdate = applyWhatsAppReceipts(updated, receipts.rows);
        if (receiptUpdate) {
          const [withReceipt] = await tx.update(outreachMessagesTable).set(receiptUpdate).where(eq(outreachMessagesTable.id, id)).returning();
          if (withReceipt.status === 'failed') {
            const failedReceipt = receipts.rows.find((row: {event_type?:string}) => row.event_type === 'whatsapp_failed');
            const raw = failedReceipt?.raw_data as {status?:{errors?:Array<{code?:number}>}} | undefined;
            const { planWhatsAppProviderRetry } = await import('../../services/outreach/WhatsAppProviderRetry.js');
            await planWhatsAppProviderRetry(tx,message.userId,providerId,receiptAccount,raw?.status?.errors?.[0]?.code);
          }
          return withReceipt;
        }
      }
      return updated;
    });
  }
  const [updated] = await db
    .update(outreachMessagesTable)
    .set(updateData)
    .where(eq(outreachMessagesTable.id, id))
    .returning();
  return updated;
}

/**
 * Mark messages as read
 */
export async function markMessagesAsRead(
  conversationId: number
): Promise<void> {
  await db
    .update(outreachMessagesTable)
    .set({
      isRead: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachMessagesTable.conversationId, conversationId),
        eq(outreachMessagesTable.direction, 'inbound'),
        eq(outreachMessagesTable.isRead, false)
      )
    );
  
  // Also update conversation unread count
  await markConversationAsRead(conversationId);
}

/**
 * Get conversation with messages (paginated)
 */
export async function getConversationWithMessages(
  conversationId: number,
  limit = 50,
  offset = 0,
  beforeMessageId?: number,
): Promise<{
  conversation: OutreachConversationRecord | undefined;
  messages: OutreachMessageRecord[];
}> {
  const conversation = await getOutreachConversationById(conversationId);
  const messages = await getMessagesByConversationId(conversationId, limit, offset, beforeMessageId);
  
  return {
    conversation,
    messages: messages.reverse(), // Return in chronological order for chat display
  };
}

/**
 * Get all conversations with latest message for a user
 * JOINs with leads table to always return up-to-date lead info
 */
export async function getConversationsWithPreview(
  userId: number,
  channel?: string,
  limit = 50,
  offset = 0,
  filters?: { status?: 'open' | 'completed' | 'read' | 'unread'; dateFrom?: string; dateTo?: string }
): Promise<(OutreachConversationRecord & { subject?: string | null })[]> {
  const channelFilter =
    channel === 'email'
      ? sql`AND oc.channel IN ('email', 'gmail')`
      : channel
        ? sql`AND oc.channel = ${channel}`
        : sql``;
  const statusFilter = filters?.status === 'open'
    ? sql`AND oc.status IN ('active', 'replied', 'open')`
    : filters?.status === 'completed'
      ? sql`AND oc.status IN ('closed', 'resolved', 'completed')`
      : filters?.status === 'unread'
        ? sql`AND COALESCE(oc.unread_count, 0) > 0`
        : filters?.status === 'read'
          ? sql`AND COALESCE(oc.unread_count, 0) = 0`
          : sql``;
  const fromFilter = filters?.dateFrom
    ? sql`AND oc.last_message_at >= (${filters.dateFrom}::timestamptz AT TIME ZONE 'UTC')`
    : sql``;
  const toFilter = filters?.dateTo
    ? sql`AND oc.last_message_at < (${filters.dateTo}::timestamptz AT TIME ZONE 'UTC')`
    : sql``;
  
  const result = await db.execute(sql`
    SELECT
      oc.id,
      oc.user_id         AS "userId",
      oc.lead_id         AS "leadId",
      oc.channel,
      oc.provider_account_id AS "providerAccountId",
      (SELECT account_name FROM channel_credentials credential WHERE credential.user_id = oc.user_id
        AND credential.account_identifier = oc.provider_account_id
        AND credential.platform = CASE oc.channel WHEN 'facebook' THEN 'facebook_api' WHEN 'instagram' THEN 'instagram_api' END
        ORDER BY credential.updated_at DESC LIMIT 1) AS "providerAccountName",
      oc.status,
      oc.integration_provider   AS "integrationProvider",
      oc.thread_key             AS "threadKey",
      oc.external_thread_id     AS "externalThreadId",
      oc.last_message_at        AS "lastMessageAt",
      oc.last_message_by        AS "lastMessageBy",
      oc.last_message_preview   AS "lastMessagePreview",
      oc.total_messages         AS "totalMessages",
      oc.unread_count           AS "unreadCount",
      oc.lead_instagram         AS "leadInstagram",
      oc.lead_avatar            AS "leadAvatar",
      oc.metadata,
      oc.created_at             AS "createdAt",
      oc.updated_at             AS "updatedAt",
      COALESCE(
        l.full_name,
        NULLIF(TRIM(CONCAT(COALESCE(l.first_name, ''), ' ', COALESCE(l.last_name, ''))), ''),
        CASE WHEN l.name IS NOT NULL AND l.name !~ '^(IG User|FB User|Instagram User|Facebook User) ' THEN l.name ELSE NULL END,
        oc.lead_name,
        l.name
      )                         AS "leadName",
      COALESCE(l.email, oc.lead_email)                    AS "leadEmail",
      COALESCE(l.company, l.company_name, oc.lead_company) AS "leadCompany",
      (SELECT om.subject FROM outreach_messages om
       WHERE om.conversation_id = oc.id AND om.subject IS NOT NULL
       ORDER BY om.created_at ASC LIMIT 1
      )                         AS subject
    FROM outreach_conversations oc
    LEFT JOIN leads l ON l.id = oc.lead_id
    WHERE oc.user_id = ${userId} ${channelFilter} ${statusFilter} ${fromFilter} ${toFilter}
    ORDER BY oc.last_message_at DESC NULLS LAST, oc.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  
  return result.rows as (OutreachConversationRecord & { subject?: string | null })[];
}

/**
 * Search conversations by lead name or company
 */
export async function searchConversations(
  userId: number,
  searchTerm: string,
  channel?: string
): Promise<OutreachConversationRecord[]> {
  const conditions = [
    eq(outreachConversationsTable.userId, userId),
    or(
      sql`${outreachConversationsTable.leadName} ILIKE ${`%${searchTerm}%`}`,
      sql`${outreachConversationsTable.leadCompany} ILIKE ${`%${searchTerm}%`}`,
      sql`${outreachConversationsTable.leadEmail} ILIKE ${`%${searchTerm}%`}`
    )
  ];
  
  if (channel) {
    conditions.push(eq(outreachConversationsTable.channel, channel));
  }
  
  return db
    .select()
    .from(outreachConversationsTable)
    .where(and(...conditions))
    .orderBy(desc(outreachConversationsTable.lastMessageAt))
    .limit(20);
}

/**
 * Find an outreach message by its external message ID (e.g. Resend email ID, Gmail message ID)
 */
export async function getMessageByExternalId(
  externalMessageId: string
): Promise<OutreachMessageRecord | undefined> {
  const [message] = await db
    .select()
    .from(outreachMessagesTable)
    .where(or(
      eq(outreachMessagesTable.externalMessageId, externalMessageId),
      eq(outreachMessagesTable.providerMessageId, externalMessageId),
      eq(outreachMessagesTable.rfcMessageId, externalMessageId)
    ));
  return message;
}

/**
 * Update outreach message status by external message ID.
 * Used by webhooks to update delivery status (e.g. Resend email events).
 */
export async function updateMessageStatusByExternalId(
  externalMessageId: string,
  status: string,
  additionalData?: Partial<InsertOutreachMessage>
): Promise<OutreachMessageRecord | undefined> {
  const protectedStatuses = deliveryStatusesProtectedFrom(status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: any = {
    updatedAt: new Date(),
    ...additionalData,
    // Compare in the UPDATE, not in a prior read: concurrent callbacks must
    // obey the same ordering without a read/modify/write race.
    status: protectedStatuses.length > 0
      ? sql`CASE WHEN ${inArray(outreachMessagesTable.status, protectedStatuses)}
          THEN ${outreachMessagesTable.status} ELSE ${status} END`
      : status,
  };

  if (['sent', 'delivered', 'read'].includes(status)) {
    // A verified positive receipt resolves uncertainty only when the persisted
    // outcome permits it. Evaluate every field against the same row atomically:
    // a late success callback must preserve an already confirmed failure.
    const confirmedFailure = inArray(outreachMessagesTable.status, ['failed', 'bounced', 'complained']);
    updateData.providerCallState = sql`CASE WHEN ${confirmedFailure}
      THEN ${outreachMessagesTable.providerCallState} ELSE ${'confirmed'} END`;
    updateData.manualReviewRequired = sql`CASE WHEN ${confirmedFailure}
      THEN ${outreachMessagesTable.manualReviewRequired} ELSE ${false} END`;
    updateData.errorMessage = sql`CASE WHEN ${confirmedFailure}
      THEN ${outreachMessagesTable.errorMessage} ELSE NULL END`;
  }

  if (status === 'delivered' || status === 'read') {
    updateData.deliveredAt = sql`COALESCE(${outreachMessagesTable.deliveredAt}, ${additionalData?.deliveredAt || new Date()})`;
  }
  if (status === 'read') {
    updateData.readAt = sql`COALESCE(${outreachMessagesTable.readAt}, ${additionalData?.readAt || new Date()})`;
  } else if (status === 'failed' || status === 'bounced' || status === 'complained') {
    updateData.failedAt = sql`COALESCE(${outreachMessagesTable.failedAt}, ${additionalData?.failedAt || new Date()})`;
  }

  const [updated] = await db
    .update(outreachMessagesTable)
    .set(updateData)
    .where(and(
      eq(outreachMessagesTable.direction, 'outbound'),
      or(
        eq(outreachMessagesTable.externalMessageId, externalMessageId),
        eq(outreachMessagesTable.providerMessageId, externalMessageId),
        eq(outreachMessagesTable.rfcMessageId, externalMessageId),
      ),
    ))
    .returning();
  
  // If the message was bounced, also update the conversation status
  if (updated && (status === 'bounced' || status === 'failed')) {
    await db
      .update(outreachConversationsTable)
      .set({ status: 'bounced', updatedAt: new Date() })
      .where(eq(outreachConversationsTable.id, updated.conversationId));
  }

  return updated;
}

/**
 * Delete a conversation and all its messages (cascade handled by FK)
 */
export async function deleteOutreachConversation(
  conversationId: number,
  userId: number
): Promise<boolean> {
  const [deleted] = await db
    .delete(outreachConversationsTable)
    .where(
      and(
        eq(outreachConversationsTable.id, conversationId),
        eq(outreachConversationsTable.userId, userId)
      )
    )
    .returning({ id: outreachConversationsTable.id });
  return !!deleted;
}

/**
 * Delete a single outreach message by ID
 */
export async function deleteOutreachMessage(
  messageId: number
): Promise<boolean> {
  const [deleted] = await db
    .delete(outreachMessagesTable)
    .where(eq(outreachMessagesTable.id, messageId))
    .returning({ id: outreachMessagesTable.id });
  return !!deleted;
}
