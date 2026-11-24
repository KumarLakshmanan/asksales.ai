import { afterEach, describe, expect, it, vi } from "vitest";
import { startWidgetHistoryPoll } from "@/lib/widget-history-poll";
afterEach(() => vi.useRealTimers());
describe("public widget history polling", () => {
  it("does not poll hidden tabs, resumes when visible, and unsubscribes", async () => {
    vi.useFakeTimers();
    let visible = false;
    let change = () => {};
    const unsubscribe = vi.fn();
    const read = vi.fn(async () => true);
    const stop = startWidgetHistoryPoll({
      read,
      visible: () => visible,
      onVisibility: (listener) => {
        change = listener;
        return unsubscribe;
      },
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).not.toHaveBeenCalled();
    visible = true;
    change();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    visible = false;
    change();
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("does not overlap requests and backs off after a transient failure", async () => {
    vi.useFakeTimers();
    let resolve!: (value: boolean) => void;
    const read = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const stop = startWidgetHistoryPoll({
      read,
      visible: () => true,
      onVisibility: () => () => {},
      timeout: 60000,
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(read).toHaveBeenCalledTimes(1);
    resolve(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(9999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
  it("aborts a timed-out request and an in-flight request when stopped", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const read = vi.fn((incoming: AbortSignal) => {
      signal = incoming;
      return new Promise<boolean>((resolve) =>
        incoming.addEventListener("abort", () => resolve(false)),
      );
    });
    const stop = startWidgetHistoryPoll({
      read,
      visible: () => true,
      onVisibility: () => () => {},
      timeout: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    expect(signal.aborted).toBe(true);
  });
  it("slows an idle conversation down and returns to the fast interval on activity", async () => {
    vi.useFakeTimers();
    let active = false;
    const read = vi.fn(async () => ({ success: true, active }));
    const stop = startWidgetHistoryPoll({
      read,
      visible: () => true,
      onVisibility: () => () => {},
      interval: 5000,
      idleInterval: 30000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29999);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(4);
    active = true;
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(6);
    stop();
  });
  it("wake() polls immediately, including after an in-flight read", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { success: boolean; active: boolean }) => void;
    const read = vi.fn(() => new Promise<{ success: boolean; active: boolean }>((done) => { resolve = done; }));
    const stop = startWidgetHistoryPoll({
      read,
      visible: () => true,
      onVisibility: () => () => {},
      idleInterval: 30000,
      timeout: 60000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    stop.wake();
    expect(read).toHaveBeenCalledTimes(1);
    resolve({ success: true, active: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    stop.wake();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
