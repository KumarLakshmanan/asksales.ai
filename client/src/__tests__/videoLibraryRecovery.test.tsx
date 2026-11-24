import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VideoTab from '@/components/tabs/content-studio/VideoTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/content-cards', () => ({ VideoCard: () => null }));
vi.mock('@/components/modals/PublishContentDialog', () => ({ default: () => null }));
const pending = [{ id: 123, type: 'video', title: 'Resort tour', content: '{}', status: 'pending', createdAt: '2026-09-01', performance: { operationName: 'operations/tour' } }];
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('recovers a saved operation after reload and stops polling on unmount', async () => {
  vi.mocked(api.get).mockResolvedValueOnce(pending as never).mockResolvedValue({ success: true, done: false } as never);
  const view = render(<VideoTab threadId={171} />);
  await act(async () => {});
  expect(screen.getByText('1 video request is pending')).toBeInTheDocument();
  expect(screen.queryByText('No Videos Yet')).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(api.get).toHaveBeenLastCalledWith('/api/content/studio/video/status/operations%2Ftour');
  view.unmount();
  const calls = vi.mocked(api.get).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(api.get).toHaveBeenCalledTimes(calls);
});

it('does not overlap slow provider status requests', async () => {
  vi.mocked(api.get).mockResolvedValueOnce(pending as never).mockReturnValue(new Promise(() => {}) as never);
  render(<VideoTab threadId={171} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(api.get).toHaveBeenCalledTimes(2);
});

it('ignores an old library response after a campaign switch', async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }) as never).mockResolvedValue([] as never);
  const view = render(<VideoTab threadId={171} />);
  view.rerender(<VideoTab threadId={172} />);
  await act(async () => { resolveOld(pending); });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(api.get).toHaveBeenCalledTimes(2);
});

it.each([true, false])('accepts completion only for the exact persisted asset: %s', async matches => {
  vi.mocked(api.get).mockResolvedValueOnce(pending as never).mockResolvedValueOnce({
    success: true, done: true, persisted: true, assetId: matches ? 123 : 999, videoUrl: '/uploads/tour.mp4',
  } as never).mockResolvedValue([] as never);
  const onContentCreated = vi.fn();
  render(<VideoTab threadId={171} onContentCreated={onContentCreated} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(onContentCreated).toHaveBeenCalledTimes(matches ? 1 : 0);
  if (!matches) expect(screen.getByText('1 video request is pending')).toBeInTheDocument();
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-content-brand-context", () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock("@/components/content-studio/GenerationEstimate", () => ({ GenerationEstimate: () => null }));
vi.mock("@/contexts/WebSocketContext", () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));

const queued = [{ id: 124, type: 'video', title: 'Queued clip', content: '{}', status: 'pending', createdAt: '2026-09-01', performance: { mediaGeneration: { video: { status: 'queued' } } } }];
const setVisibility = (state: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

it('skips the background library refresh while the tab is hidden and catches up when visible', async () => {
  vi.mocked(api.get).mockResolvedValue(queued as never);
  render(<VideoTab threadId={171} />);
  await act(async () => {});
  const initial = vi.mocked(api.get).mock.calls.length;
  setVisibility('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.get).toHaveBeenCalledTimes(initial);
  setVisibility('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(api.get).toHaveBeenCalledTimes(initial + 1);
});

it('does not start a library refresh while the previous one is still loading', async () => {
  setVisibility('visible');
  vi.mocked(api.get).mockResolvedValueOnce(queued as never).mockReturnValue(new Promise(() => {}) as never);
  render(<VideoTab threadId={171} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
  expect(api.get).toHaveBeenCalledTimes(2);
});
