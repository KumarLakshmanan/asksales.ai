import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { scrapingProgressTable, type ScrapingProgress, type InsertScrapingProgress } from "./schema";

export async function createMultipleScrapingProgress(dataArray: InsertScrapingProgress[]): Promise<ScrapingProgress[]> {
  return db.insert(scrapingProgressTable).values(dataArray).returning();
}

export async function getScrapingProgressByWorkflowId(workflowId: string): Promise<ScrapingProgress[]> {
  return db.select().from(scrapingProgressTable).where(eq(scrapingProgressTable.workflowId, workflowId));
}

export async function updateScrapingProgressByWorkflowAndChannel(
  workflowId: string,
  channelName: string,
  data: Partial<Omit<ScrapingProgress, "id" | "workflowId" | "channelName" | "createdAt">>
): Promise<ScrapingProgress> {
  const [progress] = await db
    .update(scrapingProgressTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(scrapingProgressTable.workflowId, workflowId), eq(scrapingProgressTable.channelName, channelName)))
    .returning();
  return progress;
}

