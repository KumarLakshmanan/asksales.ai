import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdCampaignsWorkspace from '@/app/dashboard/(main)/ads-campaigns/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks, api: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ replace: mocks.replace, push: mocks.push }) }));

const accounts = [12, 13].map((id, i) => ({ id, platform: 'meta', provider_account_id: String(111 + i), name: 'Oro Circle', currency: 'INR', timezone: 'Asia/Kolkata', is_manager: false, reporting_available: true, publishing_available: true, verified_at: '2026-10-29T12:00:00Z' }));
const cached = [
  { platformEntityId: 'own-provider', adAccountId: '111', name: 'Own stored provider', status: 'ACTIVE', spend: 100 },
  { platformEntityId: 'other-provider', adAccountId: '112', name: 'Other account provider', status: 'PAUSED', spend: 900 },
].map(campaign => ({ ...campaign, impressions: 1000, clicks: 10, lastRefreshedAt: '2026-10-29T12:00:00Z', rawData: { campaign: { objective: 'OUTCOME_TRAFFIC' } } }));
const live = cached.map(campaign => ({ id: campaign.platformEntityId, name: campaign.name, status: campaign.status, effective_status: campaign.status, objective: 'OUTCOME_TRAFFIC', metricsAvailable: false }));
const local = [
  { id: 1, name: 'Own account draft', ad_account_id: 'act_111' },
  { id: 2, name: 'Other account draft', ad_account_id: '112' },
].map(campaign => ({ ...campaign, local_status: 'draft', ad_platform: 'meta', objective: 'traffic', currency: 'INR', budget_amount: 1000, created_at: '2026-10-29T12:00:00Z' }));
const clients: QueryClient[] = [];

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  window.history.replaceState(null, '', '/dashboard/ads?tab=campaigns&layout=cards&account=12&period=7d');
  mocks.get.mockImplementation(async (path: string) => {
    if (path === '/api/campaigns/accounts') return { accounts };
    if (path === '/api/meta/oauth/platforms') return { platforms: [{ platform: 'meta', isActive: true, currency: 'INR' }] };
    if (path.startsWith('/api/campaigns/meta/cache/campaigns?')) return { campaigns: cached, lastRefreshedAt: '2026-10-29T12:00:00Z' };
    if (path.startsWith('/api/campaigns/meta/campaigns?')) return { campaigns: live };
    if (path === '/api/campaigns/autonomous') return { campaigns: local };
    throw new Error(`Unexpected review read: ${path}`);
  });
});

afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

function review() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = () => <QueryClientProvider client={client}><AdCampaignsWorkspace /></QueryClientProvider>;
  return { ...render(view()), view };
}

describe('creative and draft workspace account scope', () => {
  it('filters cached provider and managed cards, summary counts and reporting links to the selected account', async () => {
    const result = review();
    expect(await screen.findByRole('heading', { name: 'Own stored provider' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Own account draft' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Other account provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other account draft' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Campaign inventory summary')).toHaveTextContent('Active1Paused0Draft1');
    fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
    const destination = new URL(mocks.push.mock.calls.at(-1)![0], 'https://asksales.local');
    expect(destination.searchParams.get('account')).toBe('12');
    expect(destination.searchParams.get('period')).toBe('7d');
    expect(mocks.post).not.toHaveBeenCalled();

    window.history.replaceState(null, '', '/dashboard/ads?tab=campaigns&layout=cards&account=13&period=7d');
    result.rerender(result.view());
    expect(await screen.findByRole('heading', { name: 'Other account provider' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Own stored provider' })).not.toBeInTheDocument();
  });

  it('withholds unscoped cards while the selected account is unresolved', async () => {
    mocks.get.mockImplementationOnce(() => new Promise(() => {}));
    review();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/campaigns/autonomous'));
    expect(screen.queryByRole('heading', { name: 'Other account provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Own stored provider' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading selected ad account…')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('uses only the selected account sync endpoint after an explicit local test action', async () => {
    mocks.post.mockResolvedValue({ partialSuccess: true });
    review();
    await screen.findByRole('heading', { name: 'Own stored provider' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/campaigns/accounts/12/refresh', {}));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Account refresh incomplete' })));
  });
});
