const threadMutexes = new Map<string, Promise<void>>();

/**
 * FIFO mutex keyed by tenant and thread. The promise stored for each waiter
 * includes its own gate, so later callers cannot enter until every earlier
 * caller has explicitly released.
 */
export async function acquireConversationThreadMutex(
  userId: number,
  threadId: number,
): Promise<{ release: () => void }> {
  const key = `${userId}:${threadId}`;
  const previous = threadMutexes.get(key) || Promise.resolve();

  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const current = previous
    .catch(() => undefined)
    .then(() => gate);

  threadMutexes.set(key, current);
  await previous.catch(() => undefined);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      openGate();
      if (threadMutexes.get(key) === current) {
        threadMutexes.delete(key);
      }
    },
  };
}
