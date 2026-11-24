import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaidAdAccountSelector } from '@/components/performance-marketing/PaidAdAccountSelector';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get, post } }));

const account = {
  id: 1, platform: 'meta', name: 'Oro Circle', provider_account_id: 'act_111111',
  currency: 'INR', timezone: 'Asia/Kolkata', is_manager: false,
  reporting_available: true, publishing_available: true,
  verified_at: '2026-10-29T12:00:00Z' as string | null, error_code: null as string | null,
  last_succeeded_at: '2026-10-29T12:00:00Z', last_attempt_at: '2026-11-01T12:00:00Z',
  data_available_through: '2026-10-29',
};
const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.resetAllMocks();
});

function review(accounts: typeof account[], value = '1') {
  get.mockResolvedValue({ accounts });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = (selected: string) => <QueryClientProvider client={client}><PaidAdAccountSelector value={selected} onChange={vi.fn()} /></QueryClientProvider>;
  return { ...render(view(value)), view };
}

describe('saved ad account selection and readiness', () => {
  it('distinguishes same-name provider accounts without discovering or changing them', async () => {
    const result = review([account, { ...account, id: 2, provider_account_id: '222222' }]);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ad account' })).toHaveTextContent('Oro Circle · ID 111111'));
    result.rerender(result.view('2'));
    expect(screen.getByRole('combobox', { name: 'Ad account' })).toHaveTextContent('Oro Circle · ID 222222');
    expect(get).toHaveBeenCalledWith('/api/campaigns/accounts');
    expect(post).not.toHaveBeenCalled();
  });

  it('uses the saved account number when a duplicate has no provider ID', async () => {
    review([{ ...account, provider_account_id: '' }, { ...account, id: 2 }]);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ad account' })).toHaveTextContent('Oro Circle · Account #1'));
  });

  it.each(['REPORTING_FAILED', 'INCOMPLETE_REPORTING'])('does not advertise ready publishing after %s', async error_code => {
    review([{ ...account, error_code }]);
    const readiness = await screen.findByLabelText('Selected ad account readiness');
    expect(readiness).toHaveTextContent('Authorization: Recheck required');
    expect(readiness).toHaveTextContent('Reporting: Needs attention');
    expect(readiness).toHaveTextContent('Publishing: Not verified');
    expect(within(readiness).queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Ad account' })).toHaveTextContent('Sync issue');
    expect(within(readiness).getByRole('link', { name: 'Review Meta Ads connection' })).toHaveAttribute('href', '/dashboard/integrations/meta');
    expect(screen.queryByText(/Connection permissions must be renewed/)).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps healthy account capabilities and its name visible', async () => {
    review([account]);
    const readiness = await screen.findByLabelText('Selected ad account readiness');
    expect(readiness).toHaveTextContent('Authorization: Verified');
    expect(readiness).toHaveTextContent('Reporting: Ready');
    expect(readiness).toHaveTextContent('Publishing: Ready');
    expect(screen.getByRole('combobox', { name: 'Ad account' })).not.toHaveTextContent('ID');
  });

  it('does not claim publishing is verified before the first authorization check', async () => {
    review([{ ...account, verified_at: null }]);
    const readiness = await screen.findByLabelText('Selected ad account readiness');
    expect(readiness).toHaveTextContent('Authorization: Not verified');
    expect(readiness).toHaveTextContent('Publishing: Not verified');
  });
});
