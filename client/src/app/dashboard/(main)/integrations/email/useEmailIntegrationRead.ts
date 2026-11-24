import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { selectedBusinessProfileId } from '@/lib/business-profile';

export const EMAIL_READ_TIMEOUT_MS = 15_000;

type Request = { controller: AbortController; promise: Promise<boolean> };

/** Keep the last successful read, while only the current attempt may publish. */
export function useEmailIntegrationRead<T>(endpoint: string, label: string, initialValue: T) {
  const [data, setData] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const active = useRef<Request | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
    if (mounted.current) setPending(false);
  }, []);

  // A confirmed mutation can invalidate a subset of cached data immediately.
  // Cancel the prior read so it cannot restore rows the server has removed.
  const invalidate = useCallback((update: (current: T) => T) => {
    cancel();
    if (mounted.current) setData(update);
  }, [cancel]);

  const load = useCallback((replace = false): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false);
    // Coalesce repeated clicks, but allow a newer authoritative read to replace it.
    if (active.current && !replace) return active.current.promise;
    active.current?.controller.abort();
    const request: Request = { controller: new AbortController(), promise: Promise.resolve(false) };
    const profileId = selectedBusinessProfileId();
    const current = () => mounted.current && active.current === request && selectedBusinessProfileId() === profileId;
    active.current = request;
    setPending(true);
    request.promise = (async () => {
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      try {
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException('Read cancelled', 'AbortError'));
          request.controller.signal.addEventListener('abort', onAbort, { once: true });
          timeout = setTimeout(() => {
            timedOut = true;
            request.controller.abort();
          }, EMAIL_READ_TIMEOUT_MS);
        });
        // The race also settles if a mocked/late transport ignores abort.
        const result = await Promise.race([api.get<T>(endpoint, { signal: request.controller.signal }), cancelled]);
        if (!current()) return false;
        setData(result);
        setError(null);
        return true;
      } catch {
        if (!current()) return false;
        const message = timedOut ? `${label} refresh timed out. Try again.` : `${label} could not be refreshed. Try again.`;
        setError(message);
        throw new Error(message);
      } finally {
        clearTimeout(timeout);
        request.controller.signal.removeEventListener('abort', onAbort);
        if (current()) {
          active.current = null;
          setPending(false);
        }
      }
    })();
    return request.promise;
  }, [endpoint, label]);

  return { data, error, pending, load, cancel, invalidate };
}
