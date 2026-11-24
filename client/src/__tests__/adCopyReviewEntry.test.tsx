import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdCopyTab from '@/components/tabs/content-studio/AdCopyTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const push = vi.fn();
const handlers = new Map<string, (event: Record<string, unknown>) => void>();
const subscribe = (name: string, handler: (event: Record<string, unknown>) => void) => {
  handlers.set(name, handler);
  return () => { if (handlers.get(name) === handler) handlers.delete(name); };
};
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/components/modals', () => ({
  PublishCampaignModal: ({ open }: { open: boolean }) => open ? <div>Legacy publish modal</div> : null,
  EditAdModal: () => null,
  ContentFullscreenModal: () => null,
}));
const assets = [
  { id: 114, type: 'ad_copy', title: 'Selected Meta creative', content: '{"headline":"Selected Meta creative"}', channel: 'meta', version: 3, createdAt: '2026-08-21T00:00:00Z' },
  { id: 115, type: 'ad_copy', title: 'Other Google creative', content: '{"headline":"Other Google creative"}', channel: 'google', createdAt: '2026-08-21T00:00:00Z' },
];

describe('ad card conversational campaign review entry', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue(assets as never); });
  afterEach(cleanup);

  it('shows a retryable load failure instead of claiming the library is empty', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(assets as never);
    render(<AdCopyTab threadId={171} onSendMessage={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ad copy could not be loaded');
    expect(screen.queryByText('No Ad Copy Yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading ad copy' }));
    await screen.findAllByText('Selected Meta creative');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('separates no search matches from an empty library and disables bulk review', async () => {
    render(<AdCopyTab threadId={171} onSendMessage={vi.fn()} />);
    await screen.findAllByText('Selected Meta creative');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search ad copy' }), { target: { value: 'no such creative' } });
    expect(screen.getByText('No matching creatives')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare campaign review' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'Prepare campaign review' })).toBeEnabled();
  });

  it('does not present Google previews as social posts or clickable live ads', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([assets[1]] as never);
    render(<AdCopyTab threadId={171} onSendMessage={vi.fn()} />);
    await screen.findAllByText('Other Google creative');
    expect(screen.getByText('Creative preview')).toBeInTheDocument();
    expect(screen.queryByText('Like')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish$/ })).not.toBeInTheDocument();
  });

  it('discards late assets from an old campaign and refreshes the current scope', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldRequest = new Promise(resolve => { resolveOld = resolve; });
    vi.mocked(api.get).mockImplementation((url: string) => (
      url.includes('threadId=171') ? oldRequest : Promise.resolve([assets[1]])
    ) as never);
    const send = vi.fn();
    const view = render(<AdCopyTab threadId={171} onSendMessage={send} />);
    view.rerender(<AdCopyTab threadId={178} onSendMessage={send} />);
    await screen.findAllByText('Other Google creative');
    await act(async () => { resolveOld([assets[0]]); });
    expect(screen.queryByText('Selected Meta creative')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare campaign review' }));
    expect(send.mock.calls[0][0]).toContain('"assetId":115');
    await act(async () => { handlers.get('content_asset_updated')?.({ type: 'ad_copy', threadId: 178 }); });
    expect(api.get).toHaveBeenLastCalledWith('/api/content/assets?type=ad_copy&threadId=178');
  });

  it('removes old publishable cards immediately while the new campaign loads', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([assets[0]] as never).mockReturnValueOnce(new Promise(() => undefined) as never);
    const send = vi.fn();
    const view = render(<AdCopyTab threadId={171} onSendMessage={send} />);
    await screen.findAllByText('Selected Meta creative');
    view.rerender(<AdCopyTab threadId={178} onSendMessage={send} />);
    expect(screen.queryByText('Selected Meta creative')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare campaign review' })).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('routes a single card to chat without opening or submitting the legacy modal', async () => {
    const send = vi.fn();
    render(<AdCopyTab threadId={171} onSendMessage={send} />);
    const buttons = await screen.findAllByRole('button', { name: 'Review this creative' });
    fireEvent.click(buttons[0]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('[{"assetId":114,"displayedRevision":3}]');
    expect(send.mock.calls[0][0]).not.toContain('115');
    expect(screen.queryByText('Legacy publish modal')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('uses only the visible filtered assets and preserves unknown revisions', async () => {
    const send = vi.fn();
    render(<AdCopyTab threadId={171} onSendMessage={send} />);
    await screen.findAllByText('Other Google creative');
    fireEvent.change(screen.getByPlaceholderText('Search ads...'), { target: { value: 'Other Google' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare campaign review' }));
    expect(send.mock.calls[0][0]).toContain('[{"assetId":115,"displayedRevision":null}]');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('preserves the clicked asset in details view as well', async () => {
    const send = vi.fn();
    render(<AdCopyTab threadId={171} onSendMessage={send} />);
    await screen.findAllByText('Other Google creative');
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Review this creative' })[1]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('[{"assetId":115,"displayedRevision":null}]');
    expect(screen.queryByText('Legacy publish modal')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('retains the standalone library entry when no conversational callback exists', async () => {
    render(<AdCopyTab threadId={171} />);
    await screen.findAllByText('Other Google creative');
    fireEvent.click(screen.getAllByRole('button', { name: 'Review this creative' })[0]);
    expect(push).toHaveBeenCalledWith('/dashboard/conversations?campaignAssetId=114');
    expect(api.post).not.toHaveBeenCalled();
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/use-content-brand-context", () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock("@/components/content-studio/GenerationEstimate", () => ({ GenerationEstimate: () => null }));
