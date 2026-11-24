import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TicketPage from '@/app/dashboard/(main)/support/[id]/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), push: vi.fn(), ticketId: '1' }));
const router = { push: mocks.push };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 7, businessProfileId: 3 } }) }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ id: mocks.ticketId }) }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({ useSupportRealtimeRefresh: () => ({ isRealtimeConnected: true }) }));
vi.mock('@/components/proposals/RelatedProposals', () => ({ RelatedProposals: () => null }));

beforeEach(() => {
  vi.clearAllMocks(); mocks.ticketId = '1';
  Element.prototype.scrollIntoView = vi.fn();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/timeline')) return { events: [{ key: 'conversation:12', id: 12, source: 'conversation', type: 'customer', direction: 'inbound', content: '[Restricted content]', restricted: true, createdAt: '2026-09-18T00:00:00Z' }] };
    if (url.endsWith('/teams')) return [];
    return { id: Number(mocks.ticketId), ticketNumber: 'SUP-1', subject: 'Customer request', status: 'open', priority: 'medium', tags: [], channel: 'instagram', customerName: 'Customer', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', totalMessages: 1, ownershipMode: 'human', aiReplyEnabled: false };
  });
  mocks.post.mockImplementation(async () => ({ content: 'Private contact details', revealExpiresAt: new Date(Date.now() + 1000).toISOString() }));
});
afterEach(() => vi.useRealTimers());

describe('explicit owner restricted-content access', () => {
  it('requires a reason, records the explicit request, and hides details at server expiry', async () => {
    render(<TicketPage />);
    const reveal = await screen.findByRole('button', { name: 'Reveal restricted content' });
    expect(reveal).toBeDisabled(); expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for restricted content access' }), { target: { value: 'Confirm callback details' } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(reveal); });
    expect(mocks.post).toHaveBeenCalledWith('/api/support/1/messages/conversation/12/reveal', { reason: 'Confirm callback details' });
    expect(screen.getByText('Private contact details')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.queryByText('Private contact details')).not.toBeInTheDocument();
    expect(screen.getByText('[Restricted content]')).toBeInTheDocument();
  });

  it('clears a revealed message when navigating to another ticket', async () => {
    const view = render(<TicketPage />);
    const reveal = await screen.findByRole('button', { name: 'Reveal restricted content' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for restricted content access' }), { target: { value: 'Resolve request' } });
    await act(async () => { fireEvent.click(reveal); });
    expect(screen.getByText('Private contact details')).toBeInTheDocument();
    mocks.ticketId = '2';
    await act(async () => view.rerender(<TicketPage />));
    expect(screen.queryByText('Private contact details')).not.toBeInTheDocument();
  });
});
