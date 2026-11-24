import type { Locator } from '@playwright/test';
import { expect, installAppShellMocks, test } from './fixtures/app';

const lead = {
  id: 1490, name: 'Breadcrumb fixture lead', company: 'Fixture Company',
  email: 'breadcrumb@example.test', source: 'manual', score: 65,
  createdAt: '2026-10-09T00:00:00Z',
};

test.beforeEach(async ({ page }) => {
  if (test.info().project.name === 'desktop-chromium') {
    await page.setViewportSize({ width: 1180, height: 757 });
  }
  // All API traffic stays in the browser fixture; no real session or records.
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
  await page.route('**/api/leads?*', route => route.fulfill({
    json: { data: [lead], total: 1, totalPages: 1, page: 1, pageSize: 15 },
  }));
  await page.route('**/api/leads/1490', route => route.fulfill({ json: lead }));
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: {
    totalLeads: 1, newLeads: 1, activeCampaigns: 0, completedCampaigns: 0,
    totalSpent: 0, totalBudget: 0, messagesSent: 0, conversionRate: '0',
  } }));
  await page.route('**/api/suggestions', route => route.fulfill({ json: { success: true, suggestions: [], allSuggestions: [] } }));
  await page.route('**/api/proposals/42', route => route.fulfill({ json: {
    id: 42, title: 'Breadcrumb fixture proposal', proposalNumber: 'P-42', status: 'draft',
    revision: 1, currency: 'INR', subtotal: '0', total: '0', taxRate: '0', discountValue: '0',
    lineItems: [], createdAt: lead.createdAt, updatedAt: lead.createdAt,
  } }));
  await page.route('**/api/proposals/brand', route => route.fulfill({ json: { companyName: 'Fixture Company' } }));
  await page.route('**/api/proposals?*', route => route.fulfill({ json: { proposals: [], total: 0, totalPages: 1 } }));
  await page.route('**/api/proposals/analytics', route => route.fulfill({ json: {
    total: 0, draft: 0, sent: 0, viewed: 0, accepted: 0, rejected: 0,
    expired: 0, delivery_unknown: 0, acceptanceRate: 0,
  } }));
});

async function expectCurrentPage(breadcrumb: Locator, label: string) {
  const current = breadcrumb.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText(label);
  await expect(current).not.toHaveAttribute('href');
  await expect(current).not.toHaveAttribute('tabindex');
  await expect(breadcrumb.getByRole('link', { name: label, exact: true })).toHaveCount(0);
}

test('AS001: lead parent links and browser Back retain a valid semantic trail', async ({ page }) => {
  const invalidRequests: string[] = [];
  const mutations: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/dashboard/leads/view') invalidRequests.push(request.url());
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/dashboard/leads/view/1490');
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb', exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(page.getByRole('heading', { name: lead.name, exact: true })).toBeVisible();
    await expectCurrentPage(breadcrumb, 'Lead #1490');
    await expect(breadcrumb.getByRole('link')).toHaveCount(2);
    await expect(breadcrumb.getByRole('link', { name: 'View', exact: true })).toHaveCount(0);
    const leadsLink = breadcrumb.getByRole('link', { name: 'Leads', exact: true });
    await expect(leadsLink).toHaveAttribute('href', '/dashboard/leads');
    await leadsLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/dashboard\/leads$/);
    await expect(page.getByRole('heading', { name: /All Leads/ })).toBeVisible();
    await expectCurrentPage(breadcrumb, 'Leads');
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard\/leads\/view\/1490$/);
    await expectCurrentPage(breadcrumb, 'Lead #1490');
  }

  const home = breadcrumb.getByRole('link', { name: 'Home dashboard', exact: true });
  await expect(home).toHaveAttribute('href', '/dashboard/home');
  await home.click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await expect(page.locator('#main-content')).toBeVisible();
  await expect(breadcrumb).toHaveCount(0);
  await expect(page.getByText('This page does not exist.', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expectCurrentPage(breadcrumb, 'Lead #1490');
  expect(invalidRequests).toEqual([]);
  expect(mutations).toEqual([]);
});

test('another shared dashboard detail trail retains its valid parent and current page', async ({ page }) => {
  await page.goto('/dashboard/proposals/42');
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb', exact: true });
  await expect(page.locator('header').getByRole('heading', { name: 'Breadcrumb fixture proposal', exact: true })).toBeVisible();
  await expectCurrentPage(breadcrumb, '42');
  await expect(breadcrumb.getByRole('link')).toHaveCount(2);
  const parent = breadcrumb.getByRole('link', { name: 'Proposals', exact: true });
  await expect(parent).toHaveAttribute('href', '/dashboard/proposals');
  await parent.click();
  await expect(page).toHaveURL(/\/dashboard\/proposals$/);
  await expect(page.getByRole('heading', { name: 'Proposals', exact: true })).toBeVisible();
  await expectCurrentPage(breadcrumb, 'Proposals');
  await page.goBack();
  await expectCurrentPage(breadcrumb, '42');
});
