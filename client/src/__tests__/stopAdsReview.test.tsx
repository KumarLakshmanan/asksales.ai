import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StopAdsWidget } from '@/components/widgets/StopAdsWidget';
import type { WidgetState } from '@/components/widgets/types';
import api from '@/lib/api';
vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const widget: WidgetState = { id: 13, threadId: 171, messageId: null, toolName: 'stop_ads', widgetType: 'stop_ads', status: 'active', agentType: 'performance_marketing', formValues: { campaignId: 19, platforms: ['meta'] }, createdAt: '', updatedAt: '' };
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
it('requires a saved target before enabling the exact stop request and never submits automatically', async () => {
  vi.mocked(api.get).mockResolvedValue({ campaign: { campaignId: 19, name: 'Saved resort campaign', localStatus: 'draft', lastRecordedProviderStatus: 'PAUSED' }, platforms: ['meta'] } as never);
  const onFormChange = vi.fn(), onSubmit = vi.fn();
  render(<StopAdsWidget widget={widget} onFormChange={onFormChange} onSubmit={onSubmit} onClose={vi.fn()} />);
  expect(onFormChange.mock.calls[0][0]._review_validation_error).toContain('Loading');
  expect(onFormChange.mock.calls[0][0]).toMatchObject({ campaignId: 19, platforms: ['meta'] });
  await screen.findByText('Saved resort campaign');
  expect(onFormChange.mock.calls.at(-1)?.[0]).toEqual({ campaignId: 19, platforms: ['meta'] });
  expect(screen.getByText(/Spend may continue/)).toBeInTheDocument();
  expect(screen.getByText('draft')).toBeInTheDocument();
  expect(screen.getByText('PAUSED')).toBeInTheDocument();
  expect(screen.getByText(/Last recorded provider status · not live verified/)).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});
it('keeps approval blocked for a mismatched saved target', async () => {
  vi.mocked(api.get).mockResolvedValue({ campaign: { campaignId: 99, name: 'Wrong campaign' }, platforms: ['meta'] } as never);
  const onFormChange = vi.fn();
  render(<StopAdsWidget widget={widget} onFormChange={onFormChange} onSubmit={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole('alert');
  await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toContain('invalid'));
  expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ campaignId: 19, platforms: ['meta'] });
  expect(screen.queryByText('Wrong campaign')).not.toBeInTheDocument();
});

it('renders gated receipts without implying pause or reloading an editable review', () => {
  render(<StopAdsWidget widget={{ ...widget, status: 'queued', executionResult: { output: { message: 'Pause not confirmed', platforms: [{ platform: 'meta', actionId: 8, status: 'gated' }] } } }} onFormChange={vi.fn()} onSubmit={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText(/Provider access is gated/)).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalled();
});
