import { db } from "../db";
import { chatMessagesTable, type ChatMessageRecord, type InsertChatMessage } from "./schema";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { eq, desc, and, isNull, isNull as drizzleIsNull, lt, or, asc, sql } from "drizzle-orm";
import { webSocketEmitter } from "../../services/agents/WebSocketEmitter";
import { countTokens } from "../../utils/tokenCounter";
import { sanitizeErrorFields, sanitizeAssistantContent } from "../../../shared/userFacingError.js";
import { readMessageApprovalReference, type ApprovalActionReference } from '../../mastra/approvalActions.js';
import type { ActionButton } from '../../mastra/state.js';
import { isRecord } from "../../../shared/records.js";

// ── Filter helper: exclude soft-deleted rows in all SELECT queries ──────
const NOT_DELETED = isNull(chatMessagesTable.deletedAt);

export function presentStoredMessage(message: ChatMessageRecord): ChatMessageRecord {
  if (message.role !== 'assistant') return message;
  return {
    ...message,
    content: sanitizeAssistantContent(message.content),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: message.metadata ? sanitizeErrorFields(message.metadata as Record<string, any>) : message.metadata,
  };
}

export async function getChatMessagesByUserId(userId: number, limit = 100): Promise<ChatMessageRecord[]> {
  return await db.select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.userId, userId), NOT_DELETED))
    .orderBy(desc(chatMessagesTable.createdAt))
    .limit(limit);
}

export async function getChatMessagesByThreadId(threadId: number, limit = 100): Promise<ChatMessageRecord[]> {
  return await db.select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.threadId, threadId), NOT_DELETED))
    .orderBy(desc(chatMessagesTable.createdAt))
    .limit(limit);
}

export async function hasUserMessageInThread(threadId: number): Promise<boolean> {
  const [message] = await db.select({ id: chatMessagesTable.id })
    .from(chatMessagesTable)
    .where(and(
      eq(chatMessagesTable.threadId, threadId),
      eq(chatMessagesTable.role, 'user'),
      NOT_DELETED,
    ))
    .limit(1);
  return Boolean(message);
}

/**
 * Get messages by thread ID with cursor-based pagination.
 * Returns messages in chronological order (oldest first).
 * @param threadId - The thread ID
 * @param limit - Maximum number of messages to return (default 50)
 * @param cursor - Message ID to paginate after (for next page)
 * @returns { messages, nextCursor, hasMore }
 */
export async function getChatMessagesByThreadIdCursor(
  threadId: number,
  limit = 50,
  cursor?: number
): Promise<{ messages: ChatMessageRecord[]; nextCursor: number | null; hasMore: boolean }> {
  // Fetch one extra to determine if there are more messages
  const fetchLimit = limit + 1;
  
  let messages: ChatMessageRecord[];
  
  if (cursor) {
    // The cursor identifies the oldest displayed row, not a timestamp or an
    // insertion boundary. Imports/backfills and equal timestamps can make IDs
    // disagree with timestamp order. Resolve both ordering keys in this thread.
    // Keep soft-deleted anchors usable while another tab is paging history.
    // Compare in PostgreSQL: JS Dates would discard sub-millisecond precision.
    messages = await db.select()
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.threadId, threadId),
          NOT_DELETED,
          sql`(${chatMessagesTable.createdAt}, ${chatMessagesTable.id}) < (
            SELECT ${chatMessagesTable.createdAt}, ${chatMessagesTable.id}
            FROM ${chatMessagesTable}
            WHERE ${chatMessagesTable.threadId} = ${threadId} AND ${chatMessagesTable.id} = ${cursor}
          )`,
        )
      )
      .orderBy(desc(chatMessagesTable.createdAt), desc(chatMessagesTable.id))
      .limit(fetchLimit);
  } else {
    // Get most recent messages
    messages = await db.select()
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.threadId, threadId),
          NOT_DELETED
        )
      )
      .orderBy(desc(chatMessagesTable.createdAt), desc(chatMessagesTable.id))
      .limit(fetchLimit);
  }
  
  const hasMore = messages.length > limit;
  const resultMessages = hasMore ? messages.slice(0, limit) : messages;
  
  // Reverse to return in chronological order (oldest first)
  resultMessages.reverse();
  // Rows saved before write-time sanitizing can hold raw validation or provider
  // errors; present them the same way new rows are stored.
  for (let i = 0; i < resultMessages.length; i += 1) resultMessages[i] = presentStoredMessage(resultMessages[i]);
  
  // The next cursor is the ID of the oldest message in this batch
  // (so the next request fetches messages older than this)
  const nextCursor = hasMore && resultMessages.length > 0
    ? resultMessages[0].id
    : null;
  
  return {
    messages: resultMessages,
    nextCursor,
    hasMore,
  };
}

