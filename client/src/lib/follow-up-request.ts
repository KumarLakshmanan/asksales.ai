/** Bound follow-up reads and configuration writes, including response parsing. */
export const FOLLOW_UP_REQUEST_TIMEOUT_MS = 15_000;

export class FollowUpRequestTimeoutError extends Error {
  constructor() {
    super('The follow-up request timed out. Its result is unconfirmed; retry the same request or refresh its saved state.');
    this.name = 'FollowUpRequestTimeoutError';
  }
}

/** Abort is best effort. Race the whole operation so stalled fetch/body parsing is bounded too. */
export async function followUpRequest<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new FollowUpRequestTimeoutError()); controller.abort(); }, FOLLOW_UP_REQUEST_TIMEOUT_MS);
  });
  try { return await Promise.race([work(controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}
