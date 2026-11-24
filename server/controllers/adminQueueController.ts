/**
 * Admin Queue Controller
 * BullMQ queue management: list jobs, retry, remove, pause/resume queues
 */

import type { Request, Response } from 'express';
import type { JobType } from 'bullmq';
import { queueRegistry, QUEUE_NAMES, type QueueName } from '../queues/index.js';
import { logger } from '../utils/logger.js';
import {
  prepareLeadEnrichmentJobRemoval,
  recordFailedLeadEnrichmentJobRemoval,
  releaseRemovedLeadEnrichmentReservation,
} from '../services/enrichment/removedJobReservation.js';
import {
  sanitizeQueueDiagnosticString,
  sanitizeQueueDiagnosticValue,
} from '../utils/queueDiagnostics.js';

const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES);
const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;
const MAX_PAGE_SIZE = 100;

function isValidQueue(name: string): name is QueueName {
  return ALL_QUEUE_NAMES.includes(name as QueueName);
}

function isValidJobId(jobId: string): boolean {
  return /^[A-Za-z0-9:_-]{1,200}$/.test(jobId);
}

function parseBoundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/**
 * GET /api/admin/queues
 * List all queues with job counts
 */
export async function listQueues(_req: Request, res: Response) {
  try {
    const metrics = await queueRegistry.getAllQueueMetrics();
    return res.json({ success: true, data: metrics });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to list queues');
    return res.status(500).json({ error: 'Unable to retrieve queue metrics.' });
  }
}

/**
 * GET /api/admin/queues/:queueName/jobs
 * List jobs for a specific queue (filterable by status)
 */
