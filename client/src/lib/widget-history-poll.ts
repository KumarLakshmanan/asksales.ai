export type WidgetPollResult = boolean | { success: boolean; active: boolean };

export interface WidgetHistoryPoll {
  (): void;
  /** Poll now and return to the fast interval (for example after sending). */
  wake: () => void;
}

/** Sequential polling: hidden tabs suspend reads, retries back off, every
 * fetch has a deadline, and an idle conversation slows down to
 * `idleInterval` until something changes or `wake()` is called. A plain
 * boolean result counts as activity, so callers that do not report activity
 * keep the fixed interval. */
export function startWidgetHistoryPoll({
  read,
  visible = () => document.visibilityState !== "hidden",
  onVisibility = (listener: () => void) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  interval = 5000,
  idleInterval = interval,
  timeout = 12000,
}: {
  read: (signal: AbortSignal) => Promise<WidgetPollResult>;
  visible?: () => boolean;
  onVisibility?: (listener: () => void) => () => void;
  interval?: number;
  idleInterval?: number;
  timeout?: number;
}): WidgetHistoryPoll {
  let stopped = false;
  let running = false;
  let failures = 0;
  let idle = 0;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  function schedule(delay: number) {
    if (!stopped && visible()) timer = setTimeout(() => void refresh(), delay);
  }
  function nextDelay() {
    if (failures > 0) return Math.min(interval * 2 ** Math.min(failures, 4), 60000);
    return Math.min(interval * 2 ** Math.min(idle, 6), Math.max(interval, idleInterval));
  }
  async function refresh() {
    if (stopped || running || !visible()) return;
    running = true;
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), timeout);
    try {
      const result = await read(controller.signal);
      const success = typeof result === "boolean" ? result : result.success;
      const active = typeof result === "boolean" ? result : result.active;
      failures = success ? 0 : failures + 1;
      if (success) idle = active ? 0 : idle + 1;
    } catch {
      failures += 1;
    } finally {
      clearTimeout(deadline);
      running = false;
      if (wakeRequested) {
        wakeRequested = false;
        idle = 0;
        schedule(0);
      } else schedule(nextDelay());
    }
  }
  const unsubscribe = onVisibility(() => {
    clearTimeout(timer);
    if (!visible()) controller?.abort();
    else if (!running) void refresh();
  });
  schedule(0);
  const stop = (() => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    unsubscribe();
  }) as WidgetHistoryPoll;
  stop.wake = () => {
    if (stopped) return;
    idle = 0;
    if (running) {
      wakeRequested = true;
      return;
    }
    clearTimeout(timer);
    void refresh();
  };
  return stop;
}
