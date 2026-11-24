import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportPage from '@/app/dashboard/(main)/support/page';
import SupportAnalyticsPage from '@/app/dashboard/(main)/support/analytics/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({ useSupportRealtimeRefresh: () => ({ isRealtimeConnected: true }) }));
vi.mock('@/components/support/CreateSupportTicketDialog', () => ({ CreateSupportTicketDialog: () => null }));

const metrics = { totalTickets: 0, openTickets: 0, activeTickets: 0, waitingOnCustomerTickets: 0, resolvedTickets: 0, slaBreaches: 0, deliveryFailures: 0,
  avgFirstResponseHours: 0, avgResolutionHours: 0, handoffs: 0, reviewCount: 0, averageRating: 0, days: 30, statusDistribution: {}, priorityDistribution: {}, ticketsByDay: [],
  currentQueue: { openTickets: 227, activeTickets: 228, waitingOnCustomerTickets: 1, slaBreaches: 220, ticketsWithSla: 228 } };
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState(null, '', '/dashboard/support');
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('/analytics') ? metrics : { tickets: [{ id: 1, ticketNumber: 'OLD-1', subject: 'Older unresolved ticket', status: 'open', priority: 'high', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', slaDeadline: '2026-08-02T00:00:00Z', customerName: 'Customer', channel: 'email' }], totalPages: 1, total: 1 }));
});
afterEach(cleanup);
describe('current support workload versus reporting period', () => {
  it('shows older active tickets in queue totals even when this period has no intake', async () => {
    render(<SupportPage />);
    await screen.findByText('Older unresolved ticket');
    expect(screen.getByText('Active queue').parentElement).toHaveTextContent('228');
    expect(screen.getByText('SLA breached').parentElement).toHaveTextContent('220');
    expect(screen.getByText('Waiting').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Active queue').parentElement).toHaveTextContent('all dates');
    expect(screen.getByText('Resolved').parentElement).toHaveTextContent('0');
  });
  it('computes current SLA health from current deadlines, without using period intake as denominator', async () => {
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByText('Active queue').parentElement).toHaveTextContent('228');
    expect(screen.getByText('SLA health').parentElement).toHaveTextContent('4%');
    expect(screen.getByText('SLA health').parentElement).toHaveTextContent('220 breached');
  });
  it('does not present an empty SLA sample as perfect health', async () => {
    mocks.get.mockResolvedValue({ ...metrics, currentQueue: { ...metrics.currentQueue, ticketsWithSla: 0, slaBreaches: 0 } });
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByText('SLA health').parentElement).toHaveTextContent('—');
    expect(screen.getByText('SLA health').parentElement).not.toHaveTextContent('100%');
  });
  it('shows a totals failure rather than silently hiding it or inventing zeroes', async () => {
    mocks.get.mockImplementation((path: string) => path.includes('/analytics') ? Promise.reject(new Error('Unavailable')) : Promise.resolve({ tickets: [], total: 0, totalPages: 1 }));
    render(<SupportPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue totals are unavailable');
    expect(screen.getByRole('button', { name: 'Retry totals' })).toBeEnabled();
    expect(screen.queryByText('Active queue')).not.toBeInTheDocument();
  });
});
