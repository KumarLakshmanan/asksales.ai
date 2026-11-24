import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SubscriptionManager from '@/components/pricing/SubscriptionManager';
import { SUBSCRIPTION_PLANS } from '../../../shared/subscriptions';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({
  user: { id: 1, name: 'Synthetic owner', email: 'owner@example.test' },
  isLoading: false, isSetupComplete: true, isApproved: true,
}) }));
vi.mock('@/hooks/use-pricing-catalog', () => ({ usePricingCatalog: () => ({
  data: { version: 2, currency: 'INR', taxInclusive: true, plans: SUBSCRIPTION_PLANS }, isLoading: false, isError: false,
}) }));
vi.mock('@/lib/api', async original => ({ ...await original<object>(), default: { get: mocks.get, post: mocks.post } }));

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SubscriptionManager /></QueryClientProvider>);
}
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
afterEach(cleanup);

it('shows an error with retry, not an endless loader, when no billing account matches the business', async () => {
  mocks.get.mockResolvedValueOnce({ organizations: [], invitations: [], selectedOrganizationId: null });
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('No billing account was found');
  expect(screen.queryByText('Loading subscription…')).toBeNull();
  mocks.get.mockResolvedValueOnce({ organizations: [], invitations: [], selectedOrganizationId: null });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(mocks.get).toHaveBeenCalledTimes(2);
});

it('shows an error with retry when the billing account request fails', async () => {
  mocks.get.mockRejectedValue(new Error('Synthetic outage'));
  show();
  // The hook retries once (about 1 s) before reporting the failure.
  expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('Your billing account could not be loaded');
  // The error stays put: no observer remount loop refetching in the background.
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(screen.getByRole('alert')).toBeVisible();
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Loading subscription…')).toBeNull();
});
