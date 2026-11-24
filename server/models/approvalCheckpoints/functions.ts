import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import { approvalCheckpointsTable, type ApprovalCheckpoint } from "./schema";

export async function getApprovalCheckpointById(id: string): Promise<ApprovalCheckpoint | undefined> {
  const [checkpoint] = await db.select().from(approvalCheckpointsTable).where(eq(approvalCheckpointsTable.id, id));
  return checkpoint;
}

export async function getApprovalCheckpointsByWorkflowId(workflowId: string): Promise<ApprovalCheckpoint[]> {
  return db
    .select()
    .from(approvalCheckpointsTable)
    .where(eq(approvalCheckpointsTable.workflowId, workflowId))
    .orderBy(desc(approvalCheckpointsTable.createdAt));
}

export async function updateApprovalCheckpoint(
  id: string,
  data: Partial<Omit<ApprovalCheckpoint, "id" | "workflowId" | "createdAt">>
): Promise<ApprovalCheckpoint> {
  const [checkpoint] = await db
    .update(approvalCheckpointsTable)
    .set({ ...data, decidedAt: data.userDecision ? new Date() : undefined })
    .where(eq(approvalCheckpointsTable.id, id))
    .returning();
  return checkpoint;
}

