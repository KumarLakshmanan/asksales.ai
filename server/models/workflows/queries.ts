import { db } from "../db";
import { workflows, workflowExecutions, type Workflow, type NewWorkflow, type WorkflowExecution, type NewWorkflowExecution } from "./schema";
 
import { eq, desc } from "drizzle-orm";

// Workflow CRUD operations
export async function createWorkflow(workflow: NewWorkflow): Promise<Workflow> {
  const [newWorkflow] = await db.insert(workflows).values(workflow).returning();
  return newWorkflow;
}

export async function getWorkflowById(id: number): Promise<Workflow | undefined> {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return workflow;
}

export async function getWorkflowsByUserId(userId: number): Promise<Workflow[]> {
  return await db.select().from(workflows).where(eq(workflows.userId, userId)).orderBy(desc(workflows.updatedAt));
}

export async function updateWorkflow(id: number, updates: Partial<NewWorkflow>): Promise<Workflow | undefined> {
  const [updated] = await db
    .update(workflows)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(workflows.id, id))
    .returning();
  return updated;
}

export async function deleteWorkflow(id: number): Promise<boolean> {
  const result = await db.delete(workflows).where(eq(workflows.id, id));
  return result.rowCount !== null && result.rowCount > 0;
}

// Workflow Execution operations
export async function createWorkflowExecution(execution: NewWorkflowExecution): Promise<WorkflowExecution> {
  const [newExecution] = await db.insert(workflowExecutions).values(execution).returning();
  return newExecution;
}

export async function getWorkflowExecutionById(id: number): Promise<WorkflowExecution | undefined> {
  const [execution] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).limit(1);
  return execution;
}

export async function getWorkflowExecutions(workflowId: number): Promise<WorkflowExecution[]> {
  return await db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId))
    .orderBy(desc(workflowExecutions.startedAt));
}

export async function updateWorkflowExecution(
  id: number,
  updates: Partial<NewWorkflowExecution>
): Promise<WorkflowExecution | undefined> {
  const [updated] = await db.update(workflowExecutions).set(updates).where(eq(workflowExecutions.id, id)).returning();
  return updated;
}

export async function getUserWorkflowExecutions(userId: number): Promise<WorkflowExecution[]> {
  return await db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.userId, userId))
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(50);
}
