/**
 * Structured Logger using Pino
 * Replaces console.log/console.error with structured, leveled logging
 * Integrates with OpenTelemetry for trace correlation
 * 
 * Logs are written to:
 * - Console (pino-pretty in development, JSON in production)
 * - server/logs/error.log (error level and above, always)
 * - server/logs/combined.log (all levels, always)
 */

import pino, { type StreamEntry } from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SystemLogDBStream } from '../services/systemLogDBStream.js';
import { redactedLogDestination } from './logRedaction.js';
import { registerLogPersistenceDiagnostics } from '../infrastructure/logPersistenceDiagnostics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const requestedLogLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');
const validLogLevels = new Set<pino.Level>(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const logLevel: pino.Level = validLogLevels.has(requestedLogLevel as pino.Level)
  ? requestedLogLevel as pino.Level
  : isProduction ? 'info' : 'debug';
const fileLoggingEnabled = process.env.FILE_LOGGING_ENABLED === 'true'
  || (isProduction && process.env.FILE_LOGGING_ENABLED !== 'false');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!isTest && fileLoggingEnabled && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function createResilientFileStream(filePath: string) {
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  let reported = false;
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // A logging destination must never take down the API. In particular,
    // ENOSPC used to surface as an uncaught exception and made every module
    // look unavailable even though the database and Redis were healthy.
    if (reported) return;
    reported = true;
    try {
      process.stderr.write(`[Logger] Disabled ${path.basename(filePath)} after write failure (${error.code || 'unknown'}).\n`);
    } catch {
      // stderr can also be unavailable during process shutdown.
    }
  });
  return stream;
}

/**
 * Create the base logger instance with multi-stream support
 * - Console: pretty in dev, JSON in prod
 * - error.log: only error/fatal level
 * - combined.log: all levels
 */

const streams: StreamEntry[] = isTest
  ? [{ level: 'fatal', stream: process.stdout }]
  : (() => {
      const databaseStream = new SystemLogDBStream();
      registerLogPersistenceDiagnostics(databaseStream);
      const runtimeStreams: StreamEntry[] = [
        isProduction
          ? { level: logLevel, stream: process.stdout }
          : {
              level: logLevel,
              stream: pino.transport({
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:HH:MM:ss',
                  ignore: 'pid,hostname,service,env',
                },
              }),
            },
        { level: 'info', stream: databaseStream },
      ];

      if (fileLoggingEnabled) {
        runtimeStreams.push(
          { level: 'error', stream: createResilientFileStream(path.join(logsDir, 'error.log')) },
          { level: logLevel, stream: createResilientFileStream(path.join(logsDir, 'combined.log')) },
        );
      }

      return runtimeStreams;
    })();

export const logger = pino(
  {
    level: isTest ? 'silent' : logLevel,
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
    // Redact sensitive fields
    redact: {
      paths: [
        'email',
        'emailAddress',
        'phone',
        '*.emailAddress',
        'password',
        'apiKey',
        'api_key',
        'token',
        'authorization',
        'cookie',
        'secret',
        '*.password',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.secret',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        '*.apiSecret',
        '*.accessToken',
        '*.refreshToken',
        '*.privateKey',
        '*.clientSecret',
        '*.credentials',
        '*.email',
        '*.phone',
        'error',
        '*.error',
        'err.message',
        'err.stack',
        '*.err.message',
        '*.err.stack',
      ],
      censor: '[REDACTED]',
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redactedLogDestination(pino.multistream(streams as any)),
);

/**
 * Create a child logger with additional context
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createLogger(context: Record<string, any>) {
  return logger.child(context);
}

/**
 * Create a request-scoped logger
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRequestLogger(req: any) {
  return logger.child({
    requestId: req.headers['x-request-id'] || req.id,
    userId: req.user?.id,
    method: req.method,
    url: req.url,
  });
}

/**
 * Agent-specific logger
 */
export function createAgentLogger(agentName: string, userId: number, threadId?: number) {
  return logger.child({
    component: 'agent',
    agent: agentName,
    userId,
    threadId,
  });
}

/**
 * Worker-specific logger
 */
export function createWorkerLogger(workerName: string) {
  return logger.child({
    component: 'worker',
    worker: workerName,
  });
}

/**
 * Queue-specific logger
 */
export function createQueueLogger(queueName: string) {
  return logger.child({
    component: 'queue',
    queue: queueName,
  });
}

export default logger;
