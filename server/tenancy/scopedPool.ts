import type { Pool, PoolClient, QueryConfig } from 'pg';
import { currentBillingScope, type BillingScope } from './billingContext.js';
import { currentDatabaseScope, type DatabaseScope } from './businessContext.js';
import { effectiveStatementTimeoutMs, idleInTransactionTimeoutMs } from './statementTimeout.js';
import { noteDatabaseFailure } from './databaseAvailability.js';
import { logger } from '../utils/logger.js';

// All application SQL passes through this adapter. Each checkout captures its
// scope once; later async-context changes cannot retarget an open transaction.
// The login may own the schema (or be a local superuser), but application SQL
// always runs as this unprivileged role. Migration 299 creates and grants it.
const RUNTIME_ROLE = 'salesmarketing_business_runtime';
type QueryArgs = [string | QueryConfig, unknown[]?];

// One round trip sets the role, the time limits and the scope. Every standalone
// query used to spend three round trips here while holding a pooled
// connection. set_config('role', ..., true) is SET LOCAL ROLE: the same
// membership check applies and it ends with the transaction.
//
// Every transaction gets a finite statement_timeout (see statementTimeout.ts:
// 25 s inside API requests, a longer background bound everywhere else) and an
// idle_in_transaction_session_timeout, so neither a slow query nor a leaked
// open transaction can hold a pooled connection indefinitely.
//
// JIT is off for application SQL. These are short interactive and background
// queries over one business's rows; compiling them never pays off, while a
// high planner estimate (wide CTE reports, or a disabled join method) makes
// PostgreSQL JIT-compile and inline hundreds of expressions per execution.
// The campaign report spent 19 s of a 19.1 s request compiling a 17 ms query,
// and the CRM work queue of the largest business already plans with JIT.
const CONFIGURE = `SELECT set_config('role', $1, true),
    set_config('app.business_profile_id', $2, true),
    set_config('app.current_user_id', $3, true),
    set_config('app.business_system', $4, true),
    set_config('app.knowledge_admin', $4, true),
    set_config('app.billing_organization_id', $5, true),
    set_config('app.billing_actor_user_id', $6, true),
    set_config('app.business_actor_user_id', $7, true),
    set_config('statement_timeout', $8, true),
    set_config('idle_in_transaction_session_timeout', $9, true),
    set_config('jit', 'off', true)`;

interface Limits { statementMs: number; idleInTransactionMs: number }

async function configure(client: PoolClient, scope: DatabaseScope | undefined, billing: Readonly<BillingScope> | undefined, limits: Limits) {
  await client.query(CONFIGURE, [
    RUNTIME_ROLE,
    scope?.kind === 'business' ? String(scope.businessProfileId) : '',
    scope?.kind === 'business' ? String(scope.userId) : '',
    scope?.kind === 'system' ? 'on' : 'off',
    billing ? String(billing.organizationId) : '',
    billing ? String(billing.actorUserId) : '',
    scope?.kind === 'business' ? String(scope.actorUserId ?? scope.userId) : '',
    `${limits.statementMs}ms`,
    `${limits.idleInTransactionMs}ms`,
  ]);
}

export function createBusinessScopedPool(pool: Pool): Pool {
  const checkout = async () => {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      noteDatabaseFailure(error);
      throw error;
    }
    // PostgreSQL ends a session that sits idle inside a transaction too long
    // (idle_in_transaction_session_timeout) or is terminated by an operator.
    // node-postgres reports that as an 'error' event on the checked-out
    // client; the pool only listens while the client is idle, and an
    // unhandled 'error' event would reach uncaughtException and exit the
    // process. The next query on this client fails and releases it.
    const onClientError = (error: Error) => {
      noteDatabaseFailure(error);
      logger.warn({ err: error.message, code: (error as { code?: unknown }).code }, '[DB] Checked-out connection ended');
    };
    const listens = typeof client.on === 'function';
    if (listens) client.on('error', onClientError);
    const releaseClient = (argument?: Error | boolean) => {
      if (listens) client.removeListener('error', onClientError);
      client.release(argument);
    };
    const scope = currentDatabaseScope();
    const billing = currentBillingScope();
    // Captured at checkout like the scope: the bound of the code that asked
    // for the connection, or the background bound when there is none.
    const limits: Limits = { statementMs: effectiveStatementTimeoutMs(), idleInTransactionMs: idleInTransactionTimeoutMs() };
    let inTransaction = false;
    let released = false;
    // A connection dropped mid-request is an availability failure too.
    const execute = (...args: QueryArgs) => run(...args).catch((error: unknown) => {
      noteDatabaseFailure(error);
      throw error;
    });
    const run = async (...args: QueryArgs) => {
      if (released) throw new Error('Database client has been released');
      const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/^\s*(?:begin|start\s+transaction)\b/i.test(statement)) {
        if (inTransaction) throw new Error('Transaction is already open');
        try {
          const result = await client.query(...args);
          inTransaction = true;
          await configure(client, scope, billing, limits);
          return result;
        } catch (error) {
          // Drizzle starts BEGIN outside its own try/finally. A setup failure
          // must release here or it permanently consumes a pool connection.
          try { await client.query('ROLLBACK'); } finally { released = true; releaseClient(true); }
          throw error;
        }
      }
      if (inTransaction) {
        const result = await client.query(...args);
        if (/^\s*(?:commit|end|rollback(?!\s+to))\b/i.test(statement)) inTransaction = false;
        return result;
      }
      await client.query('BEGIN');
      try {
        await configure(client, scope, billing, limits);
        const result = await client.query(...args);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { releaseClient(true); released = true; }
        throw error;
      }
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') return execute;
        if (property === 'release') return (error?: Error | boolean) => {
          if (!released) { released = true; releaseClient(inTransaction ? true : error); }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') return checkout;
      if (property === 'query') return async (...args: QueryArgs) => {
        const client = await checkout();
        try { return await client.query(...args); } finally { client.release(); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
