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
  vi.clearAllMocks(); mocks.allowed = true; mocks.post.mockResolvedValue({ reviewDeliveryStatus: 'in_progress' });
  Element.prototype.scrollIntoView = vi.fn();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/reveal')) return { content: 'Private widget details', revealExpiresAt: new Date(Date.now() + 1000).toISOString() };
    if (url.includes('/timeline')) return { canRevealRestrictedContent: mocks.allowed, events: [{ key: 'support_chat:12', id: 12, source: 'support_chat', type: 'customer', direction: 'inbound', content: '[Restricted content]', restricted: true, attachments: [], createdAt: '2026-09-18T00:00:00Z' }] };
    return { id: 1, ticketNumber: 'SUP-1', subject: 'Widget request', status: 'open', priority: 'medium', tags: [], messages: [], channel: 'web', customerName: 'Customer', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', totalMessages: 1, ownershipMode: 'human', handoffId: 9, handoffStatus: 'in_progress', assignedMemberId: 7, aiReplyEnabled: false, claimable: false };
  });
});
afterEach(() => { vi.useRealTimers(); });
describe('review delivery outcome', () => {
  it('opens a named modal with focus inside and closes on Escape', async () => {
    render(<TicketPage />);
    const opener = await screen.findByRole('button', { name: 'Close & Review' });
    opener.focus(); fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Close Ticket' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('describes an in-progress review without claiming delivery or displaying undefined', async () => {
    render(<TicketPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close & Review' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close & Send' })); });
    const toast = mocks.toast.mock.calls.find(call => call[0].title === 'Ticket closed')?.[0];
    expect(toast?.description).toContain('Review delivery is in progress');
    expect(toast?.description).not.toContain('undefined');
    expect(toast?.description).not.toContain('received the review');
  });
});
