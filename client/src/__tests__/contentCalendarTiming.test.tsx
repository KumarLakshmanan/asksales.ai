import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContentCalendarPage from '@/app/dashboard/(main)/content-calendar/page';
import { zonedDateTimeToUtc } from '@/lib/timezone';
import { selectBusinessProfile } from '@/lib/business-profile';
import { confirmUnsavedNavigation } from '@/hooks/use-unsaved-changes';
import { saveCalendarBulkIntent } from '@/lib/calendar-bulk-intent';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), push: vi.fn(), preferences: { timezone: 'Pacific/Honolulu' } }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ preferences: mocks.preferences }) }));

describe('content calendar timing and request ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    selectBusinessProfile(11);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-08T02:00:00Z'));
    mocks.preferences = { timezone: 'Pacific/Honolulu' };
    mocks.get.mockResolvedValue({ items: [] });
  });
  afterEach(() => { vi.useRealTimers(); window.history.replaceState({}, '', '/'); });

  it('rejects an unsupported selection before writing a recovery ledger that cannot be reloaded', () => {
    expect(() => saveCalendarBulkIntent('user-4101:business-11', {
      action: 'cancel', scope: 'single', assetIds: Array.from({ length: 101 }, (_, index) => index + 1),
      expectedVersions: {}, expectedScheduledFor: {},
    })).toThrow();
    expect(sessionStorage.getItem('calendar-bulk:v1:user-4101:business-11')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('highlights today and fetches the week in the preference timezone', async () => {
    render(<ContentCalendarPage />);
    await screen.findByText('September, 2026');
    expect(screen.getByText('7', { selector: 'div' })).toHaveClass('bg-primary');
    expect(screen.getByText('8', { selector: 'div' })).not.toHaveClass('bg-primary');
    expect(screen.getByText(/scheduled social publishing · Pacific\/Honolulu/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/content/calendar', { params: { startDate: '2026-09-06', endDate: '2026-09-12', timezone: 'Pacific/Honolulu' } }));
  });

  it('opens the social post template creator directly from the page action', async () => {
    render(<ContentCalendarPage />);
    await screen.findByText('September, 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Create Post' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates/social/generate');
    expect(screen.queryByRole('heading', { name: 'Create post' })).not.toBeInTheDocument();
  });

  it('preserves the selected calendar date when opening the social post template creator', async () => {
    render(<ContentCalendarPage />);
    const dayNumber = await screen.findByText('8', { selector: 'div' });
    fireEvent.click(dayNumber.closest('[role="button"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Post for This Date' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates/social/generate?date=2026-09-08');
    expect(screen.queryByRole('heading', { name: 'Create post' })).not.toBeInTheDocument();
  });

  it('does not let an older timezone response replace the latest calendar', async () => {
    const oldResponses: Array<(value: unknown) => void> = [];
    mocks.get.mockImplementation((_path: string, options: { params: { timezone: string } }) => {
      if (options.params.timezone === 'Pacific/Honolulu') return new Promise((resolve) => { oldResponses.push(resolve); });
      return Promise.resolve({ items: [{ id: 91, sourceKey: 'asset-91', title: 'Current timezone post', content: 'Current', platform: 'facebook', scheduled_date: '2026-09-08', scheduled_time: '00:00', status: 'scheduled', type: 'post', contentAssetId: 91 }] });
    });
    const view = render(<ContentCalendarPage />);
    await waitFor(() => expect(oldResponses.length).toBeGreaterThan(0));
    mocks.preferences = { timezone: 'UTC' };
    view.rerender(<ContentCalendarPage />);
    expect(await screen.findByText(/Current timezone post/)).toBeVisible();
    await act(async () => { for (const resolve of oldResponses) resolve({ items: [{ id: 92, title: 'Stale timezone post', platform: 'facebook', scheduled_date: '2026-09-07', scheduled_time: '14:00', status: 'scheduled', type: 'post' }] }); });
    expect(screen.getByText(/Current timezone post/)).toBeVisible();
    expect(screen.queryByText(/Stale timezone post/)).not.toBeInTheDocument();
    expect(screen.getByText('Scheduled: 00:00')).toBeVisible();
  });

  it('rejects DST gaps/folds during calendar edits and round-trips midnight correctly', () => {
    expect(zonedDateTimeToUtc('2026-09-10', '00:00', 'Asia/Kolkata').toISOString()).toBe('2026-09-09T18:30:00.000Z');
    expect(() => zonedDateTimeToUtc('2026-03-08', '02:30', 'America/New_York')).toThrow(/does not exist/);
    expect(() => zonedDateTimeToUtc('2026-11-01', '01:30', 'America/New_York')).toThrow(/occurs twice/);
  });

  it('labels publish-now calendar entries as published', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [{
      id: 93,
      sourceKey: 'asset-93-facebook',
      title: 'Published QA post',
      content: 'Published content',
      platform: 'facebook',
      scheduled_date: '2026-09-08',
      scheduled_time: '09:08',
      status: 'published',
      type: 'post',
      contentAssetId: 93,
    }] });
    render(<ContentCalendarPage />);
    expect(await screen.findByText('Published: 09:08')).toBeVisible();
    expect(screen.queryByText('Scheduled: 09:08')).not.toBeInTheDocument();
  });

  it('gives each day drawer its own bounded vertical scroll region', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [{
      id: 94,
      sourceKey: 'asset-94-instagram',
      title: 'Scrollable calendar detail',
      content: 'Long-form scheduled post detail',
      platform: 'instagram',
      scheduled_date: '2026-09-08',
      scheduled_time: '16:45',
      status: 'scheduled',
      type: 'post',
      contentAssetId: 94,
    }] });
    render(<ContentCalendarPage />);
    const dayNumber = await screen.findByText('8', { selector: 'div' });
    const dayButton = dayNumber.closest('[role="button"]');
    expect(dayButton).not.toBeNull();
    fireEvent.click(dayButton!);
    const scrollRegion = await screen.findByTestId('calendar-day-drawer-scroll-region');
    expect(scrollRegion).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain');
  });

  const scheduledItem = { id: 94, sourceKey: 'asset-94', title: 'Ready post', content: 'Caption', platform: 'instagram', scheduled_date: '2026-09-08', scheduled_time: '16:45', scheduledAt: '2026-09-08T16:45:00Z', status: 'scheduled', type: 'post', contentAssetId: 94, publishAttempts: [] };

  it('opens a month event with the keyboard without selecting it for bulk actions', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    render(<ContentCalendarPage />);
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Open Ready post' }), { key: 'Enter' });
    expect(await screen.findByTestId('calendar-day-drawer-scroll-region')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel 1 selected' })).not.toBeInTheDocument();
    expect(mocks.get.mock.calls.filter(call => String(call[0]).includes('publish-attempts'))).toHaveLength(0);
  });

  it('restricts bulk selection and dragging to scheduled deliveries', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem, { ...scheduledItem, id: 95, contentAssetId: 95, sourceKey: 'asset-95', title: 'Published post', status: 'published' }] });
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select scheduled posts' }));
    expect(screen.getByRole('checkbox', { name: 'Select Ready post' })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Select Published post' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Published post' })).toHaveAttribute('draggable', 'false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ready post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel 1 selected' }));
    expect(screen.getByText('Selected destinations only')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedules' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/calendar/bulk', expect.objectContaining({ action: 'cancel', assetIds: [94], scope: 'single', expectedScheduledFor: { 94: '2026-09-08T16:45:00Z' } }), expect.anything()));
  });

  it('refreshes the currently visible month when an earlier recovery mutation completes', async () => {
    mocks.preferences = { timezone: 'UTC' };
    const attempts = [{ id: 991, platform: 'facebook', status: 'ambiguous', attemptCount: 1, maxAttempts: 3, capabilities: { reconcile: true } }];
    mocks.get.mockImplementation((path: string, options?: { params: { startDate: string } }) => Promise.resolve(path === '/api/content/calendar'
      ? { items: options?.params.startDate.startsWith('2026-09') ? [{ ...scheduledItem, status: 'ambiguous', publishAttempts: attempts }] : [] }
      : { attempts }));
    let release!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ready post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check provider status' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await screen.findByText('October, 2026');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/content/calendar', { params: { startDate: '2026-10-01', endDate: '2026-10-31', timezone: 'UTC' } }));
    await act(async () => release({ success: true }));
    const reads = mocks.get.mock.calls.filter(([path]) => path === '/api/content/calendar');
    expect(reads.at(-1)?.[1]).toEqual({ params: { startDate: '2026-10-01', endDate: '2026-10-31', timezone: 'UTC' } });
    expect(screen.queryByRole('button', { name: 'Open Ready post' })).not.toBeInTheDocument();
  });

  it('keeps a pending bulk receipt and retries the same reviewed intent after remount', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    mocks.post.mockResolvedValueOnce({ success: false, inProgress: true });
    let view = render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select scheduled posts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ready post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel 1 selected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedules' }));
    await screen.findByText(/This calendar action is not confirmed/);
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Schedules cancelled' }));
    const [path, payload, options] = mocks.post.mock.calls[0];
    view.unmount();
    view = render(<ContentCalendarPage />);
    const retry = await screen.findByRole('button', { name: 'Retry same calendar action' });
    mocks.post.mockResolvedValueOnce({ success: true, affected: 1, action: 'cancel' });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][0]).toBe(path);
    expect(mocks.post.mock.calls[1][1]).toEqual(payload);
    expect(mocks.post.mock.calls[1][2].headers).toEqual(options.headers);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Schedules cancelled' })));
    expect(screen.queryByRole('button', { name: 'Retry same calendar action' })).not.toBeInTheDocument();
    view.unmount();
    render(<ContentCalendarPage />);
    await screen.findByRole('button', { name: 'Select scheduled posts' });
    expect(screen.queryByRole('button', { name: 'Retry same calendar action' })).not.toBeInTheDocument();
  });

  it('does not submit a bulk mutation when recovery metadata cannot be stored', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select scheduled posts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ready post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel 1 selected' }));
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel schedules' }));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Calendar action not submitted' })));
      expect(mocks.post).not.toHaveBeenCalled();
    } finally { storage.mockRestore(); }
  });

  it('retains transport-uncertain metadata but never restores it into another business', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Lost response'), { status: 0 }));
    const view = render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select scheduled posts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ready post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel 1 selected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedules' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Calendar action not confirmed' })));
    view.unmount();
    selectBusinessProfile(12);
    const other = render(<ContentCalendarPage />);
    await screen.findByRole('button', { name: 'Select scheduled posts' });
    expect(screen.queryByRole('button', { name: 'Retry same calendar action' })).not.toBeInTheDocument();
    other.unmount();
    selectBusinessProfile(11);
    render(<ContentCalendarPage />);
    await screen.findByRole('button', { name: 'Retry same calendar action' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('does not replay an intent after the existing server receipt window', async () => {
    sessionStorage.setItem('calendar-bulk:v1:user-4101:business-11', JSON.stringify({
      version: 1, scope: 'user-4101:business-11', key: 'expired-fixture-key', createdAt: Date.now() - 24 * 60 * 60 * 1000 - 1,
      payload: { action: 'cancel', assetIds: [94], scope: 'single', expectedVersions: { 94: 3 }, expectedScheduledFor: {} },
    }));
    render(<ContentCalendarPage />);
    expect(await screen.findByRole('button', { name: 'Retry same calendar action' })).toBeDisabled();
    expect(screen.getByText(/24-hour replay window has ended/)).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('guards an unsaved editorial move and releases it when the edit is explicitly cancelled', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [{ ...scheduledItem, contentAssetId: undefined, plan_id: 8, status: 'planned', title: 'Editorial guard fixture' }] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const view = render(<ContentCalendarPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Weekly' }));
      fireEvent.dragStart(await screen.findByRole('button', { name: 'Open Editorial guard fixture' }));
      fireEvent.drop(view.container.querySelector('[data-calendar-slot="2026-09-09T10:00"]')!);
      await screen.findByRole('heading', { name: 'Edit editorial plan' });
      expect(confirmUnsavedNavigation('workspace')).toBe(false);
      expect(mocks.post).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(confirmUnsavedNavigation('workspace')).toBe(true);
    } finally { confirm.mockRestore(); }
  });

  it('retains loaded content and exposes a read-only retry after a quiet refresh failure', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    render(<ContentCalendarPage />);
    await screen.findByRole('button', { name: 'Open Ready post' });
    mocks.get.mockRejectedValueOnce(new Error('Synthetic refresh outage'));
    fireEvent(window, new Event('focus'));
    await screen.findByText(/Calendar may be out of date/);
    expect(screen.getByRole('button', { name: 'Open Ready post' })).toBeVisible();
    mocks.get.mockResolvedValue({ items: [{ ...scheduledItem, title: 'Refreshed post' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar refresh' }));
    await screen.findByRole('button', { name: 'Open Refreshed post' });
    expect(screen.queryByText(/Calendar may be out of date/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('clears an earlier range error when a later quiet read successfully recovers that range', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    render(<ContentCalendarPage />);
    await screen.findByRole('button', { name: 'Open Ready post' });
    mocks.get.mockRejectedValueOnce(new Error('Synthetic range outage'));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await screen.findByRole('heading', { name: 'We couldn’t load the content calendar' });
    mocks.get.mockResolvedValue({ items: [] });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'We couldn’t load the content calendar' })).not.toBeInTheDocument());
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('requires confirmation and uses the hour of the weekly drop target', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [scheduledItem] });
    const view = render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly' }));
    const event = await screen.findByRole('button', { name: 'Open Ready post' });
    fireEvent.dragStart(event);
    fireEvent.drop(view.container.querySelector('[data-calendar-slot="2026-09-09T10:00"]')!);
    expect(await screen.findByRole('heading', { name: 'Confirm reschedule' })).toBeVisible();
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-09');
    expect(screen.getByLabelText('Time')).toHaveValue('10:00');
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/assets/94/reschedule', expect.objectContaining({ scope: 'single', scheduledFor: '2026-09-09T10:00:00.000Z' })));
  });

  it('opens notification links on the owned asset date in the preference timezone only once', async () => {
    mocks.preferences = { timezone: 'Asia/Kolkata' };
    window.history.replaceState({}, '', '/dashboard/content-calendar?assetId=94');
    mocks.get.mockImplementation((path: string) => Promise.resolve(path === '/api/content/assets/94'
      ? { id: 94, status: 'scheduled', scheduledPublishAt: '2026-10-09T20:00:00Z', createdAt: '2026-09-01T00:00:00Z' }
      : { items: [{ ...scheduledItem, scheduled_date: '2026-10-10', scheduled_time: '01:30' }] }));
    render(<ContentCalendarPage />);
    expect(await screen.findByText('October, 2026')).toBeVisible();
    expect(await screen.findByTestId('calendar-day-drawer-scroll-region')).toBeVisible();
    expect(screen.getByText('October 10, 2026')).toBeVisible();
    expect(mocks.get.mock.calls.filter(call => call[0] === '/api/content/assets/94')).toHaveLength(1);
  });

  it('requires explicit confirmation before publishing a scheduled destination immediately', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockResolvedValue({ items: [{ ...scheduledItem, version: 3, publishAttempts: [{ id: 77, platform: 'instagram', status: 'pending', attemptCount: 0, maxAttempts: 5, capabilities: { retry: false, reconcile: false, publishNow: true } }] }] });
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ready post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish this destination now' }));
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/assets/94/publish-attempts/77/recover', { action: 'publish_now', expectedVersion: 3 }));
  });

  it('shows partial history failures separately from empty history and retries only reads', async () => {
    mocks.preferences = { timezone: 'UTC' };
    let fail = true;
    const items = [scheduledItem, { ...scheduledItem, id: 95, contentAssetId: 95, sourceKey: 'asset-95', title: 'Unavailable history', publishAttempts: undefined }];
    mocks.get.mockImplementation((path: string) => {
      if (path === '/api/content/calendar') return Promise.resolve({ items });
      if (fail) return Promise.reject(new Error('Synthetic history read failure'));
      return Promise.resolve({ attempts: [] });
    });
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ready post' }));
    expect(await screen.findByText(/Publishing history unavailable/)).toBeVisible();
    expect(screen.getByText('No publishing history yet.')).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry publishing history' }));
    await waitFor(() => expect(screen.queryByText(/Publishing history unavailable/)).not.toBeInTheDocument());
    expect(screen.getAllByText('No publishing history yet.')).toHaveLength(2);
    expect(mocks.get.mock.calls.filter(call => call[0] === '/api/content/assets/95/publish-attempts')).toHaveLength(2);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('does not apply a rejected history read after closing and reopening the drawer', async () => {
    mocks.preferences = { timezone: 'UTC' };
    let rejectOld: (reason: Error) => void = () => {};
    let historyReads = 0;
    mocks.get.mockImplementation((path: string) => {
      if (path === '/api/content/calendar') return Promise.resolve({ items: [{ ...scheduledItem, publishAttempts: undefined }] });
      historyReads += 1;
      if (historyReads === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
      return Promise.resolve({ attempts: [] });
    });
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ready post' }));
    expect(await screen.findByText('Loading publishing history…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByTestId('calendar-day-drawer-scroll-region')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Open Ready post' }));
    expect(await screen.findByText('No publishing history yet.')).toBeVisible();
    await act(async () => { rejectOld(new Error('Late history failure')); });
    expect(screen.queryByText(/Publishing history unavailable/)).not.toBeInTheDocument();
    expect(screen.getByText('No publishing history yet.')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('deduplicates history reads for destinations belonging to the same asset', async () => {
    mocks.preferences = { timezone: 'UTC' };
    mocks.get.mockImplementation((path: string) => Promise.resolve(path === '/api/content/calendar'
      ? { items: [{ ...scheduledItem, publishAttempts: undefined }, { ...scheduledItem, sourceKey: 'asset-94-facebook', platform: 'facebook', title: 'Other destination', publishAttempts: undefined }] }
      : { attempts: [] }));
    render(<ContentCalendarPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ready post' }));
    await waitFor(() => expect(screen.getAllByText('No publishing history yet.')).toHaveLength(2));
    expect(mocks.get.mock.calls.filter(call => call[0] === '/api/content/assets/94/publish-attempts')).toHaveLength(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
