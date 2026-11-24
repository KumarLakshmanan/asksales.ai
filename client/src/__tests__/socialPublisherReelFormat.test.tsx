import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialPublisher } from '@/components/social-publishing/SocialPublisher';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
  accounts: [{ credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', isSelected: true }] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useOrganicPublishingAccounts', () => ({
  useOrganicPublishingAccounts: () => ({
    accounts: mocks.accounts,
    loading: false,
    error: null,
    connectedPlatforms: ['instagram'],
    forPlatform: (platform: string) => mocks.accounts.filter((account) => account.platform === platform),
    preferredForPlatform: (platform: string) => mocks.accounts.find((account) => account.platform === platform),
  }),
}));

afterEach(cleanup);

describe('SocialPublisher publishing format', () => {
  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('defaults a video post with a generated image to Instagram Reel and still offers Carousel', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences')
      ? { timezone: 'UTC' }
      : { id: 52, version: 1, publishingReviewToken: 'fixture-review', type: 'social_post', title: 'Launch', content: JSON.stringify({ caption: 'Launch day' }), channel: 'instagram', imageUrl: '/uploads/cover.png', videoUrl: '/uploads/launch.mp4' }));
    render(<SocialPublisher assetId={52} open onOpenChange={vi.fn()} />);
    const format = await screen.findByRole('combobox', { name: 'Instagram publishing format' });
    expect(format).toHaveTextContent('Instagram Reel · video only');
    fireEvent.click(format);
    expect(await screen.findByRole('option', { name: 'Instagram carousel' })).toBeInTheDocument();
    expect(screen.getByText('Publishes the saved video as an Instagram Reel with its reviewed caption.')).toBeVisible();
  });

  it('offers Reel for a plain video asset', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences')
      ? { timezone: 'UTC' }
      : { id: 53, version: 1, publishingReviewToken: 'fixture-review', type: 'video', title: 'Clip', content: 'Clip', channel: 'instagram', videoUrl: '/uploads/clip.mp4' }));
    render(<SocialPublisher assetId={53} open onOpenChange={vi.fn()} />);
    const format = await screen.findByRole('combobox', { name: 'Instagram publishing format' });
    expect(format).toHaveTextContent('Instagram Reel');
    fireEvent.click(format);
    expect(screen.queryByRole('option', { name: 'Instagram carousel' })).not.toBeInTheDocument();
  });
});
