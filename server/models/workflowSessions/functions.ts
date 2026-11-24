import { eq, desc } from "drizzle-orm";
import { logger } from '../../utils/logger.js';
import { db } from "../db";
import { workflowSessionsTable, type WorkflowSession, type InsertWorkflowSession } from "./schema";

export async function createWorkflowSession(data: InsertWorkflowSession): Promise<WorkflowSession> {
  try {
    logger.info({ data: data }, '[WorkflowSession] Creating with data:');
    const [session] = await db.insert(workflowSessionsTable).values(data).returning();
    logger.info({ data: session }, '[WorkflowSession] Created:');
    return session;
  } catch (error) {
    logger.error({ err: error }, '[WorkflowSession] Error creating session:');
    throw error;
  }
}

export async function getWorkflowSessionById(id: string): Promise<WorkflowSession | undefined> {
  const [session] = await db.select().from(workflowSessionsTable).where(eq(workflowSessionsTable.id, id));
  return session;
}

export async function getWorkflowSessionsByUserId(userId: number): Promise<WorkflowSession[]> {
  return db
    .select()
    .from(workflowSessionsTable)
    .where(eq(workflowSessionsTable.userId, userId))
    .orderBy(desc(workflowSessionsTable.createdAt));
}

export async function updateWorkflowSession(
  id: string,
  data: Partial<Omit<WorkflowSession, "id" | "userId" | "createdAt">>
): Promise<WorkflowSession> {
  const [session] = await db
    .update(workflowSessionsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(workflowSessionsTable.id, id))
    .returning();
  return session;
}

