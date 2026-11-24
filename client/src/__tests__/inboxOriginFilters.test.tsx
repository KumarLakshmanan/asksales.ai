import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxItem } from '@/lib/outreach-inbox';
import { OutreachMessageBubble } from '@/components/outreach/OutreachMessageBubble';
import type { OutreachMessage } from '@/components/outreach/types';

const mocks = vi.hoisted(() => ({ params: new URLSearchParams('channel=whatsapp'), replace: vi.fn(), get: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), useSearchParams: () => mocks.params }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/components/outreach/inbox/useInboxConversation', () => ({
  useInboxConversation: (item: InboxItem) => ({ item, loading: false, messages: [], draft: { content: '', subject: '', attachments: [] }, setDraft: vi.fn(), send: vi.fn() }),
}));
vi.mock('@/components/outreach/OutreachComposeArea', () => ({
  OutreachComposeArea: (props: { disabled?: boolean; placeholder?: string; extraLeftActions?: React.ReactNode }) => (
    <div data-testid="reply-bar" data-disabled={String(Boolean(props.disabled))}>{props.placeholder}{props.extraLeftActions}</div>
  ),
}));
vi.mock('@/components/outreach/inbox/InboxWhatsAppTemplate', () => ({ InboxWhatsAppTemplate: () => <p>Template picker</p> }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));
vi.mock('@/components/support/ConversationEventTimeline', () => ({ ConversationEventTimeline: () => null }));
import OutreachInbox from '@/components/outreach/inbox/OutreachInbox';

const item = {
  key: 'conversation:7', kind: 'conversation', id: 7, channel: 'whatsapp', leadId: 3, leadName: 'Ada', recipient: '919800000000',
  preview: 'Hello', activityAt: '2026-10-03T00:00:00Z', unreadCount: 0, totalMessages: 1, status: 'active', origin: 'outreach', aiHandled: true,
  reply: { canReply: true, requiresTemplate: true, accountLabel: 'Sales line', providerAccountId: 'pn-1' },
} as unknown as InboxItem;
const page = {
  items: [item], nextCursor: null,
  unreadThreads: { all: 2, email: 0, whatsapp: 2, instagram: 0, facebook: 0, sms: 0 },
  totalThreads: { all: 1234, email: 0, whatsapp: 1234, instagram: 0, facebook: 0, sms: 0 },
  originCounts: { outreach: 1000, customer: 200, manual: 30, native_app: 4, ai: 12 },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = new URLSearchParams('channel=whatsapp');
  mocks.get.mockImplementation(async (url: string) => url.includes('/inbox/conversation/') ? { item } : page);
});
afterEach(cleanup);

it('shows all and unread totals with origin chips, and filters the list by origin', async () => {
  render(<OutreachInbox />);
  expect(await screen.findByRole('button', { name: /All\s*1,234/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /Unread\s*2/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Customer started\s*200/ })).toBeInTheDocument();
  expect(screen.getByText('Outreach · AI')).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /AI handled\s*12/ })));
  await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith(expect.stringContaining('origin=ai'), expect.anything()));
  expect(screen.getByRole('button', { name: /AI handled/ })).toHaveAttribute('aria-pressed', 'true');
});

it('keeps the reply bar one line when the window is closed and opens templates in a side panel', async () => {
  mocks.params = new URLSearchParams('channel=whatsapp&thread=conversation:7');
  render(<OutreachInbox />);
  expect(await screen.findByText('24-hour window closed · reply with a template')).toBeInTheDocument();
  expect(screen.getByTestId('reply-bar')).toHaveAttribute('data-disabled', 'true');
  expect(screen.queryByText(/Assistant:/)).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Template' })));
  expect(await screen.findByRole('dialog', { name: 'Send a WhatsApp template' })).toBeInTheDocument();
  expect(screen.getByText('Template picker')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send template' })).toBeDisabled();
});

it('heads each sent message with how it was sent', () => {
  const message = {
    id: 1, conversationId: 1, direction: 'outbound', content: 'Hi', status: 'delivered', sentAt: null, deliveredAt: null, readAt: null,
    isRead: true, createdAt: '2026-10-03T00:00:00Z',
    origin: { kind: 'outreach', label: 'AskSales outreach', outreachName: 'Diwali launch', templateName: 'diwali_offer', followUpStep: 2 },
  } as OutreachMessage;
  render(<OutreachMessageBubble channel="whatsapp" message={message} />);
  expect(screen.getByText('AskSales outreach · Diwali launch · Template diwali_offer · Follow-up 2')).toBeInTheDocument();
});
