import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

// Most route handlers end in `catch { res.status(500) }`, so a request that
// could not get a database connection (pool exhausted, server restarting)
// used to look like a handler bug. Clients cannot tell that apart from a real
// failure, and retrying a real failure only repeats it. This marks requests
// that hit an availability problem so their 5xx goes out as 503 with
// Retry-After, which clients treat as "try again shortly".
//
// Statement timeouts (57014 "canceling statement due to statement timeout") are
// NOT availability failures: the database answered, the query was too slow.
// They get their own answer instead of the handler's generic 500: 504 with
// code DATABASE_QUERY_TIMEOUT, retryable (reads only) and a longer Retry-After. The
// web client does not replay this code automatically (repeating a slow query
// during an overload adds load); the person can retry from the page.

interface RequestDatabaseState { unavailable: boolean; statementTimedOut: boolean }
const state = new AsyncLocalStorage<RequestDatabaseState>();

const UNAVAILABLE_MESSAGES = [
  "timeout exceeded when trying to connect",
  "connection terminated unexpectedly",
  "connection terminated due to connection timeout",
  "connection terminated",
  "the database system is starting up",
  "the database system is shutting down",
];
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", "08001", "08003", "08004", "08006", // connection_exception family
]);

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return UNAVAILABLE_MESSAGES.some(text => message.includes(text));
}

/** The server cancelled a statement because it hit statement_timeout. A user
 * or admin cancel shares SQLSTATE 57014 but not this message. */
export function isStatementTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code !== "57014") return false;
  return String((error as { message?: unknown }).message ?? "").toLowerCase().includes("statement timeout");
}

/** Called by the database layer on every failure; only availability errors
 * and statement timeouts are recorded. */
export function noteDatabaseFailure(error: unknown): void {
  const current = state.getStore();
  if (!current) return;
  if (isDatabaseUnavailableError(error)) current.unavailable = true;
  else if (isStatementTimeoutError(error)) current.statementTimedOut = true;
}

export function requestHitDatabaseUnavailable(): boolean {
  return state.getStore()?.unavailable === true;
}

export function requestHitStatementTimeout(): boolean {
  return state.getStore()?.statementTimedOut === true;
}

export const RETRY_AFTER_SECONDS = 5;
export const QUERY_TIMEOUT_RETRY_AFTER_SECONDS = 15;
export const QUERY_TIMEOUT_CODE = "DATABASE_QUERY_TIMEOUT";
export const QUERY_TIMEOUT_MESSAGE = "This took too long, so it was stopped. Check whether your change was saved, then try again in a few seconds.";
const QUERY_TIMEOUT_READ_MESSAGE = "This took too long to load, so it was stopped. Try again in a few seconds.";

/** Mount before the API routes (and before responseWrapper). */
export const databaseUnavailableResponses: RequestHandler = (req, res, next) => {
  // Only a read is safe to repeat; a timed-out write may have done part of its work.
  const retryable = ["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase());
  const current: RequestDatabaseState = { unavailable: false, statementTimedOut: false };
  let timeoutAnswer = false;
  const status = res.status.bind(res);
  res.status = ((code: number) => {
    if (code >= 500 && !res.headersSent) {
      // An unreachable database wins: the statement timeout may be a symptom.
      if (current.unavailable && code !== 503) {
        res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
        return status(503);
      }
      if (!current.unavailable && current.statementTimedOut) {
        timeoutAnswer = true;
        if (retryable) res.setHeader("Retry-After", String(QUERY_TIMEOUT_RETRY_AFTER_SECONDS));
        return status(504);
      }
    }
    return status(code);
  }) as typeof res.status;
  // Replace the handler's generic error body so the page can say what happened.
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => timeoutAnswer
    ? json({
      success: false,
      error: retryable ? QUERY_TIMEOUT_READ_MESSAGE : QUERY_TIMEOUT_MESSAGE,
      message: retryable ? QUERY_TIMEOUT_READ_MESSAGE : QUERY_TIMEOUT_MESSAGE,
      code: QUERY_TIMEOUT_CODE,
      retryable,
      ...(retryable ? { retryAfter: QUERY_TIMEOUT_RETRY_AFTER_SECONDS } : {}),
    })
    : json(body)) as typeof res.json;
  state.run(current, next);
};
