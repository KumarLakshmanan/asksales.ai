import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxItem } from '@/lib/outreach-inbox';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), replace: vi.fn(), params: new URLSearchParams('thread=conversation%3A61') }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/outreach/inbox',
  useSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>();
  const api = { get: mocks.get, post: mocks.post };
  return { ...actual, api, default: api };
});
// These cases cover the error card itself, so automatic transient retries are off.
vi.mock('@/lib/sessionCheckRetry', async original => ({
  ...(await original<typeof import('@/lib/sessionCheckRetry')>()),
  sessionCheckRetryDelays: () => [],
}));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/components/outreach/inbox/useInboxConversation', () => ({ useInboxConversation: (item: InboxItem) => ({ item, loading: true, messages: [], draft: { content: '', subject: '', attachments: [] } }) }));
vi.mock('@/components/outreach/OutreachComposeArea', () => ({ OutreachComposeArea: () => null }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));
vi.mock('@/components/outreach/EmailSenderPicker', () => ({ EmailSenderPicker: () => null }));

import { AuthProvider } from '@/contexts/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useBusinessProfiles } from '@/hooks/use-business-profiles';
import { businessProfileHeaders, selectedBusinessProfileId } from '@/lib/business-profile';
import { ApiError } from '@/lib/api';
import OutreachInbox from '@/components/outreach/inbox/OutreachInbox';

const user = { id: 41, email: 'fixture@example.test', name: 'Synthetic account' };
const profile = { id: 71, name: 'Synthetic workspace', isDefault: true };
const item = { key: 'conversation:61', kind: 'conversation', id: 61, channel: 'instagram', leadName: 'Synthetic contact', recipient: 'fixture', preview: 'Hello', activityAt: '2026-10-27T00:00:00Z', unreadCount: 0, totalMessages: 1, status: 'active', reply: { canReply: false, accountLabel: null } } as InboxItem;

// Match the dashboard's workspace gate while using the real inbox navigation,
// auth provider and business-profile hook together.
function Workspace() {
  const { isLoading, activeProfile } = useBusinessProfiles();
  if (isLoading || !activeProfile) return <p>Checking workspace</p>;
  return <OutreachInbox />;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AuthProvider><ProtectedRoute skipSetupCheck><Workspace /></ProtectedRoute></AuthProvider></QueryClientProvider>);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  window.history.replaceState(null, '', '/dashboard/outreach/inbox?thread=conversation%3A61');
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { user };
    if (url === '/api/settings/business-profiles') return [profile];
    expect(businessProfileHeaders()).toEqual({ 'X-Business-Profile-Id': '71' });
    if (url.includes('/inbox/conversation/61')) return { item };
    return { items: [item], nextCursor: null, unreadThreads: { all: 0 } };
  });
});
afterEach(cleanup);

it('opens an encoded inbox deep link from a fresh cookie session only after hydration', async () => {
  const session = deferred<{ user: typeof user }>();
  mocks.get.mockImplementationOnce(() => session.promise);
  mount();
  expect(mocks.get.mock.calls.map(call => call[0])).toEqual(['/api/auth/me']);
  expect(screen.queryByRole('region', { name: 'Selected conversation' })).toBeNull();
  await act(async () => session.resolve({ user }));
  await screen.findByRole('region', { name: 'Selected conversation' });
  expect(selectedBusinessProfileId()).toBe(71);
  expect(window.location.search).toBe('?thread=conversation%3A61');
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('keeps the deep link on a failed session check and opens it after explicit retry', async () => {
  mocks.get.mockRejectedValueOnce(new TypeError('Connection unavailable'));
  mount();
  await screen.findByText('Session check unavailable');
  expect(mocks.get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry session check' }));
  await screen.findByRole('region', { name: 'Selected conversation' });
  expect(window.location.search).toBe('?thread=conversation%3A61');
  expect(mocks.push).not.toHaveBeenCalled();
});

it('revalidates changed cross-tab account storage and safely resumes the same inbox on retry', async () => {
  mount();
  await screen.findByRole('region', { name: 'Selected conversation' });
  mocks.get.mockRejectedValueOnce(new TypeError('Session verification unavailable'));
  act(() => {
    localStorage.removeItem('user');
    window.dispatchEvent(new StorageEvent('storage', { key: 'user', newValue: null, storageArea: localStorage }));
  });
  await screen.findByText('Session check unavailable');
  expect(screen.queryByRole('region', { name: 'Selected conversation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry session check' }));
  await screen.findByRole('region', { name: 'Selected conversation' });
  expect(window.location.search).toBe('?thread=conversation%3A61');
  expect(mocks.post).not.toHaveBeenCalled();
});

it('redirects a genuinely rejected cross-tab session without selecting stale profiles', async () => {
  mount();
  await screen.findByRole('region', { name: 'Selected conversation' });
  mocks.get.mockRejectedValueOnce(new ApiError('Expired session', 401));
  act(() => {
    localStorage.removeItem('user');
    window.dispatchEvent(new StorageEvent('storage', { key: 'user', newValue: null, storageArea: localStorage }));
  });
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/login'));
  expect(screen.queryByRole('region', { name: 'Selected conversation' })).toBeNull();
  expect(selectedBusinessProfileId()).toBeNull();
});
