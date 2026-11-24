import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SocialInsightsPage from '@/app/dashboard/(main)/marketing/analytics/page';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), track: vi.fn() }));
const searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => searchParams }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/lib/performanceMarketingAnalytics', () => ({ trackPerformanceMarketingEvent: mocks.track }));
vi.mock('@/components/social-insights/SocialReportsPanel', () => ({ SocialReportsPanel: () => null }));
vi.mock('@/components/social-insights/SocialListeningPanel', () => ({ SocialListeningPanel: () => null }));
vi.mock('@/components/social-insights/SocialContentInsights', () => ({
  ContentFeed: () => null, ContentOverview: () => null, PublishingTrend: () => null,
  useSocialContent: () => ({ data: null, loading: false, error: null }),
}));

function Fixture({ workspace = 1, showPage = true, nextDialog = false, revision = 0 }: {
  workspace?: number; showPage?: boolean; nextDialog?: boolean; revision?: number;
}) {
  return <>
    <button>New navigation action</button>
    <span>Revision {revision}</span>
    {/* Match DashboardLayout's selected-workspace remount boundary. */}
    {showPage && <ErrorBoundary key={workspace}><SocialInsightsPage /></ErrorBoundary>}
    <Dialog open={nextDialog}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Newer dialog</DialogTitle>
        <button>Newer dialog action</button>
      </DialogContent>
    </Dialog>
  </>;
}

beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function settled() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
}

async function openConnections() {
  const opener = screen.getByRole('button', { name: 'Data & connections' });
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Data & connections' });
  await waitFor(() => expect(within(dialog).getByLabelText('Timezone')).toHaveFocus());
  return { opener, dialog, close: within(dialog).getByRole('button', { name: 'Close' }) };
}

function mockAlternateEntry(name: string) {
  const unavailableCredential = name !== 'Manage data';
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/channel-accounts/instagram_api')) return [{
      // A display account with no credential exercises the existing Connect branches.
      id: unavailableCredential ? '' : 4201, accountIdentifier: 'synthetic-account',
      accountName: 'synthetic-account', displayName: 'Synthetic account',
      profilePictureUrl: null, isSelected: true, usesInstagramLogin: true, analyticsReady: true,
    }];
    if (url.includes('/social-analytics/dashboard')) return {
      summary: {}, trends: [], recommendation: { recommendation: null, citations: [] }, bestTime: null,
      previousPeriod: null, sync: null,
      freshness: { latestSnapshotAt: unavailableCredential ? null : '2026-10-10T00:00:00.000Z', snapshotCount: 0, evidenceSourceCount: 0 },
    };
    return [];
  });
}

