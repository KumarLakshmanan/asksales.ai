import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportAnalyticsPage from '@/app/dashboard/(main)/support/analytics/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({ useSupportRealtimeRefresh: () => ({ isRealtimeConnected: true }) }));

const metrics = { totalTickets: 0, openTickets: 0, activeTickets: 0, waitingOnCustomerTickets: 0, resolvedTickets: 0, slaBreaches: 0, deliveryFailures: 0,
  avgFirstResponseHours: 0, avgResolutionHours: 0, handoffs: 0, reviewCount: 0, averageRating: 0, days: 30, statusDistribution: {}, priorityDistribution: {}, ticketsByDay: [],
  currentQueue: { openTickets: 0, activeTickets: 0, waitingOnCustomerTickets: 0, slaBreaches: 0, ticketsWithSla: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(metrics);
});
afterEach(cleanup);

describe('support analytics without measured response times', () => {
  it('shows "No data yet" instead of an instant 0.0h first response or resolution time', async () => {
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByText('First response').parentElement).toHaveTextContent('No data yet');
    expect(screen.getByText('First response').parentElement).toHaveTextContent('No replies measured in this period');
    expect(screen.getByText('Average resolution time').parentElement).toHaveTextContent('No data yet');
    expect(screen.queryByText('0.0h')).not.toBeInTheDocument();
  });

  it('shows the measured average once a response time exists', async () => {
    mocks.get.mockResolvedValue({ ...metrics, avgFirstResponseHours: 2.345, avgResolutionHours: 10 });
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByText('First response').parentElement).toHaveTextContent('2.3h');
    expect(screen.getByText('First response').parentElement).toHaveTextContent('average');
    expect(screen.getByText('Average resolution time').parentElement).toHaveTextContent('10.0h');
  });
});

describe('support analytics readability', () => {
  it('shows "No data yet" for the rating with no reviews and hides SLA health when no SLA tickets exist', async () => {
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByText('Average rating').parentElement).toHaveTextContent('No data yet');
    expect(screen.queryByText('SLA health')).not.toBeInTheDocument();
    expect(screen.queryByText('SLA met (open queue)')).not.toBeInTheDocument();
  });

  it('explains the SLA figure with its breakdown when SLA tickets exist', async () => {
    mocks.get.mockResolvedValue({ ...metrics, currentQueue: { ...metrics.currentQueue, ticketsWithSla: 4, slaBreaches: 4 } });
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByText('SLA met (open queue)').parentElement).toHaveTextContent('0%');
    expect(screen.getByText('SLA met (open queue)').parentElement).toHaveTextContent('0 of 4 SLA tickets within target · 4 breached');
  });

  it('gives the ticket intake chart a y-axis, value labels and a text summary for screen readers', async () => {
    mocks.get.mockResolvedValue({ ...metrics, totalTickets: 5, ticketsByDay: [{ date: '2026-11-01', count: 2 }, { date: '2026-11-02', count: 3 }] });
    render(<SupportAnalyticsPage />);
    await screen.findByRole('heading', { name: 'Support operations analytics' });
    expect(screen.getByRole('img', { name: /5 tickets created from 2026-11-01 to 2026-11-02/ })).toBeInTheDocument();
    expect(screen.getByText('Tickets created per day in the selected range')).toBeInTheDocument();
    expect(screen.getAllByText('3').length).toBeGreaterThan(1); // y-axis tick and bar value label
  });
});
