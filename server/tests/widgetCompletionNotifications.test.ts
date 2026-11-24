import { describe, expect, it, jest } from '@jest/globals';
import { dispatchWidgetCompletionNotifications } from '../mastra/widgetCompletionNotifications.js';
import type { WidgetState } from '../models/widgetStates/schema.js';

const widget = (id: number) => ({ id, userId: 7, threadId: 171, status: 'failed', executionResult: {
  completionNotification: { status: 'pending', eventId: `widget-stop-completed:${id}` },
  output: { message: 'Provider pause failed' },
} } as WidgetState);

describe('durable widget completion notifications', () => {
  it('resumes during a gateway outage and retries the same notification after recovery', async () => {
    const emit = jest.fn<any>().mockRejectedValueOnce(new Error('gateway unavailable')).mockResolvedValue(undefined);
    const resume = jest.fn<any>().mockResolvedValueOnce('resumed').mockResolvedValueOnce('completed');
    const acknowledge = jest.fn<any>();
    const onError = jest.fn();
    const deps = { pending: async () => [widget(1)], emit, resume, acknowledge, onError };
    expect(await dispatchWidgetCompletionNotifications(deps)).toBe(0);
    expect(resume).toHaveBeenCalledWith(widget(1));
    expect(acknowledge).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await dispatchWidgetCompletionNotifications(deps)).toBe(1);
    expect(emit.mock.calls[0]).toEqual(emit.mock.calls[1]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it.each(['waiting', 'failed'] as const)('retains %s continuation for a later sweep', async outcome => {
    const acknowledge = jest.fn<any>();
    const resume = jest.fn<any>().mockResolvedValueOnce(outcome).mockResolvedValueOnce('completed');
    const deps = { pending: async () => [widget(1)], emit: jest.fn(() => {}), resume, acknowledge, onError: jest.fn() };
    expect(await dispatchWidgetCompletionNotifications(deps)).toBe(0);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await dispatchWidgetCompletionNotifications(deps)).toBe(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('dispatches the durable result to its exact owner/thread before acknowledging', async () => {
    const calls: string[] = [];
    const emit = jest.fn<any>(async () => { calls.push('emit'); });
    const acknowledge = jest.fn<any>(async () => { calls.push('ack'); });
    expect(await dispatchWidgetCompletionNotifications({ pending: async () => [widget(1)], emit, acknowledge, onError: jest.fn() })).toBe(1);
    expect(emit).toHaveBeenCalledWith(7, 171, widget(1), 'widget-stop-completed:1');
    expect(acknowledge).toHaveBeenCalledWith(1, 7, 'widget-stop-completed:1');
    expect(calls).toEqual(['emit', 'ack']);
  });
  it('retains failed dispatches for retry and does not block other conversations', async () => {
    const emit = jest.fn<any>().mockRejectedValueOnce(new Error('gateway unavailable')).mockResolvedValue(undefined);
    const acknowledge = jest.fn<any>();
    const onError = jest.fn();
    const deps = { pending: async () => [widget(1), widget(2)], emit, acknowledge, onError };
    expect(await dispatchWidgetCompletionNotifications(deps)).toBe(1);
    expect(acknowledge).not.toHaveBeenCalledWith(1, 7, expect.anything());
    expect(onError).toHaveBeenCalledTimes(1);
    await dispatchWidgetCompletionNotifications({ ...deps, pending: async () => [widget(1)] });
    expect(emit.mock.calls[0][3]).toBe(emit.mock.calls[2][3]);
    expect(acknowledge).toHaveBeenLastCalledWith(1, 7, 'widget-stop-completed:1');
  });
  it('does not dispatch queued, unscoped or already dispatched work', async () => {
    const emit = jest.fn(() => {});
    await dispatchWidgetCompletionNotifications({ pending: async () => [
      { ...widget(1), status: 'queued' }, { ...widget(2), threadId: 0 },
      { ...widget(3), executionResult: { completionNotification: { status: 'dispatched', eventId: 'old' } } },
    ], emit, acknowledge: async () => {}, onError: jest.fn() });
    expect(emit).not.toHaveBeenCalled();
  });
});