describe.each(['Manage data', 'Connect', 'Open data & connections'])('Analytics alternate entry: %s', name => {
  it.each(['unfocused pointer Close', 'keyboard Enter Close', 'keyboard Escape'])('preserves actual ownership on direct, toolbar→alternate and alternating %s cycles', async method => {
    mockAlternateEntry(name);
    const user = userEvent.setup();
    render(<Fixture />);
    const alternate = await screen.findByRole('button', { name });
    const toolbar = screen.getByRole('button', { name: 'Data & connections' });
    for (const phase of ['direct', 'toolbar first', 'alternating', 'alternating']) {
      if (phase !== 'direct') {
        toolbar.focus();
        await user.keyboard('{Enter}');
        await screen.findByRole('dialog', { name: 'Data & connections' });
        await user.keyboard('{Escape}');
        await settled();
        expect(toolbar).toHaveFocus();
      }
      if (method === 'unfocused pointer Close') {
        screen.getByRole('button', { name: 'New navigation action' }).focus();
        fireEvent.click(alternate);
      } else {
        alternate.focus();
        await user.keyboard('{Enter}');
      }
      const dialog = await screen.findByRole('dialog', { name: 'Data & connections' });
      await waitFor(() => expect(within(dialog).getByLabelText('Timezone')).toHaveFocus());
      if (method === 'keyboard Escape') await user.keyboard('{Escape}');
      else {
        const close = within(dialog).getByRole('button', { name: 'Close' });
        if (method === 'unfocused pointer Close') fireEvent.click(close);
        else { close.focus(); await user.keyboard('{Enter}'); }
      }
      await settled();
      expect(document.activeElement).toBe(alternate);
    }
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each(['removed', 'disabled', 'hidden', 'inert', 'aria-hidden'])('does not fall back to the stale toolbar when its %s opener is unavailable', async state => {
    mockAlternateEntry(name);
    render(<Fixture />);
    const alternate = await screen.findByRole('button', { name });
    const { opener: toolbar, close: toolbarClose } = await openConnections();
    fireEvent.click(toolbarClose);
    await settled();
    const toolbarRestore = vi.spyOn(toolbar, 'focus');
    fireEvent.click(alternate);
    const dialog = await screen.findByRole('dialog', { name: 'Data & connections' });
    const alternateRestore = vi.spyOn(alternate, 'focus');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    if (state === 'removed') alternate.remove();
    else alternate.setAttribute(state, state === 'aria-hidden' ? 'true' : '');
    await settled();
    expect(alternateRestore).not.toHaveBeenCalled();
    expect(toolbarRestore).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('Analytics Data & connections focus lifecycle', () => {
  it.each(['pointer Close', 'Enter Close', 'Escape'])('returns to the exact opener after repeated %s dismissal', async method => {
    const user = userEvent.setup();
    render(<StrictMode><Fixture /></StrictMode>);
    const opener = screen.getByRole('button', { name: 'Data & connections' });
    let originalTimezone: string | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      if (method === 'pointer Close') await user.click(opener);
      else { opener.focus(); await user.keyboard('{Enter}'); }
      const dialog = await screen.findByRole('dialog', { name: 'Data & connections' });
      const timezone = within(dialog).getByLabelText('Timezone') as HTMLInputElement;
      await waitFor(() => expect(timezone).toHaveFocus());
      originalTimezone ??= timezone.value;
      expect(timezone).toHaveValue(originalTimezone);
      if (method === 'Escape') await user.keyboard('{Escape}');
      else {
        const close = within(dialog).getByRole('button', { name: 'Close' });
        if (method === 'pointer Close') await user.click(close);
        else { close.focus(); await user.keyboard('{Enter}'); }
      }
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Data & connections' })).toBeNull());
      await settled();
      expect(document.activeElement).toBe(opener);
    }
    expect(mocks.track).toHaveBeenCalledTimes(3);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('captures the activated opener even when pointer activation did not focus it', async () => {
    render(<Fixture />);
    screen.getByRole('button', { name: 'New navigation action' }).focus();
    const { opener, close } = await openConnections();
    fireEvent.click(close);
    await settled();
    expect(opener).toHaveFocus();
  });

  it('preserves initial Timezone focus and keyboard trapping', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const { dialog, close } = await openConnections();
    const timezone = within(dialog).getByLabelText('Timezone');
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab();
    expect(timezone).toHaveFocus();
    close.focus();
    await user.tab();
    expect(timezone).toHaveFocus();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('retains the opener through unrelated rerenders', async () => {
    const view = render(<Fixture />);
    const { opener, close } = await openConnections();
    view.rerender(<Fixture revision={1} />);
    fireEvent.click(close);
    await settled();
    expect(opener).toHaveFocus();
  });

  it.each([false, true])('respects a newer focus decision (later blurred: %s)', async blur => {
    render(<Fixture />);
    const { opener, close } = await openConnections();
    const restore = vi.spyOn(opener, 'focus');
    fireEvent.click(close);
    const next = screen.getByRole('button', { name: 'New navigation action' });
    next.focus();
    if (blur) next.blur();
    await settled();
    expect(restore).not.toHaveBeenCalled();
    if (!blur) expect(next).toHaveFocus();
  });

  it.each(['pointer', 'keyboard'])('respects a newer %s decision without a focus destination', async action => {
    render(<Fixture />);
    const { opener, close } = await openConnections();
    const restore = vi.spyOn(opener, 'focus');
    fireEvent.click(close);
    const next = screen.getByRole('button', { name: 'New navigation action' });
    if (action === 'pointer') fireEvent.pointerDown(next);
    else fireEvent.keyDown(next, { key: 'Enter' });
    await settled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('rejects deferred restoration after a route change', async () => {
    render(<Fixture />);
    const { opener, close } = await openConnections();
    const restore = vi.spyOn(opener, 'focus');
    fireEvent.click(close);
    const previousUrl = window.location.href;
    try {
      window.history.pushState(null, '', '/dashboard/leads');
      await settled();
      expect(restore).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, '', previousUrl); }
  });

  it.each(['removed', 'disabled', 'hidden', 'inert', 'aria-hidden'])('rejects an opener that becomes %s while closing', async state => {
    render(<Fixture />);
    const { opener, close } = await openConnections();
    const restore = vi.spyOn(opener, 'focus');
    fireEvent.click(close);
    if (state === 'removed') opener.remove();
    else opener.setAttribute(state, state === 'aria-hidden' ? 'true' : '');
    await settled();
    expect(restore).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not reclaim focus after page unmount (already closing: %s)', async closing => {
    const view = render(<Fixture />);
    const { opener, close } = await openConnections();
    const restore = vi.spyOn(opener, 'focus');
    if (closing) fireEvent.click(close);
    view.rerender(<Fixture showPage={false} />);
    await settled();
    expect(restore).not.toHaveBeenCalled();
  });

  it.each([false, true])('retires the session on a workspace remount (already closing: %s)', async closing => {
    const view = render(<Fixture workspace={1} />);
    const { opener, close } = await openConnections();
    const restore = vi.spyOn(opener, 'focus');
    if (closing) fireEvent.click(close);
    view.rerender(<Fixture workspace={2} />);
    await settled();
    expect(restore).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Data & connections' })).toBeNull();
    const next = await openConnections();
    expect(next.opener).not.toBe(opener);
    fireEvent.click(next.close);
    await settled();
    expect(next.opener).toHaveFocus();
  });

  it('yields to a newer dialog during dismissal', async () => {
    const view = render(<Fixture />);
    const { close } = await openConnections();
    fireEvent.click(close);
    view.rerender(<Fixture nextDialog />);
    await settled();
    expect(screen.getByRole('button', { name: 'Newer dialog action' })).toHaveFocus();
  });

  it('ignores retired callbacks after an immediate reopening', async () => {
    render(<Fixture />);
    const { opener, close } = await openConnections();
    fireEvent.click(close);
    fireEvent.click(opener);
    await settled();
    expect(screen.getByLabelText('Timezone')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settled();
    expect(opener).toHaveFocus();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
