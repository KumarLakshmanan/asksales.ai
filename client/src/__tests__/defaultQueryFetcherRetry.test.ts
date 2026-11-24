import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, type QueryFunctionContext } from '@tanstack/react-query';
import { getQueryFn } from '@/lib/queryClient';

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const context = (queryKey: string[]) => ({ queryKey, signal: new AbortController().signal, meta: undefined, client: new QueryClient() }) as unknown as QueryFunctionContext;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('retries a transient read failure like every other page read', async () => {
  fetchMock.mockResolvedValueOnce(json(503)).mockResolvedValueOnce(json(200, { ok: 1 }));
  const pending = getQueryFn({ on401: 'throw' })(context(['/api/example']));
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual({ ok: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('returns null for a 401 when asked to, without signing the user out', async () => {
  const signedOut = vi.fn();
  window.addEventListener('auth:unauthorized', signedOut);
  fetchMock.mockResolvedValue(json(401, { message: 'Signed out' }));
  await expect(getQueryFn({ on401: 'returnNull' })(context(['/api/example']))).resolves.toBeNull();
  await expect(getQueryFn({ on401: 'throw' })(context(['/api/example']))).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(signedOut).not.toHaveBeenCalled();
  window.removeEventListener('auth:unauthorized', signedOut);
});
