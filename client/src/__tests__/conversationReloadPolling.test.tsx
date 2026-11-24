import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChat } from '@/hooks/useChat';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), send: vi.fn(() => 'sent') }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/services/WebSocketService', () => ({ default: {
  send: mocks.send, subscribe: () => () => undefined,
} }));
beforeEach(() => { vi.useFakeTimers(); mocks.get.mockReset(); mocks.send.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); sessionStorage.clear(); });

it.each(['completed', 'cancelled', 'uncertain'])('releases processing after a reloaded running turn becomes %s without a websocket receipt', async status => {
  mocks.get.mockResolvedValueOnce([{ request_id: 'before-reload', status: 'running' }])
    .mockResolvedValue([{ request_id: 'before-reload', status }]);
  const hook = renderHook(() => useChat('', async () => undefined));
  await act(async () => { hook.result.current.setCurrentThreadId(42); });
  expect(hook.result.current.isProcessing).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(hook.result.current.isProcessing).toBe(false);
  expect(hook.result.current.isProcessingRef.current).toBe(false);
});

it('does not release a newly submitted turn using a status read that began before submission', async () => {
  let finishRead!: (value: unknown) => void;
  mocks.get.mockResolvedValueOnce([{ request_id: 'before-reload', status: 'running' }])
    .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const hook = renderHook(() => useChat('', async () => undefined));
  await act(async () => { hook.result.current.setCurrentThreadId(42); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  await act(async () => { await hook.result.current.handleSendMessage('A new queued question'); });
  await act(async () => { finishRead([{ request_id: 'before-reload', status: 'completed' }]); });
  expect(hook.result.current.isProcessing).toBe(true);
});

it('keeps status reads serial so a delayed running snapshot cannot overwrite a newer terminal snapshot', async () => {
  let finishRead!: (value: unknown) => void;
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
    .mockResolvedValue([]);
  const hook = renderHook(() => useChat('', async () => undefined));
  await act(async () => { hook.result.current.setCurrentThreadId(42); });
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(mocks.get).toHaveBeenCalledTimes(1);
  await act(async () => { finishRead([{ request_id: 'before-reload', status: 'running' }]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(hook.result.current.isProcessing).toBe(false);
});

it('reads turn status every 15 seconds, not every 3, while the conversation is idle', async () => {
  mocks.get.mockResolvedValue([{ request_id: 'done', status: 'completed' }]);
  const hook = renderHook(() => useChat('', async () => undefined));
  await act(async () => { hook.result.current.setCurrentThreadId(42); });
  expect(mocks.get).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(mocks.get).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(mocks.get).toHaveBeenCalledTimes(2);
});

it('keeps the fast read while a turn is in flight', async () => {
  mocks.get.mockResolvedValue([{ request_id: 'live', status: 'running' }]);
  const hook = renderHook(() => useChat('', async () => undefined));
  await act(async () => { hook.result.current.setCurrentThreadId(42); });
  await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
  expect(mocks.get).toHaveBeenCalledTimes(4);
  expect(hook.result.current.isProcessing).toBe(true);
});

it('does not restore an old running snapshot after a newer turn has already finished', async () => {
  let finishRead!: (value: unknown) => void;
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const hook = renderHook(() => useChat('', async () => undefined));
  await act(async () => { hook.result.current.setCurrentThreadId(42); });
  await act(async () => { await hook.result.current.handleSendMessage('New question'); });
  act(() => hook.result.current.setIsProcessing(false));
  await act(async () => { finishRead([{ request_id: 'old-turn', status: 'running' }]); });
  expect(hook.result.current.isProcessing).toBe(false);
});