export async function listQueueJobs(req: Request, res: Response) {
  try {
    const { queueName } = req.params;
    if (!isValidQueue(queueName)) {
      return res.status(400).json({ error: `Invalid queue name: ${queueName}` });
    }

    const status = String(req.query.status || 'all');
    if (status !== 'all' && !JOB_STATES.includes(status as typeof JOB_STATES[number])) {
      return res.status(400).json({ error: 'Invalid job status filter' });
    }
    const start = parseBoundedInteger(req.query.start, 0, 0, 1_000_000);
    if (start === null) return res.status(400).json({ error: 'Invalid pagination start' });
    const requestedEnd = parseBoundedInteger(req.query.end, start + 49, start, 1_000_099);
    if (requestedEnd === null || requestedEnd - start + 1 > MAX_PAGE_SIZE) {
      return res.status(400).json({ error: `Queue job pages are limited to ${MAX_PAGE_SIZE} records` });
    }
    const end = requestedEnd;

    const queue = queueRegistry.getQueue(queueName);

    let types: JobType[];
    if (status === 'all') {
      types = [...JOB_STATES];
    } else {
      types = [status as JobType];
    }

    const [jobs, total] = await Promise.all([
      queue.getJobs(types, start, end),
      queue.getJobCountByTypes(...types),
    ]);

    const mapped = await Promise.all(jobs.map(async (j) => ({
      id: j.id,
      name: j.name,
      status: await j.getState(),
      data: sanitizeQueueDiagnosticValue(j.data),
      opts: {
        attempts: j.opts?.attempts,
        delay: j.opts?.delay,
        priority: j.opts?.priority,
        repeat: j.opts?.repeat,
      },
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason ? sanitizeQueueDiagnosticString(j.failedReason) : null,
      stacktrace: j.stacktrace?.slice(0, 3).map(sanitizeQueueDiagnosticString) || [],
      returnvalue: j.returnvalue == null ? null : sanitizeQueueDiagnosticValue(j.returnvalue),
      timestamp: j.timestamp,
      processedOn: j.processedOn || null,
      finishedOn: j.finishedOn || null,
    })));

    return res.json({
      success: true,
      data: {
        queueName,
        jobs: mapped,
        total,
        start,
        end,
        hasMore: end + 1 < total,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to list jobs');
    return res.status(500).json({ error: 'Unable to retrieve queue jobs.' });
  }
}

/**
 * POST /api/admin/queues/:queueName/jobs/:jobId/retry
 * Retry a failed job
 */
export async function retryJob(req: Request, res: Response) {
  try {
    const { queueName, jobId } = req.params;
    if (!isValidQueue(queueName)) {
      return res.status(400).json({ error: `Invalid queue name: ${queueName}` });
    }
    if (!isValidJobId(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const queue = queueRegistry.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const state = await job.getState();
    if (state !== 'failed') {
      return res.status(409).json({ error: `Only failed jobs can be retried; this job is ${state}` });
    }

    await job.retry();
    logger.info({ queueName, jobId, adminId: req.user?.id }, 'Admin retried job');
    return res.json({ success: true, message: 'Job queued for retry' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to retry job');
    return res.status(500).json({ error: 'Unable to retry job.' });
  }
}

/**
 * DELETE /api/admin/queues/:queueName/jobs/:jobId
 * Remove a job from the queue
 */
export async function removeJob(req: Request, res: Response) {
  try {
    const { queueName, jobId } = req.params;
    if (!isValidQueue(queueName)) {
      return res.status(400).json({ error: `Invalid queue name: ${queueName}` });
    }
    if (!isValidJobId(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const queue = queueRegistry.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const state = await job.getState();
    if (state === 'active') {
      return res.status(409).json({
        error: 'Active jobs cannot be removed safely. Wait for completion or use the workflow-specific cancellation control.',
      });
    }

    // Preserve the fetched job's original reservation before Redis erases it.
    const ticket = queueName === QUEUE_NAMES.LEAD_ENRICHMENT
      ? await prepareLeadEnrichmentJobRemoval({ queueName, jobId, data: job.data })
      : null;
    try {
      await job.remove();
    } catch (removalError) {
      if (ticket) {
        try { await recordFailedLeadEnrichmentJobRemoval(ticket, 'uncertain'); }
        catch (intentError) {
          logger.error({ err: intentError, queueName, jobId, intentId: ticket.intentId, adminId: req.user?.id }, 'Unable to record uncertain job removal');
        }
      }
      throw removalError;
    }
    logger.info({ queueName, jobId, state, adminId: req.user?.id }, 'Admin removed job');
    let cleanup: Awaited<ReturnType<typeof releaseRemovedLeadEnrichmentReservation>> | undefined;
    if (ticket) {
      try {
        cleanup = await releaseRemovedLeadEnrichmentReservation(ticket);
        if (cleanup.status === 'not_removed') {
          return res.status(202).json({ success: true, removed: true, cleanupPending: true,
            intentId: ticket.intentId, message: 'Job removal completed. Reservation cleanup needs reconciliation.' });
        }
      } catch (cleanupError) {
        // Deletion already succeeded. Keep its durable intent and report that
        // financial cleanup is pending rather than claiming deletion failed.
        logger.error({ err: cleanupError, queueName, jobId, intentId: ticket.intentId, adminId: req.user?.id, removed: true }, 'Removed job reservation cleanup pending');
        return res.status(202).json({ success: true, removed: true, cleanupPending: true,
          intentId: ticket.intentId, message: 'Job removed. Reservation cleanup is pending reconciliation.' });
      }
    }
    return res.json({
      success: true,
      removed: true,
      cleanupPending: false,
      ...(cleanup ? { reservationCleanup: cleanup.status } : {}),
      message: cleanup?.status === 'not_releasable'
        ? 'Job removed. Its reservation was not eligible for release.'
        : ['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'].includes(state)
          ? 'Pending job cancelled'
          : 'Job history removed',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to remove job');
    return res.status(500).json({ error: 'Unable to remove job.' });
  }
}

/**
 * POST /api/admin/queues/:queueName/pause
 * Pause a queue
 */
export async function pauseQueue(req: Request, res: Response) {
  try {
    const { queueName } = req.params;
    if (!isValidQueue(queueName)) {
      return res.status(400).json({ error: `Invalid queue name: ${queueName}` });
    }

    const queue = queueRegistry.getQueue(queueName);
    await queue.pause();
    logger.info({ queueName, adminId: req.user?.id }, 'Admin paused queue');
    return res.json({ success: true, message: `Queue "${queueName}" paused` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to pause queue');
    return res.status(500).json({ error: 'Unable to pause queue.' });
  }
}

/**
 * POST /api/admin/queues/:queueName/resume
 * Resume a paused queue
 */
export async function resumeQueue(req: Request, res: Response) {
  try {
    const { queueName } = req.params;
    if (!isValidQueue(queueName)) {
      return res.status(400).json({ error: `Invalid queue name: ${queueName}` });
    }

    const queue = queueRegistry.getQueue(queueName);
    await queue.resume();
    logger.info({ queueName, adminId: req.user?.id }, 'Admin resumed queue');
    return res.json({ success: true, message: `Queue "${queueName}" resumed` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to resume queue');
    return res.status(500).json({ error: 'Unable to resume queue.' });
  }
}

/**
 * POST /api/admin/queues/:queueName/clean
 * Clean completed/failed jobs from a queue
 */
export async function cleanQueue(req: Request, res: Response) {
  try {
    const { queueName } = req.params;
    if (!isValidQueue(queueName)) {
      return res.status(400).json({ error: `Invalid queue name: ${queueName}` });
    }

    const status = String(req.body?.status || 'completed');
    const grace = parseBoundedInteger(req.body?.grace, 0, 0, 30 * 24 * 60 * 60 * 1000);

    if (!['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "completed" or "failed"' });
    }
    if (grace === null) return res.status(400).json({ error: 'Invalid cleanup grace period' });

    const queue = queueRegistry.getQueue(queueName);
    const removed = await queue.clean(grace, 1000, status as 'completed' | 'failed');
    logger.info({ queueName, status, removed: removed.length, adminId: req.user?.id }, 'Admin cleaned queue');
    return res.json({ success: true, message: `Cleaned ${removed.length} ${status} jobs`, removed: removed.length });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminQueue] Failed to clean queue');
    return res.status(500).json({ error: 'Unable to clean queue.' });
  }
}
