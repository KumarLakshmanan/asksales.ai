import { db } from "../db";
import { chatSummariesTable, type ChatSummaryRecord, type InsertChatSummary } from "./schema";
 
import { eq, desc } from "drizzle-orm";

export async function createChatSummary(data: InsertChatSummary): Promise<ChatSummaryRecord> {
  const [summary] = await db.insert(chatSummariesTable).values(data).returning();
  return summary;
}

export async function getLatestSummaryByThreadId(threadId: number): Promise<ChatSummaryRecord | undefined> {
  const [summary] = await db
    .select()
    .from(chatSummariesTable)
    .where(eq(chatSummariesTable.threadId, threadId))
    .orderBy(desc(chatSummariesTable.version))
    .limit(1);
  return summary;
}

export async function getSummariesByThreadId(threadId: number): Promise<ChatSummaryRecord[]> {
  return await db
    .select()
    .from(chatSummariesTable)
    .where(eq(chatSummariesTable.threadId, threadId))
    .orderBy(desc(chatSummariesTable.version));
}

