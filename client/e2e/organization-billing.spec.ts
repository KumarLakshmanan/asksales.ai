import { expect, test, type Page } from '@playwright/test';
import { SUBSCRIPTION_PLANS, type SubscriptionPlan } from '../../shared/subscriptions';
import { mockApp, businessProfiles, user } from './fixtures/organization-billing';

const noOverflow = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const screenshot = (page: Page, name: string) => page.screenshot({ path: `/tmp/organization-billing-e2e/${name}-${test.info().project.name}.png`, fullPage: true });

async function switchBusiness(page: Page, name: string) {
  const sidebar = page.locator('aside[data-sidebar-state]');
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await sidebar.getByRole('button', { name: /Switch business profile/ }).click();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('dialog', { name: 'Choose a business profile' }).getByRole('button', { name: `Open ${name} business profile` }).click(),
  ]);
}

test('dashboard pricing follows the selected business and respects staff billing permissions', async ({ page }) => {
  const fixture = await mockApp(page, true);
  await page.goto('/dashboard/billing/pricing');
  await expect(page.getByRole('heading', { name: 'Pricing', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Billing organization' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '1,234 credits available' })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Saved CRM contacts' })).toHaveAttribute('aria-valuenow', '1250');
  const cards = page.getByTestId('plan-cards');
  await expect(cards.getByRole('article')).toHaveCount(3);
  await expect(cards.getByRole('link', { name: 'Choose Growth' })).toHaveAttribute('href', '/dashboard/billing/subscription?plan=growth&term=monthly&version=2');
  await noOverflow(page); await screenshot(page, 'business-pricing-owner');
  await switchBusiness(page, 'Shared Ventures');
  await page.goto('/dashboard/billing/pricing');
  await expect(page.getByRole('heading', { name: '9,200 credits available' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '1,234 credits available' })).toHaveCount(0);
  await expect(cards.getByRole('button', { name: 'Ask your business owner' })).toHaveCount(3);
  await expect(cards.getByRole('link')).toHaveCount(0);
  await expect.poll(() => fixture.requests.some(request => request.path === '/api/wallet' && request.organization === '22' && request.business === '202')).toBe(true);
  const yearly = page.getByRole('radio', { name: /Yearly/ });
  await yearly.focus(); await yearly.press('Space');
  await expect(cards.getByRole('article', { name: 'Growth plan' }).getByRole('button', { name: 'Current plan' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Credit costs', exact: true }).click();
  await expect(page.getByText('Lead discovery', { exact: true })).toBeVisible();
  await expect(page.getByText('2 credits / lead', { exact: true })).toBeVisible();
  await expect.poll(() => fixture.requests.some(request => request.path === '/api/wallet/usage' && request.business === '202')).toBe(true);
  await page.getByRole('tab', { name: 'Plans & limits', exact: true }).click();
  await screenshot(page, 'business-pricing-member');
  await switchBusiness(page, 'North Studio');
  await page.goto('/dashboard/billing/pricing');
  await expect(page.getByRole('heading', { name: '1,234 credits available' })).toBeVisible();
  await expect(cards.getByRole('link', { name: 'Choose Growth' })).toBeVisible();
  await noOverflow(page);
  expect(fixture.pageErrors).toEqual([]);
});

test('business owner invites staff and revokes access from the same profile', async ({ page }) => {
  const fixture = await mockApp(page, true);
  const members = [{ id: 1, userId: user.id, email: user.email, role: 'owner', status: 'active' }];
  const mutations: { path: string; body: unknown; business: string | undefined }[] = [];
  await page.route('**/api/settings/business-profiles/101/members', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); mutations.push({ path: 'invite', body, business: route.request().headers()['x-business-profile-id'] });
      members.push({ id: 2, userId: 0, email: body.email, role: body.role, status: 'invited' });
      return route.fulfill({ json: { member: members[1] } });
    }
    return route.fulfill({ json: { members } });
  });
  await page.route('**/api/settings/business-profiles/101/members/2', route => {
    mutations.push({ path: 'revoke', body: null, business: route.request().headers()['x-business-profile-id'] });
    members[1].status = 'revoked'; return route.fulfill({ json: { success: true } });
  });
  await page.goto('/dashboard/billing/organization');
  await expect(page).toHaveURL(/\/dashboard\/settings\/team$/);
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create another organization' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Email address' }).fill('teammate@example.test');
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('billing_admin');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(page.getByText('teammate@example.test', { exact: true })).toBeVisible();
  await expect(page.getByText('Invitation pending', { exact: true })).toBeVisible();
  expect(mutations[0]).toEqual({ path: 'invite', body: { email: 'teammate@example.test', role: 'billing_admin' }, business: '101' });
  await noOverflow(page); await screenshot(page, 'business-staff');
  await page.getByRole('button', { name: 'Remove teammate@example.test' }).click();
  expect(mutations).toHaveLength(1);
  await page.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(page.getByText('Removed access (1)')).toBeVisible();
  expect(mutations[1]).toEqual({ path: 'revoke', body: null, business: '101' });
  expect(fixture.pageErrors).toEqual([]);
});

