import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlogTab from '@/components/tabs/content-studio/BlogTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/MediaManager', () => ({ default: () => null }));
const asset = (id: number, title: string) => ({ id, title, type: 'blog_post', content: JSON.stringify({ title, introduction: 'A useful article.' }), createdAt: '2026-09-01T00:00:00Z' });

describe('blog library panel', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(cleanup);

  it('renders the current generator article body and copies complete Markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    // Copy uses the async Clipboard API only in a secure context; jsdom reports false by default.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    const body = '## Practical follow-ups\n\nA complete article about a fictional campaign.';
    vi.mocked(api.get).mockResolvedValue([{ ...asset(1, 'NimbusFlow guide'), content: JSON.stringify({ title: 'NimbusFlow guide', content: body, excerpt: 'Follow-up advice.' }) }] as never);
    render(<BlogTab threadId={214} />);
    await screen.findByText('NimbusFlow guide');
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(await screen.findByRole('heading', { name: 'Practical follow-ups' })).toBeInTheDocument();
    expect(screen.getAllByText('A complete article about a fictional campaign.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(`# NimbusFlow guide\n\n${body}`));
  });

  it('shows newly saved articles after a result event without manual refresh', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([] as never).mockResolvedValueOnce([asset(1, 'New campaign article')] as never);
    const view = render(<BlogTab threadId={214} refreshKey={0} />);
    await screen.findByText('No blog posts yet');
    view.rerender(<BlogTab threadId={214} refreshKey={1} />);
    expect(await screen.findByText('New campaign article')).toBeInTheDocument();
  });

  it('shows a retry state instead of pretending a failed library is empty', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([asset(1, 'Resort guide')] as never);
    render(<BlogTab threadId={171} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Blog posts could not be loaded');
    expect(screen.queryByText('No blog posts yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading blog posts' }));
    await screen.findByText('Resort guide');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a clear-search action for zero matches', async () => {
    vi.mocked(api.get).mockResolvedValue([asset(1, 'Resort guide')] as never);
    render(<BlogTab threadId={171} />);
    await screen.findByText('Resort guide');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search blog posts' }), { target: { value: 'unmatched' } });
    const emptyState = screen.getByText('No matching blog posts').parentElement!;
    // The search field has its own "Clear search" button too; this test covers the empty-state action.
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Resort guide')).toBeInTheDocument();
  });

  it('does not let an old campaign response replace the current library', async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(api.get).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }) as never)
      .mockResolvedValueOnce([asset(2, 'Current article')] as never);
    const view = render(<BlogTab threadId={171} />);
    view.rerender(<BlogTab threadId={178} />);
    await screen.findByText('Current article');
    await act(async () => { resolveOld([asset(1, 'Old article')]); });
    expect(screen.queryByText('Old article')).not.toBeInTheDocument();
    expect(screen.getByText('Current article')).toBeInTheDocument();
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-content-brand-context", () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock("@/components/content-studio/GenerationEstimate", () => ({ GenerationEstimate: () => null }));
vi.mock("@/contexts/WebSocketContext", () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));

vi.mock('@/components/content-studio/ContentCreatorShell', () => {
  const Frame = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { ContentCreatorShell: Frame, ContentCreatorHeader: Frame, ContentCreatorBody: Frame, ContentCreatorComposer: Frame, ContentCreatorStage: Frame, CreatorResultsPane: Frame };
});
