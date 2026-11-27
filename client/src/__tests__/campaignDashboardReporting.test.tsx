import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { CampaignDashboardView } from '@/components/CampaignDashboardView';

const fixture = vi.hoisted(() => ({ response: {} as Record<string, unknown>, toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/lib/api', () => ({ api: { get: async () => fixture.response } }));
vi.mock('recharts', () => {
  const chart = ({ data, children }: { data: unknown; children: ReactNode }) => <div data-testid="chart" data-values={JSON.stringify(data)}>{children}</div>;
  const empty = () => null;
  return { ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>, BarChart: chart, AreaChart: chart, PieChart: ({ children }: { children: ReactNode }) => <div>{children}</div>, Pie: chart,
    Bar: empty, Area: empty, XAxis: empty, YAxis: empty, CartesianGrid: empty, Tooltip: empty, Legend: empty, Cell: empty };
});

beforeEach(() => { fixture.toast.mockClear(); fixture.response = {
  summary: { leads: 500, contentAssets: 101, messages: 500, sent: 500, pending: 0, contactedLeads: 1, engagedLeads: 1, convertedContacts: 1, crmContacts: 2,
    bySource: { linkedin: 400, google: 100 }, byStatus: { new: 400, custom_qualified: 100 }, byChannel: { email: 500 },
    channels: [{ name: 'email', outreach: 500, replied: 1 }], timeline: [{ week: '2026-09-14', outreached: 500 }] },
  leads: { total: 500, items: [{ id: 1, name: 'Fixture lead', email: 'fixture@example.test', source: 'linkedin', status: 'new', fit_score: 50 }] },
  outreaches: { items: [{ status: 'converted' }] },
}; });
afterEach(cleanup);

describe('campaign reporting contract', () => {
  it('uses full aggregates and distinct-contact coverage while identifying the bounded preview', async () => {
    render(<CampaignDashboardView threadId={42} />);
    await screen.findByText('Lead preview (1 of 500)');
    expect(screen.getByText('500', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Found or selected for this campaign')).toBeVisible();
    expect(screen.getByText('0%')).toBeVisible(); // One contacted lead out of 500, rounded.
    expect(screen.getByText('Recorded CRM wins')).toBeVisible();
    expect(screen.getByText(/do not prove the campaign caused them/)).toBeVisible();
    expect(screen.getAllByTestId('chart').map(element => element.getAttribute('data-values'))).toContain(JSON.stringify([{ name: 'email', outreach: 500, replied: 1 }]));
    expect(screen.getAllByTestId('chart').map(element => element.getAttribute('data-values'))).toContain(JSON.stringify([{ name: 'new', value: 400, color: '#3b82f6' }, { name: 'custom_qualified', value: 100, color: '#3b82f6' }]));
    expect(screen.queryByText('Conversion')).toBeNull();
  });

  it('shows an actionable error instead of calculating totals from previews when aggregates are missing', async () => {
    fixture.response = { leads: { total: 500, items: [] }, outreaches: { items: [{ status: 'converted' }] } };
    render(<CampaignDashboardView threadId={42} />);
    await waitFor(() => expect(screen.getByText('Campaign dashboard could not be loaded')).toBeVisible());
    expect(fixture.toast).toHaveBeenCalledOnce();
    expect(screen.queryByText('Recorded CRM wins')).toBeNull();
  });
});
