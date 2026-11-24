import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageCreator from '@/components/content-studio/creators/ImageCreator';
import VideoCreator from '@/components/content-studio/creators/VideoCreator';
import EmailCreator from '@/components/content-studio/creators/EmailCreator';
import SmsCreator from '@/components/content-studio/creators/SmsCreator';
import DmCreator from '@/components/content-studio/creators/DmCreator';
import BlogCreator from '@/components/content-studio/creators/BlogCreator';
import AdCreator from '@/components/content-studio/creators/AdCreator';
import SocialCreator from '@/components/content-studio/creators/SocialCreator';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({
  brandToolkitId: 7, businessProfileId: 9, toolkit: { id: 7 }, businessProfile: { id: 9 }, isReady: true,
}) }));
vi.mock('@/components/content-cards', () => ({ ImageCard: () => null, VideoCard: () => null, EmailCard: () => null, SmsCard: () => null, SocialMessageCard: () => null, BlogCard: () => null, AdCopyCard: () => null, SocialPostCard: () => null }));
const quotes = {
  text: { ready: true, credits: 1, model: 'synthetic-text', basis: 'Synthetic text quote' },
  image: { ready: true, credits: 4, model: 'synthetic-image', basis: 'Synthetic image quote' },
  video: { ready: true, credits: 12, model: 'synthetic-video', basis: 'Synthetic video quote' },
};
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
  mocks.get.mockImplementation(async (url: string) => url.includes('/studio/estimates') ? quotes : []);
});
afterEach(cleanup);
const mount = (Component: React.ComponentType) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><Component /></QueryClientProvider>);

describe('CS15 estimates belong to the current generation action', () => {
  it.each([
    { name: 'image', Component: ImageCreator, total: 4, manual: 'Upload an image' },
    { name: 'video', Component: VideoCreator, total: 12, manual: 'Upload a video' },
    { name: 'email', Component: EmailCreator, total: 1, manual: 'Write an email' },
    { name: 'sms', Component: SmsCreator, total: 1, manual: 'Write an SMS' },
    { name: 'dm', Component: DmCreator, total: 1, manual: 'Write a DM' },
    { name: 'blog', Component: BlogCreator, total: 1, manual: 'Write a post' },
    { name: 'ad', Component: AdCreator, total: 1, manual: 'Build an ad' },
    { name: 'social', Component: SocialCreator, total: 1, manual: 'Custom Post' },
  ])('$name has one relevant quote in AI mode and none in manual mode', async ({ Component, total, manual }) => {
    mount(Component);
    await waitFor(() => expect(screen.getAllByText(/^Estimated /)).toHaveLength(1));
    expect(screen.getByText(`Estimated ${total} ${total === 1 ? 'credit' : 'credits'}`)).toBeInTheDocument();
    expect(screen.getByLabelText('Generation setup and saving')).not.toHaveTextContent('Estimated');
    fireEvent.click(screen.getByRole('button', { name: manual }));
    await waitFor(() => expect(screen.queryByText(/^Estimated /)).not.toBeInTheDocument());
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('uses the canonical media quote and requested video count', async () => {
    mount(VideoCreator);
    await screen.findByText('Estimated 12 credits');
    fireEvent.click(screen.getByRole('button', { name: 'Generation Settings' }));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await screen.findByText('Estimated 24 credits for 2 variants');
    expect(screen.queryByText('Estimated 1 credit')).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
