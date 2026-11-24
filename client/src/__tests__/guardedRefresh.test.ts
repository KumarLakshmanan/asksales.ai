import { afterEach, expect, it, vi } from 'vitest';
import { createGuardedRefresh } from '@/lib/guardedRefresh';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const setVisibility = (state: DocumentVisibilityState) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
afterEach(() => setVisibility('visible'));

it('skips timer ticks while a refresh is still running', async () => {
  const pending = deferred();
  const refresh = vi.fn(() => pending.promise);
  const guard = createGuardedRefresh(refresh);
  guard.poll();
  guard.poll();
  guard.poll();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(guard.inFlight).toBe(true);
  pending.resolve();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(guard.inFlight).toBe(false);
  guard.poll();
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('skips timer ticks while the tab is hidden', () => {
  setVisibility('hidden');
  const refresh = vi.fn(async () => undefined);
  const guard = createGuardedRefresh(refresh);
  guard.poll();
  expect(refresh).not.toHaveBeenCalled();
});

it('queues one follow-up for explicit refreshes during a running one', async () => {
  const first = deferred();
  const refresh = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
  const guard = createGuardedRefresh(refresh);
  const running = guard.run();
  void guard.run();
  void guard.run();
  expect(refresh).toHaveBeenCalledTimes(1);
  first.resolve();
  await running;
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('keeps polling after a failed refresh and stops after stop()', async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error('Synthetic outage')).mockResolvedValue(undefined);
  const guard = createGuardedRefresh(refresh);
  await guard.run();
  expect(guard.inFlight).toBe(false);
  guard.poll();
  expect(refresh).toHaveBeenCalledTimes(2);
  guard.stop();
  await Promise.resolve();
  guard.poll();
  expect(refresh).toHaveBeenCalledTimes(2);
});
