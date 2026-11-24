/** Acceptance mocked UI reproductions. No application API/provider/database calls. */
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SubscriptionManager from '@/components/pricing/SubscriptionManager';
import { PlanCards, PlanComparison } from '@/components/pricing/PlanCards';
import { SUBSCRIPTION_PLANS } from '../../../shared/subscriptions';

const mocks = vi.hoisted(() => ({
  post: vi.fn(), loader: vi.fn(), state: null as any, catalog: null as any,
  search: new URLSearchParams(), checkoutOptions: null as any,
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.search }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({
  user: { id: 1, name: 'Synthetic owner', email: 'owner@example.test' },
  isLoading: false, isSetupComplete: true, isApproved: true,
}) }));
vi.mock('@/hooks/use-subscription', () => ({ useSubscription: () => ({ data: mocks.state, isLoading: false, isError: false, refetch: vi.fn() }) }));
vi.mock('@/hooks/use-pricing-catalog', () => ({ usePricingCatalog: () => ({ data: mocks.catalog, isLoading: false, isError: false }) }));
vi.mock('@/hooks/use-billing-organizations', () => ({ useBillingOrganizations: () => ({
  organizationId: 11, businessProfileId: 101, billingScopeKey: '1:101:11',
  ready: true, isError: false,
}) }));
vi.mock('@/components/billing/BillingOrganizationSelector', () => ({ default: () => null }));
vi.mock('@/lib/api', () => ({ default: { post: mocks.post } }));
vi.mock('@/lib/subscription-checkout', () => ({ loadSubscriptionCheckout: mocks.loader, PLAN_INTENT_KEY: 'audit-plan-intent' }));

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SubscriptionManager /></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.search = new URLSearchParams();
  mocks.catalog = { version: 2, currency: 'INR', taxInclusive: true, plans: SUBSCRIPTION_PLANS };
  mocks.state = {
    organization: { id: 11, name: 'Synthetic business', role: 'owner', canManageBilling: true },
    entitlements: { limits: SUBSCRIPTION_PLANS[0].limits, usage: {}, enforced: true, catalogVersion: 2, planSlug: 'starter' },
    access: { allowed: false, reason: 'subscription_required', accessUntil: null, canTopUp: false },
    approved: true, checkoutAvailable: true, mode: 'test', subscription: null, pendingChange: null,
    nextDepositAt: null, charges: [],
  };
  mocks.loader.mockResolvedValue(undefined);
  mocks.checkoutOptions = null;
  window.Razorpay = class {
    constructor(options: Record<string, unknown>) { mocks.checkoutOptions = options; }
    on() {}
    open() {}
  } as any;
});
afterEach(cleanup);

describe('regression: subscription UX regressions', () => {
  it('expected recovery: a canceled Growth renewal can select the same plan to authorize it again', async () => {
    mocks.state.subscription = {
      id: 'sub_synthetic', version: 2, name: 'Growth', plan: 'growth', term: 'monthly',
      status: 'cancelled', mode: 'live', paidThrough: '2099-12-31T00:00:00Z',
      cancelAtPeriodEnd: true, paymentMethod: 'upi', source: 'razorpay',
    };
    mocks.state.access = { allowed: true, reason: 'paid', accessUntil: '2099-12-31T00:00:00Z', canTopUp: true };
    show();
    await screen.findByRole('heading', { name: 'Your selection: Starter' });
    const growth = within(screen.getByRole('article', { name: 'Growth plan' }));
    const action = growth.getByRole('button');
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(screen.getByRole('heading', { name: 'Your selection: Growth' })).toBeInTheDocument();
  });

  it('expected review freeze: billing term cannot change while checkout creation is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    show();
    await screen.findByRole('heading', { name: 'Your selection: Starter' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/subscriptions/start',
      { plan: 'starter', term: 'monthly', catalogVersion: 2 }, expect.anything()));
    const yearly = screen.getByRole('radio', { name: /Yearly/ });
    fireEvent.click(yearly);
    // Finish only the mocked provider response; no external checkout is loaded.
    await act(async () => finish({ subscriptionId: 'sub_synthetic', keyId: 'rzp_test_synthetic', mode: 'test', startsAt: null, replacement: false }));
    await waitFor(() => expect(mocks.checkoutOptions).not.toBeNull());
    expect(mocks.checkoutOptions.description).toBe('Starter · monthly subscription');
    expect(yearly).not.toBeChecked();
  });
  it('labels an inherited legacy storage allowance in cards and comparison',()=>{
    const legacy={...SUBSCRIPTION_PLANS[0],version:1,limits:{...SUBSCRIPTION_PLANS[0].limits}};
    delete (legacy.limits as Partial<typeof legacy.limits>).storageBytes;
    render(<><PlanCards plans={[legacy]} term="monthly"/><PlanComparison plans={[legacy]}/></>);
    expect(screen.getAllByText('Legacy account allowance').length).toBeGreaterThan(0);
    expect(screen.getByText(/File storage follows your account/)).toBeInTheDocument();
  });

});
