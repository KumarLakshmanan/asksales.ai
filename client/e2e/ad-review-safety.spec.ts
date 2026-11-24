import { expect, test } from './fixtures/app';

const asset = {
  id: 501,
  type: 'ad_copy',
  title: 'Dental Growth',
  content: JSON.stringify({ headline: 'Book more consultations', body: 'A reviewed campaign draft.', keywords: ['dentist crm', 'dental leads'] }),
  channel: 'google',
  status: 'draft',
  createdAt: '2026-08-29T00:00:00.000Z',
  version: 2,
  updatedAt: '2026-08-29T00:00:00.000Z',
};

async function installReviewMocks(page: import('@playwright/test').Page) {
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 9, website: 'https://example.test' }] }));
  await page.route('**/api/content/brand-toolkits/default', route => route.fulfill({ json: { id: 4 } }));
  await page.route('**/api/content/assets?type=ad_copy', route => route.fulfill({ json: [asset] }));
  await page.route('**/api/content/templates/601', route => route.fulfill({ json: {
    id: 601,
    name: 'Saved dental search ad',
    type: 'ad_copy',
    content: JSON.stringify({ headline: 'Saved headline', body: 'Saved reviewed body', keywords: ['saved keyword'] }),
    category: 'google',
    version: 3,
    updatedAt: '2026-08-29T00:00:00.000Z',
  } }));
  await page.route('**/api/settings/ads', route => route.fulfill({ json: {
    settings: { defaultLifetimeBudget: 500, currency: 'USD', locations: [{ countryCode: 'US', googleGeoTargetId: '2840' }] },
    readiness: { accounts: { google: { customerId: 'customer-double-1', accountName: 'Regression Google Ads' } } },
  } }));
  await page.route('**/api/campaigns/autonomous/infer-objective', route => route.fulfill({ json: {
    inference: { objective: 'traffic', rationale: 'Deterministic regression fixture.' },
  } }));
}

for (const source of [
  { name: 'Conversation Builder asset', query: 'assetId=501' },
  { name: 'Saved Template', query: 'templateId=601' },
] as const) {
  test(`${source.name} reaches Google Ads review without live mutation`, async ({ page, audit }) => {
    await installReviewMocks(page);
    await page.goto(`/dashboard/saved-templates/ads/publish?${source.query}`);
    await expect(page.getByRole('heading', { name: 'Publish ad campaign' })).toBeVisible();
    await page.getByRole('checkbox', { name: /Google Ads/ }).click();
    await expect(page.getByText(/Regression Google Ads · customer-double-1/)).toBeVisible();

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByText('Google Budget')).toBeVisible();
    await expect(page.getByPlaceholder('Reviewed keywords, comma separated')).toBeVisible();
    await expect(page.getByLabel('Confirm live activation and spend')).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Publish Campaign' })).toBeDisabled();
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
  });
}
