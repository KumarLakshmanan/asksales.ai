import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OverviewTab from '@/components/tabs/OverviewTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
const handlers = new Map<string, (event: Record<string, unknown>) => void>();
const subscribe = (name: string, handler: (event: Record<string, unknown>) => void) => {
  handlers.set(name, handler);
  return () => { if (handlers.get(name) === handler) handlers.delete(name); };
};
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
const overview = (id: number, count: number) => ({
  thread: { id }, stats: { leadsCount: count, outreachCount: 0, scrapingCount: 0 },
  icp: null, activeAgents: [], workflowExecutions: [],
  timeline: [{ id: 'event', type: 'workflow_event', title: 'Recorded result', description: 'Stored outcome', timestamp: new Date().toISOString() }],
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

describe('overview request isolation and recovery', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => { cleanup(); handlers.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('ignores other-thread and unscoped events, but coalesces current-thread refreshes', async () => {
    vi.mocked(api.get).mockResolvedValue(overview(42, 222) as never);
    render(<OverviewTab threadId={42} />);
    await screen.findByText('222');
    vi.useFakeTimers();
    await act(async () => {
      handlers.get('workflow_completed')?.({ threadId: 41 });
      handlers.get('workflow_completed')?.({});
      handlers.get('workflow_completed')?.({ threadId: 42, __envelope: { threadId: 41 } });
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      handlers.get('workflow_completed')?.({ __envelope: { threadId: 42 } });
      handlers.get('execution_summary')?.({ thread_id: '42' });
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('reloads durable state after reconnect and cancels queued refresh on unmount', async () => {
    vi.mocked(api.get).mockResolvedValue(overview(42, 222) as never);
    const view = render(<OverviewTab threadId={42} />);
    await screen.findByText('222');
    vi.useFakeTimers();
    await act(async () => {
      handlers.get('websocket_connected')?.({});
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    act(() => { handlers.get('websocket_connected')?.({}); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(handlers.size).toBe(0);
  });

  it('discards a delayed response from the previous campaign', async () => {
    const old = deferred();
    vi.mocked(api.get).mockImplementation((url: string) => (url.includes('/41/') ? old.promise : Promise.resolve(overview(42, 222))) as never);
    const view = render(<OverviewTab threadId={41} />);
    view.rerender(<OverviewTab threadId={42} />);
    expect(await screen.findByText('222')).toBeInTheDocument();
    await act(async () => { old.resolve(overview(41, 111)); });
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    expect(screen.getByText('222')).toBeInTheDocument();
  });

  it('rejects a response scoped to another campaign and supports retry', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(overview(41, 111) as never).mockResolvedValueOnce(overview(42, 222) as never);
    render(<OverviewTab threadId={42} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load');
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading overview' }));
    expect(await screen.findByText('222')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the latest refresh when same-campaign requests finish out of order', async () => {
    const older = deferred();
    vi.mocked(api.get).mockResolvedValueOnce(overview(42, 111) as never)
      .mockReturnValueOnce(older.promise as never).mockResolvedValueOnce(overview(42, 333) as never);
    render(<OverviewTab threadId={42} />);
    await screen.findByText('111');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('333')).toBeInTheDocument();
    await act(async () => { older.resolve(overview(42, 222)); });
    expect(screen.queryByText('222')).not.toBeInTheDocument();
    expect(screen.getByText('333')).toBeInTheDocument();
  });

  it('retains same-campaign data with a visible stale warning after refresh failure', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(overview(42, 222) as never).mockRejectedValueOnce(new Error('offline'));
    render(<OverviewTab threadId={42} />);
    await screen.findByText('222');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Showing the last loaded overview');
    expect(screen.getByText('222')).toBeInTheDocument();
  });
});