test('accepts a business invitation before setup without granting billing management', async ({ page }) => {
  const fixture = await mockApp(page, true);
  let accepted = false;
  const invited = businessProfiles[1];
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { ...user, workspaceRole: accepted ? 'member' : null, hasBusinessProfile: accepted, hasBrandToolkit: false, isSetupComplete: accepted } } }));
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: accepted ? [invited] : [] }));
  await page.route('**/api/settings/business-profiles/invitations', route => route.fulfill({ json: { invitations: accepted ? [] : [{ id: 9, businessProfileId: invited.id, businessProfileName: invited.name, email: user.email, role: 'member' }] } }));
  await page.route('**/api/settings/business-profiles/invitations/9/accept', route => { accepted = true; return route.fulfill({ json: { businessProfile: invited } }); });
  await page.route('**/api/settings/business-profiles/202/members', route => route.fulfill({ json: { members: [{ id: 1, email: 'owner@example.test', role: 'owner', status: 'active' }, { id: 2, userId: user.id, email: user.email, role: 'member', status: 'active' }] } }));
  await page.goto('/dashboard/invitations');
  await expect(page.getByRole('heading', { name: 'Join your business' })).toBeVisible();
  await page.getByRole('button', { name: 'Join Shared Ventures' }).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('active-business-profile:731'))).toBe('202');
  await page.goto('/dashboard/settings/team');
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invitation' })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.goto('/dashboard/billing/pricing');
  await expect(page.getByRole('button', { name: 'Ask your business owner' })).toHaveCount(3);
  await noOverflow(page);
  expect(fixture.pageErrors).toEqual([]);
});

