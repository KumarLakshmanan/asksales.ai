/**
 * Worker Entry Point
 *
 * Standalone process that runs BullMQ workers independently from the API server.
 * Can be started with: npx tsx server/workers/worker-entry.ts
 *
 * In production, run as a separate container or pm2 process.
 */

import '../env.js';
import http from 'http';
import { startAllWorkers, stopAllWorkers, workersAreReady } from './index.js';
import { readinessHandler } from '../infrastructure/readiness.js';
import { isRedisAvailable } from '../infrastructure/redis.js';
import { pgPool } from '../models/db.js';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { resolveBookingProviderKind } from '../services/booking/providerConfig.js';

let healthServer: http.Server | null = null;
let shuttingDown = false;

// Phase 4.11 / DEPLOY-002: validate env vars at startup. The server process
// does this via `env.ts` but the worker process has its own entry point, so
// we re-check the critical ones here too and fail fast with a clear message.
function validateWorkerEnv(): void {
  const required = [
    'REDIS_URL',
    'DB_USER',
    'DB_PASSWORD',
    'DB_HOST',
  ];
  const optional: Record<string, string> = {
    CHANNEL_AUTH_ENCRYPTION_KEY: process.env.CHANNEL_AUTH_ENCRYPTION_KEY ?? '',
  };
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.length === 0);
  if (!process.env.DB_NAME?.trim() && !process.env.DB_DATABASE?.trim()) missing.push('DB_NAME or DB_DATABASE');
  if (missing.length > 0) {
    logger.error(
      { missing, optionalMissing: Object.entries(optional).filter(([, v]) => !v).map(([k]) => k) },
      '[WorkerEntry] Required env vars missing — aborting startup'
    );
    throw new Error(
      `Worker startup aborted. Missing required env vars: ${missing.join(', ')}. ` +
        `CHANNEL_AUTH_ENCRYPTION_KEY is also required for credential decryption.`
    );
  }
  if (!optional.CHANNEL_AUTH_ENCRYPTION_KEY) {
    throw new Error(
      'CHANNEL_AUTH_ENCRYPTION_KEY must be set for channel credential decryption.'
    );
  }
  resolveBookingProviderKind();
}

async function main() {
  validateWorkerEnv();
  logger.info('[WorkerEntry] Starting worker processes...');

  // Start all workers
  await startAllWorkers();

  logger.info('[WorkerEntry] All workers running. Press Ctrl+C to stop.');

  // Simple health check HTTP server for PM2 monitoring
  const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || '0', 10);
  if (HEALTH_PORT > 0) {
    // Phase 5.4 / QUEUE-008: attach `.on('error', ...)` before `.listen()` so
    // a failed bind (port-in-use, EACCES) is logged instead of swallowed by
    // an unhandled 'error' event crashing the worker.
    const ready = readinessHandler([isRedisAvailable, async () => workersAreReady(), async () => {
      if (!pgPool) return false;
      const query = { text: 'SELECT 1', query_timeout: 1_500 };
      await pgPool.query(query);
      return true;
    }], () => shuttingDown);
    healthServer = http.createServer((req, res) => {
      if (req.url !== '/ready' && req.url !== '/health') { res.writeHead(404); res.end(); return; }
      // Adapt the small JSON response surface without running Express in workers.
      const response = { status(code: number) { res.statusCode = code; return response; },
        json(value: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); } };
      void ready(req as Request, response as Response);
    });
    healthServer.on('error', (err) => {
      logger.error({ err, port: HEALTH_PORT }, '[WorkerEntry] Health check server error');
    });
    healthServer.listen(HEALTH_PORT, () => {
      logger.info({ port: HEALTH_PORT }, '[WorkerEntry] Health check server listening');
    });
  }

  // Graceful shutdown — flush any buffered Langfuse traces before process exits
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '[WorkerEntry] Shutting down workers...');
    const failures: unknown[] = [];
    if (healthServer) {
      try {
        await new Promise<void>((resolve, reject) => {
          healthServer!.close((error) => error ? reject(error) : resolve());
        });
      } catch (err) {
        failures.push(err);
        logger.warn({ err }, '[WorkerEntry] Health server shutdown failed');
      } finally {
        healthServer = null;
      }
    }
    try {
      await stopAllWorkers();
    } catch (err) {
      failures.push(err);
      logger.error({ err }, '[WorkerEntry] Worker shutdown failed');
    }
    // Phase 4.13: stop periodic timers in long-lived singletons.
    try {
      const { ChannelAuthManager } = await import('../services/ChannelAuthManager.js');
      ChannelAuthManager.getInstance().destroy();
    } catch (err) {
      logger.warn({ err }, '[WorkerEntry] ChannelAuthManager dispose failed (skipped)');
    }
    try {
      const { actorHealthMonitor } = await import('../services/ActorHealthMonitor.js');
      actorHealthMonitor.destroy();
    } catch (err) {
      logger.warn({ err }, '[WorkerEntry] ActorHealthMonitor dispose failed (skipped)');
    }
    // Phase 4.12 / DEPLOY-003: flush langfuse trace buffer.
    // (Import lazily so worker-entry can still start if langfuse is unconfigured.)
    try {
      const { shutdownLangfuse } = await import('../infrastructure/langfuse.js');
      await shutdownLangfuse();
    } catch (err) {
      logger.warn({ err }, '[WorkerEntry] Langfuse shutdown skipped or failed');
    }
    try {
      const { closeRedisConnections } = await import('../infrastructure/redis.js');
      await closeRedisConnections();
    } catch (err) {
      failures.push(err);
      logger.warn({ err }, '[WorkerEntry] Redis shutdown failed');
    }
    logger.info({ clean: failures.length === 0 }, '[WorkerEntry] Workers stopped. Exiting.');
    await pgPool?.end();
    process.exitCode = failures.length === 0 ? 0 : 1;
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, '[WorkerEntry] Fatal error');
  process.exit(1);
});
