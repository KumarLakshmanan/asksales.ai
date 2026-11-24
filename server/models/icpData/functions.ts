import { eq } from "drizzle-orm";
import { db } from "../db";
import { icpProfilesTable, type IcpProfile, type InsertIcpProfile } from "./schema";
import { logger } from '../../utils/logger.js';

export async function createIcpData(data: InsertIcpProfile): Promise<IcpProfile> {
  const [icp] = await db.insert(icpProfilesTable).values(data).returning();
  return icp;
}

export async function getIcpDataById(id: number): Promise<IcpProfile | undefined> {
  const [icp] = await db.select().from(icpProfilesTable).where(eq(icpProfilesTable.id, id));
  return icp;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getIcpDataByWorkflowId(workflowId: string): Promise<IcpProfile | undefined> {
  // Since the new schema doesn't have workflowId, we'll need to find ICP by userId and threadId
  // For now, return undefined as this needs to be handled differently
  // The controllers will need to be updated to use the new schema structure
  logger.warn("getIcpDataByWorkflowId called but workflowId field doesn't exist in new schema");
  return undefined;
}

export async function getIcpProfilesByUserId(userId: number): Promise<IcpProfile[]> {
  return await db.select().from(icpProfilesTable).where(eq(icpProfilesTable.userId, userId));
}

export async function updateIcpData(
  id: number,
  data: Partial<Omit<IcpProfile, "id" | "uuid" | "userId" | "createdAt">>
): Promise<IcpProfile> {
  const [icp] = await db
    .update(icpProfilesTable)
    .set(data)
    .where(eq(icpProfilesTable.id, id))
    .returning();
  return icp;
}