/**
 * Create a chat message and emit via WebSocket.
 * NOTE: Only emits for USER messages to prevent duplicate emissions.
 * Assistant messages are emitted separately by the controller to avoid duplicates.
 */
export async function createChatMessage(message: InsertChatMessage): Promise<ChatMessageRecord> {
  // Cache token count in metadata at insertion time
  const tokenCount = message.content ? countTokens(message.content) : 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingMeta = sanitizeErrorFields((message.metadata as Record<string, any>) || {});
  const safeContent = message.role === 'assistant'
    ? sanitizeAssistantContent(message.content)
    : message.content;
  const enrichedMessage = {
    ...message,
    content: safeContent,
    metadata: { ...existingMeta, tokenCount },
  };

  const result = await db.insert(chatMessagesTable).values(enrichedMessage).returning();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const savedMessage = result?.[0] || (enrichedMessage as any);
  
  // Only emit via WebSocket for USER messages
  // Assistant messages are emitted explicitly by chatController to avoid duplicates
  if (savedMessage.threadId && savedMessage.role === 'user') {
    webSocketEmitter.emitChatMessage(savedMessage.userId, savedMessage.threadId, {
      id: savedMessage.id,
      role: savedMessage.role,
      content: savedMessage.content,
      agentType: savedMessage.agentType || 'user',
      metadata: savedMessage.metadata,
      timestamp: new Date(savedMessage.createdAt).getTime(),
    });
  }
  
  return savedMessage;
}

export type PersistedChatActionResolution = {
  status: 'processing' | 'selected' | 'failed_retryable' | 'superseded';
  selectedButtonId: string;
  action: string;
  outcome: 'selected' | 'approved' | 'rejected';
  resolvedAt?: string;
  startedAt?: string;
  failure?: string;
};

type ChatActionClaimResult =
  | { state: 'claimed'; resolution: PersistedChatActionResolution; approvalReference?: ApprovalActionReference }
  | { state: 'processing' | 'selected'; resolution: PersistedChatActionResolution }
  | { state: 'not_found' | 'invalid_button' | 'conflict' };

const CHAT_ACTION_PROCESSING_STALE_MS = 2 * 60 * 1000;

/**
 * Atomically claims a persisted one-shot message action. Row locking prevents
 * two browser tabs from dispatching different choices for the same prompt.
 */
export async function claimChatMessageAction(params: {
  messageId: number;
  userId: number;
  threadId: number;
  buttonId: string;
  action: string;
  outcome: PersistedChatActionResolution['outcome'];
}): Promise<ChatActionClaimResult> {
  // Database adapter is intentionally `any` in models/db.ts so tests can swap
  // in a lightweight chainable implementation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    const [message] = await tx.select()
      .from(chatMessagesTable)
      .where(and(
        eq(chatMessagesTable.id, params.messageId),
        eq(chatMessagesTable.userId, params.userId),
        eq(chatMessagesTable.threadId, params.threadId),
        NOT_DELETED,
      ))
      .for('update')
      .limit(1);

    if (!message) return { state: 'not_found' } as const;

    const metadata = isRecord(message.metadata) ? message.metadata : {};
    const actionButtons = Array.isArray(metadata.actionButtons) ? metadata.actionButtons : [];
    const configuredButton = actionButtons.find((candidate: unknown) =>
      isRecord(candidate)
      && candidate.id === params.buttonId
      && candidate.action === params.action,
    );
    if (!configuredButton) return { state: 'invalid_button' } as const;

    const existing = isRecord(metadata.actionResolution)
      ? metadata.actionResolution as PersistedChatActionResolution
      : null;
    if (existing) {
      const sameChoice = existing.selectedButtonId === params.buttonId && existing.action === params.action;
      if (!sameChoice) return { state: 'conflict' } as const;
      if (existing.status === 'selected') return { state: 'selected', resolution: existing } as const;
      if (existing.status === 'processing') {
        const startedAt = existing.startedAt ? Date.parse(existing.startedAt) : Number.NaN;
        if (Number.isFinite(startedAt) && Date.now() - startedAt < CHAT_ACTION_PROCESSING_STALE_MS) {
          return { state: 'processing', resolution: existing } as const;
        }
      }
    }

    const resolution: PersistedChatActionResolution = {
      status: 'processing',
      selectedButtonId: params.buttonId,
      action: params.action,
      outcome: params.outcome,
      startedAt: new Date().toISOString(),
    };
    await tx.update(chatMessagesTable)
      .set({ metadata: { ...metadata, actionResolution: resolution } })
      .where(eq(chatMessagesTable.id, params.messageId));

    return {
      state: 'claimed', resolution,
      approvalReference: readMessageApprovalReference(metadata, configuredButton as ActionButton),
    } as const;
  });
}

