import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationTurnStatus } from '@/components/conversation/ConversationTurnStatus';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get, post } }));
vi.mock('@/lib/support-api', () => ({ supportApi: { get, post } }));
beforeEach(() => { get.mockReset(); post.mockReset().mockResolvedValue({}); });
afterEach(cleanup);
it('renders a reloaded queue and cancels the specific queued request', async () => {
  get.mockResolvedValue([{ request_id: 'request-queued',status: 'queued' }]);
  render(<ConversationTurnStatus basePath="/api/chat/threads/1" />);
  fireEvent.click(await screen.findByRole('button',{ name: 'Cancel queued message' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/chat/threads/1/stop',expect.objectContaining({ requestId: 'request-queued' })));
});
it('ignores an old status response after switching conversations', async () => {
  let resolve!: (value: unknown) => void;
  get.mockReturnValueOnce(new Promise(r => { resolve=r; })).mockResolvedValue([]);
  const view = render(<ConversationTurnStatus basePath="/api/chat/threads/1" />);
  view.rerender(<ConversationTurnStatus basePath="/api/chat/threads/2" />);
  await act(async () => { resolve([{request_id:'old-request',status:'uncertain'}]); });
  expect(screen.queryByRole('textbox',{name:'Turn review note'})).not.toBeInTheDocument();
});
it('reads every 15 seconds while idle when asked, and at once when a turn starts', async () => {
  vi.useFakeTimers();
  try {
    get.mockResolvedValue([]);
    const view = render(<ConversationTurnStatus basePath="/api/chat/threads/1" idlePollMs={15_000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(get).toHaveBeenCalledTimes(2);
    get.mockResolvedValue([{ request_id: 'live', status: 'running' }]);
    view.rerender(<ConversationTurnStatus basePath="/api/chat/threads/1" idlePollMs={15_000} active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(get).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); }
});
it('keeps the 3-second read by default', async () => {
  vi.useFakeTimers();
  try {
    get.mockResolvedValue([]);
    render(<ConversationTurnStatus basePath="/api/support/ai/sessions/2" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(get).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});
it('requires a verification note before resolving an interrupted turn', async () => {
  get.mockResolvedValue([{ request_id: 'request-uncertain',status: 'uncertain' }]);
  render(<ConversationTurnStatus basePath="/api/support/ai/sessions/2" />);
  const button = await screen.findByRole('button',{ name: 'Record review and allow next message' }); expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox',{ name: 'Turn review note' }),{ target: { value: 'Verified the saved tool receipt.' } });
  fireEvent.click(button); await waitFor(() => expect(post).toHaveBeenCalledWith('/api/support/ai/sessions/2/reconcile',{ requestId: 'request-uncertain',note: 'Verified the saved tool receipt.' }));
});
