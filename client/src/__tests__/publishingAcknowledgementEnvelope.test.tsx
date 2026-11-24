import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocialPublisher } from '@/components/social-publishing/SocialPublisher';

// Captured from the real controller/service/scoped-PostgreSQL accepted202 fixture,
// with mocked external effects and an injected asset-finalization outage.
const capturedAcknowledgement = {
  "success": false,
  "platform": "linkedin",
  "results": {
    "linkedin": {
      "success": false,
      "scheduled": false,
      "terminal": false,
      "status": "provider_succeeded",
      "attemptId": 1,
      "assetId": 1,
      "postId": "urn:li:share:123456789",
      "postUrl": "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123456789"
    }
  },
  "accepted": true,
  "scheduled": false,
  "partialSuccess": false,
  "platforms": [
    "linkedin"
  ]
};
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(),
  accounts: [{ credentialId: 13, platform: 'linkedin', accountName: 'Synthetic LinkedIn', isSelected: true }],
  platforms: ['linkedin'],
}));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useOrganicPublishingAccounts', () => ({ useOrganicPublishingAccounts: () => {
  return { accounts: mocks.accounts, connectedPlatforms: mocks.platforms, loading: false, error: null,
    forPlatform: (platform: string) => platform === 'linkedin' ? mocks.accounts : [],
    preferredForPlatform: (platform: string) => platform === 'linkedin' ? mocks.accounts[0] : undefined };
} }));
afterEach(() => { vi.restoreAllMocks(); });

describe('publishing caller consumes the captured accepted202 envelope', () => {
  it('renders in-progress recovery and polls the retained attempt without offering or issuing another publish', async () => {
    const onPublished = vi.fn();
    let poll: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(callback => { poll = callback as () => void; return 123 as unknown as ReturnType<typeof window.setInterval>; });
    mocks.get.mockImplementation(async (path: string) => path.includes('preferences') ? { timezone: 'UTC' }
      : path.endsWith('/publish-attempts') ? { attempts: [{ id: 1, platform: 'linkedin', status: 'provider_succeeded', providerPostUrl: capturedAcknowledgement.results.linkedin.postUrl }] }
      : { id: 1, version: 1, publishingReviewToken: 'synthetic-review', type: 'social_post', title: 'Reviewed', content: 'HTTP reviewed synthetic text', channel: 'linkedin' });
    mocks.post.mockResolvedValue(capturedAcknowledgement);
    render(<SocialPublisher assetId={1} open initialPlatform="linkedin" onOpenChange={vi.fn()} onPublished={onPublished} />);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    expect(await screen.findByText('Publishing in progress')).toBeVisible();
    expect(screen.getByText('Accepted for processing; publishing is not yet complete. Check the calendar for updated delivery status.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review again' })).not.toBeInTheDocument();
    expect(onPublished).toHaveBeenCalledWith(capturedAcknowledgement);
    await act(async () => { poll?.(); });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/content/assets/1/publish-attempts'));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][0]).toBe('/api/content/assets/1/publish');
    expect(screen.getByRole('link', { name: 'View status in calendar' })).toHaveAttribute('href', '/dashboard/content-calendar');
    expect(screen.getByText('Publishing in progress')).toBeVisible();
  });
});
