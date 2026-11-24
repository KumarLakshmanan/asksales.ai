import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxItem } from '@/lib/outreach-inbox';
const mocks = vi.hoisted(() => ({ params: new URLSearchParams('channel=whatsapp'), get: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), useSearchParams: () => mocks.params }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/components/support/ConversationEventTimeline', () => ({ ConversationEventTimeline: () => null }));
vi.mock('@/components/outreach/inbox/useInboxConversation', () => ({ useInboxConversation: (item: InboxItem) => ({ item, loading: true, messages: [], draft: { content: '', subject: '', attachments: [] } }) }));
vi.mock('@/components/outreach/OutreachComposeArea', () => ({ OutreachComposeArea: () => null }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));
vi.mock('@/components/outreach/EmailSenderPicker', () => ({ EmailSenderPicker: () => null }));
import OutreachInbox from '@/components/outreach/inbox/OutreachInbox';
const item = (id: number): InboxItem => ({ key: `conversation:${id}`, kind: 'conversation', id, channel: 'whatsapp', leadId: id, leadName: `Contact ${id}`, leadEmail: null, leadPhone: null, leadCompany: null, leadAvatar: null, recipient: null, subject: null, preview: 'Message', activityAt: `2026-10-03T08:${String(59 - id).padStart(2, '0')}:00Z`, unreadCount: 0, totalMessages: 1, status: 'active', integrationProvider: null, reply: { canReply: true, reason: null, accountLabel: 'Original account', providerAccountId: 'wa-1' } });
const counts = { all: 0, whatsapp: 0, email: 0, instagram: 0, facebook: 0, sms: 0 };
beforeEach(() => { vi.clearAllMocks(); mocks.params = new URLSearchParams('channel=whatsapp'); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const viewport = () => screen.getByRole('button', { name: 'Open Contact 1 on WhatsApp' }).closest('.overflow-y-auto') as HTMLElement;

it('replaces a transient verification error with pending retry feedback and recovers without navigation', async () => {
  let finishRetry!: (value: unknown) => void;
  mocks.get.mockRejectedValueOnce(new Error('Your session could not be verified. Please try again.'))
    .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
  render(<OutreachInbox />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
  expect(mocks.get).toHaveBeenCalledTimes(2);
  await act(async () => finishRetry({ items: [item(1)], nextCursor: null, unreadThreads: counts }));
  await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  expect(screen.queryByRole('status')).toBeNull();
  expect(mocks.replace).not.toHaveBeenCalled();
});

it('ignores a superseded startup failure after switching to Instagram and avoids duplicate refreshes', async () => {
  let failStartup!: (error: Error) => void;
  let finishInstagram!: (value: unknown) => void;
  mocks.params = new URLSearchParams();
  mocks.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { failStartup = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishInstagram = resolve; }));
  render(<OutreachInbox />);
  fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
  expect(mocks.get).toHaveBeenCalledTimes(2);
  await act(async () => finishInstagram({ items: [{ ...item(1), channel: 'instagram' }], nextCursor: null, unreadThreads: counts }));
  await screen.findByRole('button', { name: 'Open Contact 1 on Instagram' });
  await act(async () => failStartup(new Error('Authentication failed')));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('ends a timed-out search with a recoverable error and retries the same search', async () => {
  let shouldTimeout = true;
  let searchSignal: AbortSignal | undefined;
  mocks.get.mockImplementation((url: string, options?: { signal: AbortSignal }) => {
    const search = new URL(url, 'http://fixture.test').searchParams.get('search');
    if (search === 'slow' && shouldTimeout) {
      searchSignal = options?.signal;
      return new Promise((_resolve, reject) => options?.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }
    return Promise.resolve({ items: [item(1)], nextCursor: null, unreadThreads: counts });
  });
  render(<OutreachInbox />);
  await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Search inbox'), { target: { value: 'slow' } });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(searchSignal?.aborted).toBe(true);
  expect(screen.getByRole('alert')).toHaveTextContent('The search did not finish within 20 seconds');
  shouldTimeout = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Open Contact 1 on WhatsApp' })).toBeVisible();
  expect(mocks.get.mock.calls.at(-1)?.[0]).toContain('search=slow');
});

it('explains a timed-out first load without blaming a search the user never typed', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  mocks.get.mockImplementation((_url: string, options?: { signal: AbortSignal }) => {
    attempts += 1;
    if (attempts === 1) return new Promise((_resolve, reject) => options?.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    return Promise.resolve({ items: [item(1)], nextCursor: null, unreadThreads: counts });
  });
  render(<OutreachInbox />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Your conversations did not load within 20 seconds');
  expect(alert).not.toHaveTextContent('search');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Open Contact 1 on WhatsApp' })).toBeVisible();
});

it('cancels a superseded search and prevents refresh from discarding an in-flight result', async () => {
  let resolveSearch: (value: unknown) => void = () => {};
  let searchSignal: AbortSignal | undefined;
  mocks.get.mockImplementation((url: string, options?: { signal: AbortSignal }) => {
    const query = new URL(url, 'http://fixture.test').searchParams.get('search');
    if (query === 'slow') { searchSignal = options?.signal; return new Promise(resolve => { resolveSearch = resolve; }); }
    return Promise.resolve({ items: [item(1)], nextCursor: null, unreadThreads: counts });
  });
  render(<OutreachInbox />);
  await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  fireEvent.change(screen.getByLabelText('Search inbox'), { target: { value: 'slow' } });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(searchSignal).toBeDefined());
  const calls = mocks.get.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
  expect(mocks.get).toHaveBeenCalledTimes(calls);
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  fireEvent.change(screen.getByLabelText('Search inbox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  expect(searchSignal?.aborted).toBe(true);
  await act(async () => resolveSearch({ items: [item(2)], nextCursor: null, unreadThreads: counts }));
  expect(screen.queryByRole('button', { name: 'Open Contact 2 on WhatsApp' })).toBeNull();
});

it('loads the next page near the end while retaining keyboard-accessible earlier conversations', async () => {
  mocks.get.mockResolvedValueOnce({ items: [item(1)], nextCursor: 'next', unreadThreads: counts }).mockResolvedValueOnce({ items: [item(1), item(2)], nextCursor: null, unreadThreads: counts });
  render(<OutreachInbox />);
  const first = await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  const list = viewport();
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, value: 1500, writable: true } });
  fireEvent.scroll(list);
  await screen.findByRole('button', { name: 'Open Contact 2 on WhatsApp' });
  expect(screen.getAllByRole('button', { name: 'Open Contact 1 on WhatsApp' })).toHaveLength(1);
  expect(first).toHaveStyle({ contentVisibility: 'auto' });
  expect(mocks.get.mock.calls[1][0]).toContain('cursor=next');
});

it('stops automatic retries after a failed page and retains the manual load-more recovery', async () => {
  mocks.get.mockResolvedValueOnce({ items: [item(1)], nextCursor: 'next', unreadThreads: counts }).mockRejectedValueOnce(new Error('Page unavailable')).mockResolvedValueOnce({ items: [item(2)], nextCursor: null, unreadThreads: counts });
  render(<OutreachInbox />);
  await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  fireEvent.scroll(viewport());
  await screen.findByRole('alert');
  fireEvent.scroll(viewport());
  expect(mocks.get).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open Contact 2 on WhatsApp' })).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Open Contact 1 on WhatsApp' })).toBeInTheDocument();
});

it('retains the visible thread offset when a refresh inserts newer activity above it', async () => {
  mocks.get.mockResolvedValueOnce({ items: [item(1)], nextCursor: 'next', unreadThreads: counts }).mockResolvedValueOnce({ items: [{ ...item(2), activityAt: '2026-10-03T09:00:00Z' }, item(1)], nextCursor: 'next', unreadThreads: counts });
  render(<OutreachInbox />);
  const row = await screen.findByRole('button', { name: 'Open Contact 1 on WhatsApp' });
  const list = viewport();
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, value: 500, writable: true } });
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400 } as DOMRect);
  row.getBoundingClientRect = () => {
    const moved = Boolean(screen.queryByRole('button', { name: 'Open Contact 2 on WhatsApp' }));
    return { top: moved ? 210 : 80, bottom: moved ? 340 : 210, height: 130 } as DOMRect;
  };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
  await screen.findByRole('button', { name: 'Open Contact 2 on WhatsApp' });
  expect(list.scrollTop).toBe(630);
});
