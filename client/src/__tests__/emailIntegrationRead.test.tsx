import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { EMAIL_READ_TIMEOUT_MS, useEmailIntegrationRead } from '@/app/dashboard/(main)/integrations/email/useEmailIntegrationRead';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const get = vi.mocked(api.get);
const useRead = () => useEmailIntegrationRead('/api/gmail/oauth/status', 'Gmail status', 'known');
beforeEach(() => {
  get.mockReset();
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  sessionStorage.setItem('active-business-profile:4101', '4102');
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

describe('email integration read recovery', () => {
  it('invalidates confirmed removed rows while a stale transport ignores cancellation', async () => {
    const pending = deferred<string[]>();
    get.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useEmailIntegrationRead('/api/email-senders', 'Senders', ['gmail', 'resend']));
    let read!: Promise<boolean>;
    act(() => { read = result.current.load(); result.current.invalidate(rows => rows.filter(row => row !== 'gmail')); });
    await act(async () => { expect(await read).toBe(false); pending.resolve(['gmail', 'resend']); });
    expect(result.current.data).toEqual(['resend']);
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });
  it('retains prior data on rejection and clears the error only after a successful retry', async () => {
    const retry = deferred<string>();
    get.mockRejectedValueOnce(new Error('private provider response')).mockReturnValueOnce(retry.promise);
    const { result } = renderHook(useRead);
    await act(async () => { await expect(result.current.load()).rejects.toThrow('Gmail status could not be refreshed'); });
    expect(result.current.data).toBe('known');
    expect(result.current.pending).toBe(false);
    expect(result.current.error).not.toContain('private provider');
    let attempt!: Promise<boolean>;
    act(() => { attempt = result.current.load(); });
    expect(result.current.pending).toBe(true);
    expect(result.current.error).toContain('could not be refreshed');
    expect(result.current.data).toBe('known');
    await act(async () => { retry.resolve('fresh'); expect(await attempt).toBe(true); });
    expect(result.current.data).toBe('fresh');
    expect(result.current.error).toBeNull();
  });

  it('bounds even a transport which ignores abort and permits a successful retry', async () => {
    vi.useFakeTimers();
    const old = deferred<string>();
    get.mockReturnValueOnce(old.promise).mockResolvedValueOnce('fresh');
    const { result } = renderHook(useRead);
    let attempt!: Promise<boolean>;
    act(() => { attempt = result.current.load(); });
    const rejection = expect(attempt).rejects.toThrow('timed out');
    await act(async () => { await vi.advanceTimersByTimeAsync(EMAIL_READ_TIMEOUT_MS); await rejection; });
    expect(get.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.data).toBe('known');
    await act(async () => { await result.current.load(); });
    await act(async () => { old.resolve('obsolete'); });
    expect(result.current.data).toBe('fresh');
    expect(result.current.error).toBeNull();
  });

  it('coalesces repeated actions before React can disable the button', async () => {
    const pending = deferred<string>();
    get.mockReturnValue(pending.promise);
    const { result } = renderHook(useRead);
    let first!: Promise<boolean>;
    act(() => { first = result.current.load(); expect(result.current.load()).toBe(first); });
    expect(get).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve('fresh'); await first; });
    expect(result.current.pending).toBe(false);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`does not let an older ${outcome} clear a newer request's pending state`, async () => {
      const old = deferred<string>();
      const latest = deferred<string>();
      get.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
      const { result } = renderHook(useRead);
      let oldAttempt!: Promise<boolean>;
      let newAttempt!: Promise<boolean>;
      act(() => { oldAttempt = result.current.load(); newAttempt = result.current.load(true); });
      await act(async () => {
        if (outcome === 'resolve') old.resolve('obsolete'); else old.reject(new Error('obsolete'));
        expect(await oldAttempt).toBe(false);
      });
      expect(result.current.pending).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toBe('known');
      await act(async () => { latest.resolve('latest'); await newAttempt; });
      expect(result.current.data).toBe('latest');
    });
  }

  it('does not let an older success erase a newer error', async () => {
    const old = deferred<string>();
    get.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('new failure'));
    const { result } = renderHook(useRead);
    let oldAttempt!: Promise<boolean>;
    act(() => { oldAttempt = result.current.load(); });
    await act(async () => { await expect(result.current.load(true)).rejects.toThrow('could not be refreshed'); });
    await act(async () => { old.resolve('obsolete'); expect(await oldAttempt).toBe(false); });
    expect(result.current.error).toContain('could not be refreshed');
    expect(result.current.data).toBe('known');
  });

  it('cancels immediately when the expanded domain changes, even if abort is ignored', async () => {
    const pending = deferred<string>();
    get.mockReturnValue(pending.promise);
    const { result } = renderHook(useRead);
    let attempt!: Promise<boolean>;
    act(() => { attempt = result.current.load(); result.current.cancel(); });
    await act(async () => { expect(await attempt).toBe(false); });
    expect(result.current.pending).toBe(false);
    expect(get.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => { pending.reject(new Error('late failure')); });
    expect(result.current.error).toBeNull();
  });

  it('aborts on unmount and cannot publish into a newly mounted page', async () => {
    const pending = deferred<string>();
    get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce('new page');
    const first = renderHook(useRead);
    let attempt!: Promise<boolean>;
    act(() => { attempt = first.result.current.load(); });
    first.unmount();
    const next = renderHook(useRead);
    await act(async () => { expect(await attempt).toBe(false); await next.result.current.load(); pending.resolve('old page'); });
    expect(get.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(next.result.current.data).toBe('new page');
  });

  it('rejects a stale workspace result before the keyed page has remounted', async () => {
    const pending = deferred<string>();
    get.mockReturnValue(pending.promise);
    const { result } = renderHook(useRead);
    let attempt!: Promise<boolean>;
    act(() => { attempt = result.current.load(); });
    sessionStorage.setItem('active-business-profile:4101', '4103');
    await act(async () => { pending.resolve('other workspace'); expect(await attempt).toBe(false); });
    expect(result.current.data).toBe('known');
    expect(result.current.error).toBeNull();
  });

  it('works after StrictMode effect cleanup and clears its request timer', async () => {
    vi.useFakeTimers();
    get.mockResolvedValue('fresh');
    const { result } = renderHook(useRead, { wrapper: StrictMode });
    await act(async () => { await result.current.load(); });
    expect(result.current.data).toBe('fresh');
    expect(vi.getTimerCount()).toBe(0);
  });
});
