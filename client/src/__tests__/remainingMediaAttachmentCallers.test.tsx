import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MediaManager from '@/components/MediaManager';
import AdCopyTab from '@/components/tabs/content-studio/AdCopyTab';
import SocialPostsPage from '@/app/dashboard/(main)/saved-templates/social/page';

const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), get: vi.fn(), toast: vi.fn(), push: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/modals', () => ({ PublishCampaignModal: () => null, EditAdModal: () => null, ContentFullscreenModal: () => null }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));
vi.mock('@/components/modals/EditAdModal', () => ({ default: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null }));
vi.mock('@/components/content-cards', () => {
  const Card = ({ onGenerateImage, onGenerateVideo, content, imageUrl, videoUrl, isGeneratingImage, isGeneratingVideo, onEdit }: { onEdit?: () => void; onGenerateImage: (prompt: string) => void; onGenerateVideo: (prompt: string) => void; content?: string; imageUrl?: string; videoUrl?: string; isGeneratingImage?: boolean; isGeneratingVideo?: boolean }) => {
    const parsed = content ? JSON.parse(content) as { imageUrl?: string; videoUrl?: string } : {};
    return <article>
    <button onClick={onEdit}>Edit saved creative</button>
    <span>{imageUrl || parsed.imageUrl}</span><span>{videoUrl || parsed.videoUrl}</span>
    <button disabled={isGeneratingImage} onClick={() => onGenerateImage('Reviewed attached image')}>Generate attachment image</button>
    <button disabled={isGeneratingVideo} onClick={() => onGenerateVideo('Reviewed attached video')}>Generate attachment video</button>
  </article>;
  };
  return { AdCopyCard: Card, SocialPostCard: Card };
});

type Surface = 'manager' | 'ad-sidebar' | 'social-library';
const clients: QueryClient[] = [];
async function setupSurface(surface: Surface, kind: 'image' | 'video') {
  const onMediaChange = vi.fn();
  if (surface === 'manager') {
    render(<MediaManager images={[]} videos={[]} assetId="db-812" threadId={171} onMediaChange={onMediaChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
    return { button: screen.getByRole('button', { name: kind === 'video' ? 'Generate Video' : 'Generate Image' }), onMediaChange };
  }
  if (surface === 'ad-sidebar') {
    render(<AdCopyTab threadId={171} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit saved creative' }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
    return { button: screen.getByRole('button', { name: kind === 'video' ? 'Generate Video' : 'Generate Image' }), onMediaChange };
  }
  else {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><SocialPostsPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Saved social' }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
    return { button: screen.getByRole('button', { name: kind === 'video' ? 'Generate Video' : 'Generate Image' }), onMediaChange };
  }
}

describe('remaining media callers use the exact saved parent and provider receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.post.mockReset();
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/content/templates?') ? { templates: [], total: 0 } : path === '/api/content/assets/812' ? { id: 812, type: 'social_post', title: 'Saved social', content: 'Reviewed post', channel: 'instagram', createdAt: '2026-09-01T00:00:00Z' } : path.includes('type=ad_copy')
      ? [{ id: 812, type: 'ad_copy', title: 'Saved creative', content: JSON.stringify({ headline: 'Reviewed headline', primaryText: 'Reviewed body' }), channel: 'meta', createdAt: '2026-09-01T00:00:00Z' }]
      : path.includes('type=social_post')
        ? [{ id: 812, type: 'social_post', title: 'Saved social', content: JSON.stringify({ caption: 'Reviewed post' }), channel: 'instagram', createdAt: '2026-09-01T00:00:00Z' }]
        : []));
  });
  afterEach(() => { for (const client of clients.splice(0)) client.clear(); });

  for (const surface of ['manager', 'ad-sidebar', 'social-library'] as const) {
    it.each(['saved', 'queued', 'unconfirmed', 'wrong-parent'] as const)(`${surface}: video outcome %s retains parent identity without a duplicate asset write`, async (outcome) => {
      const response = { success: true, persisted: outcome !== 'unconfirmed', assetId: outcome === 'wrong-parent' ? 999 : 812, ...(outcome === 'queued' ? { operationName: 'operations/attached-parent' } : { videoUrl: '/uploads/attached-parent.mp4' }) };
      mocks.post.mockResolvedValue(response);
      const { button, onMediaChange } = await setupSurface(surface, 'video');
      fireEvent.click(button);
      await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/studio/video', expect.objectContaining({ assetId: 812, saveToAssets: true })));
      if (surface !== 'social-library') expect(mocks.post.mock.calls[0][1].threadId).toBe(171);
      const title = outcome === 'saved' ? 'Video attached' : outcome === 'queued' ? 'Video generation queued' : 'Error';
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title })));
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.put).not.toHaveBeenCalled();
      if (surface === 'manager') {
        if (outcome === 'saved') expect(onMediaChange).toHaveBeenCalledExactlyOnceWith([], ['/uploads/attached-parent.mp4']);
        else expect(onMediaChange).not.toHaveBeenCalled();
      }
      if (surface === 'ad-sidebar') {
        if (outcome === 'saved') expect(document.querySelector('video[src$="attached-parent.mp4"]')).toBeInTheDocument();
        else expect(screen.queryByText('/uploads/attached-parent.mp4')).not.toBeInTheDocument();
      }
      if (outcome === 'queued') expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: expect.stringContaining('not ready yet') }));
      if (outcome === 'unconfirmed' || outcome === 'wrong-parent') expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    it.each([true, false])(`${surface}: image receipt matches the intended parent: %s`, async (confirmed) => {
      mocks.post.mockResolvedValue({ success: true, persisted: true, assetId: confirmed ? 812 : 999, imageUrl: '/uploads/attached-parent.png' });
      const { button, onMediaChange } = await setupSurface(surface, 'image');
      fireEvent.click(button);
      await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/studio/image', expect.objectContaining({ assetId: 812, saveToAssets: true })));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: confirmed ? 'Image attached' : 'Error' })));
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.put).not.toHaveBeenCalled();
      if (surface === 'manager') {
        if (confirmed) expect(onMediaChange).toHaveBeenCalledExactlyOnceWith(['/uploads/attached-parent.png'], []);
        else expect(onMediaChange).not.toHaveBeenCalled();
      }
    });
  }

  it('blocks an unsaved media-manager parent before invoking a provider', async () => {
    render(<MediaManager images={[]} videos={[]} assetId="gen-local" onMediaChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate Image' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', description: 'Save the content before attaching media.' })));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('locks repeated media-manager submissions while a provider response is pending', async () => {
    mocks.post.mockImplementation(() => new Promise(() => undefined));
    const { button } = await setupSurface('manager', 'image');
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
