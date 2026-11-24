import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TicketPage from '@/app/support/tickets/[id]/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), push: vi.fn(), allowed: true }));
const router = { push: mocks.push };
vi.mock('@/lib/support-api', () => ({ supportApi: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ id: '1' }) }));
vi.mock('@/contexts/SupportAuthContext', () => ({ useSupportAuth: () => ({ member: { id: 7, name: 'Member', role: 'member' }, isAuthenticated: true, isLoading: false }) }));

beforeEach(() => {
  vi.clearAllMocks(); mocks.allowed = true;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/reveal')) return { content: 'Private widget details', revealExpiresAt: new Date(Date.now() + 1000).toISOString() };
    if (url.includes('/timeline')) return { canRevealRestrictedContent: mocks.allowed, events: [{ key: 'support_chat:12', id: 12, source: 'support_chat', type: 'customer', direction: 'inbound', content: '[Restricted content]', restricted: true, attachments: [], createdAt: '2026-09-18T00:00:00Z' }] };
    return { id: 1, ticketNumber: 'SUP-1', subject: 'Widget request', status: 'open', priority: 'medium', tags: [], messages: [], channel: 'web', customerName: 'Customer', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', totalMessages: 1, ownershipMode: 'human', handoffId: 9, handoffStatus: 'in_progress', assignedMemberId: 7, aiReplyEnabled: false, claimable: false };
  });
});
afterEach(() => vi.useRealTimers());

describe('member widget restricted-content access', () => {
  it('allows the assigned member to reveal a widget message and honors server expiry', async () => {
    render(<TicketPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Full conversation/ }));
    const reveal = await screen.findByRole('button', { name: 'Reveal restricted content' });
    expect(reveal).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for restricted content access' }), { target: { value: 'Confirm request details' } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(reveal); });
    expect(mocks.get).toHaveBeenCalledWith('/api/support-portal/handoffs/9/messages/12/reveal?reason=Confirm%20request%20details');
    expect(screen.getByText('Private widget details')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.queryByText('Private widget details')).not.toBeInTheDocument();
  });

  it('does not infer reveal permission merely from the presence of a handoff', async () => {
    mocks.allowed = false;
    render(<TicketPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Full conversation/ }));
    expect(await screen.findByRole('button', { name: 'Reveal restricted content' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'Reason for restricted content access' })).not.toBeInTheDocument();
  });
});
