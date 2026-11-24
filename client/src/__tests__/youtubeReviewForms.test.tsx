import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublishContentDialog from '@/components/modals/PublishContentDialog';
import { PublishPostWidget } from '@/components/widgets/PublishPostWidget';
import type { WidgetState } from '@/components/widgets/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), forPlatform: vi.fn(), preferredForPlatform: vi.fn(), accounts: [{ credentialId: 91, platform: 'youtube', accountName: 'Saved channel', isSelected: true, expired: false }] }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useOrganicPublishingAccounts', () => ({ useOrganicPublishingAccounts: () => ({ accounts: mocks.accounts, loading: false, forPlatform: mocks.forPlatform, preferredForPlatform: mocks.preferredForPlatform }) }));

const asset = { id: 771, version: 1, publishingReviewToken: 'fixture-review', title: 'Asset label', videoUrl: '/uploads/demo.mp4', content: JSON.stringify({ title: 'Saved video title', description: 'Saved description', tags: ['demo'], youtubeOptions: { madeForKids: false, containsSyntheticMedia: true } }) };
const widget: WidgetState = { id: 771, threadId: 3, messageId: null, toolName: 'publish_post', agentType: null, createdAt: '2026-09-10', updatedAt: '2026-09-10', widgetType: 'publish_post', formValues: { content_asset_id: 771, platform: 'youtube' }, status: 'active' };

describe('YouTube review forms (mock publishing only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('/publishing/accounts') ? { accounts: mocks.accounts } : path.includes('preferences') ? { timezone: 'UTC' } : asset));
    mocks.forPlatform.mockImplementation((platform: string) => mocks.accounts.filter(account => account.platform === platform));
    mocks.preferredForPlatform.mockImplementation((platform: string) => mocks.accounts.find(account => account.platform === platform));
    mocks.post.mockRejectedValue(new Error('Response interrupted'));
  });

  it('hydrates the widget and fingerprints changed reviewed tags while retaining disclosures', async () => {
    const onFormChange = vi.fn();
    render(<PublishPostWidget widget={widget} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(await screen.findByLabelText('Video title')).toHaveValue('Saved video title');
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toBeUndefined());
    const before = onFormChange.mock.calls.at(-1)![0];
    expect(before.targets[0]).toMatchObject({ title: 'Saved video title', tags: ['demo'], privacyStatus: 'private', youtubeOptions: { madeForKids: false, containsSyntheticMedia: true } });
    fireEvent.change(screen.getByLabelText('YouTube tags'), { target: { value: 'demo, launch' } });
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0].idempotency_key).not.toBe(before.idempotency_key));
    expect(onFormChange.mock.calls.at(-1)![0].targets[0].youtubeOptions).toEqual(before.targets[0].youtubeOptions);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('uses saved video media despite legacy props and safely retries the exact reviewed target', async () => {
    render(<PublishContentDialog open onOpenChange={vi.fn()} assetId={771} defaultCaption="Reviewed description" hasVideo={false} />);
    await waitFor(() => expect(screen.getByLabelText('YouTube video title')).toHaveValue('Saved video title'));
    expect(screen.getByLabelText('YouTube description')).toHaveValue('Reviewed description');
    expect(screen.getByText(/Uploads remain in processing/)).toBeVisible();
    const publish = screen.getByRole('button', { name: 'Publish post' });
    fireEvent.click(publish);
    await screen.findByRole('alert');
    fireEvent.click(publish);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[0][1].targets).toEqual([expect.objectContaining({ platform: 'youtube', credentialId: 91, title: 'Saved video title', caption: 'Reviewed description', tags: ['demo'], privacyStatus: 'private', youtubeOptions: { madeForKids: false, containsSyntheticMedia: true } })]);
    expect(mocks.post.mock.calls[0][2]).toEqual(mocks.post.mock.calls[1][2]);
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.change(screen.getByLabelText('YouTube tags'), { target: { value: 'changed' } });
    fireEvent.click(publish);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    expect(mocks.post.mock.calls[2][2]).not.toEqual(mocks.post.mock.calls[0][2]);
  });

  it('retains reviewed settings and blocks an explicitly empty reviewed title', async () => {
    const onFormChange = vi.fn();
    const target = { platform: 'youtube', credentialId: 91, title: '', caption: 'Reviewed', postType: 'video', tags: ['reviewed'], privacyStatus: 'unlisted', youtubeOptions: { madeForKids: true, containsSyntheticMedia: false, categoryId: '27', defaultLanguage: 'en', license: 'youtube' } };
    render(<PublishPostWidget widget={{ ...widget, id: 774, formValues: { content_asset_id: 771, targets: [target] } }} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(await screen.findByLabelText('Video title')).toHaveValue('');
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toMatch(/title of 1–100/));
    expect(onFormChange.mock.calls.at(-1)![0].targets[0]).toMatchObject({ privacyStatus: 'unlisted', tags: target.tags, youtubeOptions: target.youtubeOptions });
  });

  it('requires explicit audience review when saved content has no disclosures', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('/publishing/accounts') ? { accounts: mocks.accounts } : { ...asset, content: JSON.stringify({ title: 'New video', description: 'Description' }) }));
    const onFormChange = vi.fn();
    render(<PublishPostWidget widget={{ ...widget, id: 775 }} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await screen.findByLabelText('Video title');
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toMatch(/made for kids/));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('blocks mixed saved media even when legacy hasVideo says true', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences') ? { timezone: 'UTC' } : { ...asset, imageUrl: '/uploads/image.jpg' }));
    render(<PublishContentDialog open onOpenChange={vi.fn()} assetId={772} hasVideo />);
    await screen.findByLabelText('YouTube tags');
    expect(screen.getByRole('button', { name: 'Publish post' })).toBeDisabled();
    expect(screen.getByText('YouTube requires exactly one saved video and no images.')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('never calls onPublished for accepted processing', async () => {
    mocks.post.mockResolvedValue({ success: false, accepted: true, results: { youtube: { success: true, status: 'provider_succeeded' } } });
    const onPublished = vi.fn();
    render(<PublishContentDialog open onOpenChange={vi.fn()} assetId={773} onPublished={onPublished} />);
    await screen.findByLabelText('YouTube tags');
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));
    await waitFor(() => expect(screen.getAllByText('Publishing in progress').length).toBeGreaterThan(0));
    expect(screen.getByText('Uploaded; provider processing in progress')).toBeVisible();
    expect(screen.queryByText('Published')).not.toBeInTheDocument();
    expect(onPublished).not.toHaveBeenCalled();
  });
});
