import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Queue from '@/app/support/tickets/page';
import type { SupportMemberTicket } from '@/lib/supportTicketWorkspace';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn() }));
const router = { push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/support/tickets', useSearchParams: () => new URLSearchParams('scope=team') }));
vi.mock('@/lib/support-api', () => ({ supportApi: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/SupportAuthContext', () => ({ useSupportAuth: () => ({ member: { id: 51, teamId: 1 }, isAuthenticated: true, isLoading: false }) }));

const ticket: SupportMemberTicket = {
  id: 1, ticketNumber: 'SYNTHETIC-1', subject: 'Synthetic claim', description: null,
  status: 'open', priority: 'medium', category: null, version: 1, totalMessages: 0, unreadCount: 0,
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', slaDeadline: null,
  customerName: null, customerEmail: null, channel: 'web', conversationId: null,
  assignedMemberId: null, assignedMemberName: null, teamId: 1, teamName: 'Synthetic',
  handoffId: null, handoffStatus: null, handoffReason: null, handoffTriggerType: null,
  handoffConfidenceScore: null, handoffSlaDeadline: null, handoffAssignedMemberId: null,
  ownershipMode: 'ai_active', aiReplyEnabled: true, claimable: true, lastMessagePreview: null, lastMessageAt: null,
};
beforeEach(() => {
  vi.clearAllMocks(); history.replaceState(null, '', '/support/tickets?scope=team');
  mocks.get.mockImplementation(async (url: string) => url.includes('team-members') ? [] : { tickets: [ticket], total: 1, totalPages: 1, page: 1 });
});

describe('claim feedback uses confirmed returned AI state', () => {
  it.each([
    [true, 'The ticket’s AI reply setting is enabled.'],
    [false, 'The ticket’s AI reply setting is disabled.'],
    [undefined, 'Refresh this ticket to check its AI reply setting.'],
  ])('describes returned aiReplyEnabled=%s truthfully', async (aiReplyEnabled, description) => {
    mocks.post.mockResolvedValue({ ...ticket, assignedMemberId: 51, aiReplyEnabled });
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}><Queue /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /^Claim$/ }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: 'Ticket claimed', description }));
    queryClient.clear();
  });
});
