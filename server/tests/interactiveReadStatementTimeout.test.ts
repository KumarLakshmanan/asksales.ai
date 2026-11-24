import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import {
  DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_INTERACTIVE_READ_TIMEOUT_MS,
  DEFAULT_LONG_REQUEST_TIMEOUT_MS,
  backgroundStatementTimeoutMs,
  currentStatementTimeoutMs,
  effectiveStatementTimeoutMs,
  interactiveReadTimeoutMs,
  isLongRequest,
  requestStatementTimeout,
  statementTimeout,
  withStatementTimeout,
  withStatementTimeoutAtMost,
  withoutStatementTimeout,
} from '../tenancy/statementTimeout.js';

const north = { userId: 1, businessProfileId: 11 };

function fakePool() {
  const query = jest.fn<(text: string, values?: unknown[]) => Promise<unknown>>().mockResolvedValue({ rows: [] });
  const release = jest.fn();
  const raw = { connect: async () => ({ query, release }) as unknown as PoolClient } as Pool;
  return { pool: createBusinessScopedPool(raw), query, release };
}

// The limits ride in the one configure call: $8 statement_timeout, $9 idle.
const configureCalls = (query: ReturnType<typeof fakePool>['query']) =>
  query.mock.calls.filter(([text]) => typeof text === 'string' && text.includes("'statement_timeout'"));
const timeoutCalls = (query: ReturnType<typeof fakePool>['query']) =>
  configureCalls(query).map(([, values]) => (values as unknown[])[7]);

/** Runs `middleware` and reports the bound the next handler sees. */
async function boundSeenBehind(middleware: ReturnType<typeof requestStatementTimeout>, method: string, url: string) {
  let seen: number | undefined;
  const next = (async () => { await Promise.resolve(); seen = currentStatementTimeoutMs(); }) as unknown as NextFunction;
  await middleware({ method, originalUrl: url, url } as Request, {} as Response, next);
  await new Promise(resolve => setImmediate(resolve));
  return seen;
}

