// React Query retry policies. The API client already retries GET network
// failures and 502/503/504 twice inside one query attempt; these policies decide
// whether React Query starts another attempt after that.

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  // lib/queryClient's default fetcher throws Error("<status>: <body>").
  const match = error instanceof Error ? /^(\d{3}):/.exec(error.message) : null;
  return match ? Number(match[1]) : undefined;
}

/** A 4xx answer (401, 403, 404, 422, 429...) will not change by asking again. */
export function isClientRejection(error: unknown): boolean {
  const status = statusOf(error);
  return status !== undefined && status >= 400 && status < 500;
}

/** The API stopped a query that ran past its time limit (code
 * DATABASE_QUERY_TIMEOUT). Asking again at once repeats the same slow query. */
export function isQueryTimeoutAnswer(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  return Boolean(data && typeof data === "object" && (data as { code?: unknown }).code === "DATABASE_QUERY_TIMEOUT");
}

/** Default for every query: one more attempt, but never for a 4xx answer or a
 * query timeout. */
export function defaultQueryRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && !isClientRejection(error) && !isQueryTimeoutAnswer(error);
}

/** For gates that block a whole page (for example the business-profile check):
 * keep trying through a short server outage before showing an error. */
// `error: Error` (not unknown): useQuery infers its error type from this
// callback, and unknown would leak into every consumer's `error` field.
export function gateQueryRetry(failureCount: number, error: Error): boolean {
  return failureCount < 3 && !isClientRejection(error);
}

export function gateQueryRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000);
}
