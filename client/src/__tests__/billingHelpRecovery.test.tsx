import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BillingPage from '@/app/dashboard/(main)/billing/page';
import ContactPage from '@/app/contact/page';
import SubscriptionManager from '@/components/pricing/SubscriptionManager';
import { moduleForDashboardPath } from '@/lib/platform-access';
import { SUBSCRIPTION_PLANS } from '../../../shared/subscriptions';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), fetch: vi.fn(),
  state: null as Record<string, unknown> | null,
  catalog: null as Record<string, unknown> | null,
  search: new URLSearchParams(),
  supportEnabled: false,
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.search }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({
  user: { id: 11, name: 'Synthetic owner', email: 'owner@example.test' },
  isLoading: false, isApproved: true, isSetupComplete: true,
}) }));
vi.mock('@/hooks/use-billing-api', () => ({ useBillingApi: () => ({ get: mocks.get }) }));
vi.mock('@/hooks/use-billing-organizations', () => ({ useBillingOrganizations: () => ({
  organizationId: 77, businessProfileId: 101, billingScopeKey: '11:101:77', ready: true, isError: false,
}) }));
vi.mock('@/hooks/use-subscription', () => ({ useSubscription: () => ({
  data: mocks.state, isLoading: false, isPending: false, isError: false, refetch: vi.fn(),
}) }));
vi.mock('@/hooks/use-pricing-catalog', () => ({ usePricingCatalog: () => ({
  data: mocks.catalog, isLoading: false, isError: false,
}) }));
vi.mock('@/hooks/use-platform-access', () => ({ usePlatformAccess: () => ({
  data: { maintenance: { enabled: false }, modules: [{ key: 'support', enabled: mocks.supportEnabled }] },
  isLoading: false, isError: false,
}) }));
vi.mock('@/components/billing/BillingOrganizationSelector', () => ({ default: () => null }));
vi.mock('@/components/billing/CreditActivity', () => ({ default: () => <p>Credit activity history</p> }));
vi.mock('@/components/PublicLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/lib/subscription-checkout', () => ({
  loadSubscriptionCheckout: vi.fn(), PLAN_INTENT_KEY: 'billing-help-test-intent',
}));

function show(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  sessionStorage.clear();
  mocks.supportEnabled = false;
  mocks.search = new URLSearchParams();
  mocks.catalog = { version: 2, currency: 'INR', taxInclusive: true, plans: SUBSCRIPTION_PLANS };
  mocks.state = {
    organization: { id: 77, name: 'Synthetic business', role: 'owner', canManageBilling: true },
    entitlements: { limits: SUBSCRIPTION_PLANS[0].limits, usage: {}, enforced: true, catalogVersion: 2, planSlug: 'starter' },
    access: { allowed: false, reason: 'subscription_required', canTopUp: false, accessUntil: null },
    approved: true, checkoutAvailable: false, mode: 'test', subscription: null, pendingChange: null,
    nextDepositAt: null, charges: [],
  };
  mocks.get.mockImplementation((path: string) => Promise.resolve(path === '/api/wallet'
    ? { balance: 1234, rechargeRate: 10 } : { transactions: [], total: 0 }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('platform billing help recovery', () => {
  it.each([false, true])('subscription help uses public contact when tenant Support enabled=%s', supportEnabled => {
    mocks.supportEnabled = supportEnabled;
    show(<SubscriptionManager />);
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/contact');
    expect(moduleForDashboardPath('/contact')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('invoice help reaches platform contact even when the subscription has lapsed', async () => {
    show(<BillingPage />);
    expect(screen.getByRole('link', { name: 'Invoice support' })).toHaveAttribute('href', '/contact');
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(mocks.get.mock.calls.every(([path]) => !String(path).startsWith('/api/support'))).toBe(true);
  });

  it('public contact explains the distinct customer queue and opens no draft or send on render', () => {
    const previousLocation = window.location.href;
    show(<ContactPage />);
    expect(screen.getByText(/For AskSales\.AI account, subscription or invoice help, use the email draft on this page\./)).toBeInTheDocument();
    expect(screen.getByText(/Your workspace’s Support area manages your own customers’ tickets\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open email draft' })).toBeEnabled();
    expect(screen.getByLabelText('Reply email')).toHaveValue('');
    expect(window.location.href).toBe(previousLocation);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
