import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import {
  QUERY_TIMEOUT_CODE,
  QUERY_TIMEOUT_RETRY_AFTER_SECONDS,
  RETRY_AFTER_SECONDS,
  databaseUnavailableResponses,
  isDatabaseUnavailableError,
  isStatementTimeoutError,
  noteDatabaseFailure,
} from '../tenancy/databaseAvailability.js';
import { DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS } from '../tenancy/statementTimeout.js';

function fakeResponse() {
  const headers: Record<string, string> = {};
  const sent: { body?: unknown } = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: (name: string, value: string) => { headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  };
  return { res: res as unknown as Response & { statusCode: number }, headers, sent };
}

/** Runs `handler` the way Express would after the middleware. */
async function throughMiddleware(handler: (res: Response) => Promise<void> | void, method = 'GET') {
  const { res, headers, sent } = fakeResponse();
  let done!: Promise<void>;
  databaseUnavailableResponses({ method } as Request, res, (() => { done = Promise.resolve(handler(res)); }) as NextFunction);
  await done;
  return { status: res.statusCode, headers, body: sent.body };
}

const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('database availability errors', () => {
  it.each([
    [new Error('timeout exceeded when trying to connect'), true],
    [Object.assign(new Error('sorry, too many clients already'), { code: '53300' }), true],
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }), true],
    [new Error('Connection terminated unexpectedly'), true],
    [Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), false],
    [Object.assign(new Error('duplicate key value'), { code: '23505' }), false],
    [new Error('Cannot read properties of undefined'), false],
  ])('classifies %s', (error, expected) => {
    expect(isDatabaseUnavailableError(error)).toBe(expected);
  });

  it.each([
    [statementTimeout(), true],
    [Object.assign(new Error('canceling statement due to user request'), { code: '57014' }), false],
    [new Error('canceling statement due to statement timeout'), false],
  ])('recognizes statement timeouts: %s', (error, expected) => {
    expect(isStatementTimeoutError(error)).toBe(expected);
  });

  it('turns a handler 500 into 503 with Retry-After when the request could not reach the database', async () => {
    const result = await throughMiddleware(async res => {
      await Promise.resolve();
      noteDatabaseFailure(new Error('timeout exceeded when trying to connect'));
      res.status(500);
    });
    expect(result.status).toBe(503);
    expect(result.headers['Retry-After']).toBe(String(RETRY_AFTER_SECONDS));
  });

  it('leaves a genuine handler failure as 500', async () => {
    const result = await throughMiddleware(res => {
      noteDatabaseFailure(Object.assign(new Error('duplicate key value'), { code: '23505' }));
      noteDatabaseFailure(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
      res.status(500).json({ message: 'Unable to load' });
    });
    expect(result.status).toBe(500);
    expect(result.headers['Retry-After']).toBeUndefined();
    expect(result.body).toEqual({ message: 'Unable to load' });
  });

  it('answers a statement timeout as a retryable 504, not as database unavailable', async () => {
    const result = await throughMiddleware(async res => {
      await Promise.resolve();
      noteDatabaseFailure(statementTimeout());
      res.status(500).json({ success: false, message: 'Failed to fetch dashboard' });
    });
    expect(result.status).toBe(504);
    expect(result.headers['Retry-After']).toBe(String(QUERY_TIMEOUT_RETRY_AFTER_SECONDS));
    expect(result.body).toMatchObject({ success: false, code: QUERY_TIMEOUT_CODE, retryable: true });
  });

  it('does not invite a repeat of a write that timed out', async () => {
    const result = await throughMiddleware(res => {
      noteDatabaseFailure(statementTimeout());
      res.status(500).json({ message: 'Failed to save' });
    }, 'POST');
    expect(result.status).toBe(504);
    expect(result.headers['Retry-After']).toBeUndefined();
    expect(result.body).toMatchObject({ code: QUERY_TIMEOUT_CODE, retryable: false });
    expect(result.body).not.toHaveProperty('retryAfter');
  });

  it('keeps an unreachable database as 503 even when a statement also timed out', async () => {
    const result = await throughMiddleware(res => {
      noteDatabaseFailure(statementTimeout());
      noteDatabaseFailure(new Error('timeout exceeded when trying to connect'));
      res.status(500).json({ message: 'x' });
    });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ message: 'x' });
  });

  it('does not rewrite a handled statement timeout that answered normally', async () => {
    const result = await throughMiddleware(res => {
      noteDatabaseFailure(statementTimeout());
      res.status(200).json({ partial: true });
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ partial: true });
  });

  it('records a statement timeout raised through the scoped pool', async () => {
    const query = jest.fn<(text: string) => Promise<unknown>>(async text => {
      if (text === 'SELECT pg_sleep(60)') throw statementTimeout();
      return { rows: [] };
    });
    const raw = { connect: async () => ({ query, release: jest.fn() }) as unknown as PoolClient } as Pool;
    const pool = createBusinessScopedPool(raw);
    const result = await throughMiddleware(async res => {
      await expect(withSystemScope('test', () => pool.query('SELECT pg_sleep(60)'))).rejects.toThrow('statement timeout');
      res.status(500).json({ message: 'x' });
    });
    expect(result.status).toBe(504);
    expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
  });

  it('never changes non-5xx answers', async () => {
    const result = await throughMiddleware(res => {
      noteDatabaseFailure(new Error('timeout exceeded when trying to connect'));
      res.status(404);
    });
    expect(result.status).toBe(404);
  });

  it('keeps requests separate', async () => {
    const failed = throughMiddleware(async res => {
      noteDatabaseFailure(new Error('timeout exceeded when trying to connect'));
      await new Promise(resolve => setImmediate(resolve));
      res.status(500);
    });
    const healthy = throughMiddleware(async res => {
      await new Promise(resolve => setImmediate(resolve));
      res.status(500);
    });
    expect((await failed).status).toBe(503);
    expect((await healthy).status).toBe(500);
  });

  it('records a pool checkout timeout from the scoped pool', async () => {
    const raw = { connect: async () => { throw new Error('timeout exceeded when trying to connect'); } } as unknown as Pool;
    const pool = createBusinessScopedPool(raw);
    const result = await throughMiddleware(async res => {
      await expect(withSystemScope('test', () => pool.query('SELECT 1'))).rejects.toThrow('timeout exceeded');
      res.status(500);
    });
    expect(result.status).toBe(503);
  });
});

describe('scoped pool configuration', () => {
  it('sets role and scope in one round trip around each standalone query', async () => {
    const query = jest.fn<(text: string, values?: unknown[]) => Promise<unknown>>().mockResolvedValue({ rows: [] });
    const raw = { connect: async () => ({ query, release: jest.fn() }) as unknown as PoolClient } as Pool;
    const pool = createBusinessScopedPool(raw);
    await withBusinessScope({ userId: 1, businessProfileId: 11 }, () => pool.query('SELECT 1'));
    const texts = query.mock.calls.map(([text]) => String(text));
    expect(texts).toHaveLength(4);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toContain("set_config('role', $1, true)");
    expect(texts[1]).toContain("set_config('app.business_profile_id', $2, true)");
    // Background work without a request bound still gets finite limits.
    expect(texts[1]).toContain("set_config('statement_timeout', $8, true)");
    expect(query.mock.calls[1][1]).toEqual([
      'salesmarketing_business_runtime', '11', '1', 'off', '', '', '1',
      `${DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS}ms`, `${DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`,
    ]);
    expect(texts[2]).toBe('SELECT 1');
    expect(texts[3]).toBe('COMMIT');
    expect(texts.some(text => /SET LOCAL ROLE/i.test(text))).toBe(false);
  });
});
