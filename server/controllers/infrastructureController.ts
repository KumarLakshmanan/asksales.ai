/**
 * Infrastructure Dashboard Controller
 * Provides queue metrics, worker status, and system health for admin panel
 * Architecture V2: Observable infrastructure
 */

import type { Request, Response } from 'express';
import { queueRegistry } from '../queues/index.js';
import { isRedisAvailable } from '../infrastructure/redis.js';
import { logger } from '../utils/logger.js';
import { pgPool } from '../models/db.js';
import { dependenciesReady } from '../infrastructure/readiness.js';
import { getLogPersistenceDiagnostics } from '../infrastructure/logPersistenceDiagnostics.js';

async function observeDependencies() {
  const [redis, database] = await Promise.all([
    dependenciesReady([isRedisAvailable]),
    dependenciesReady([async () => {
      if (!pgPool) return false;
      const query = { text: 'SELECT 1', query_timeout: 1_500 };
      await pgPool.query(query);
      return true;
    }]),
  ]);
  return { redis, database, status: redis && database ? 'healthy' : 'unhealthy' };
}

/**
 * GET /api/admin/infrastructure/status
 * Overall infrastructure status
 */
export async function getInfrastructureStatus(req: Request, res: Response) {
  try {
    const observed = await observeDependencies();
    const status = {
      mode: 'distributed',
      status: observed.status,
      redis: observed.redis ? 'connected' : 'disconnected',
      database: observed.database ? 'connected' : 'disconnected',
      // This API process cannot attest to consumers running in other processes.
      queues: 'unknown',
      workers: 'unknown',
      eventBus: 'unknown',
      timestamp: new Date().toISOString(),
    };

    return res.json({ success: true, data: status });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[InfraController] Failed to get status');
    return res.status(500).json({ error: 'Unable to retrieve infrastructure status. Please try again.' });
  }
}

/**
 * GET /api/admin/infrastructure/queues
 * Queue metrics for all registered queues
 */
export async function getQueueMetrics(req: Request, res: Response) {
  try {
    const metrics = await queueRegistry.getAllQueueMetrics();
    return res.json({ success: true, data: { available: true, queues: metrics } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[InfraController] Failed to get queue metrics');
    return res.status(500).json({ error: 'Unable to retrieve queue metrics. Please try again.' });
  }
}

/**
 * GET /api/admin/infrastructure/health
 * Detailed health check
 */
export async function getDetailedHealth(req: Request, res: Response) {
  try {
    const observed = await observeDependencies();
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();

    const health = {
      status: observed.status,
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      uptimeSeconds: uptime,
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)} MB`,
      },
      redis: observed.redis,
      database: observed.database,
      // These counters cover this API process, not external worker processes.
      logPersistence: getLogPersistenceDiagnostics(),
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
    };

    return res.json({ success: true, data: health });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[InfraController] Failed to get health');
    return res.status(500).json({ error: 'Unable to retrieve health details. Please try again.' });
  }
}
