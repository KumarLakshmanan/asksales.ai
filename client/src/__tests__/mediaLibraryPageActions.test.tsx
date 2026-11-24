import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import ImagePage from '@/app/dashboard/(main)/saved-templates/image/page';
import VideoPage from '@/app/dashboard/(main)/saved-templates/video/page';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  writeText: vi.fn(),
  anchorClick: vi.fn(),
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
  assetQuery: {
    assets: [] as Array<Record<string, unknown>>,
    total: 0,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    hasNextPage: true,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  },
}));

vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-paginated-content-assets', () => ({ usePaginatedContentAssets: () => mocks.assetQuery }));
vi.mock('@/components/social-publishing/SocialPublisher', () => ({
  SocialPublisher: ({ assetId, initialPlatform }: { assetId: number; initialPlatform?: string }) => (
    <div data-testid="youtube-publisher">YouTube publisher {assetId} · {initialPlatform}</div>
  ),
}));

afterEach(cleanup);

const image = { id: 1, type: 'image', title: 'Hero image', content: '/uploads/hero.png', channel: 'content_studio', prompt: 'sunlit product hero', createdAt: '2026-09-17T00:00:00Z' };
const video = { id: 2, type: 'video', title: 'Launch video', content: '/uploads/launch.mp4', channel: 'content_studio', prompt: 'smooth product reveal', createdAt: '2026-09-17T00:00:00Z' };

function renderWithClient(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function installBrowserMocks() {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.writeText } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: mocks.anchorClick });
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

describe('saved image and video library actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installBrowserMocks();
    mocks.writeText.mockResolvedValue(undefined);
    mocks.assetQuery.assets = [];
    mocks.assetQuery.total = 0;
    mocks.assetQuery.isLoading = false;
    mocks.assetQuery.isFetching = false;
    mocks.assetQuery.isError = false;
    mocks.assetQuery.hasNextPage = true;
    mocks.assetQuery.isFetchingNextPage = false;
    mocks.get.mockResolvedValue({});
    mocks.delete.mockResolvedValue({ success: true });
  });

  it('renders the image library and exercises navigation, search, copy, download, preview, delete, refresh, and pagination', async () => {
    mocks.assetQuery.assets = [image];
    mocks.assetQuery.total = 1;
    renderWithClient(<ImagePage />);
    expect(await screen.findByRole('heading', { name: 'Image gallery' })).toBeVisible();
    expect(screen.getByText('1 image — AI-generated images')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.assetQuery.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate Image' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates/image/generate');
    fireEvent.click(screen.getByRole('button', { name: 'Content library' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates');

    const search = screen.getByPlaceholderText('Search by prompt or title...');
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No images match your search')).toBeVisible();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByText('Hero image')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for Hero image' }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('sunlit product hero'));
    fireEvent.click(screen.getByRole('button', { name: 'Download Hero image' }));
    expect(mocks.anchorClick).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Hero image' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByRole('heading', { name: 'Hero image' })).toBeVisible();
    fireEvent.click(within(preview).getByRole('button', { name: 'Copy Prompt' }));
    fireEvent.click(within(preview).getByRole('button', { name: 'Download' }));
    expect(mocks.writeText).toHaveBeenCalledWith('sunlit product hero');
    fireEvent.click(within(preview).getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Hero image' }));
    const confirmation = await screen.findByRole('alertdialog');
    expect(confirmation).toHaveTextContent('Delete this image?');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Hero image' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete image' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/content/assets/1'));

    fireEvent.click(screen.getByRole('button', { name: 'Load more images' }));
    expect(mocks.assetQuery.fetchNextPage).toHaveBeenCalled();
  });

  it('renders the video library and exercises video actions including YouTube publishing entry', async () => {
    mocks.assetQuery.assets = [video];
    mocks.assetQuery.total = 1;
    renderWithClient(<VideoPage />);
    expect(await screen.findByRole('heading', { name: 'Video gallery' })).toBeVisible();
    expect(screen.getByText('1 video — AI-generated videos')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.assetQuery.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate Video' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates/video/generate');
    fireEvent.click(screen.getByRole('button', { name: 'Content library' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for Launch video' }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('smooth product reveal'));
    fireEvent.click(screen.getByRole('button', { name: 'Download Launch video' }));
    expect(mocks.anchorClick).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Launch video' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByRole('heading', { name: 'Launch video' })).toBeVisible();
    fireEvent.click(within(preview).getByRole('button', { name: 'Copy Prompt' }));
    fireEvent.click(within(preview).getByRole('button', { name: 'Download' }));
    fireEvent.click(within(preview).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish / schedule on YouTube' }));
    expect(screen.getByTestId('youtube-publisher')).toHaveTextContent('YouTube publisher 2 · youtube');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Launch video' }));
    const confirmation = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete video' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/content/assets/2'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more videos' }));
    expect(mocks.assetQuery.fetchNextPage).toHaveBeenCalled();
  });

  it.each([
    ['image', ImagePage, 'No images yet', 'Generate Image', '/dashboard/saved-templates/image/generate', "Couldn't load your images"],
    ['video', VideoPage, 'No videos yet', 'Generate Video', '/dashboard/saved-templates/video/generate', "Couldn't load your videos"],
  ] as const)('%s library exposes empty and retry actions', async (_label, Page, emptyHeading, generateButton, route, errorHeading) => {
    renderWithClient(<Page />);
    expect(await screen.findByText(emptyHeading)).toBeVisible();
    const generateButtons = screen.getAllByRole('button', { name: generateButton });
    fireEvent.click(generateButtons[generateButtons.length - 1]);
    expect(mocks.push).toHaveBeenCalledWith(route);

    cleanup();
    mocks.assetQuery.isError = true;
    mocks.assetQuery.hasNextPage = false;
    renderWithClient(<Page />);
    expect(await screen.findByText(errorHeading)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.assetQuery.refetch).toHaveBeenCalled();
  });
});
