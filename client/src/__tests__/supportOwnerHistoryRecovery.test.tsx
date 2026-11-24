import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerTicket from '@/app/dashboard/(main)/support/[id]/page';

const mocks = vi.hoisted(() => ({
  timeline: vi.fn(), get: vi.fn(), post: vi.fn(), toast: vi.fn(),
  refresh: null as null | (() => Promise<void>),
}));
const router = { push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ id: '59' }) }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 9, businessProfileId: 1 } }) }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({
  useSupportRealtimeRefresh: (refresh: () => Promise<void>) => { mocks.refresh = refresh; return { isRealtimeConnected: true }; },
}));
vi.mock('@/components/proposals/RelatedProposals', () => ({ RelatedProposals: () => null }));
const event = (content: string, type = 'customer') => ({
  key: content, id: 10, source: 'ticket', type, direction: 'inbound', content,
  actorName: null, attachments: [], createdAt: '2026-10-23T00:00:00Z',
  deliveryStatus: null, providerMessageId: null, deliveryError: null,
});
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.timeline.mockReset().mockResolvedValue({ events: [] });
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/timeline')) return mocks.timeline(url);
    if (url.endsWith('/teams')) return [];
    return { id: 59, ticketNumber: 'SUP-59', subject: 'Synthetic history case', description: '',
      status: 'open', priority: 'medium', tags: [], channel: 'web', customerName: 'Synthetic',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', totalMessages: 250 };
  });
});
afterEach(cleanup);

describe('owner history availability and recovery', () => {
  it('does not treat automation ownership as verified AI reply readiness', async () => {
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (url: string) => url === '/api/support/59'
      ? { ...await get(url), ownershipMode: 'ai_active', aiReplyEnabled: true, handoffId: null, status: 'resolved' }
      : get(url));
    render(<OwnerTicket />);
    expect(await screen.findByText('AI reply readiness not verified here')).toBeInTheDocument();
    expect(screen.getAllByText('No human takeover')).toHaveLength(2);
    expect(screen.getByText(/Replies require an enabled runtime and a ready, published assistant assigned to the account/)).toBeInTheDocument();
    for (const claim of ['AI active', 'AI can respond', 'No active handoff is blocking automation.']) {
      expect(screen.queryByText(claim)).not.toBeInTheDocument();
    }
    expect(mocks.get.mock.calls.every(([url]) => String(url).startsWith('/api/support/'))).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('describes ticket-level AI permission without claiming a ready assistant exists', async () => {
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (url: string) => url === '/api/support/59'
      ? { ...await get(url), ownershipMode: 'ai_active', aiReplyEnabled: true, handoffId: 8, handoffAssignedMemberId: 4 }
      : get(url));
    render(<OwnerTicket />);
    expect(await screen.findByText(/This handoff permits limited AI assistance/)).toBeInTheDocument();
    expect(screen.getAllByText('Human owned')).toHaveLength(2);
    expect(screen.getByText('AI reply readiness not verified here')).toBeInTheDocument();
    expect(screen.queryByText('Ticket-aware AI is available')).not.toBeInTheDocument();
  });
  it('records ended human takeover without promising that closure restored delivery', async () => {
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (url: string) => url === '/api/support/59'
      ? { ...await get(url), ownershipMode: 'ai_active', handoffId: null, metadata: { ownershipResolution: {
        outcome: 'ai_resumed', resolution: 'closed', resolvedAt: '2026-10-27T00:00:00Z',
      } } }
      : get(url));
    render(<OwnerTicket />);
    expect(await screen.findByText('Ticket closed; human takeover ended')).toBeInTheDocument();
    expect(screen.getByText('Closing the ticket ended human takeover. Assistant readiness and delivery rules still apply to future messages.')).toBeInTheDocument();
    expect(screen.queryByText('Ticket closed and AI resumed')).not.toBeInTheDocument();
  });
  it('distinguishes unavailable history from an empty conversation', async () => {
    mocks.timeline.mockRejectedValueOnce(new Error('Synthetic private backend detail'));
    render(<OwnerTicket />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Conversation history could not be loaded');
    expect(screen.getByText('History unavailable · 250 stored')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic private backend detail')).not.toBeInTheDocument();
  });
  it('retries only the existing history read and preserves its window and event projection', async () => {
    mocks.timeline.mockRejectedValueOnce(new Error('Synthetic outage')).mockResolvedValueOnce({
      events: [event('Recovered customer message'), event('Synthetic system event', 'system')],
    });
    render(<OwnerTicket />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry conversation history' }));
    expect(await screen.findByText('Recovered customer message')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic system event')).not.toBeInTheDocument();
    expect(mocks.timeline.mock.calls.map(call => call[0])).toEqual([
      '/api/support/59/timeline?latest=true&limit=200', '/api/support/59/timeline?latest=true&limit=200',
    ]);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('retains loaded history and labels it stale when a realtime refresh fails', async () => {
    mocks.timeline.mockResolvedValueOnce({ events: [event('Previously loaded message')] }).mockRejectedValueOnce(new Error('Synthetic refresh outage'));
    render(<OwnerTicket />);
    expect(await screen.findByText('Previously loaded message')).toBeInTheDocument();
    await act(async () => { await mocks.refresh!(); });
    expect(screen.getByRole('alert')).toHaveTextContent('Displayed messages may be out of date');
    expect(screen.getByText('Previously loaded message')).toBeInTheDocument();
    expect(screen.getByText('1 last loaded · 250 stored')).toBeInTheDocument();
  });
  it('keeps a successful empty history distinct from failure', async () => {
    render(<OwnerTicket />);
    await waitFor(() => expect(screen.getByText('0 events · 250 stored')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('does not let an older refresh failure overwrite a newer successful read', async () => {
    mocks.timeline.mockResolvedValueOnce({ events: [event('Initial message')] });
    render(<OwnerTicket />);
    await screen.findByText('Initial message');
    let rejectOlder!: (error: Error) => void;
    mocks.timeline.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOlder = reject; }))
      .mockResolvedValueOnce({ events: [event('Newest message')] });
    let older!: Promise<void>;
    act(() => { older = mocks.refresh!(); });
    await act(async () => { await mocks.refresh!(); });
    await act(async () => { rejectOlder(new Error('Older failed read')); await older; });
    expect(screen.getByText('Newest message')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('bounds an in-flight retry without issuing a write or a competing retry', async () => {
    mocks.timeline.mockRejectedValueOnce(new Error('Synthetic outage'));
    render(<OwnerTicket />);
    const retry = await screen.findByRole('button', { name: 'Retry conversation history' });
    let finish!: (value: unknown) => void;
    mocks.timeline.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(mocks.timeline).toHaveBeenCalledTimes(2);
    await act(async () => { finish({ events: [event('Retried history')] }); });
    expect(screen.getByText('Retried history')).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
