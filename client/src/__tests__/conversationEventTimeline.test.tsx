import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantActivity, AssistantConversationContext } from '../../../shared/assistantOperations';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/lib/business-profile', () => ({
  subscribeBusinessProfile: () => () => {}, selectedBusinessProfileId: () => 42,
  businessProfileHeaders: () => ({ 'X-Business-Profile-Id': '42' }),
}));
import { ConversationEventTimeline } from '@/components/support/ConversationEventTimeline';
const context: AssistantConversationContext = { assistantId: 'assistant-1', name: 'Oro support', revision: 3, channel: 'whatsapp', accountId: 'original-account', mode: 'ai', sessionStatus: 'active', playbook: { id: 5, name: 'Room booking', nodeId: 'guests', status: 'running' }, followUp: { status: 'scheduled', scheduledAt: '2026-10-04T08:00:00Z' } };
const event = (key: string, extra: Partial<AssistantActivity> = {}): AssistantActivity => ({ key, id: 1, kind: 'delivery', conversationId: 7, channel: 'whatsapp', accountId: 'original-account', status: 'uncertain', createdAt: '2026-10-03T08:00:00Z', scheduledAt: null, content: 'I sent the brochure successfully', reason: 'Provider confirmation is missing', providerMessageId: null, assistantId: 'assistant-1', assistantRevision: 3, step: null, ...extra });
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it('shows actual outcomes and original account without repeating generated success claims', async () => {
  mocks.get.mockResolvedValue({ items: [event('delivery:1'), event('delivery:3', { content: 'Approved PDF delivery', status: 'failed' }), event('proposal:2', { kind: 'proposal', content: 'Hotel stay proposal', status: 'awaiting_approval', resourceId: 12 })], context, nextCursor: null });
  render(<ConversationEventTimeline conversationId={7} initiallyOpen />);
  await screen.findByText('Oro support');
  expect(screen.getByText(/Account original-account/)).toBeInTheDocument();
  expect(screen.getByText(/Playbook: Room booking/)).toBeInTheDocument();
  expect(screen.getByText('Delivery · uncertain')).toBeInTheDocument();
  expect(screen.getByText('Approved PDF delivery · failed')).toBeInTheDocument();
  expect(screen.queryByText('I sent the brochure successfully')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Open proposal/ })).toHaveAttribute('href', '/dashboard/proposals/12');
  expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('/conversations/7/activity?limit=25'), { headers: { 'X-Business-Profile-Id': '42' } });
});

it('paginates, deduplicates events and retains loaded history when the next page fails', async () => {
  mocks.get.mockResolvedValueOnce({ items: [event('delivery:1')], context, nextCursor: 'page-2' }).mockRejectedValueOnce(new Error('Activity unavailable')).mockResolvedValueOnce({ items: [event('delivery:1'), event('session:2', { kind: 'session', status: 'completed' })], context, nextCursor: null });
  render(<ConversationEventTimeline conversationId={7} initiallyOpen />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier activity' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Delivery · uncertain')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier activity' }));
  await screen.findByText('Conversation session · completed');
  expect(screen.getAllByText('Delivery · uncertain')).toHaveLength(1);
  expect(mocks.get.mock.calls[2][0]).toContain('cursor=page-2');
});

it('ignores an earlier conversation response after switching threads', async () => {
  let finish!: (value: unknown) => void;
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ items: [], context: { ...context, name: 'New assistant', accountId: 'new-account' }, nextCursor: null });
  const view = render(<ConversationEventTimeline conversationId={7} />);
  view.rerender(<ConversationEventTimeline conversationId={8} />);
  await screen.findByText('New assistant');
  await act(async () => { finish({ items: [event('old')], context, nextCursor: null }); });
  expect(screen.queryByText('Oro support')).not.toBeInTheDocument();
  expect(screen.getByText(/new-account/)).toBeInTheDocument();
});

it('keeps the last known context visible after a failed refresh and offers human support navigation', async () => {
  mocks.get.mockResolvedValueOnce({ items: [], context: { ...context, mode: 'human_owned' }, nextCursor: null }).mockRejectedValueOnce(new Error('Refresh failed'));
  render(<ConversationEventTimeline conversationId={7} />);
  expect(await screen.findByRole('link', { name: /Open support tickets/ })).toHaveAttribute('href', '/dashboard/support');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation activity' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed'));
  expect(screen.getByText('Oro support')).toBeInTheDocument();
});
