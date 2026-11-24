import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishAdsWidget } from '@/components/widgets/PublishAdsWidget';
import type { WidgetState } from '@/components/widgets/types';
import type { CampaignPublishReview } from '../../../shared/adCampaignReview';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
const widget: WidgetState = { id: 12, threadId: 3, messageId: null, toolName: 'publish_ads', widgetType: 'publish_ads',
  formValues: { campaign_id: '19', platforms: ['meta', 'google'] }, status: 'active', agentType: 'performance_marketing', createdAt: '', updatedAt: '' };
const review: CampaignPublishReview = { schemaVersion: 1, campaignId: 19, revision: 'a'.repeat(64), validationErrors: [], platformErrors: { meta: [], google: [] }, snapshot: {
  schemaVersion: 1, campaignId: 19, userId: 7, campaignVersion: 3, name: 'Saved resort campaign', objective: 'traffic', platforms: ['meta', 'google'],
  budget: { amountMinor: 127500, currency: 'USD', budgetType: 'lifetime' }, landingPageUrl: 'https://example.com/approved',
  startDate: '2090-01-01T10:00:00Z', endDate: '2090-01-08T10:00:00Z', locations: [{ countryCode: 'US' }], targeting: {},
  allocations: [{ key: 'meta-1', platform: 'meta', amountMinor: 75000 }, { key: 'google-1', platform: 'google', amountMinor: 52500 }],
  providerAccounts: { meta: { adAccountId: 'act_12', pageId: '34' }, google: { customerId: '1234567890' } },
  providerConfig: { meta: { placements: ['instagram_stream'], bidStrategy: 'LOWEST_COST_WITHOUT_CAP' }, google: { biddingStrategy: 'MAXIMIZE_CLICKS' } },
  creativeRevision: 3, creativeSources: [{ sourceId: 88, sourceVersion: 2 }], creatives: { meta: [{ primaryText: 'Exact saved creative text' }], google: [{ headlines: ['Reviewed Google headline'] }] }, scheduleDates: {},
} };

describe('saved campaign review in the conversation', () => {
  afterEach(cleanup);
  beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue({ review }); mocks.post.mockResolvedValue({ review }); });

  it('shows the server revision and general validation errors before enabling approval', async () => {
    mocks.get.mockResolvedValue({ review: { ...review, validationErrors: ['Missing landing page URL', 'Invalid country code'] } });
    const onFormChange = vi.fn();
    const onSubmit = vi.fn();
    render(<PublishAdsWidget widget={widget} onClose={vi.fn()} onSubmit={onSubmit} onFormChange={onFormChange} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing landing page URL');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid country code');
    expect(screen.getByText(`Review revision ${review.revision}`)).toBeVisible();
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ review_revision: review.revision,
      _review_validation_error: 'Missing landing page URL Invalid country code' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a stale server response for another campaign', async () => {
    const onFormChange = vi.fn();
    render(<PublishAdsWidget widget={{ ...widget, formValues: { campaign_id: '17', platforms: ['meta'] } }} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('does not match the requested campaign');
    expect(screen.queryByText('Saved resort campaign')).not.toBeInTheDocument();
    expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ campaign_id: '17' });
    expect(onFormChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('review_revision');
  });

  it.each([12, 13])('does not retain another campaign review when widget %s fails to load', async (id) => {
    const onFormChange = vi.fn();
    const props = { onClose: vi.fn(), onSubmit: vi.fn(), onFormChange };
    const view = render(<PublishAdsWidget widget={widget} {...props} />);
    await screen.findByText('Saved resort campaign');
    mocks.get.mockRejectedValueOnce(new Error('New campaign unavailable'));
    view.rerender(<PublishAdsWidget widget={{ ...widget, id, formValues: { campaign_id: '20', platforms: ['google'] } }} {...props} />);
    expect(screen.queryByText('Saved resort campaign')).not.toBeInTheDocument();
    await screen.findByRole('alert');
    expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ campaign_id: '20', platforms: ['google'], _review_validation_error: 'New campaign unavailable' });
    expect(onFormChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('review_revision');
  });

  it('ignores draft preparation completing after switching to another widget', async () => {
    let finishOld!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    const onFormChange = vi.fn();
    const props = { onClose: vi.fn(), onSubmit: vi.fn(), onFormChange };
    const view = render(<PublishAdsWidget widget={{ ...widget, formValues: { asset_ids: [88], platforms: ['meta'] } }} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved campaign review' }));
    view.rerender(<PublishAdsWidget widget={{ ...widget, id: 13, threadId: 4, formValues: { asset_ids: [99], platforms: ['google'] } }} {...props} />);
    await act(async () => { finishOld({ review }); });
    expect(screen.queryByText('Saved resort campaign')).not.toBeInTheDocument();
    expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ asset_ids: [99], platforms: ['google'] });
    expect(onFormChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('review_revision');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('loads authoritative budget/account/copy instead of placeholder values', async () => {
    const onFormChange = vi.fn();
    render(<PublishAdsWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    expect(screen.queryByLabelText('Lifetime Budget')).not.toBeInTheDocument();
    expect(await screen.findByText('Saved resort campaign')).toBeVisible();
    expect(screen.getByText('$1,275.00')).toBeVisible();
    expect(screen.getByText('Exact saved creative text')).toBeVisible();
    expect(screen.getByText('act_12')).toBeVisible();
    expect(screen.getByText('instagram_stream')).toBeVisible();
    expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ campaign_id: '19', review_revision: review.revision, platforms: ['meta', 'google'], _review_validation_error: undefined });
    expect(onFormChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('budget_amount_minor');
  });

  it('keeps approval disabled when the saved review cannot be loaded and supports retry', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Review unavailable'));
    const onFormChange = vi.fn();
    render(<PublishAdsWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Review unavailable');
    expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toBe('Review unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading review' }));
    expect(await screen.findByText('Saved resort campaign')).toBeVisible();
  });

  it('prepares a durable draft without executing or granting approval', async () => {
    const onSubmit = vi.fn(), onFormChange = vi.fn();
    render(<PublishAdsWidget widget={{ ...widget, formValues: { asset_ids: [88], platforms: ['meta'], landing_url: 'https://example.com/offer' } }} onClose={vi.fn()} onSubmit={onSubmit} onFormChange={onFormChange} />);
    expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toContain('Prepare');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved campaign review' }));
    expect(await screen.findByText('Saved resort campaign')).toBeVisible();
    expect(mocks.post).toHaveBeenCalledWith('/api/widgets/12/ad-review', expect.objectContaining({ values: expect.objectContaining({ asset_ids: [88], platforms: ['meta'] }) }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('preserves an independently selected healthy platform when the other has errors', async () => {
    mocks.get.mockResolvedValue({ review: { ...review, platformErrors: { meta: [], google: ['Google account disconnected'] } } });
    const onFormChange = vi.fn();
    render(<PublishAdsWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    expect(await screen.findByText('Google account disconnected')).toBeVisible();
    expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Selected Meta' }));
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toContain('Resolve the platform'));
  });
});
