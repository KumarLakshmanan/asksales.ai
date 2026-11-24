import { db } from "../db";
import { scrapingDetailsTable, type ScrapingDetailRecord, type InsertScrapingDetail } from "./schema";
import { eq, desc, and } from "drizzle-orm";

export async function createScrapingDetail(detail: InsertScrapingDetail): Promise<ScrapingDetailRecord> {
  const result = await db.insert(scrapingDetailsTable).values(detail).returning();
  return result[0];
}

export async function updateScrapingDetailByExecutionAndPlatform(
  executionId: string,
  platform: string,
  updates: Partial<Omit<ScrapingDetailRecord, 'id' | 'createdAt'>>
): Promise<ScrapingDetailRecord | null> {
  const result = await db.update(scrapingDetailsTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(
      eq(scrapingDetailsTable.executionId, executionId),
      eq(scrapingDetailsTable.platform, platform)
    ))
    .returning();
  return result[0] || null;
}

export async function getLatestScrapingDetailsByThreadId(threadId: number): Promise<ScrapingDetailRecord[]> {
  // Get the latest message_id for this thread
  const latestDetails = await db.select()
    .from(scrapingDetailsTable)
    .where(eq(scrapingDetailsTable.threadId, threadId))
    .orderBy(desc(scrapingDetailsTable.createdAt))
    .limit(1);
  
  if (latestDetails.length === 0) return [];
  
  const latestMessageId = latestDetails[0].messageId;
  
  // Get all details for that message
  return await db.select()
    .from(scrapingDetailsTable)
    .where(and(
      eq(scrapingDetailsTable.threadId, threadId),
      eq(scrapingDetailsTable.messageId, latestMessageId)
    ))
    .orderBy(desc(scrapingDetailsTable.updatedAt));
}

export async function getScrapingDetailsByExecutionId(executionId: string): Promise<ScrapingDetailRecord[]> {
  return await db.select()
    .from(scrapingDetailsTable)
    .where(eq(scrapingDetailsTable.executionId, executionId))
    .orderBy(desc(scrapingDetailsTable.updatedAt));
}

