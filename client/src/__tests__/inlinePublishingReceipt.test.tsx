import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineWidgetCard } from '@/components/widgets/InlineWidgetCard';
import type { WidgetState } from '@/components/widgets/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), submitWidget: vi.fn(), updateFormValues: vi.fn(), closeWidget: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/components/widgets/WidgetContext', () => ({ useWidgets: () => mocks }));
vi.mock('@/components/widgets/registry', () => ({ widgetRegistry: { publish_post: { title: 'Publish post', description: 'Review each destination', component: () => null } } }));
const widget: WidgetState = { id: 91, threadId: 1, messageId: null, toolName: 'publish_post', widgetType: 'publish_post', formValues: {}, status: 'succeeded', agentType: null, createdAt: '', updatedAt: '' };

describe('conversation publishing delivery receipts', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('shows partial publishing and preserves the successful destination link', () => {
    render(<InlineWidgetCard widget={{ ...widget, executionResult: { output: { assetId: 101, partialSuccess: true, results: { facebook: { success: true, status: 'succeeded', postUrl: 'https://facebook.com/post' }, instagram: { success: false, status: 'failed', error: 'Account needs reconnection' } } } } }} />);
    expect(screen.getByText('Partially published')).toBeVisible();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.getByText('Account needs reconnection')).toBeVisible();
    expect(screen.getByRole('link', { name: 'View published post' })).toHaveAttribute('href', 'https://facebook.com/post');
    expect(screen.getByRole('link', { name: 'View delivery details and recovery options' })).toHaveAttribute('href', '/dashboard/content-calendar?assetId=101');
  });
  it('keeps scheduled acceptance distinct from completion', () => {
    render(<InlineWidgetCard widget={{ ...widget, executionResult: { output: { assetId: 102, scheduled: true, results: { instagram: { success: true, status: 'pending', attemptId: 25, assetId: 102 } } } } }} />);
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View published post' })).not.toBeInTheDocument();
  });
  it('shows a delivery failure even when the original scheduling action succeeded', () => {
    render(<InlineWidgetCard widget={{ ...widget, executionResult: { output: { results: { instagram: { success: false, status: 'failed', error: 'Media rejected' } } } } }} />);
    expect(screen.getByText('Publishing needs attention')).toBeVisible();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });
  it('marks an uploaded video with failed optional settings as published with a warning', () => {
    render(<InlineWidgetCard widget={{ ...widget, status: 'queued', executionResult: { output: { results: { youtube: { success: true, status: 'succeeded', error: 'Thumbnail rejected; finish in YouTube Studio', postUrl: 'https://youtube.com/watch?v=done' } } } } }} />);
    expect(screen.getByText('Published with a warning')).toBeVisible();
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry safely' })).not.toBeInTheDocument();
  });
  it('refreshes the child destination receipt after the provider completes', async () => {
    let tick: (() => void) | undefined;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation(callback => { tick = callback as () => void; return 91 as unknown as ReturnType<typeof window.setInterval>; });
    mocks.get.mockResolvedValue({ attempts: [{ id: 26, status: 'succeeded', providerPostUrl: 'https://youtube.com/watch?v=done' }] });
    try {
      render(<InlineWidgetCard widget={{ ...widget, executionResult: { output: { assetId: 100, accepted: true, results: { youtube: { success: false, status: 'provider_succeeded', attemptId: 26, assetId: 103 } } } } }} />);
      expect(screen.getByText('Publishing')).toBeVisible();
      await act(async () => { tick?.(); });
      await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/content/assets/103/publish-attempts'));
      expect(await screen.findByRole('link', { name: 'View published post' })).toHaveAttribute('href', 'https://youtube.com/watch?v=done');
      expect(screen.queryByText('Publishing')).not.toBeInTheDocument();
    } finally { interval.mockRestore(); }
  });
});
