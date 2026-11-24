import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/** Upload parsers resume from request-stream events created before auth scope.
 * Mount after authentication and validated business/billing scopes. Bind only
 * their continuation to that snapshot, including the distinct actor and payer.
 * This does not authorize a request, choose a default business, restore revoked
 * authority or turn an unscoped request into a scoped one. Parser errors and
 * synchronous throws retain normal Express semantics. */
export function preserveAsyncContext(
  middleware: RequestHandler,
): RequestHandler {
  return (req, res, next) => middleware(req, res, AsyncLocalStorage.bind(next));
}
