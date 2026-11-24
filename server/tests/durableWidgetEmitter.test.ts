import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const publish = jest.fn<any>();
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { publish } }));
const { WebSocketEmitter } = await import('../services/agents/WebSocketEmitter.js');
const widget = { id: 40, userId: 7, threadId: 171, status: 'succeeded' };
beforeEach(() => { publish.mockReset(); publish.mockResolvedValue(undefined); });

describe('awaited widget event publication', () => {
  it('does not acknowledge before the bus accepts and preserves replay identity', async () => {
    let accept!: () => void;
    publish.mockReturnValueOnce(new Promise<void>(resolve => { accept = resolve; }));
    const emitter = new WebSocketEmitter();
    let settled = false;
    const pending = emitter.emitPersistedWidgetUpdate(7, 171, widget, 'completion:40').then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    accept();
    await pending;
    await emitter.emitPersistedWidgetUpdate(7, 171, widget, 'completion:40');
    for (const [event] of publish.mock.calls) expect(event).toEqual(expect.objectContaining({
      channel: 'events:ws:widget_update', messageId: 'completion:40', userId: 7, threadId: 171,
      data: expect.objectContaining({ event_id: 'completion:40', eventId: 'completion:40', thread_id: 171, widget }),
    }));
  });
  it('propagates transport failure to the outbox dispatcher', async () => {
    publish.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(new WebSocketEmitter().emitPersistedWidgetUpdate(7, 171, widget, 'completion:40')).rejects.toThrow('Redis unavailable');
  });
  it.each([[0, 171], [7, 0], [8, 171], [7, 172]])('rejects missing or mismatched scope: %s/%s', async (userId, threadId) => {
    await expect(new WebSocketEmitter().emitPersistedWidgetUpdate(userId, threadId, widget, 'completion:40')).rejects.toThrow('matching owner');
    expect(publish).not.toHaveBeenCalled();
  });
});
