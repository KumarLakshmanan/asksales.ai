/**
 * Health check controller with service status
 */

import { Request, Response } from 'express';
import { getServiceStatus } from '../utils/config';
import { db, pgPool } from '../models/db';
import { logger } from '../utils/logger.js';

/**
 * GET /api/health
 * Basic health check
 */
export async function healthCheck(req: Request, res: Response) {
  try {
    // Test database connection
    let dbHealthy = false;
    try {
      await db.execute('SELECT 1');
      dbHealthy = true;
    } catch (_error) {
      logger.error({ err: _error }, 'Database health check failed');
    }

    const overallHealthy = dbHealthy; // Add other critical service checks as needed

    res.status(overallHealthy ? 200 : 503).json({
      status: overallHealthy ? 'healthy' : 'unhealthy',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Health check error');
    res.status(503).json({
      status: 'unhealthy',
    });
  }
}

/**
 * GET /api/health/detailed
 * Detailed health check with more diagnostics
 */
export async function detailedHealthCheck(req: Request, res: Response) {
  try {
    const services = getServiceStatus();

    // Test database connection and get stats
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dbStatus: { healthy: boolean; latency: number | null; tables: Record<string, number> | any[] } = { healthy: false, latency: null, tables: [] };
    try {
      const start = Date.now();
      await db.execute('SELECT 1');
      const latency = Date.now() - start;

      // Get table counts (simple diagnostics)
      const tables = ['users', 'icp_profiles', 'leads', 'campaigns'];
      const tableStats: Record<string, number> = {};

      for (const table of tables) {
        try {
          const result = await db.execute(`SELECT COUNT(*) as count FROM ${table}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tableStats[table] = parseInt((result.rows[0] as any).count) || 0;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          tableStats[table] = -1; // Indicates error accessing table
        }
      }

      // Connection pool stats
      const poolStats = pgPool
        ? { total: pgPool.totalCount, idle: pgPool.idleCount, waiting: pgPool.waitingCount }
        : null;

      dbStatus = {
        healthy: true,
        latency,
        tables: tableStats,
        ...(poolStats && { pool: poolStats }),
      };
    } catch (error) {
      logger.error({ err: error }, 'Detailed database check failed');
      dbStatus = {
        healthy: false,
        latency: null,
        tables: [],
      };
    }

    // Memory usage
    const memUsage = process.memoryUsage();

    // System info
    const systemInfo = {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      pid: process.pid,
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memUsage.external / 1024 / 1024), // MB
      },
    };

    const overallHealthy = dbStatus.healthy; // Add other critical checks

    res.status(overallHealthy ? 200 : 503).json({
      status: overallHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services,
      database: dbStatus,
      system: systemInfo,
      environment: {
        nodeEnv: process.env.NODE_ENV,
        port: process.env.PORT,
        hasRedis: !!process.env.REDIS_URL,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Detailed health check error');
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
    });
  }
}
