import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SavedTemplatesPage from '@/app/dashboard/(main)/saved-templates/page';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  assetQuery: {
    assets: [] as Array<Record<string, unknown>>,
    total: 0,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  },
}));

vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-paginated-content-assets', () => ({ usePaginatedContentAssets: () => mocks.assetQuery }));
vi.mock('@/components/social-publishing/SocialPublisher', () => ({ SocialPublisher: () => null }));

afterEach(cleanup);

const categories = [
  ['Images', 'image', '/dashboard/saved-templates/image', '/dashboard/saved-templates/image/generate', 2],
  ['Videos', 'video', '/dashboard/saved-templates/video', '/dashboard/saved-templates/video/generate', 3],
  ['Email templates', 'email', '/dashboard/saved-templates/email', '/dashboard/saved-templates/email/generate', 5],
  ['SMS templates', 'sms', '/dashboard/saved-templates/sms', '/dashboard/saved-templates/sms/generate', 7],
  ['WhatsApp templates', 'whatsapp', '/dashboard/integrations/whatsapp/templates', '/dashboard/integrations/whatsapp/templates/create', null],
  ['Social media posts', 'social', '/dashboard/saved-templates/social', '/dashboard/saved-templates/social/generate', 11],
  ['Social DM templates', 'social_message', '/dashboard/saved-templates/dm', '/dashboard/saved-templates/dm/generate', 13],
  ['Ad creative drafts', 'ad_copy', '/dashboard/saved-templates/ads', '/dashboard/saved-templates/ads/generate', 17],
  ['Blog posts', 'blog', '/dashboard/saved-templates/blog', '/dashboard/saved-templates/blog/generate', 19],
] as const;

describe('content library category navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation(async (url: string) => url === '/api/content/templates/counts' ? {} : { image: 2, video: 3, email_template: 5, sms_template: 7, social_post: 11, social_dm: 13, ad_copy: 17, blog_post: 19 });
  });

  it('renders every content category with its saved count and both actions', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SavedTemplatesPage /></QueryClientProvider>);
    expect(await screen.findByText('2 saved')).toBeVisible();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(categories.length);
    for (const [label, , , , count] of categories) {
      const card = cards.find((candidate) => within(candidate).queryByRole('heading', { name: label }));
      expect(card).toBeDefined();
      expect(within(card!).getByText(count === null ? 'Managed in WhatsApp' : `${count} saved`)).toBeVisible();
      expect(within(card!).getByRole('button', { name: `Open library: ${label}` })).toBeEnabled();
      expect(within(card!).getByRole('button', { name: `Create: ${label}` })).toBeEnabled();
    }
  });

  it('counts manually saved templates together with generated drafts', async () => {
    mocks.get.mockImplementation(async (url: string) => url === '/api/content/templates/counts'
      ? { email: 4, sms: 3, social_message: 2 }
      : { email_template: 5, sms_template: 1, social_dm: 7 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SavedTemplatesPage /></QueryClientProvider>);
    const card = screen.getAllByRole('article').find(candidate => within(candidate).queryByRole('heading', { name: 'Email templates' }))!;
    expect(await within(card).findByText('9 saved')).toBeVisible();
    const sms = screen.getAllByRole('article').find(candidate => within(candidate).queryByRole('heading', { name: 'SMS templates' }))!;
    expect(within(sms).getByText('4 saved')).toBeVisible();
  });

  it('routes every Open library and Create button to the matching local page', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SavedTemplatesPage /></QueryClientProvider>);
    await screen.findByText('2 saved');
    const cards = screen.getAllByRole('article');
    for (const [label, , libraryRoute, generateRoute] of categories) {
      const card = cards.find((candidate) => within(candidate).queryByRole('heading', { name: label }))!;
      fireEvent.click(within(card).getByRole('button', { name: `Open library: ${label}` }));
      fireEvent.click(within(card).getByRole('button', { name: `Create: ${label}` }));
      expect(mocks.push).toHaveBeenNthCalledWith(mocks.push.mock.calls.length - 1, libraryRoute);
      expect(mocks.push).toHaveBeenLastCalledWith(generateRoute);
    }
    expect(mocks.push).toHaveBeenCalledTimes(categories.length * 2);
  });
});
