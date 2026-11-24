import { db } from "../db.js";
import { handoffQueueTable } from "./schema.js";
import { eq, and, sql } from "drizzle-orm";

export async function getOwnedHandoffQueueById(userId: number, id: number) {
  const result = await db.select().from(handoffQueueTable).where(and(
    eq(handoffQueueTable.id, id),
    eq(handoffQueueTable.userId, userId),
  ));
  return result[0] || null;
}

export async function getHandoffQueueByConversation(userId: number, conversationId: number) {
  const result = await db.execute(sql`
    SELECT * FROM handoff_queue
    WHERE user_id = ${userId}
      AND conversation_id = ${conversationId}
    ORDER BY created_at DESC
  `);
  return result.rows.map((raw: Record<string, unknown>) => Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      value,
    ]),
  )) as Array<typeof handoffQueueTable.$inferSelect>;
}

export async function updateHandoffQueue(userId: number, id: number, updates: Partial<typeof handoffQueueTable.$inferInsert>) {
  const result = await db
    .update(handoffQueueTable)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(and(
      eq(handoffQueueTable.id, id),
      eq(handoffQueueTable.userId, userId),
    ))
    .returning();
  return result[0];
}
