/**
 * Queue Bridge — Connects LangGraph tool executors to BullMQ job queues
 * 
 * This module provides the missing link between:
 *   - LangGraph tool executors (which need synchronous tool results)
 *   - BullMQ job queues (which process asynchronously in workers)
 * 
 * For long-running operations (image/video generation, web scraping, outreach sending),
 * it dispatches to the queue and waits for completion via EventBus.
 * For fast operations (ICP gen, content text gen), it falls back to direct execution.
 * 
 * Architecture: Executor → QueueBridge.dispatchAndWait() → JobDispatcher → BullMQ → Worker → EventBus → resolve
 */

import { jobDispatcher, type DispatchResult } from '../../queues/JobDispatcher.js';
import { queueRegistry } from '../../queues/index.js';
import { logger } from '../../utils/logger.js';
import type { ToolContext } from './toolRegistry';
import type { ToolResult } from '../state';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface QueueBridgeOptions {
  /** Maximum time to wait for a queued job result (ms). Default: 5 minutes */
  timeout?: number;
  /** Priority level (1=highest). Default: 0 (normal) */
  priority?: number;
  /** Delay before processing (ms). Default: 0 */
  delay?: number;
}

// Tools that should be dispatched to queues (long-running operations)
const QUEUE_ELIGIBLE_TOOLS = new Set([
  'generate_image',
  'generate_video',
]);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Queue Bridge ───────────────────────────────────────────────────────────────

/**
 * Determine if a tool should be dispatched to a queue
 */
export function shouldUseQueue(toolName: string): boolean {
  return QUEUE_ELIGIBLE_TOOLS.has(toolName) && jobDispatcher.isQueueEnabled();
}

/**
 * Dispatch a tool call to BullMQ and wait for the result via EventBus.
 * Direct mode is selected before dispatch. A failed/uncertain queue attempt
 * must never be repeated inline or reinterpret an authority denial.
 * 
 * @param toolName - The tool being executed
 * @param payload - Job payload data
 * @param context - LangGraph tool context (userId, threadId, etc.)
 * @param directExecutor - Fallback function for direct inline execution
 * @param options - Queue options (timeout, priority, delay)
 * @returns ToolResult from either queue worker or direct execution
 */
export async function dispatchAndWait(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>,
  context: ToolContext,
  directExecutor: () => Promise<ToolResult>,
  options: QueueBridgeOptions = {}
): Promise<ToolResult> {
  const { timeout = DEFAULT_TIMEOUT_MS, priority, delay } = options;

  // If queue dispatch isn't available or tool isn't queue-eligible, execute directly
  if (!shouldUseQueue(toolName)) {
    logger.info({ toolName }, '[QueueBridge] Direct execution (not queue-eligible or Redis unavailable)');
    return directExecutor();
  }

  const userIdNum = typeof context.userId === 'string' ? parseInt(context.userId, 10) : context.userId;
  const threadIdNum = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) : context.threadId;

  try {
    // Dispatch to the queue
    const dispatchResult: DispatchResult = await jobDispatcher.dispatch(toolName, {
      userId: userIdNum,
      threadId: threadIdNum,
      workflowId: context.workflowId,
      ...payload,
    }, { priority, delay });

    // Queue-based execution: wait for result via EventBus
    logger.info({
      toolName,
      queue: dispatchResult.queue,
      jobId: dispatchResult.jobId,
      correlationId: dispatchResult.correlationId,
    }, '[QueueBridge] Job dispatched, waiting for result');

    return await waitForJobResult(toolName, dispatchResult, timeout);

  } catch (error) {
    logger.error({ toolName, err: error }, '[QueueBridge] Dispatch was rejected or its outcome is uncertain');
    // Capture may have denied authority, or Redis may have persisted the job
    // before its acknowledgement was lost. Preserve the original error/code;
    // neither case authorizes a new inline provider effect.
    throw error;
  }
}

/**
 * Wait for BullMQ's durable job result. This remains correct even when a worker
 * finishes between enqueue and listener setup, unlike a transient Pub/Sub wait.
 */
async function waitForJobResult(
  toolName: string,
  dispatchResult: DispatchResult,
  timeout: number
): Promise<ToolResult> {
  try {
    const output = await queueRegistry.waitForJobResult(
      dispatchResult.queue,
      dispatchResult.jobId,
      timeout,
    );
    logger.info({ toolName, jobId: dispatchResult.jobId }, '[QueueBridge] BullMQ job completed');
    return { success: true, toolName, output };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const timedOut = /timed out/i.test(error?.message || '');
    logger.error(
      { toolName, jobId: dispatchResult.jobId, error: error?.message },
      timedOut ? '[QueueBridge] BullMQ job timed out' : '[QueueBridge] BullMQ job failed',
    );
    return {
      success: false,
      toolName,
      error: timedOut
        ? `Tool execution timed out after ${timeout / 1000}s. The operation may still be processing in the background.`
        : error?.message || 'Job execution failed in worker',
    };
  }
}

