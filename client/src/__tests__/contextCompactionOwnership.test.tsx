import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatContextWindow } from '@/components/chat/ChatContextWindow';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
let handler: (event: Record<string, unknown>) => void;
const subscribe = (_name: string, callback: typeof handler) => { handler = callback; return () => undefined; };
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const contextData = (threadId: number, usagePercent: number) => ({ threadId, messageCount: 140, canCompact: true, summary: null, lastCompactedAt: null,
  tokenUsage: { totalTokens: 10000, promptTokens: 9000, completionTokens: 1000,
    estimatedCurrentContextTokens: 10000, maxContextTokens: 10000, modelName: 'test', usagePercent } });

it('does not replace a newer WebSocket snapshot with a late HTTP response', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise(done => { resolve = done; }) as never);
  render(<ChatContextWindow threadId={91} />);
  await act(async () => { handler({ ...contextData(91, 60), thread_id: 91 }); });
  await screen.findByRole('button', { name: /Context usage: 60%/ });
  await act(async () => { resolve(contextData(91, 95)); });
  expect(screen.getByRole('button', { name: /Context usage: 60%/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Context usage: 95%/ })).not.toBeInTheDocument();
});

it('hides the old conversation immediately and rejects a wrong-thread HTTP payload', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.get).mockResolvedValueOnce(contextData(91, 80) as never)
    .mockReturnValueOnce(new Promise(done => { resolve = done; }) as never);
  const view = render(<ChatContextWindow threadId={91} />);
  await screen.findByRole('button', { name: /Context usage: 80%/ });
  view.rerender(<ChatContextWindow threadId={92} />);
  expect(screen.queryByRole('button', { name: /Context usage: 80%/ })).not.toBeInTheDocument();
  await act(async () => { resolve(contextData(91, 90)); });
  expect(screen.queryByRole('button', { name: /Context usage:/ })).not.toBeInTheDocument();
});

it('ignores old conversation requests and unrelated WebSocket updates after switching', async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise(done => { resolveOld = done; }) as never)
    .mockResolvedValueOnce(contextData(92, 45) as never);
  const view = render(<ChatContextWindow threadId={91} />);
  view.rerender(<ChatContextWindow threadId={92} />);
  await screen.findByRole('button', { name: /Context usage: 45%/ });
  await act(async () => {
    resolveOld(contextData(91, 90));
    handler({ ...contextData(91, 95), thread_id: 91 });
  });
  expect(screen.getByRole('button', { name: /Context usage: 45%/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Context usage: 9/ })).not.toBeInTheDocument();
});

it('does not reuse a previous mounted session summary from a global cache', async () => {
  vi.mocked(api.get).mockResolvedValueOnce(contextData(91, 80) as never).mockResolvedValueOnce(contextData(91, 55) as never);
  const view = render(<ChatContextWindow threadId={91} />);
  await screen.findByRole('button', { name: /Context usage: 80%/ });
  view.unmount();
  render(<ChatContextWindow threadId={91} />);
  await screen.findByRole('button', { name: /Context usage: 55%/ });
  expect(api.get).toHaveBeenCalledTimes(2);
});

it('never starts paid compaction from a full meter or repeated context updates', async () => {
  const data = { threadId: 999001, messageCount: 140, canCompact: true, summary: null, lastCompactedAt: null,
    tokenUsage: { totalTokens: 10000, promptTokens: 9000, completionTokens: 1000,
      estimatedCurrentContextTokens: 10000, maxContextTokens: 10000, modelName: 'test', usagePercent: 100 } };
  vi.mocked(api.get).mockResolvedValue(data as never);
  render(<ChatContextWindow threadId={999001} />);
  await screen.findByRole('button', { name: /Context usage: 100%/ });
  await act(async () => { handler({ ...data, thread_id: data.threadId }); });
  await act(async () => { handler({ ...data, thread_id: data.threadId }); });
  expect(api.post).not.toHaveBeenCalled();
});