describe('statement timeout', () => {
  it('bounds statements started inside a request-scoped read deadline', async () => {
    const { pool, query, release } = fakePool();
    await withBusinessScope(north, () => withStatementTimeout(25_000, () => pool.query('SELECT 1')));
    expect(timeoutCalls(query)).toEqual(['25000ms']);
    const texts = query.mock.calls.map(([text]) => text);
    // Applied inside the statement's own transaction, before the statement.
    expect(texts.indexOf('BEGIN')).toBeLessThan(texts.findIndex(text => text.includes("'statement_timeout'")));
    expect(texts.findIndex(text => text.includes("'statement_timeout'"))).toBeLessThan(texts.indexOf('SELECT 1'));
    expect(texts.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('gives background work without request context the finite background bound', async () => {
    const { pool, query } = fakePool();
    await withBusinessScope(north, () => pool.query('SELECT 1'));
    expect(timeoutCalls(query)).toEqual([`${DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS}ms`]);
    expect(DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LONG_REQUEST_TIMEOUT_MS);
  });

  it('always bounds idle time inside a transaction', async () => {
    const { pool, query } = fakePool();
    await withBusinessScope(north, () => withStatementTimeout(5_000, () => pool.query('SELECT 1')));
    await withBusinessScope(north, () => pool.query('SELECT 1'));
    const idle = configureCalls(query).map(([text, values]) => {
      expect(text).toContain("set_config('idle_in_transaction_session_timeout', $9, true)");
      return (values as unknown[])[8];
    });
    expect(idle).toEqual([`${DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`, `${DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`]);
  });

  it('applies the bound to explicit transactions opened inside the deadline', async () => {
    const { pool, query } = fakePool();
    const client = await withBusinessScope(north, () => withStatementTimeout(5_000, () => pool.connect()));
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await client.query('COMMIT');
    client.release();
    expect(timeoutCalls(query)).toEqual(['5000ms']);
  });

  it('keeps a session ended while checked out from crashing the process, and stops listening on release', async () => {
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();
    const query = jest.fn<(text: string) => Promise<unknown>>().mockResolvedValue({ rows: [] });
    const release = jest.fn();
    const rawClient = Object.assign(emitter, { query, release });
    const pool = createBusinessScopedPool({ connect: async () => rawClient as unknown as PoolClient } as Pool);
    const client = await withBusinessScope(north, () => pool.connect());
    await client.query('BEGIN');
    expect(emitter.listenerCount('error')).toBe(1);
    // Without a listener this emit would throw (and reach uncaughtException).
    expect(() => emitter.emit('error', Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' }))).not.toThrow();
    client.release();
    expect(release).toHaveBeenCalledWith(true);
    expect(emitter.listenerCount('error')).toBe(0);
  });

  it('lets maintenance work opt out explicitly', async () => {
    const { pool, query } = fakePool();
    await withBusinessScope(north, () => withoutStatementTimeout(() => pool.query('SELECT 1')));
    expect(timeoutCalls(query)).toEqual(['0ms']);
  });

  it('never lengthens a shorter surrounding bound', async () => {
    const { pool, query } = fakePool();
    await withStatementTimeout(25_000, () => withStatementTimeoutAtMost(60_000, () => pool.query('SELECT 1')));
    await withStatementTimeoutAtMost(60_000, () => pool.query('SELECT 1'));
    await withoutStatementTimeout(() => withStatementTimeoutAtMost(60_000, () => pool.query('SELECT 1')));
    expect(timeoutCalls(query)).toEqual(['25000ms', '60000ms', '60000ms']);
  });

  it('carries the deadline from route middleware to the handler continuation', async () => {
    const middleware = statementTimeout(12_000);
    let seen: number | undefined;
    const next = (async () => { await Promise.resolve(); seen = currentStatementTimeoutMs(); }) as unknown as NextFunction;
    await middleware({} as Request, {} as Response, next);
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).toBe(12_000);
    expect(currentStatementTimeoutMs()).toBeUndefined();
    expect(effectiveStatementTimeoutMs()).toBe(DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS);
  });

  it('bounds every API request: reads 25 s, writes and listed exports longer', async () => {
    const middleware = requestStatementTimeout({});
    expect(await boundSeenBehind(middleware, 'GET', '/api/auth/me')).toBe(DEFAULT_INTERACTIVE_READ_TIMEOUT_MS);
    expect(await boundSeenBehind(middleware, 'GET', '/api/dashboard/stats?period=7d')).toBe(DEFAULT_INTERACTIVE_READ_TIMEOUT_MS);
    // Writes have no client deadline; stopping one midway could leave half of its changes.
    expect(await boundSeenBehind(middleware, 'POST', '/api/campaigns/analytics/fetch-now')).toBe(DEFAULT_LONG_REQUEST_TIMEOUT_MS);
    expect(await boundSeenBehind(middleware, 'DELETE', '/api/settings/business-profiles/4')).toBe(DEFAULT_LONG_REQUEST_TIMEOUT_MS);
    expect(await boundSeenBehind(middleware, 'GET', '/api/crm/contacts/export?format=csv')).toBe(DEFAULT_LONG_REQUEST_TIMEOUT_MS);
    expect(await boundSeenBehind(middleware, 'POST', '/api/leads/bulk-delete')).toBe(DEFAULT_LONG_REQUEST_TIMEOUT_MS);
    // Same path, other method: not an export.
    expect(isLongRequest('DELETE', '/api/leads/export')).toBe(false);
    expect(isLongRequest('GET', '/api/outreach/batches/12/export.csv')).toBe(true);
    expect(isLongRequest('GET', '/api/outreach/batches/12/export.csv.bak')).toBe(false);
  });

  it('rejects invalid bounds and falls back to the default for bad configuration', () => {
    expect(() => statementTimeout(0)).toThrow();
    expect(() => withStatementTimeout(1.5, () => undefined)).toThrow();
    expect(() => withStatementTimeoutAtMost(-1, () => undefined)).toThrow();
    expect(interactiveReadTimeoutMs({ INTERACTIVE_READ_STATEMENT_TIMEOUT_MS: 'abc' })).toBe(DEFAULT_INTERACTIVE_READ_TIMEOUT_MS);
    expect(interactiveReadTimeoutMs({ INTERACTIVE_READ_STATEMENT_TIMEOUT_MS: '8000' })).toBe(8_000);
    expect(backgroundStatementTimeoutMs({ BACKGROUND_STATEMENT_TIMEOUT_MS: '0' })).toBe(DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS);
    expect(backgroundStatementTimeoutMs({ BACKGROUND_STATEMENT_TIMEOUT_MS: '600000' })).toBe(600_000);
    // Must stay below the browser's 30 second read deadline.
    expect(DEFAULT_INTERACTIVE_READ_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
