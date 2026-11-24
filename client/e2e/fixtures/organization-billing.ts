import { type Page } from '@playwright/test';
import { LIMIT_DEFINITIONS, SUBSCRIPTION_PLANS, type SubscriptionState } from '../../../shared/subscriptions';

export const user = { id: 731, name: 'Billing fixture', email: 'billing@example.test', isSetupComplete: true, isApproved: true, hasBusinessProfile: true, hasBrandToolkit: true };
export const organizations = [
  { id: 11, businessProfileId: 101, name: 'North Studio', ownerUserId: user.id, defaultForUserId: user.id, role: 'owner', canManageBilling: true },
  { id: 22, businessProfileId: 202, name: 'Shared Ventures', ownerUserId: 732, defaultForUserId: null, role: 'member', canManageBilling: false },
] as const;
export const businessProfiles = organizations.map((org, index) => ({ id: org.businessProfileId, name: org.name, companyName: org.name, isDefault: index === 0, isApproved: true, role: org.role, canManageTeam: org.role === 'owner', canManageBilling: org.canManageBilling, billingOrganizationId: org.id }));
export const catalog = { version: 2, currency: 'INR', taxInclusive: true, plans: SUBSCRIPTION_PLANS };
const usage = Object.fromEntries(LIMIT_DEFINITIONS.map(({ key }) => [key, key === 'contacts' ? 1250 : key === 'storageBytes' ? 750_000_000 : key === 'members' ? 2 : 1])) as SubscriptionState['entitlements']['usage'];
export const initial: SubscriptionState = {
  organization: organizations[0], entitlements: { limits: SUBSCRIPTION_PLANS[0].limits, usage, enforced: false, catalogVersion: 2, planSlug: 'starter' },
  access: { allowed: false, reason: 'subscription_required', accessUntil: null, canTopUp: false }, approved: true,
  checkoutAvailable: true, mode: 'live', subscription: null, pendingChange: null, nextDepositAt: null, charges: [],
};
export const paid: SubscriptionState = {
  ...initial, entitlements: { ...initial.entitlements, limits: SUBSCRIPTION_PLANS[1].limits, planSlug: 'growth' },
  access: { allowed: true, reason: 'paid', accessUntil: '2099-10-01T00:00:00Z', canTopUp: true },
  subscription: { id: 'fixture-local', version: 2, name: 'Growth', plan: 'growth', term: 'yearly', status: 'active', mode: 'live', paidThrough: '2099-10-01T00:00:00Z', cancelAtPeriodEnd: false, paymentMethod: 'upi' },
  nextDepositAt: '2099-11-01T00:00:00Z',
};
export type CapturedRequest = { path: string; method: string; organization: string | undefined; business: string | undefined; body: unknown };

export async function mockApp(page: Page, signedIn = false) {
  const requests: CapturedRequest[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('theme', 'light'); });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const organization = request.headers()['x-billing-organization-id'];
    const business = request.headers()['x-business-profile-id'];
    const currentOrganization = organizations.find(item => item.businessProfileId === Number(business)) ?? organizations[0];
    requests.push({ path, method: request.method(), organization, business, body: request.postData() ? request.postDataJSON() : undefined });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/auth/me') return reply(signedIn ? { user: { ...user, workspaceRole: currentOrganization.role, businessProfileId: currentOrganization.businessProfileId } } : { error: 'Sign in required' }, signedIn ? 200 : 401);
    if (path === '/api/auth/csrf-token') return reply({ csrfToken: 'fixture' });
    if (path === '/api/subscriptions/catalog') return reply(catalog);
    if (path === '/api/organizations') return reply({ organizations: [currentOrganization], invitations: [], selectedOrganizationId: currentOrganization.id });
    if (path === '/api/subscriptions/current') return reply(currentOrganization.id === 22 ? { ...paid, organization: organizations[1] } : initial);
    if (path === '/api/platform/access') return reply({ maintenance: { enabled: false, message: '' }, modules: ['billing', 'campaigns', 'storage', 'integrations'].map(key => ({ key, name: key, description: '', status: 'available', message: null, mode: 'enabled', enabled: true })), subscription: paid.access });
    if (path === '/api/settings/business-profiles') return reply(businessProfiles);
    if (path === '/api/settings/business-profiles/invitations') return reply({ invitations: [] });
    if (/^\/api\/settings\/business-profiles\/\d+$/.test(path)) return reply(businessProfiles.find(profile => profile.id === Number(path.split('/').at(-1))));
    if (path === '/api/settings/preferences') return reply({ theme: 'light', language: 'en', timezone: 'UTC' });
    if (path === '/api/notifications/unread/count') return reply({ count: 0 });
    if (path === '/api/chat/threads') return reply({ threads: [], total: 0 });
    if (path === '/api/wallet') return reply({ balance: currentOrganization.id === 22 ? 9200 : 1234, totalCreditsAdded: 15000, totalCreditsUsed: 1000, rechargeRate: 10, summary: { totalRecharges: 1, totalDeductions: 2, totalRefunds: 0, transactionCount: 3 } });
    if (path === '/api/wallet/usage') return reply({ usage: [], pricing: [{ eventKey: 'lead.search', name: 'Lead discovery', category: 'lead', creditsPerUnit: 2, unitLabel: 'credits / lead' }] });
    return reply({ success: true, data: [] });
  });
  return { requests, pageErrors };
}
