// Background refresh guard shared by timer polls.
//
// - `poll()` is for timer ticks: it skips while the tab is hidden and while a
//   refresh is still running, so a read slower than the interval never stacks
//   up overlapping requests against a busy server.
// - `run()` is for explicit triggers (first load, socket event, user action):
//   while a refresh is running it queues exactly one follow-up instead of
//   starting a parallel request, so the event is not lost.
// - `stop()` cancels any queued follow-up (call it from effect cleanup).
export interface GuardedRefresh {
  run: () => Promise<void>;
  poll: () => void;
  stop: () => void;
  readonly inFlight: boolean;
}

export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function createGuardedRefresh(refresh: () => Promise<unknown>): GuardedRefresh {
  let running: Promise<void> | null = null;
  let queued = false;
  let stopped = false;

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          queued = false;
          await Promise.resolve(refresh()).catch(() => undefined);
        } while (queued && !stopped);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    run,
    poll: () => {
      if (stopped || running || isDocumentHidden()) return;
      void run();
    },
    stop: () => {
      stopped = true;
      queued = false;
    },
    get inFlight() {
      return running !== null;
    },
  };
}
