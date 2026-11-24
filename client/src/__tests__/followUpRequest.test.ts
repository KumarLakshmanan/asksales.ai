import { afterEach, describe, expect, it, vi } from 'vitest';
import { followUpRequest, FOLLOW_UP_REQUEST_TIMEOUT_MS, FollowUpRequestTimeoutError } from '@/lib/follow-up-request';

afterEach(() => vi.useRealTimers());
describe('bounded follow-up requests', () => {
  it('settles a truly never-ending operation and aborts without assuming server cancellation', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const request = followUpRequest(value => { signal = value; return new Promise(() => {}); });
    const outcome = expect(request).rejects.toBeInstanceOf(FollowUpRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_REQUEST_TIMEOUT_MS); await outcome;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a response arriving after timeout, including a server commit after abort', async () => {
    vi.useFakeTimers(); let finish!: (value: string) => void;
    const request = followUpRequest(() => new Promise(resolve => { finish = resolve; }));
    const success = vi.fn(); const failure = vi.fn(); const settled = request.then(success, failure);
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_REQUEST_TIMEOUT_MS); await settled;
    finish('committed after deadline'); await Promise.resolve();
    expect(success).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0]).toBeInstanceOf(FollowUpRequestTimeoutError);
  });
  it('bounds stalled response parsing too and removes the timer after ordinary success', async () => {
    vi.useFakeTimers();
    const request = followUpRequest(async () => { const response = { json: () => new Promise(() => {}) }; return response.json(); });
    const outcome = expect(request).rejects.toThrow('unconfirmed');
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_REQUEST_TIMEOUT_MS); await outcome;
    await expect(followUpRequest(async () => 'saved')).resolves.toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
  });
});
