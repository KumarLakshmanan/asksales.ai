import { db } from "../db";
import { workflowLogs, workflowActivityExecutions, type NewWorkflowLog, type NewWorkflowActivityExecution, type WorkflowLog, type WorkflowActivityExecution } from "./schema";
import { eq, desc } from "drizzle-orm";

/**
 * Create a new workflow log entry
 */
export async function createWorkflowLog(data: NewWorkflowLog): Promise<WorkflowLog> {
  const [log] = await db.insert(workflowLogs).values(data).returning();
  return log;
}

/**
 * Get all logs for an execution
 */
export async function getLogsByExecutionId(executionId: string): Promise<WorkflowLog[]> {
  return db
    .select()
    .from(workflowLogs)
    .where(eq(workflowLogs.executionId, executionId))
    .orderBy(workflowLogs.createdAt);
}

/**
 * Get logs by thread ID with pagination
 */
export async function getLogsByThreadId(
  threadId: number,
  limit = 100,
  offset = 0
): Promise<WorkflowLog[]> {
  return db
    .select()
    .from(workflowLogs)
    .where(eq(workflowLogs.threadId, threadId))
    .orderBy(desc(workflowLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get logs by user ID with pagination
 */
export async function getLogsByUserId(
  userId: number,
  limit = 100,
  offset = 0
): Promise<WorkflowLog[]> {
  return db
    .select()
    .from(workflowLogs)
    .where(eq(workflowLogs.userId, userId))
    .orderBy(desc(workflowLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Create a new workflow execution
 */
export async function createWorkflowExecution(data: NewWorkflowActivityExecution): Promise<WorkflowActivityExecution> {
  const [execution] = await db.insert(workflowActivityExecutions).values(data).returning();
  return execution;
}

/**
 * Update a workflow execution
 */
export async function updateWorkflowExecution(
  executionId: string,
  updates: Partial<NewWorkflowActivityExecution>
): Promise<WorkflowActivityExecution | null> {
  const [execution] = await db
    .update(workflowActivityExecutions)
    .set(updates)
    .where(eq(workflowActivityExecutions.executionId, executionId))
    .returning();
  return execution || null;
}

/**
 * Get workflow execution by execution ID
 */
export async function getWorkflowExecutionById(executionId: string): Promise<WorkflowActivityExecution | null> {
  const [execution] = await db
    .select()
    .from(workflowActivityExecutions)
    .where(eq(workflowActivityExecutions.executionId, executionId))
    .limit(1);
  return execution || null;
}

/**
 * Get all executions for a user with pagination
 */
export async function getExecutionsByUserId(
  userId: number,
  limit = 50,
  offset = 0
): Promise<WorkflowActivityExecution[]> {
  return db
    .select()
    .from(workflowActivityExecutions)
    .where(eq(workflowActivityExecutions.userId, userId))
    .orderBy(desc(workflowActivityExecutions.startedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get execution by ID (alias for getWorkflowExecutionById)
 */
export async function getExecutionById(executionId: string): Promise<WorkflowActivityExecution | null> {
  return getWorkflowExecutionById(executionId);
}

/**
 * Mark execution as paused
 */
export async function pauseExecution(executionId: string): Promise<WorkflowActivityExecution | null> {
  return updateWorkflowExecution(executionId, {
    isPaused: true,
    pausedAt: new Date(),
    status: 'paused'
  });
}

/**
 * Mark execution as resumed
 */
export async function resumeExecution(executionId: string): Promise<WorkflowActivityExecution | null> {
  return updateWorkflowExecution(executionId, {
    isPaused: false,
    resumedAt: new Date(),
    status: 'running'
  });
}

/**
 * Mark execution as completed
 */
export async function completeExecution(
  executionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>,
  totalLeadsGenerated: number
): Promise<WorkflowActivityExecution | null> {
  return updateWorkflowExecution(executionId, {
    status: 'completed',
    completedAt: new Date(),
    result,
    totalLeadsGenerated
  });
}

/**
 * Mark execution as failed
 */
export async function failExecution(
  executionId: string,
  errorMessage: string
): Promise<WorkflowActivityExecution | null> {
  return updateWorkflowExecution(executionId, {
    status: 'error',
    completedAt: new Date(),
    errorMessage
  });
}

/**
 * Update lead count for an execution
 */
export async function updateExecutionLeadCount(
  executionId: string,
  leadsGenerated: number,
  platformsCompleted?: number
): Promise<WorkflowActivityExecution | null> {
  const updates: Partial<NewWorkflowActivityExecution> = {
    totalLeadsGenerated: leadsGenerated
  };
  if (platformsCompleted !== undefined) {
    updates.platformsCompleted = platformsCompleted;
  }
  return updateWorkflowExecution(executionId, updates);
}

/**
 * Update lead counts (add to existing count)
 */
export async function updateExecutionLeadCounts(
  executionId: string,
  additionalLeads: number
): Promise<WorkflowActivityExecution | null> {
  const execution = await getWorkflowExecutionById(executionId);
  if (!execution) return null;
  
  const newCount = (execution.totalLeadsGenerated || 0) + additionalLeads;
  return updateExecutionLeadCount(executionId, newCount);
}

/**
 * Cancel execution
 */
export async function cancelExecution(executionId: string): Promise<WorkflowActivityExecution | null> {
  return updateWorkflowExecution(executionId, {
    status: 'cancelled',
    completedAt: new Date(),
  });
}

