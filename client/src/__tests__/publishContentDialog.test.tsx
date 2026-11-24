import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublishContentDialog from '@/components/modals/PublishContentDialog';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), accounts: [{ credentialId: 11, platform: 'instagram', accountName: 'Launch profile', isSelected: true }], forPlatform: vi.fn(), preferredForPlatform: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useOrganicPublishingAccounts', () => ({ useOrganicPublishingAccounts: () => ({ accounts: mocks.accounts, loading: false, error: null, forPlatform: mocks.forPlatform, preferredForPlatform: mocks.preferredForPlatform }) }));

describe('PublishContentDialog reviewed publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.forPlatform.mockImplementation((platform: string) => mocks.accounts.filter((account) => account.platform === platform));
    mocks.preferredForPlatform.mockImplementation((platform: string) => mocks.accounts.find((account) => account.platform === platform));
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences') ? { timezone: 'Asia/Kolkata' } : { id: 601, version: 1, publishingReviewToken: 'fixture-review', title: 'Asset', imageUrl: '/uploads/photo.jpg', content: JSON.stringify({ caption: 'Saved copy', cta: 'Learn more', hashtags: ['Launch'] }) }));
    mocks.post.mockResolvedValue({ success: true, results: { instagram: { success: true, status: 'succeeded' } } });
  });

  it('loads complete saved copy before allowing publishing when no caption prop exists', async () => {
    render(<PublishContentDialog open onOpenChange={vi.fn()} assetId={601} hasImage />);
    expect(screen.queryByRole('button', { name: 'Publish post' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Caption/)).toHaveValue('Saved copy\n\nLearn more\n\n#Launch'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0][1].targets[0].caption).toBe('Saved copy\n\nLearn more\n\n#Launch');
  });

  it('reuses the exact idempotency key on an interrupted response', async () => {
    mocks.post.mockRejectedValue(new Error('Connection lost'));
    render(<PublishContentDialog open onOpenChange={vi.fn()} assetId={602} defaultCaption="Reviewed copy" hasImage />);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    await screen.findByRole('alert');
    fireEvent.click(publish);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[0][2]).toEqual(mocks.post.mock.calls[1][2]);
  });

  it('schedules the selected timezone at midnight and labels it scheduled, not published', async () => {
    mocks.post.mockResolvedValue({ success: true, scheduled: true, results: { instagram: { success: true, status: 'pending' } } });
    const onPublished = vi.fn();
    render(<PublishContentDialog open onOpenChange={vi.fn()} onPublished={onPublished} assetId={603} defaultCaption="Reviewed copy" hasImage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish post' })).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Schedule for later'));
    await screen.findByText('Asia/Kolkata');
    fireEvent.change(screen.getByLabelText('Scheduled date and time'), { target: { value: '2099-09-10T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule post' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ scheduledFor: '2099-09-09T18:30:00.000Z', timezone: 'Asia/Kolkata' });
    expect(await screen.findByText('Post scheduled')).toBeVisible();
    expect(screen.getByText('Saved for the selected time. It has not been published yet.')).toBeVisible();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('clears result and schedule when opening another asset', async () => {
    const props = { open: true, onOpenChange: vi.fn(), hasImage: true };
    const view = render(<PublishContentDialog {...props} assetId={604} defaultCaption="First" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish post' })).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Schedule for later'));
    view.rerender(<PublishContentDialog {...props} assetId={605} defaultCaption="Second" />);
    await waitFor(() => expect(screen.getByLabelText(/Caption/)).toHaveValue('Second'));
    expect(screen.getByLabelText('Schedule for later')).not.toBeChecked();
    expect(screen.queryByLabelText('Scheduled date and time')).not.toBeInTheDocument();
  });

  it('preserves an explicitly reviewed empty caption and does not silently restore saved text', async () => {
    render(<PublishContentDialog open onOpenChange={vi.fn()} assetId={606} defaultCaption="" hasImage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish post' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0][1].targets[0].caption).toBe('');
  });
});
