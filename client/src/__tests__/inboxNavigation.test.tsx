import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxItem } from '@/lib/outreach-inbox';

const mocks = vi.hoisted(() => ({ params: new URLSearchParams('channel=email&leadId=3&thread=conversation:7'), replace: vi.fn(), get: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), useSearchParams: () => mocks.params }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/components/outreach/inbox/useInboxConversation', () => ({ useInboxConversation: (item: InboxItem) => ({ item, loading: true, messages: [], draft: { content: '', subject: '', attachments: [] } }) }));
vi.mock('@/components/outreach/OutreachComposeArea', () => ({ OutreachComposeArea: () => null }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));
vi.mock('@/components/outreach/EmailSenderPicker', () => ({ EmailSenderPicker: () => null }));
import OutreachInbox from '@/components/outreach/inbox/OutreachInbox';

const item = { key: 'conversation:7', kind: 'conversation', id: 7, channel: 'email', leadId: 3, leadName: 'Ada', recipient: 'ada@example.test', preview: 'Hello', activityAt: '2026-10-03T00:00:00Z', unreadCount: 0, totalMessages: 1, status: 'active', reply: { canReply: true, accountLabel: null } } as InboxItem;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = new URLSearchParams('channel=email&leadId=3&thread=conversation:7');
  window.history.replaceState(null, '', `/dashboard/outreach/inbox?${mocks.params}`);
  mocks.get.mockImplementation(async (url: string) => url.includes('/inbox/conversation/') ? { item } : { items: [item], nextCursor: null, unreadThreads: { all: 0, email: 0, whatsapp: 0, instagram: 0, facebook: 0, sms: 0 } });
});
afterEach(cleanup);

it('clears SMS to All in the URL and keeps the cleared channel after a fresh mount', async () => {
  mocks.params = new URLSearchParams('channel=sms&leadId=3&source=crm&source=work');
  window.history.replaceState(null, '', `/dashboard/outreach/inbox?${mocks.params}#conversation-list`);
  mocks.get.mockImplementation(async (url: string) => ({ items: new URL(url, 'https://fixture.test').searchParams.get('channel') === 'sms' ? [] : [item], nextCursor: null, unreadThreads: { all: 0 } }));
  const view = render(<OutreachInbox />);
  const clear = await screen.findByRole('button', { name: 'Clear filters' });
  await act(async () => fireEvent.click(clear));
  expect(mocks.replace).toHaveBeenLastCalledWith('/dashboard/outreach/inbox?leadId=3&source=crm&source=work#conversation-list', { scroll: false });
  const target = mocks.replace.mock.calls.at(-1)![0] as string;
  const cleared = new URL(target, window.location.origin);
  mocks.params = cleared.searchParams;
  window.history.replaceState(null, '', target);
  view.unmount();
  render(<OutreachInbox />);
  await screen.findByRole('button', { name: 'Open Ada on Email' });
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  expect(screen.getByRole('button', { name: 'All channels' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'SMS' })).toHaveAttribute('aria-pressed', 'false');
  expect(window.location.hash).toBe('#conversation-list');
});

it('clears local filters while keeping a selected conversation, contact scope, unrelated query and hash', async () => {
  mocks.params = new URLSearchParams('channel=email&leadId=3&thread=conversation:7&source=crm');
  window.history.replaceState(null, '', `/dashboard/outreach/inbox?${mocks.params}#reply`);
  render(<OutreachInbox />);
  await screen.findByRole('region', { name: 'Selected conversation' });
  mocks.get.mockImplementation(async (url: string) => url.includes('/inbox/conversation/') ? { item } : { items: [], nextCursor: null, unreadThreads: { all: 0 } });
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  fireEvent.change(screen.getByLabelText('Search inbox'), { target: { value: 'no-match' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })));
  expect(mocks.replace).toHaveBeenLastCalledWith('/dashboard/outreach/inbox?leadId=3&thread=conversation%3A7&source=crm#reply', { scroll: false });
  expect(screen.getByLabelText('Search inbox')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.getByRole('region', { name: 'Selected conversation' })).toBeInTheDocument();
  await waitFor(() => expect(mocks.get.mock.calls.at(-1)?.[0]).toContain('channel=all&unread=false&search=&'));
});

it('writes channel changes to the URL, preserves the contact filter and clears an incompatible thread', async () => {
  render(<OutreachInbox />);
  await screen.findByRole('region', { name: 'Selected conversation' });
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(mocks.replace).toHaveBeenLastCalledWith('/dashboard/outreach/inbox?channel=sms&leadId=3', { scroll: false });
  expect(screen.queryByRole('region', { name: 'Selected conversation' })).not.toBeInTheDocument();
});

it.each(['invalid', 'conversation:99'])('removes the previous thread during failed navigation to %s', async thread => {
  const view = render(<OutreachInbox />);
  await screen.findByRole('region', { name: 'Selected conversation' });
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/inbox/conversation/99')) throw new Error('Conversation unavailable');
    return { items: [], nextCursor: null, unreadThreads: { all: 0 } };
  });
  mocks.params = new URLSearchParams(`channel=email&thread=${thread}`);
  view.rerender(<OutreachInbox />);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected conversation' })).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getAllByRole('alert').some(alert => /invalid|unavailable/.test(alert.textContent || ''))).toBe(true));
});