export async function finalizeChatMessageAction(params: {
  messageId: number;
  userId: number;
  threadId: number;
  buttonId: string;
  action: string;
  succeeded: boolean;
  failure?: string;
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    const [message] = await tx.select()
      .from(chatMessagesTable)
      .where(and(
        eq(chatMessagesTable.id, params.messageId),
        eq(chatMessagesTable.userId, params.userId),
        eq(chatMessagesTable.threadId, params.threadId),
        NOT_DELETED,
      ))
      .for('update')
      .limit(1);
    if (!message) return;

    const metadata = isRecord(message.metadata) ? message.metadata : {};
    const existing = isRecord(metadata.actionResolution)
      ? metadata.actionResolution as PersistedChatActionResolution
      : null;
    if (!existing || existing.selectedButtonId !== params.buttonId || existing.action !== params.action) return;

    const resolution: PersistedChatActionResolution = {
      ...existing,
      status: params.succeeded ? 'selected' : 'failed_retryable',
      resolvedAt: new Date().toISOString(),
      ...(params.succeeded ? { failure: undefined } : { failure: params.failure || 'The action was not accepted. You can retry safely.' }),
    };
    await tx.update(chatMessagesTable)
      .set({ metadata: { ...metadata, actionResolution: resolution } })
      .where(eq(chatMessagesTable.id, params.messageId));
  });
}

// ── Soft-delete ───────────────────────────────────────────────────────

/**
 * Soft-delete a single message by setting deleted_at = NOW().
 * The row is kept in the database for compliance and audit purposes.
 */
export async function softDeleteChatMessage(messageId: number, userId: number): Promise<void> {
  await db.update(chatMessagesTable)
    .set({ deletedAt: new Date(), deletedBy: userId })
    .where(eq(chatMessagesTable.id, messageId));
}

/**
 * Soft-delete all messages in a thread (e.g., when a thread is soft-deleted).
 */
export async function softDeleteChatMessagesByThreadId(threadId: number, userId: number): Promise<void> {
  await db.update(chatMessagesTable)
    .set({ deletedAt: new Date(), deletedBy: userId })
    .where(eq(chatMessagesTable.threadId, threadId));
}

export async function softDeleteChatMessagesByUserId(userId: number): Promise<void> {
  await db.update(chatMessagesTable)
    .set({ deletedAt: new Date(), deletedBy: userId })
    .where(and(
      eq(chatMessagesTable.userId, userId),
      NOT_DELETED,
    ));
}

// ── Hard-delete (admin only, for records past retention period) ────────

export async function hardDeleteChatMessagesByUserId(userId: number): Promise<void> {
  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.userId, userId));
}

export async function hardDeleteChatMessagesByThreadId(threadId: number): Promise<void> {
  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.threadId, threadId));
}

/**
 * @deprecated Use softDeleteChatMessage instead. Retained for GDPR right-to-erasure requests
 * past the retention window (hard delete only after retention period).
 */
export const deleteChatMessagesByUserId = hardDeleteChatMessagesByUserId;

/**
 * @deprecated Use softDeleteChatMessagesByThreadId instead.
 */
export const deleteChatMessagesByThreadId = hardDeleteChatMessagesByThreadId;