async function mockAdmin(page: Page) {
  const fixture = await mockApp(page);
  await page.route('**/api/admin/me', route => route.fulfill({ json: { admin: { id: 1, name: 'Billing admin', email: 'admin@example.test', role: 'super_admin' } } }));
  await page.route('**/api/admin/notifications', route => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.route('**/api/admin/subscriptions', route => route.fulfill({ json: { settings: { enforced: false, capacityEnforced: false, launchedAt: null, credentialId: 1 }, credentials: [{ id: 1, name: 'Fixture payment key', active: true, mode: 'test', webhookConfigured: true }], plans: [], readiness: { monthlyTest: true, yearlyTest: true, live: false, liveWebhookVerifiedAt: null, overdueGrants: 0, missingGrants: 0, unreconciledRefunds: 0, ready: false }, issues: [], refunds: [], webhookPath: '/api/webhooks/razorpay/subscriptions/1' } }));
  return fixture;
}

test('admin edits and previews a draft, handles publish failure, then publishes the same saved catalog', async ({ page }) => {
  const fixture = await mockAdmin(page);
  type Version = { version: number; status: string; plans: SubscriptionPlan[] };
  const catalogs: Version[] = [{ version: 2, status: 'published', plans: structuredClone(SUBSCRIPTION_PLANS) }];
  let publishedVersion = 2, publishAttempts = 0;
  const saves: { plans: SubscriptionPlan[] }[] = [];
  await page.route('**/api/admin/subscriptions/catalog', route => route.fulfill({ json: { catalogs, publishedVersion } }));
  await page.route('**/api/admin/subscriptions/catalog/drafts', route => {
    const draft = { version: 3, status: 'draft', plans: structuredClone(SUBSCRIPTION_PLANS).map(plan => ({ ...plan, version: 3 })) };
    catalogs.unshift(draft); return route.fulfill({ json: draft });
  });
  await page.route('**/api/admin/subscriptions/catalog/drafts/3', route => {
    const body = route.request().postDataJSON(); saves.push(body); catalogs[0].plans = body.plans;
    return route.fulfill({ json: catalogs[0] });
  });
  await page.route('**/api/admin/subscriptions/catalog/3/publish', route => {
    publishAttempts++;
    if (publishAttempts === 1) return route.fulfill({ status: 503, json: { error: 'Payment plans are temporarily unavailable. Retry publishing this draft.' } });
    catalogs[0].status = 'published'; publishedVersion = 3;
    return route.fulfill({ json: catalogs[0] });
  });
  await page.goto('/admin/dashboard/settings/subscriptions');
  await expect(page.getByRole('heading', { name: 'Plans, credits & allowances' })).toBeVisible();
  await expect(page.locator('#plan-1-monthly')).toBeDisabled();
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Catalog version' })).toHaveValue('3');
  await page.locator('#plan-1-name').fill('Growth Team');
  await page.locator('#plan-1-monthly').fill('1800');
  await page.locator('#plan-1-yearly').fill('17280');
  await page.locator('#plan-1-credits').fill('18000');
  await page.locator('#plan-1-storageBytes').fill('20');
  await page.locator('#plan-1-channelAccounts').fill('12');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
  expect(saves[0].plans[1]).toMatchObject({ version: 3, name: 'Growth Team', monthlyRupees: 1800, yearlyRupees: 17280, monthlyCredits: 18000, limits: { storageBytes: 20_000_000_000, channelAccounts: 12 } });
  await page.getByRole('button', { name: 'Preview pricing', exact: true }).click();
  const growth = page.getByRole('article', { name: 'Growth Team plan' });
  await expect(growth).toContainText('₹1,800'); await expect(growth).toContainText('18,000'); await expect(growth).toContainText('20 GB');
  await expect(growth.getByRole('button', { name: 'Choose Growth Team' })).toBeDisabled();
  await noOverflow(page); await screenshot(page, 'admin-catalog-preview');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Publish catalog', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Payment plans are temporarily unavailable' })).toBeVisible();
  expect(publishedVersion).toBe(2);
  await expect(page.getByRole('status').filter({ hasText: 'Catalog published.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish catalog', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Catalog published.' })).toBeVisible();
  expect(publishedVersion).toBe(3);
  expect(publishAttempts).toBe(2);
  expect(saves.at(-1)).toEqual(saves[0]);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toHaveCount(0);
  expect(fixture.pageErrors).toEqual([]);
});

test('admin adds credits to the reviewed organization with an audit reason', async ({ page }) => {
  const fixture = await mockAdmin(page);
  let balance = 9200;
  const adjustments: unknown[] = [];
  await page.route('**/api/admin/subscriptions/organizations?*', route => route.fulfill({ json: { organizations: [{ id: 22, name: 'Shared Ventures', ownerUserId: 732, balance, planName: 'Growth', planSlug: 'growth', catalogVersion: 2 }] } }));
  await page.route('**/api/admin/subscriptions/organizations/22/credits', route => {
    const body = route.request().postDataJSON(); adjustments.push(body); balance += body.amount;
    return route.fulfill({ json: { organizationId: 22, balance } });
  });
  await page.goto('/admin/dashboard/settings/subscriptions?tab=organizations');
  await expect(page.getByRole('heading', { name: 'Billing account wallets' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Find a billing account' }).fill('Shared Ventures');
  await page.getByRole('combobox', { name: 'Billing account wallet', exact: true }).selectOption('22');
  await page.getByRole('spinbutton', { name: 'Credits to add' }).fill('500');
  await expect(page.getByRole('button', { name: 'Review credit adjustment' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Reason for adjustment' }).fill('Service credit for verified outage');
  await page.getByRole('button', { name: 'Review credit adjustment' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Add 500 credits to Shared Ventures?' })).toBeVisible();
  expect(adjustments).toEqual([]);
  await page.getByRole('button', { name: 'Add credits', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '500 credits added to Shared Ventures. New balance: 9,700 credits.' })).toBeVisible();
  expect(adjustments).toEqual([{ amount: 500, reason: 'Service credit for verified outage' }]);
  await noOverflow(page); await screenshot(page, 'admin-organization-credits');
  expect(fixture.pageErrors).toEqual([]);
});

test('admin refund evidence separates retained credits from pending reconciliation and readiness', async ({ page }) => {
  const fixture = await mockAdmin(page);
  const controls = {
    settings: { enforced: false, capacityEnforced: false, launchedAt: null, credentialId: 1 }, credentials: [], plans: [], issues: [],
    readiness: { monthlyTest: true, yearlyTest: true, live: true, liveWebhookVerifiedAt: '2026-09-27T12:00:00Z', overdueGrants: 0, missingGrants: 0, unreconciledRefunds: 1, ready: false },
    refunds: [{ paymentId: 'pay_refund_evidence', organizationId: 22, subscriptionId: 'sub_refund_evidence', amountPaise: 1_440_000, refundAmountPaise: 1_440_000, observedAt: '2026-09-27T12:00:00Z', cancelledDeposits: 11, retainedCredits: 15000 }],
    webhookPath: '/api/webhooks/razorpay/subscriptions/1',
  };
  await page.route('**/api/admin/subscriptions', route => route.fulfill({ json: controls }));
  await page.route('**/api/admin/subscriptions/reconcile', route => {
    controls.readiness.unreconciledRefunds = 0; controls.readiness.ready = true;
    return route.fulfill({ json: controls });
  });
  await page.goto('/admin/dashboard/settings/subscriptions?tab=payments');
  await expect(page.getByRole('heading', { name: '2. Plans and webhook' })).toBeVisible();
  await expect(page.getByText('Enable subscription.authenticated', { exact: false })).toContainText('refund.processed and payment.refunded');
  await expect(page.getByRole('button', { name: 'Enable subscription requirement', exact: true })).toBeDisabled();
  const refundCheck = page.getByRole('listitem').filter({ hasText: /^Refunds reconciled$/ });
  await expect(refundCheck.getByLabel('Pending')).toBeVisible();
  const evidence = page.getByRole('region', { name: 'Reconciled refunds' });
  await expect(evidence).toContainText('Billing account 22 · ₹14,400 refunded');
  await expect(evidence).toContainText('11 future deposits cancelled · 15,000 credits retained');
  await expect(evidence).toContainText('Payment pay_refund_evidence');
  await expect(evidence).toContainText('Subscription sub_refund_evidence');
  await page.getByRole('button', { name: 'Run reconciliation', exact: true }).click();
  await expect(refundCheck.getByLabel('Complete')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable subscription requirement', exact: true })).toBeEnabled();
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/organization-billing-e2e/admin-refund-evidence-${test.info().project.name}.png`, fullPage: false });
  await noOverflow(page);
  expect(fixture.pageErrors).toEqual([]);
});
