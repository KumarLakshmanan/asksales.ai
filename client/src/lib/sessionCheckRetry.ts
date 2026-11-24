// Waits before each automatic re-attempt of a session check
// (/api/auth/me, /api/admin/me, /api/support-portal/me). The server answers
// 503/500 when it cannot reach its database in time (pool acquire timeout), and
// the browser reports status 0 or 408 for dropped or slow requests. Those
// outcomes say nothing about the credentials, so the check is repeated a few
// times before an error is shown.
export const SESSION_CHECK_RETRY_DELAYS_MS: readonly number[] = [800, 2000, 4000];

export function sessionCheckRetryDelays(): readonly number[] {
  return SESSION_CHECK_RETRY_DELAYS_MS;
}

// Only failures that leave the session undecided are retried. 401/403 are real
// rejections and 429 asks the client to back off, so none of those repeat.
// The status is read structurally so every API wrapper's ApiError qualifies.
export function isTransientSessionCheckFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 0 || status === 408 || status >= 500;
  return !(error instanceof Error && error.name === "AbortError");
}

export function waitForSessionRetry(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs one session check, retrying transient failures after each delay in
// `delays` (pass sessionCheckRetryDelays()). The last failure is rethrown.
// `isCurrent` lets the caller abandon the loop when a newer check, login or
// logout supersedes it; the promise then resolves to undefined.
export async function withSessionCheckRetry<T>(
  request: () => Promise<T>,
  delays: readonly number[],
  isCurrent: () => boolean = () => true,
): Promise<{ value: T } | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await request() };
    } catch (failure) {
      if (!isCurrent()) return undefined;
      if (attempt >= delays.length || !isTransientSessionCheckFailure(failure)) throw failure;
      await waitForSessionRetry(delays[attempt]);
      if (!isCurrent()) return undefined;
    }
  }
}

// While a session error card is shown, check again in the background this
// often, so a page opens by itself once a longer outage ends.
export const SESSION_CARD_RECHECK_MS = 15_000;
