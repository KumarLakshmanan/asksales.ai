import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api-client';

const client = createApiClient({ tokenStorageKey: 'test-token', profileStorageKeys: [], unauthorizedEvent: 'test-unauthorized' });
const fetchMock = vi.fn();
const response = () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true }) });
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded API reads', () => {
  it('ends a stuck read after 30 seconds, aborts the fetch and never retries', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const outcome = client.get('/api/support').catch(error => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toMatchObject({ status: 408, message: expect.stringContaining('too long') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('also bounds a stalled JSON body and keeps timeout settings out of fetch options', async () => {
    fetchMock.mockResolvedValue({ ...response(), json: () => new Promise(() => {}) });
    const outcome = client.get('/api/crm/pipeline/summary', { timeoutMs: 100 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toMatchObject({ status: 408 });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
  });
  it('preserves caller cancellation and ignores a late response', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const outcome = client.get('/api/support', { signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not impose a read deadline or replay an in-flight write', async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const outcome = client.post('/api/test-write', { value: 'test' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    finish(response());
    expect(await outcome).toEqual({ ok: true });
  });
  it('does not start a request whose caller already cancelled it', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(client.get('/api/support', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
