import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";

// Every statement the application sends has a finite time limit.
//
// Interactive API requests: the client abandons GETs after 30 seconds, but
// PostgreSQL keeps executing an abandoned query. A few slow reads then occupy
// the whole pool, and unrelated requests (authentication, /health) fail while
// waiting for a connection. `/api` reads therefore run with a 25 second
// bound, writes and listed exports with 120 seconds (requestStatementTimeout,
// mounted once in index.ts).
//
// Background work (BullMQ workers, cron loops, startup tasks) and any code
// whose async context was lost on the way (event emitters, upload parsers)
// falls back to a longer but still finite bound. Losing context can only make
// the limit longer, never remove it.
//
// The scoped pool applies the bound with set_config(..., true) (SET LOCAL), so
// it ends with the statement's own transaction. Migrations use their own pool
// in scripts/migrate.mjs and are not affected.
type Bound = number; // milliseconds; 0 = explicitly unbounded
const deadline = new AsyncLocalStorage<Bound | undefined>();

export const DEFAULT_INTERACTIVE_READ_TIMEOUT_MS = 25_000;
/** Writes, and exports, imports and bulk edits started from the UI. */
export const DEFAULT_LONG_REQUEST_TIMEOUT_MS = 120_000;
/** Workers, cron jobs and anything without request context. */
export const DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS = 300_000;
/** A transaction left open and idle (leaked client, awaited provider call)
 * holds locks and a pooled connection; PostgreSQL ends the session after this. */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 300_000;

/** The bound explicitly set for the current async context, if any. */
export function currentStatementTimeoutMs(): number | undefined {
  return deadline.getStore();
}

/** What the scoped pool applies: the context's bound or the background bound.
 * 0 means a caller explicitly opted out with withoutStatementTimeout. */
export function effectiveStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return deadline.getStore() ?? backgroundStatementTimeoutMs(env);
}

function validTimeout(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("Statement timeout must be a positive integer number of milliseconds");
  return ms;
}

function configured(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// The bound is read when the scoped pool checks out a connection. Drizzle
// queries are lazy (they start on await), so `work` must await the query
// itself: `async () => await db.execute(q)`, never `() => db.execute(q)`.

/** Run `work` with this bound (longer or shorter than the surrounding one). */
export function withStatementTimeout<T>(ms: number, work: () => T): T {
  return deadline.run(validTimeout(ms), work);
}

/** Run `work` with at most `ms`: never lengthens an existing, shorter bound. */
export function withStatementTimeoutAtMost<T>(ms: number, work: () => T): T {
  const bound = validTimeout(ms);
  const current = effectiveStatementTimeoutMs();
  return deadline.run(current > 0 ? Math.min(current, bound) : bound, work);
}

/** Explicit opt-out for maintenance work that must run to completion (for
 * example a one-off backfill script). Application requests and jobs should
 * use withStatementTimeout with a larger finite value instead. */
export function withoutStatementTimeout<T>(work: () => T): T {
  return deadline.run(0, work);
}

export function interactiveReadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return configured(env.INTERACTIVE_READ_STATEMENT_TIMEOUT_MS, DEFAULT_INTERACTIVE_READ_TIMEOUT_MS);
}

export function longRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return configured(env.LONG_REQUEST_STATEMENT_TIMEOUT_MS, DEFAULT_LONG_REQUEST_TIMEOUT_MS);
}

export function backgroundStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return configured(env.BACKGROUND_STATEMENT_TIMEOUT_MS, DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS);
}

export function idleInTransactionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return configured(env.IDLE_IN_TRANSACTION_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS);
}

/** Route-level bound. Mount after authentication or anywhere after the global
 * request bound; the innermost bound wins. */
export function statementTimeout(ms: number = interactiveReadTimeoutMs()): RequestHandler {
  const bound = validTimeout(ms);
  return (_req, _res, next) => deadline.run(bound, next);
}

// The few UI-started operations that legitimately read or write a lot in one
// statement. Matched against the path without the query string.
const LONG_REQUESTS: ReadonlyArray<readonly [method: RegExp, path: RegExp]> = [
  [/^(GET|POST)$/, /^\/api\/leads\/export\/?$/],
  [/^POST$/, /^\/api\/leads\/bulk-(delete|update)\/?$/],
  [/^GET$/, /^\/api\/crm\/contacts\/export\/?$/],
  [/^POST$/, /^\/api\/crm\/contacts\/(bulk|import)\/?$/],
  [/^POST$/, /^\/api\/crm\/contact-analysis\/[^/]+\/import\/?$/],
  [/^GET$/, /^\/api\/admin\/leads\/export\/?$/],
  [/^(GET|POST)$/, /^\/api\/outreach\/reports\/exports(\/.*)?$/],
  [/^GET$/, /^\/api\/outreach\/batches\/\d+\/export\.csv$/],
  [/^GET$/, /^\/api\/ai-visibility\/audits\/[^/]+\/export\.(json|csv)$/],
  [/^POST$/, /^\/api\/content\/calendar\/(bulk|import)\/?$/],
  [/^POST$/, /^\/api\/settings\/storage\/workspace\/download\/?$/],
  [/^POST$/, /^\/api\/privacy\/data-export\/?$/],
];

export function isLongRequest(method: string, originalUrl: string): boolean {
  const path = originalUrl.split("?", 1)[0];
  return LONG_REQUESTS.some(([methods, pattern]) => methods.test(method.toUpperCase()) && pattern.test(path));
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The bound for one API request: reads 25 s (below the client's 30 s read
 * deadline); writes and the listed exports 120 s. Writes have no client
 * deadline, and cancelling one midway through a multi-statement handler
 * that is not in one transaction could leave half of its changes. */
export function requestTimeoutMs(method: string, originalUrl: string, env: NodeJS.ProcessEnv = process.env): number {
  const read = READ_METHODS.has(method.toUpperCase());
  return read && !isLongRequest(method, originalUrl) ? interactiveReadTimeoutMs(env) : longRequestTimeoutMs(env);
}

/** Mount once on `/api` so every route is bounded. */
export function requestStatementTimeout(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req: Request, _res, next) =>
    deadline.run(requestTimeoutMs(req.method, req.originalUrl || req.url, env), next);
}
