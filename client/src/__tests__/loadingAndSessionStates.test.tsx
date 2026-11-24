import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageLoadingState, PAGE_LOADING_SLOW_AFTER_MS } from '@/components/ui/page-state';
import { dashboardPageName } from '@/lib/dashboardPageName';
import { SESSION_CARD_RECHECK_MS } from '@/lib/sessionCheckRetry';

const { auth, push } = vi.hoisted(() => ({
  push: vi.fn(),
  auth: {
    workspaceRole: 'owner', user: { id: 1 }, isAuthenticated: false, isLoading: false, isApproved: true,
    isSetupComplete: true, hasBusinessProfile: true, hasBrandToolkit: true,
    error: null as string | null, checkAuth: vi.fn(async () => undefined),
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: push }), usePathname: () => '/dashboard/crm/contacts' }));

import { ProtectedRoute } from '@/components/ProtectedRoute';

describe('PageLoadingState', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('names the page and step, then offers a retry once the load is slow', () => {
    const onRetry = vi.fn();
    render(<PageLoadingState context="CRM · Contacts" label="Checking account access…" description="Confirming your sign-in." onRetry={onRetry} />);
    expect(screen.getByText('CRM · Contacts')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking account access…');
    expect(screen.getByText('Confirming your sign-in.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(PAGE_LOADING_SLOW_AFTER_MS + 1_000); });
    expect(screen.getByRole('status')).toHaveTextContent(/Still working after \d+ seconds/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never shows the slow notice when it is turned off', () => {
    render(<PageLoadingState label="Loading…" slowAfterMs={0} />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('dashboardPageName', () => {
  it('turns dashboard routes into readable names and skips ids', () => {
    expect(dashboardPageName('/dashboard/crm/contacts')).toBe('CRM · Contacts');
    expect(dashboardPageName('/dashboard/chats')).toBe('Campaign history');
    expect(dashboardPageName('/dashboard/saved-templates')).toBe('Content library');
    expect(dashboardPageName('/dashboard/conversations/123')).toBe('Conversations');
    expect(dashboardPageName('/dashboard/outreach/follow-ups?tab=email')).toBe('Outreach · Follow-ups');
    expect(dashboardPageName('/dashboard')).toBe('Dashboard');
    expect(dashboardPageName('/pricing')).toBeNull();
    expect(dashboardPageName(null)).toBeNull();
  });
});

describe('ProtectedRoute session card', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.isLoading = false; auth.isAuthenticated = false; auth.checkAuth.mockClear(); push.mockClear();
    auth.error = 'We could not reach the server to confirm your sign-in.';
  });
  afterEach(() => { vi.useRealTimers(); auth.error = null; });

  it('shows the page, a countdown and a manual retry, and never redirects to login', () => {
    render(<ProtectedRoute><p>secret</p></ProtectedRoute>);
    expect(screen.getByRole('alert')).toHaveTextContent('Session check unavailable');
    expect(screen.getByText('CRM · Contacts')).toBeInTheDocument();
    expect(screen.getByText(`Checking again in ${SESSION_CARD_RECHECK_MS / 1_000} seconds.`)).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText(`Checking again in ${SESSION_CARD_RECHECK_MS / 1_000 - 5} seconds.`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry session check' }));
    expect(auth.checkAuth).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(SESSION_CARD_RECHECK_MS); });
    expect(auth.checkAuth).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });

  it('labels the loading state with the page being opened', () => {
    auth.error = null; auth.isLoading = true;
    render(<ProtectedRoute><p>secret</p></ProtectedRoute>);
    expect(screen.getByText('CRM · Contacts')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your workspace…');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});
