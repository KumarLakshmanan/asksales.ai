import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoCreator from '@/components/content-studio/creators/VideoCreator';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9, toolkit: {} }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));
vi.mock('@/components/content-cards', () => ({ VideoCard: () => null }));
vi.mock('@/components/content-studio/ContentCreatorShell', () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { ContentCreatorShell: Wrapper, ContentCreatorHeader: Wrapper, ContentCreatorBody: Wrapper, ContentCreatorComposer: Wrapper, CreatorResultsPane: Wrapper, ContentCreatorStage: ({ preview, children }: { preview: React.ReactNode; children: React.ReactNode }) => <div>{preview}{children}</div> };
});
const pending = { id: 123, type: 'video', title: 'Synthetic saved video', content: '{}', status: 'pending', createdAt: '2026-10-23', performance: { operationName: 'operations/synthetic' } };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('CS17 saved video feedback does not invite duplicate generation', () => {
  it('counts accepted queued jobs when another requested video fails', async () => {
    let accepted = false;
    mocks.get.mockImplementation(async () => accepted ? [{ ...pending, performance: { mediaGeneration: { video: { status: 'queued' } } } }] : []);
    mocks.post.mockImplementationOnce(async () => { accepted = true; return { success: true, persisted: true, assetId: 123, jobId: 'content-video-123-0' }; })
      .mockRejectedValueOnce(new Error('Synthetic submission failure'));
    render(<VideoCreator />);
    fireEvent.click(screen.getByRole('button', { name: 'Generation Settings' }));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.change(screen.getByLabelText('Video Prompt'), { target: { value: 'Reviewed synthetic scene' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate 2 Videos' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Generation partially completed', description: '0 completed, 1 queued, 1 failed of 2 requested. Synthetic submission failure',
    })));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(screen.getByText('1 video request is pending')).toBeInTheDocument();
  });
  it('announces paused polling, keeps the saved job and refreshes that operation without another submission', async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async (url: string) => url.includes('/video/status/') ? { success: true, done: false } : [pending]);
    render(<VideoCreator />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(mocks.get.mock.calls.filter(([url]) => url.includes('/video/status/'))).toHaveLength(120);
    expect(screen.getByText(/Automatic status checks have paused/)).toBeInTheDocument();
    expect(screen.getByText('1 video request is pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved video status' }));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.get).toHaveBeenLastCalledWith('/api/content/studio/video/status/operations%2Fsynthetic');
    expect(mocks.get.mock.calls.filter(([url]) => url.includes('/video/status/'))).toHaveLength(121);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('does not show a pause notice when the saved operation completes at the polling limit', async () => {
    vi.useFakeTimers(); let polls = 0;
    mocks.get.mockImplementation(async (url: string) => {
      if (!url.includes('/video/status/')) return polls < 120 ? [pending] : [{ ...pending, status: 'draft', videoUrl: '/uploads/synthetic.mp4' }];
      polls += 1;
      return polls < 120 ? { success: true, done: false } : { success: true, done: true, persisted: true, assetId: 123, videoUrl: '/uploads/synthetic.mp4' };
    });
    render(<VideoCreator />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Video ready' }));
    expect(screen.queryByText(/Automatic status checks have paused/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('keeps a refresh action after repeated transport failures without calling generation', async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async (url: string) => { if (url.includes('/video/status/')) throw new Error('Synthetic status outage'); return [pending]; });
    render(<VideoCreator />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Video status unavailable' }));
    expect(screen.getByRole('button', { name: 'Refresh saved video status' })).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
