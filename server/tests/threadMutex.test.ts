import { describe, expect, it } from '@jest/globals';
import { acquireConversationThreadMutex } from '../services/agents/ThreadMutex.js';

describe('conversation thread mutex', () => {
  it('serializes work for the same tenant thread in FIFO order', async () => {
    const first = await acquireConversationThreadMutex(7, 42);
    let secondEntered = false;
    const secondPromise = acquireConversationThreadMutex(7, 42).then((lock) => {
      secondEntered = true;
      return lock;
    });

    await Promise.resolve();
    expect(secondEntered).toBe(false);
    first.release();

    const second = await secondPromise;
    expect(secondEntered).toBe(true);
    second.release();
  });

  it('does not block a different tenant or thread', async () => {
    const held = await acquireConversationThreadMutex(7, 42);
    const otherTenant = await acquireConversationThreadMutex(8, 42);
    const otherThread = await acquireConversationThreadMutex(7, 43);

    otherTenant.release();
    otherThread.release();
    held.release();
  });

  it('makes release idempotent without admitting two waiters together', async () => {
    const first = await acquireConversationThreadMutex(7, 99);
    const secondPromise = acquireConversationThreadMutex(7, 99);
    const thirdPromise = acquireConversationThreadMutex(7, 99);

    first.release();
    first.release();
    const second = await secondPromise;

    let thirdEntered = false;
    void thirdPromise.then(() => {
      thirdEntered = true;
    });
    await Promise.resolve();
    expect(thirdEntered).toBe(false);

    second.release();
    const third = await thirdPromise;
    third.release();
  });
});
