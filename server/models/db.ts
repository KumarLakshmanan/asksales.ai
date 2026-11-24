import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, defaults as pgDefaults, types as pgTypes } from "pg";
import { logger } from '../utils/logger.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';

// PostgreSQL OID 1114 (`timestamp without time zone`) is used throughout this
// repository for UTC application timestamps. node-postgres otherwise parses
// it in the host's local timezone, which can make fresh analytics appear stale
// on non-UTC hosts. Preserve the schema's UTC convention at the driver boundary.
pgTypes.setTypeParser(1114, (value) => new Date(`${value}Z`));
pgDefaults.parseInputDatesAsUTC = true;

// Match the migration runner: an explicitly supplied DB_NAME must win over a
// legacy DB_DATABASE value loaded from local environment files.
const resolvedDbName = process.env.DB_NAME || process.env.DB_DATABASE;

const TRANSIENT_CONNECTION_ERROR =
  /connection timeout|Connection terminated|ECONNREFUSED|ECONNRESET|ETIMEDOUT|the database system is starting up/i;

/**
 * The first query runs while the rest of the app is still being loaded. On a busy host
 * that module loading can hold the event loop past the connect timeout, so the
 * handshake is abandoned even though PostgreSQL is healthy. Retry connection failures
 * a few times; schema problems are not retried and still stop startup.
 */
export async function withStartupConnectionRetry<T>(
  work: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? `${error.message} ${(error.cause as Error | undefined)?.message || ''}` : String(error);
      if (attempt >= attempts || !TRANSIENT_CONNECTION_ERROR.test(message)) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn({ attempt, delayMs: delay, err: message }, '[DB] Startup connection failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
const runningUnderTest = process.env.NODE_ENV === 'test'
  || Boolean(process.env.JEST_WORKER_ID)
  || process.argv.some((argument) => argument.includes('/jest'));

// Database connection
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
// Pool exposed for health checks — undefined in test environments
let pgPool: Pool | undefined;

if (runningUnderTest || process.env.SKIP_DB === 'true') {
  // Provide a minimal fake db object to let tests mock individual methods.
  db = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_q?: any) => ({ rows: [] }),
    // Simple chainable stubs for select/from/where/limit
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => []
        })
      })
    }),
    // Insert with values and returning stub
    insert: () => ({
      values: () => ({
        returning: async () => [],
        onConflictDoNothing: async () => [],
      })
    }),
    // Update chain stub returning empty rows
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    delete: () => ({ where: () => ({}) }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: async (callback: (tx: any) => Promise<any>) => callback(db),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
} else {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: resolvedDbName,
    ssl: process.env.DB_SSL === 'true',
    // Force UTC session timezone so CURRENT_TIMESTAMP returns UTC values
    // and TIMESTAMP WITHOUT TIME ZONE columns are correctly interpreted
    options: '-c timezone=UTC',
    // Connection pool optimizations
    max: parseInt(process.env.DB_POOL_SIZE || '10'), // Maximum pool size (reduced to limit reconnect overhead)
    min: parseInt(process.env.DB_POOL_MIN || '2'),   // Minimum pool size
    idleTimeoutMillis: 600000,                       // Keep idle connections alive for 10 minutes (avoid per-cron reconnect bursts)
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000'), // Connection timeout (default 5 seconds)
    keepAlive: true,                                 // TCP keepalive to prevent NAT/firewall drops
    keepAliveInitialDelayMillis: 10000,
  });
  
  pool.on('error', (err: Error) => {
    logger.error({ err: err.message }, '[DB Pool] Unexpected error on idle client:');
  });
  
  // db = drizzle(pool, { logger: true });
  await withStartupConnectionRetry(() => assertBusinessScopeSchema(pool));
  const scopedPool = createBusinessScopedPool(pool);
  db = drizzle(scopedPool);
  pgPool = scopedPool;
}

export { db, pgPool };
