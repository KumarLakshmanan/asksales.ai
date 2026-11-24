import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import {
  getLogsByExecutionId,
  getLogsByThreadId,
  getLogsByUserId,
  getExecutionById,
  getExecutionsByUserId,
  pauseExecution,
  resumeExecution,
  cancelExecution,
} from '../models/workflowLogs/functions';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService';
import { db } from '../models/db';
import { scrapingDetailsTable } from '../models/scrapingDetails/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

/**
 * Get workflow logs by execution ID
 */
export async function getWorkflowLogs(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { executionId } = req.params;
  if (!executionId) {
    return res.status(400).json({ error: 'executionId is required' });
  }

  try {
    const logs = await getLogsByExecutionId(executionId);
    return res.json({ success: true, data: logs });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getWorkflowLogs]');
    return res.status(500).json({ error: 'Unable to retrieve workflow logs. Please try again.' });
  }
}

/**
 * Get workflow logs by thread ID
 */
export async function getWorkflowLogsByThread(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { threadId } = req.params;
  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required' });
  }

  try {
    const logs = await getLogsByThreadId(parseInt(threadId));
    return res.json({ success: true, data: logs });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getWorkflowLogsByThread]');
    return res.status(500).json({ error: 'Unable to retrieve workflow logs for this thread. Please try again.' });
  }
}

/**
 * Get all workflow logs for current user
 */
export async function getUserWorkflowLogs(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const logs = await getLogsByUserId(userId, limit, offset);
    return res.json({ success: true, data: logs });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getUserWorkflowLogs]');
    return res.status(500).json({ error: 'Unable to retrieve your workflow logs. Please try again.' });
  }
}

/**
 * Get workflow execution details
 */
export async function getWorkflowExecution(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { executionId } = req.params;
  if (!executionId) {
    return res.status(400).json({ error: 'executionId is required' });
  }

  try {
    const execution = await getExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    return res.json({ success: true, data: execution });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getWorkflowExecution]');
    return res.status(500).json({ error: 'Unable to retrieve the workflow execution details. Please try again.' });
  }
}

/**
 * Get all workflow executions for current user
 */
export async function getUserExecutions(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const executions = await getExecutionsByUserId(userId, limit, offset);
    return res.json({ success: true, data: executions });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getUserExecutions]');
    return res.status(500).json({ error: 'Unable to retrieve your workflow executions. Please try again.' });
  }
}

/**
 * Pause a workflow execution
 */
export async function pauseWorkflowExecution(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { executionId } = req.body;
  if (!executionId) {
    return res.status(400).json({ error: 'executionId is required' });
  }

  try {
    // Verify execution belongs to user
    const execution = await getExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    if (execution.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await pauseExecution(executionId);
    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[pauseWorkflowExecution]');
    return res.status(500).json({ error: 'Unable to pause the workflow execution. Please try again.' });
  }
}

/**
 * Resume a paused workflow execution
 */
export async function resumeWorkflowExecution(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { executionId } = req.body;
  if (!executionId) {
    return res.status(400).json({ error: 'executionId is required' });
  }

  try {
    // Verify execution belongs to user
    const execution = await getExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    if (execution.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await resumeExecution(executionId);
    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[resumeWorkflowExecution]');
    return res.status(500).json({ error: 'Unable to resume the workflow execution. Please try again.' });
  }
}

/**
 * Cancel a workflow execution
 */
export async function cancelWorkflowExecution(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { executionId } = req.body;
  if (!executionId) {
    return res.status(400).json({ error: 'executionId is required' });
  }

  try {
    // Verify execution belongs to user
    const execution = await getExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    if (execution.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // First, mark the execution as cancelled in the database
    const updated = await cancelExecution(executionId);
    
    // Also update scraping details status to 'cancelled' so UI reflects correct state
    // Update by executionId
    await db.update(scrapingDetailsTable)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(scrapingDetailsTable.executionId, executionId));
    
    // Also update by threadId if available (in case executionId wasn't set on all records)
    if (execution.threadId) {
      await db.update(scrapingDetailsTable)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(
          eq(scrapingDetailsTable.threadId, execution.threadId),
          eq(scrapingDetailsTable.status, 'running')
        ));
    }
    
    // Then, abort any running actors for this execution
    await WorkflowExecutorService.abortWorkflowActors(executionId);
    
    return res.json({ success: true, data: updated, message: 'Workflow cancelled and running actors aborted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[cancelWorkflowExecution]');
    return res.status(500).json({ error: 'Unable to cancel the workflow execution. Please try again.' });
  }
}
