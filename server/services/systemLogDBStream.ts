/**
 * SystemLogDBStream
 * A custom Node.js Writable stream that intercepts Pino log entries and
 * persists error / warn / info records to the `system_logs` PostgreSQL table.
 *
 * This is intentionally resilient:
 *  - All DB failures are silently discarded to prevent log-write feedback loops.
 *  - Only warn and error are stored by default. Routine info lines (job started, job
 *    completed, cron ticks) were ~97% of rows in production (about 20,000 an hour,
 *    36M rows within the 30-day retention). They still reach stdout and the server
 *    journal. Set SYSTEM_LOG_DB_LEVEL=info to store them again, or =error for errors only.
 *  - Writes are fire-and-forget; the stream never blocks the application.
 */

import { Writable } from 'stream';
import type { SystemLogLevel } from '../models/systemLogs/functions';

/** Lowest Pino level written to system_logs, from SYSTEM_LOG_DB_LEVEL (info | warn | error). */
export function persistedMinimumLevel(value = process.env.SYSTEM_LOG_DB_LEVEL): number {
  const level = (value || '').trim().toLowerCase();
  if (level === 'info') return 30;
  if (level === 'error') return 50;
  return 40;
}

// Levels that should be persisted (Pino numeric values)
const PINO_LEVELS: Record<number, SystemLogLevel | null> = {
  10: null,   // trace  — skip
  20: null,   // debug  — skip
  30: 'info', // info
  40: 'warn', // warn
  50: 'error',// error
  60: 'error',// fatal → treated as error
};

export class SystemLogDBStream extends Writable {
  private _buffer: string = '';
  private pendingWrites = 0;
  private droppedWrites = 0;

  constructor(
    private readonly maxPendingWrites = 100,
    private readonly minimumLevel = persistedMinimumLevel(),
  ) {
    super({ decodeStrings: false });
    if (!Number.isInteger(maxPendingWrites) || maxPendingWrites < 1) {
      throw new Error('Log persistence capacity must be a positive integer');
    }
  }

  getDiagnostics() {
    return { pendingWrites: this.pendingWrites, droppedWrites: this.droppedWrites };
  }

  // Called by Pino for each log line (terminated by \n)
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this._buffer += text;

    // May receive multiple newline-separated JSON objects in one chunk
    const lines = this._buffer.split('\n');
    // Keep the last (possibly incomplete) fragment
    this._buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) this._processLine(trimmed);
    }

    callback();
  }

  private _processLine(line: string): void {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Not valid JSON — ignore
    }

    const pinoLevel = typeof entry.level === 'number' ? entry.level : 30;
    const level = PINO_LEVELS[pinoLevel];
    if (!level || pinoLevel < this.minimumLevel) return; // Below the stored level (trace/debug always)

    // Build a human-readable message
    const message =
      typeof entry.msg === 'string'
        ? entry.msg
        : typeof entry.message === 'string'
        ? entry.message
        : String(entry.msg ?? '');

    if (!message) return;

    // Extract optional source from common Pino conventions
    const source =
      typeof entry.service === 'string'
        ? entry.service
        : typeof entry.name === 'string'
        ? entry.name
        : extractSource(message);

    // Extract error stack if present
    let stack: string | undefined;
    const errField = entry.err as Record<string, unknown> | undefined;
    if (errField && typeof errField === 'object') {
      stack = typeof errField.stack === 'string' ? errField.stack : undefined;
    }

    // Build context from remaining meaningful fields
    const context: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(entry)) {
      if (['level', 'time', 'pid', 'hostname', 'msg', 'message', 'v'].includes(key)) continue;
      if (key === 'err' && typeof val === 'object') {
        const e = val as Record<string, unknown>;
        context.errorType = e.type ?? e.name;
        context.errorMessage = e.message;
        continue;
      }
      context[key] = val;
    }

    // Fire-and-forget DB write — import lazily to avoid circular dependency during boot
    this._persistAsync(level, message, source, stack, Object.keys(context).length ? context : undefined);
  }

  private _persistAsync(
    level: SystemLogLevel,
    message: string,
    source: string | undefined,
    stack: string | undefined,
    context: Record<string, unknown> | undefined,
  ): void {
    // DB outages must not build an unbounded queue behind the application pool.
    // This counter contains no log content and is available to future monitoring.
    if (this.pendingWrites >= this.maxPendingWrites) { this.droppedWrites++; return; }
    this.pendingWrites++;
    // Lazy import to avoid DB import before the pool is initialised
    import('../models/systemLogs/functions')
      .then(({ createSystemLog }) =>
        createSystemLog({ level, message, source, stack, context }),
      )
      .catch(() => {
        // Silently swallow — stream must never throw
      })
      .finally(() => { this.pendingWrites--; });
  }
}

/**
 * Attempt to extract a source name from a message string.
 * Many log callers embed "[ControllerName]" or "ServiceName" in the message.
 */
function extractSource(message: string): string | undefined {
  const match = message.match(/\[([A-Za-z]+(?:Controller|Service|Agent|Worker|Engine|Gateway))\]/);
  return match ? match[1] : undefined;
}
