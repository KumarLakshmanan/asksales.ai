import { db } from "../db";
import { leadInputsTable, type LeadInputRecord, type InsertLeadInput } from "./schema";
import { eq, desc, and } from "drizzle-orm";
import { buildReviewedLeadTotals, resolveReviewedLeadTotal } from "./reviewedTotals.js";

export async function createLeadInput(input: InsertLeadInput): Promise<LeadInputRecord> {
  const result = await db.insert(leadInputsTable).values(input).returning();
  return result[0];
}

export async function createLeadInputs(inputs: InsertLeadInput[]): Promise<LeadInputRecord[]> {
  if (inputs.length === 0) return [];
  const result = await db.insert(leadInputsTable).values(inputs).returning();
  return result;
}

export async function getLatestLeadInputsByThreadId(threadId: number): Promise<LeadInputRecord[]> {
  // Get the latest message_id for this thread
  const latestInputs = await db.select()
    .from(leadInputsTable)
    .where(eq(leadInputsTable.threadId, threadId))
    .orderBy(desc(leadInputsTable.createdAt))
    .limit(1);
  
  if (latestInputs.length === 0) return [];
  
  const latestMessageId = latestInputs[0].messageId;
  const latestCreatedAt = latestInputs[0].createdAt;
  
  // If messageId is null, get inputs created around the same time (within 5 seconds)
  // This handles the case where lead inputs were created without a messageId
  if (latestMessageId === null) {
    // Get all inputs from the same batch (created within 5 seconds of the latest)
    const allInputs = await db.select()
      .from(leadInputsTable)
      .where(eq(leadInputsTable.threadId, threadId))
      .orderBy(desc(leadInputsTable.createdAt));
    
    // Group inputs by createdAt (within 5 second window)
    const latestTime = latestCreatedAt.getTime();
    return allInputs.filter((input: LeadInputRecord) => {
      const inputTime = input.createdAt.getTime();
      return Math.abs(inputTime - latestTime) < 5000; // Within 5 seconds
    });
  }
  
  // Get all inputs for that message
  return await db.select()
    .from(leadInputsTable)
    .where(and(
      eq(leadInputsTable.threadId, threadId),
      eq(leadInputsTable.messageId, latestMessageId)
    ))
    .orderBy(desc(leadInputsTable.createdAt));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getLatestLeadInputsForUIByThreadId(threadId: number): Promise<any> {
  // Get the latest inputs for this thread
  const latestInputs = await db.select()
    .from(leadInputsTable)
    .where(eq(leadInputsTable.threadId, threadId))
    .orderBy(desc(leadInputsTable.createdAt))
    .limit(100);

  if (latestInputs.length === 0) return { hasExistingInputs: false, inputs: [] };

  // Return ALL inputs from the latest batch (same messageId or within 5-second window)
  const first = latestInputs[0];
  const latestMessageId = first.messageId;
  const latestTime = first.createdAt.getTime();

  const latestBatch: LeadInputRecord[] = latestMessageId !== null
    ? latestInputs.filter((i: LeadInputRecord) => i.messageId === latestMessageId)
    : latestInputs.filter((i: LeadInputRecord) => Math.abs(i.createdAt.getTime() - latestTime) < 5000);

  // Older retry rows may predate deterministic cap persistence. Recover only
  // an explicitly reviewed total from the same exact workflow's history; never
  // infer a new value from provider fetch parameters such as resultsLimit.
  const reviewedTotals = buildReviewedLeadTotals(latestInputs);

  // Count how many of the same platform exist in the batch for labeling
  const platformCounts: Record<string, number> = {};
  const platformIndexes: Record<string, number> = {};
  for (const input of latestBatch) {
    platformCounts[input.platform] = (platformCounts[input.platform] || 0) + 1;
  }

  const results = latestBatch.map((input: LeadInputRecord) => {
    platformIndexes[input.platform] = (platformIndexes[input.platform] || 0) + 1;
    const count = platformCounts[input.platform];
    const idx = platformIndexes[input.platform];
    const baseName = input.platform.charAt(0).toUpperCase() + input.platform.slice(1).replace(/_/g, ' ');
    return {
      id: input.id,
      platform: input.platform,
      platformDisplay: count > 1 ? `${baseName} (${idx}/${count})` : baseName,
      // The client renders searchIndex + 1, so expose a zero-based index.
      searchIndex: count > 1 ? idx - 1 : undefined,
      totalSearches: count > 1 ? count : undefined,
      inputs: input.inputs,
      actorName: input.actorName,
      category: input.category,
      workflowId: input.workflowId,
      recommendedSubWorkflows: input.recommendedSubWorkflows,
      requestedLeadTotal: resolveReviewedLeadTotal(input, reviewedTotals),
      createdAt: input.createdAt,
    };
  });

  return { hasExistingInputs: true, inputs: results };
}

export async function updateLeadInputByThreadAndPlatform(
  threadId: number,
  userId: number,
  platform: string,
  inputs?: Record<string, unknown>,
  recommendedSubWorkflows?: string[]
): Promise<LeadInputRecord | null> {
  // Get the latest input for this thread and platform
  const latestInputs = await db.select()
    .from(leadInputsTable)
    .where(and(
      eq(leadInputsTable.threadId, threadId),
      eq(leadInputsTable.userId, userId),
      eq(leadInputsTable.platform, platform)
    ))
    .orderBy(desc(leadInputsTable.createdAt))
    .limit(1);
  
  if (latestInputs.length === 0) {
    return null;
  }
  
  // Build update payload
  const updatePayload: Record<string, unknown> = {
    createdAt: new Date(),
  };
  if (inputs !== undefined) {
    updatePayload.inputs = inputs;
  }
  if (recommendedSubWorkflows !== undefined) {
    updatePayload.recommendedSubWorkflows = recommendedSubWorkflows;
  }
  
  // Update the inputs
  const updated = await db.update(leadInputsTable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set(updatePayload as any)
    .where(eq(leadInputsTable.id, latestInputs[0].id))
    .returning();
  
  return updated[0] || null;
}

export async function deleteLeadInputByThreadAndPlatform(
  threadId: number,
  userId: number,
  platform: string
): Promise<boolean> {
  // Delete all inputs for this thread and platform
  const result = await db.delete(leadInputsTable)
    .where(and(
      eq(leadInputsTable.threadId, threadId),
      eq(leadInputsTable.userId, userId),
      eq(leadInputsTable.platform, platform)
    ))
    .returning();

  return result.length > 0;
}

export async function updateLeadInputById(
  id: number,
  threadId: number,
  userId: number,
  inputs?: Record<string, unknown>,
  recommendedSubWorkflows?: string[]
): Promise<LeadInputRecord | null> {
  const updatePayload: Record<string, unknown> = { createdAt: new Date() };
  if (inputs !== undefined) updatePayload.inputs = inputs;
  if (recommendedSubWorkflows !== undefined) updatePayload.recommendedSubWorkflows = recommendedSubWorkflows;

  const updated = await db.update(leadInputsTable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set(updatePayload as any)
    .where(and(
      eq(leadInputsTable.id, id),
      eq(leadInputsTable.threadId, threadId),
      eq(leadInputsTable.userId, userId)
    ))
    .returning();

  return updated[0] || null;
}

export async function deleteLeadInputById(id: number, threadId: number, userId: number): Promise<boolean> {
  const result = await db.delete(leadInputsTable)
    .where(and(
      eq(leadInputsTable.id, id),
      eq(leadInputsTable.threadId, threadId),
      eq(leadInputsTable.userId, userId)
    ))
    .returning();

  return result.length > 0;
}
