import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test('dashboard review surface preserves navigation, reload, overflow, and critical controls', async ({ page, audit, isMobile }) => {
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 9, website: 'https://example.test' }] }));
  await page.route('**/api/content/brand-toolkits/default', route => route.fulfill({ json: { id: 4 } }));
  await page.route('**/api/content/assets?type=ad_copy', route => route.fulfill({ json: [{
    id: 501, type: 'ad_copy', title: 'Responsive fixture', content: 'Reviewed copy', channel: 'google', createdAt: '2026-08-29T00:00:00.000Z',
  }] }));
  await page.route('**/api/settings/ads', route => route.fulfill({ json: {
    settings: { defaultLifetimeBudget: 500, currency: 'USD', locations: [{ countryCode: 'US' }] },
    readiness: { accounts: { google: { customerId: 'customer-double-1', accountName: 'Regression Google Ads' } } },
  } }));
  await page.route('**/api/campaigns/autonomous/infer-objective', route => route.fulfill({ json: { inference: { objective: 'traffic', rationale: 'fixture' } } }));

  await page.goto('/dashboard/saved-templates/ads/publish?assetId=501');
  if (isMobile) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
  if (isMobile) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Creatives' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.reload();
  await expect(page).toHaveURL(/assetId=501/);
  await expect(page.getByRole('heading', { name: 'Publish ad campaign' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});
