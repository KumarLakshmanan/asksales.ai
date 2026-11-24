import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import UserUsagePage from '@/app/admin/dashboard/users/[id]/usage/page';

const state = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: '11' }) }));
vi.mock('@/lib/admin-api', () => ({ api: { get: state.get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
const fixture = {
  usage: {
    openai: { totalCalls: 2, totalTokens: 100, estimatedCostCents: 10 },
    apify: { totalRuns: 3, totalItemsScraped: 200, totalCostCents: 20 },
    zerobounce: { totalRequests: 4, totalEmailsValidated: 300, totalCostCents: 30 },
  }, totals: { totalApiCalls: 9, totalCostCents: 60 },
};
function card(label: string) { return screen.getByText(label).closest('.shadcn-card') as HTMLElement; }
beforeEach(() => { cleanup(); state.get.mockReset(); state.get.mockResolvedValue(fixture); });
describe('administrator provider measurements', () => {
  it('renders 100 tokens, 200 items and 300 emails independently from the documented API response', async () => {
    render(<UserUsagePage />);
    await screen.findByText('Total Tokens');
    expect(state.get).toHaveBeenCalledWith('/api/admin/users/11/usage');
    expect(within(card('Total Tokens')).getByText('100')).toBeInTheDocument();
    expect(within(card('Items Scraped')).getByText('200')).toBeInTheDocument();
    expect(within(card('Emails Validated')).getByText('300')).toBeInTheDocument();
    expect(screen.queryByText('600')).not.toBeInTheDocument();
    const apify = card('Apify');
    expect(within(apify).getByText('Items scraped')).toBeInTheDocument();
    expect(within(apify).queryByText('Tokens')).not.toBeInTheDocument();
    expect(within(card('ZeroBounce')).getByText('Emails validated')).toBeInTheDocument();
    expect(within(card('Total Cost')).getByText('$0.60')).toBeInTheDocument();
  });
  it('adds only compatible model token counts and preserves the API cost total', async () => {
    state.get.mockResolvedValue({ ...fixture, usage: { ...fixture.usage,
      gemini: { totalRequests: 1, totalInputTokens: 40, totalOutputTokens: 60, totalCostCents: 10 } },
      totals: { totalApiCalls: 10, totalCostCents: 70 } });
    render(<UserUsagePage />); await screen.findByText('Total Tokens');
    expect(within(card('Total Tokens')).getByText('200')).toBeInTheDocument();
    expect(within(card('Total Cost')).getByText('$0.70')).toBeInTheDocument();
  });
  it('does not invent model tokens for non-model usage', async () => {
    state.get.mockResolvedValue({ usage: { apify: fixture.usage.apify, zerobounce: fixture.usage.zerobounce }, totals: {} });
    render(<UserUsagePage />); await screen.findByText('Total Tokens');
    expect(within(card('Total Tokens')).getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('500')).not.toBeInTheDocument();
  });
  it('labels the actual API reporting window without changing its request', async () => {
    state.get.mockResolvedValue({ ...fixture, days: 30, dateRange: { start: '2026-09-23T10:00:00.000Z', end: '2026-10-23T10:00:00.000Z' } });
    render(<UserUsagePage />); await screen.findByText('Total Tokens');
    expect(screen.getByText(/Reported period/)).toHaveTextContent('30 days');
    expect(document.querySelector('time[datetime="2026-09-23T10:00:00.000Z"]')).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-10-23T10:00:00.000Z"]')).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith('/api/admin/users/11/usage');
  });

  it('names the back link and keeps it a single navigation control', async () => {
    render(<UserUsagePage />); await screen.findByText('Total Tokens');
    const back = screen.getByRole('link', { name: 'Back to user details' });
    expect(back).toHaveAttribute('href', '/admin/dashboard/users/11/view');
    expect(back.querySelector('button')).toBeNull();
  });

  it('distinguishes an empty successful report from unavailable measurements', async () => {
    state.get.mockResolvedValue({ usage: { openai: { totalCalls: 0, totalTokens: 0, estimatedCostCents: 0 } }, totals: { totalApiCalls: 0, totalCostCents: 0 } });
    const view = render(<UserUsagePage />); await screen.findByText('Total Tokens');
    expect(screen.getByText('No recorded usage in this period.')).toBeInTheDocument();
    view.unmount(); state.get.mockResolvedValue({}); render(<UserUsagePage />);
    await screen.findByText('Usage could not be loaded');
    expect(screen.queryByText('Total Tokens')).not.toBeInTheDocument();
  });

});
