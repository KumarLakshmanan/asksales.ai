import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSupportRealtimeRefresh } from '@/hooks/use-support-realtime-refresh';
const mocks = vi.hoisted(() => ({ events: new Map<string, (value: unknown) => void>() }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ isConnected: true, subscribe }) }));
function subscribe(name: string, callback: (value: unknown) => void) { mocks.events.set(name, callback); return () => mocks.events.delete(name); }
beforeEach(() => { mocks.events.clear(); });
afterEach(cleanup);
describe('support realtime refresh coalescing', () => {
  it('keeps one refresh in flight and combines a burst into one subsequent fresh read', async () => {
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    renderHook(() => useSupportRealtimeRefresh(refresh));
    await act(async () => { mocks.events.get('events:notification')!({ type: 'support_ticket_updated' }); });
    await act(async () => { for (let index = 0; index < 10; index++) mocks.events.get('events:notification')!({ type: 'support_ticket_updated' }); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('does not start a queued refresh after unmounting', async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const page = renderHook(() => useSupportRealtimeRefresh(refresh));
    await act(async () => { mocks.events.get('websocket_connected')!({}); });
    await act(async () => { mocks.events.get('websocket_connected')!({}); });
    page.unmount();
    await act(async () => { finish(); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
