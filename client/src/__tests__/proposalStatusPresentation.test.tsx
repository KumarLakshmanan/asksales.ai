import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProposalAnalyticsPage from '@/app/dashboard/(main)/proposals/analytics/page';
import { RelatedProposals } from '@/components/proposals/RelatedProposals';
const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('proposal status presentation', () => {
  it('uses readable delivery status labels in analytics', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('/performance') ? [] : {
      totalProposals: 2, sentProposals: 0, acceptedProposals: 0, rejectedProposals: 1, valueByCurrency: [], winRate: 0,
      avgDaysToDecision: 0, avgHoursToView: 0, viewRate: 0, decisionRate: 0, statusDistribution: { delivery_unknown: 1, rejected: 1 },
      funnel: { created: 2, delivered: 0, viewed: 0, decided: 1, accepted: 0 }, overdueByCurrency: [], declineReasons: [],
    }));
    render(<ProposalAnalyticsPage />);
    await screen.findByText('Delivery needs review');
    expect(screen.queryByText('delivery_unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery_unknown')).not.toBeInTheDocument();
  });
  it('also fixes raw status labels on related proposals in tickets and conversations', async () => {
    mocks.get.mockResolvedValue([{ id: 1, title: 'Customer offer', status: 'delivery_unknown' }]);
    render(<RelatedProposals supportTicketId={9} />);
    expect(await screen.findByRole('link', { name: 'Customer offer · Delivery needs review' })).toHaveAttribute('href', '/dashboard/proposals/1');
  });
});
