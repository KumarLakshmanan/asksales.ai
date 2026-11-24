import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, fetchWithReadRetry, isTransientReadFailure } from '@/lib/api-client';
import { defaultQueryRetry, gateQueryRetry, isClientRejection } from '@/lib/queryRetry';

const client = createApiClient({ tokenStorageKey: 'retry_test_token', profileStorageKeys: [], unauthorizedEvent: 'retry-test:unauthorized' });
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('API client transient read retry', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([502, 503, 504])('retries a GET after %s and returns the later success', async status => {
    fetchMock.mockResolvedValueOnce(json(status)).mockResolvedValueOnce(json(200, { ok: 1 }));
    const pending = client.get<{ ok: number }>('/api/settings/business-profiles');
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(200, { ok: 2 }));
    const pending = client.get('/api/wallet');
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: 2 });
  });

  it('gives up after two retries with the last error', async () => {
    fetchMock.mockImplementation(async () => json(503, { message: 'Still unavailable' }));
    const pending = client.get('/api/organizations');
    const outcome = expect(pending).rejects.toMatchObject({ status: 503, message: 'Still unavailable' });
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404, 408, 429, 500])('does not retry a GET answered with %s', async status => {
    fetchMock.mockImplementation(async () => json(status));
    const pending = client.get('/api/crm/contacts', { suppressUnauthorizedEvent: true });
    const outcome = expect(pending).rejects.toMatchObject({ status });
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay a query the API stopped for running too long', async () => {
    const body = { success: false, code: 'DATABASE_QUERY_TIMEOUT', retryable: true, message: 'This took too long to load, so it was stopped. Try again in a few seconds.' };
    fetchMock.mockImplementation(async () => json(504, body));
    const pending = client.get('/api/dashboard/stats');
    const outcome = expect(pending).rejects.toMatchObject({ status: 504, message: body.message });
    await vi.runAllTimersAsync();
    const error = await pending.catch(caught => caught);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isTransientReadFailure(error)).toBe(false);
    expect(defaultQueryRetry(0, error)).toBe(false);
    // A plain gateway 504 is still retried.
    expect(defaultQueryRetry(0, new ApiError('Gateway timeout', 504))).toBe(true);
  });

  it('does not replay a timed-out export download, but returns its readable answer', async () => {
    fetchMock.mockImplementation(async () => json(504, { success: false, code: 'DATABASE_QUERY_TIMEOUT' }));
    const pending = fetchWithReadRetry('/api/crm/contacts/export');
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ code: 'DATABASE_QUERY_TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never replays a write', async () => {
    fetchMock.mockImplementation(async () => json(503));
    const pending = client.post('/api/crm/contacts', { name: 'Synthetic' });
    const outcome = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours retryTransient: false', async () => {
    fetchMock.mockImplementation(async () => json(503));
    const pending = client.get('/api/auth/me', { retryTransient: false });
    const outcome = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the caller aborts during the retry pause', async () => {
    fetchMock.mockImplementation(async () => json(503));
    const controller = new AbortController();
    const pending = client.get('/api/wallet', { signal: controller.signal });
    const outcome = expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a direct download on 503 and returns the later response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(new Response('file', { status: 200 }));
    const pending = fetchWithReadRetry('/api/outreach/reports/exports/7/download/csv', { credentials: 'include' });
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('file');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last 503 download response after two retries, and never retries 500 or a POST', async () => {
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    const pending = fetchWithReadRetry('/api/settings/support-documents/3/content');
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('bug', { status: 500 }));
    expect((await fetchWithReadRetry('/api/x')).status).toBe(500);
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    expect((await fetchWithReadRetry('/api/support/review-public/t', { method: 'POST' })).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a dropped connection on a direct download but not an abort', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('ok'));
    const pending = fetchWithReadRetry('/api/settings/media-galleries/assets/1/content');
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    fetchMock.mockReset();
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(fetchWithReadRetry('/api/x', { signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('query retry policies', () => {
  it('classifies transient read failures', () => {
    expect(isTransientReadFailure(new ApiError('down', 503))).toBe(true);
    expect(isTransientReadFailure(new ApiError('offline', 0))).toBe(true);
    expect(isTransientReadFailure(new ApiError('handler or statement timeout', 500))).toBe(false);
    expect(isTransientReadFailure(new ApiError('slow', 408))).toBe(false);
  });

  it('treats 4xx as final for both ApiError and the default fetcher error format', () => {
    expect(isClientRejection(new ApiError('nope', 404))).toBe(true);
    expect(isClientRejection(new Error('403: Forbidden'))).toBe(true);
    expect(isClientRejection(new ApiError('down', 503))).toBe(false);
    expect(isClientRejection(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('retries a server error once by default and a page gate three times', () => {
    const down = new ApiError('down', 503);
    expect([0, 1].map(n => defaultQueryRetry(n, down))).toEqual([true, false]);
    expect([0, 1, 2, 3].map(n => gateQueryRetry(n, down))).toEqual([true, true, true, false]);
    expect(defaultQueryRetry(0, new ApiError('nope', 401))).toBe(false);
    expect(gateQueryRetry(0, new ApiError('nope', 403))).toBe(false);
  });
});
