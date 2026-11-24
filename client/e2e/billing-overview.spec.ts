import { expect, test } from '@playwright/test';
import { mockApp, paid, organizations } from './fixtures/organization-billing';

test('billing summary, credit filters and history work on desktop and mobile', async ({ page }) => {
  const fixture = await mockApp(page, true);
  let preferences = { theme: 'light', language: 'en', timezone: 'UTC' };
  await page.route('**/api/settings/preferences', route => {
    if (route.request().method() === 'PUT') preferences = { ...preferences, ...route.request().postDataJSON() };
    return route.fulfill({ json: preferences });
  });
  const renewal = new Date(Date.now() + 17 * 86_400_000).toISOString();
  const transactions = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1, type: index === 0 ? 'bonus' : index === 1 ? 'recharge' : 'deduction',
    amount: index === 0 ? '15000' : index === 1 ? '5000' : '-12.25',
    balanceAfter: String(20000 - index * 12.25),
    amountPaid: index === 1 ? '500' : null, currency: 'INR',
    description: index === 0 ? 'Monthly Growth credit deposit' : index === 1 ? 'Additional credit purchase' : `Lead discovery batch ${index}`,
    createdAt: new Date(Date.now() - index * 86_400_000).toISOString(),
  }));
  await page.route('**/api/subscriptions/current', route => route.fulfill({ json: {
    ...paid, organization: organizations[0],
    subscription: { ...paid.subscription, term: 'monthly', paidThrough: renewal }, nextDepositAt: renewal,
    charges: [{ id: 'fixture-charge', amountPaise: 150000, term: 'monthly', plan: 'growth', paidAt: new Date().toISOString(), periodStart: new Date().toISOString(), periodEnd: renewal, invoiceUrl: 'https://example.test/invoice', taxPaise: null }],
  } }));
  const requests: URL[] = [];
  await page.route('**/api/wallet/transactions?*', route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const type = url.searchParams.get('type');
    const filtered = type ? transactions.filter(item => item.type === type) : transactions;
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 10);
    return route.fulfill({ json: { transactions: filtered.slice(offset, offset + limit), total: filtered.length } });
  });
  await page.goto('/dashboard/billing');
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Growth plan' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Available credits' })).toContainText('1,234');
  await expect(page.getByRole('link', { name: 'Add credits' })).toHaveAttribute('href', '/dashboard/billing/recharge');
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invoice', exact: true })).toHaveAttribute('href', 'https://example.test/invoice');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/asksales-billing-overview-${test.info().project.name}.png`, fullPage: false });
  const summary = page.getByRole('region', { name: 'Growth plan' });
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/asksales-billing-subscription-${test.info().project.name}.png`, fullPage: false });
  const activity = page.getByRole('region', { name: 'Credit activity' });
  await activity.scrollIntoViewIfNeeded();
  await expect(activity.getByText('1–10 of 12 transactions')).toBeVisible();
  await activity.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(activity.getByText('11–12 of 12 transactions')).toBeVisible();
  await activity.getByLabel('Transaction type').selectOption('recharge');
  await expect(activity.getByText('1–1 of 1 transactions')).toBeVisible();
  await expect(activity.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await activity.getByLabel('From date').fill('2026-09-14');
  await activity.getByLabel('To date').fill('2026-09-29');
  await expect.poll(() => requests.some(url => url.searchParams.get('type') === 'recharge' && url.searchParams.has('startDate') && url.searchParams.has('endDate'))).toBe(true);
  await activity.getByRole('button', { name: 'Clear filters' }).click();
  await expect(activity.getByText('1–10 of 12 transactions')).toBeVisible();
  await page.screenshot({ path: `/tmp/asksales-billing-activity-${test.info().project.name}.png`, fullPage: false });
  if (test.info().project.name === 'desktop-chromium') {
    await page.setViewportSize({ width: 900, height: 1050 });
    await expect.poll(() => page.locator('aside[data-sidebar-state]').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await page.locator('#main-content').evaluate(element => { element.scrollTop = 0; });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/asksales-billing-overview-tablet.png', fullPage: false });
  }
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.locator('#main-content').evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: `/tmp/asksales-billing-overview-dark-${test.info().project.name}.png`, fullPage: false });
  expect(fixture.pageErrors).toEqual([]);
});

test('staff can review billing without purchase actions', async ({ page }) => {
  await mockApp(page, true);
  await page.route('**/api/subscriptions/current', route => route.fulfill({ json: { ...paid, organization: { ...organizations[0], role: 'member', canManageBilling: false } } }));
  await page.route('**/api/wallet/transactions?*', route => route.fulfill({ json: { transactions: [], total: 0 } }));
  await page.goto('/dashboard/billing');
  await expect(page.getByRole('heading', { name: 'Growth plan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add credits' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Manage subscription' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View subscription', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /₹500/ })).toHaveCount(0);
  await expect(page.getByText('No credit activity yet')).toBeVisible();
});
