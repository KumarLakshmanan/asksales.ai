/**
 * Race an operation against a timeout without leaving the losing timer alive.
 * The timer is unreferenced so it never blocks process shutdown, and is always
 * cleared when the operation settles first.
 */
export async function withPromiseTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
