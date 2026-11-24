import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageTab from '@/components/tabs/content-studio/ImageTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/content-cards', () => ({ ImageCard: ({ title }: { title: string }) => <article>{title}</article> }));
const asset = (id: number, title: string) => ({ id, title, type: 'image', content: '/uploads/example.png', createdAt: '2026-09-01T00:00:00Z', channel: 'content_studio' });

describe('image library panel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('offers retry after loading fails rather than displaying an empty library', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([asset(1, 'Resort terrace')] as never);
    render(<ImageTab threadId={171} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Images could not be loaded');
    expect(screen.queryByText('No Images Yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading images' }));
    await screen.findByText('Resort terrace');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('distinguishes no search matches and lets the user clear the search', async () => {
    vi.mocked(api.get).mockResolvedValue([asset(1, 'Resort terrace')] as never);
    render(<ImageTab threadId={171} />);
    await screen.findByText('Resort terrace');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'unmatched' } });
    const emptyState = screen.getByText('No matching images').parentElement!;
    // The search field has its own "Clear search" button too; this test covers the empty-state action.
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Resort terrace')).toBeInTheDocument();
  });

  it('ignores an old campaign response after switching campaigns', async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(api.get).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }) as never)
      .mockResolvedValueOnce([asset(2, 'Current campaign')] as never);
    const view = render(<ImageTab threadId={171} />);
    view.rerender(<ImageTab threadId={178} />);
    await screen.findByText('Current campaign');
    await act(async () => { resolveOld([asset(1, 'Previous campaign')]); });
    expect(screen.queryByText('Previous campaign')).not.toBeInTheDocument();
    expect(screen.getByText('Current campaign')).toBeInTheDocument();
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-content-brand-context", () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock("@/components/content-studio/GenerationEstimate", () => ({ GenerationEstimate: () => null }));
vi.mock("@/contexts/WebSocketContext", () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));
