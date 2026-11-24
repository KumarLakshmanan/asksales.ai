import { db } from "../db";
 
import { chatThreadsTable, type ChatThreadRecord } from "./schema";
import { chatMessagesTable } from "../chatMessages/schema";
import { eq, desc, and, isNull, sql } from "drizzle-orm";

// ── Filter helper: exclude soft-deleted rows in all SELECT queries ──────
const NOT_DELETED = isNull(chatThreadsTable.deletedAt);

export async function getChatThreadsByUserId(userId: number, limit?: number, offset?: number): Promise<ChatThreadRecord[]> {
  let query = db.select()
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.userId, userId), NOT_DELETED))
    .orderBy(desc(chatThreadsTable.updatedAt));
  
  if (limit) {
    query = query.limit(limit);
  }
  
  if (offset) {
    query = query.offset(offset);
  }
  
  return await query;
}

export async function getChatThreadById(threadId: number): Promise<ChatThreadRecord | undefined> {
  const result = await db.select()
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, threadId), NOT_DELETED))
    .limit(1);
  return result[0];
}

export async function createChatThread(userId: number, title?: string, businessId?: number): Promise<ChatThreadRecord> {
  const result = await db.insert(chatThreadsTable)
    .values({ 
      userId, 
      title: title || `Chat ${new Date().toLocaleDateString()}`,
      ...(businessId ? { businessId } : {}),
    })
    .returning();
  return result[0];
}

export async function updateChatThread(threadId: number, title: string, selectedAgent?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: any = { title, updatedAt: new Date() };
  if (selectedAgent !== undefined) {
    updateData.selectedAgent = selectedAgent;
  }
  const result = await db
    .update(chatThreadsTable)
    .set(updateData)
    .where(eq(chatThreadsTable.id, threadId))
    .returning();
  return result[0];
}

export async function updateChatThreadTimestamp(threadId: number): Promise<void> {
  await db.update(chatThreadsTable)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreadsTable.id, threadId));
}

// ── Soft-delete ───────────────────────────────────────────────────────

/**
 * Soft-delete a thread and all its messages. The rows remain in the database
 * for compliance and audit purposes.
 */
export async function softDeleteChatThread(threadId: number, userId: number): Promise<boolean> {
  return db.transaction(async (tx: typeof db) => {
    // Keep ownership and repeat-delete handling inside the same transaction.
    // RLS still constrains this lookup to the current business scope.
    const [thread] = await tx.select({ deletedAt: chatThreadsTable.deletedAt, deletedBy: chatThreadsTable.deletedBy })
      .from(chatThreadsTable)
      .where(and(eq(chatThreadsTable.id, threadId), eq(chatThreadsTable.userId, userId)))
      .for('update');
    if (!thread) return false;
    const deletedAt = thread.deletedAt ?? new Date();
    const deletedBy = thread.deletedBy ?? userId;
    if (!thread.deletedAt) {
      await tx.update(chatThreadsTable)
        .set({ deletedAt, deletedBy })
        .where(and(eq(chatThreadsTable.id, threadId), eq(chatThreadsTable.userId, userId)));
    }
    // A retry can finish an old partial deletion, but never refresh an existing
    // tombstone or change attribution on already-deleted messages.
    await tx.update(chatMessagesTable)
      .set({ deletedAt, deletedBy })
      .where(and(eq(chatMessagesTable.threadId, threadId), eq(chatMessagesTable.userId, userId), isNull(chatMessagesTable.deletedAt)));
    return true;
  });
}

// ── Hard-delete (admin only, for records past retention period) ────────

/**
 * @deprecated Use softDeleteChatThread instead. Retained for GDPR right-to-erasure
 * requests past the retention window (hard delete only after retention period).
 */
export async function deleteChatThread(threadId: number): Promise<void> {
  // First delete related chat messages
  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.threadId, threadId));
  // Then delete the chat thread
  await db.delete(chatThreadsTable).where(eq(chatThreadsTable.id, threadId));
}

/**
 * Update chat thread metadata - used to store pendingApproval and other session state
 */
export async function updateChatThreadMetadata(
  threadId: number, 
  metadata: Record<string, unknown>
): Promise<ChatThreadRecord | undefined> {
  const result = await db
    .update(chatThreadsTable)
    .set({ 
      metadata: metadata,
      updatedAt: new Date() 
    })
    .where(eq(chatThreadsTable.id, threadId))
    .returning();
  return result[0];
}

/**
 * Get chat thread metadata
 */
export async function getChatThreadMetadata(
  threadId: number
): Promise<Record<string, unknown> | null> {
  const result = await db.select({ metadata: chatThreadsTable.metadata })
    .from(chatThreadsTable)
    .where(eq(chatThreadsTable.id, threadId))
    .limit(1);
  return result[0]?.metadata as Record<string, unknown> | null;
}

/**
 * Remove exactly the pending approval the caller resolved. The identity
 * predicate prevents a stale request from clearing a newer pending action.
 */
export async function clearPendingApprovalIfMatches(
  threadId: number,
  userId: number,
  requestId: string,
  toolName: string,
): Promise<boolean> {
  const result = await db.update(chatThreadsTable)
    .set({
      metadata: sql`COALESCE(${chatThreadsTable.metadata}, '{}'::jsonb) - 'pendingApproval'`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(chatThreadsTable.id, threadId),
      eq(chatThreadsTable.userId, userId),
      isNull(chatThreadsTable.deletedAt),
      sql`COALESCE(${chatThreadsTable.metadata} #>> '{pendingApproval,executionId}', ${chatThreadsTable.metadata} #>> '{pendingApproval,toolCallId}') = ${requestId}`,
      sql`${chatThreadsTable.metadata} #>> '{pendingApproval,toolName}' = ${toolName}`,
    ))
    .returning({ id: chatThreadsTable.id });
  return result.length === 1;
}
