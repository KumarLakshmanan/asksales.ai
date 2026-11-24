import type { Locator, Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { installPopulatedMarketing, populatedDetail } from './fixtures/marketingPopulated';

test.use({ video: 'off' });
test.setTimeout(90_000);
const social = '/dashboard/marketing/analytics?platform=instagram&account=26&start=2026-10-01&end=2026-10-30';
const provider = '/dashboard/ads/campaigns/provider/meta/awareness?account=12&period=30d';

async function rectangle(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}
async function card(page: Page, text: string) {
  const title = page.getByText(text, { exact: true }).first();
  await expect(title).toBeVisible();
  return title.evaluate(element => {
    const box = element.closest('.shadcn-card')!.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
}
function clean(audit: Awaited<ReturnType<typeof installPopulatedMarketing>>) {
  expect(audit.errors).toEqual([]);
  expect(audit.unhandled).toEqual([]);
  expect(audit.writes).toEqual([]);
}

test('paid overview keeps mixed outcomes distinct and uses a desktop decision row', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto('/dashboard/ads?tab=overview');
  const outcomes = page.getByRole('region', { name: 'Results by objective' });
  // A named section without an explicit role is a region in the accessibility tree.
  await expect(outcomes).toBeVisible();
  await expect(outcomes.locator('.shadcn-card')).toHaveCount(5);
  await expect(page.getByText('Different outcomes are not blended', { exact: true })).toBeVisible();
  const trend = await card(page, 'Performance trend');
  const comparison = await card(page, 'Same-outcome comparison');
  const attention = await card(page, 'Attention queue');
  if (info.project.name.startsWith('desktop')) {
    expect(Math.abs(trend.y - comparison.y)).toBeLessThan(3);
    expect(Math.abs(trend.y - attention.y)).toBeLessThan(3);
    expect(comparison.x).toBeGreaterThan(trend.x + trend.width - 2);
    expect(trend.y).toBeLessThan(800);
  } else expect(comparison.y).toBeGreaterThan(trend.y);
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('creative research has a focused route and retains manual reference fields', async ({ page }) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto('/dashboard/ads?tab=recommendations&research=1&period=7d');
  await expect(page.getByRole('heading', { name: 'Competitor creative research', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Campaign reviews' })).toHaveCount(0);
  await page.getByLabel('Competitor name', { exact: true }).fill('Sample competitor');
  await page.getByLabel('Observed ad copy', { exact: true }).fill('Sample observed message');
  await expect(page.getByRole('button', { name: 'Save research', exact: true })).toBeEnabled();
  const back = page.getByRole('link', { name: 'Back to recommendations', exact: false });
  await expect(back).toHaveAttribute('href', /period=7d/);
  await expect(back).not.toHaveAttribute('href', /research=1/);
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('overview links keep the selected account and reporting window', async ({ page }) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto('/dashboard/ads?tab=overview&account=12&period=7d');
  const destinations = [
    ['Set up AI monitoring', 'automation'],
    ['Open all campaigns', 'campaigns'],
    ['Review recommendations', 'recommendations'],
  ];
  for (const [name, tab] of destinations) {
    const href = await page.getByRole('link', { name, exact: true }).getAttribute('href');
    const destination = new URL(href!, page.url());
    expect(destination.searchParams.get('account')).toBe('12');
    expect(destination.searchParams.get('period')).toBe('7d');
    expect(destination.searchParams.get('tab')).toBe(tab);
  }
  await page.getByRole('link', { name: 'Set up AI monitoring', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Automation & activity', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(new URL(page.url()).searchParams.get('account')).toBe('12');
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('duplicate ad accounts and failed sync readiness stay clear without changing provider data', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  const account = { platform: 'meta', name: 'Sample hospitality', currency: 'INR', timezone: 'Asia/Kolkata',
    is_manager: false, reporting_available: true, publishing_available: true, verified_at: '2026-10-29T12:00:00Z',
    last_succeeded_at: null, last_attempt_at: '2026-10-30T12:00:00Z', data_available_through: null };
  await page.route('**/api/campaigns/accounts', route => route.fulfill({ json: { accounts: [
    { ...account, id: 12, provider_account_id: '123456789012345', error_code: 'INCOMPLETE_REPORTING' },
    { ...account, id: 13, provider_account_id: '123456789012346', error_code: null },
  ] } }));
  await page.goto('/dashboard/ads?tab=overview&account=12');
  const selector = page.getByRole('combobox', { name: 'Ad account', exact: true });
  await expect(selector).toContainText('ID 123456789012345');
  const readiness = page.getByLabel('Selected ad account readiness', { exact: true });
  await expect(readiness).toContainText('Authorization: Recheck required');
  await expect(readiness).toContainText('Reporting: Needs attention');
  await expect(readiness).toContainText('Publishing: Not verified');
  await expect(readiness.getByRole('link', { name: 'Review Meta Ads connection', exact: true })).toHaveAttribute('href', '/dashboard/integrations/meta');
  await selector.click();
  await expect(page.getByRole('option', { name: /ID 123456789012345/ })).toBeVisible();
  await page.getByRole('option', { name: /ID 123456789012346/ }).click();
  await expect(selector).toContainText('ID 123456789012346');
  await expect(readiness).toContainText('Authorization: Verified');
  await expect(readiness).toContainText('Publishing: Ready');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('account-selection.png'), fullPage: true });
  clean(audit);
});

test('creative cards and research distinguish and retain the selected ad account', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  const accounts = [12, 13].map((id, i) => ({ id, platform: 'meta', provider_account_id: String(111 + i), name: 'Sample hospitality',
    currency: 'INR', timezone: 'Asia/Kolkata', is_manager: false, reporting_available: true, publishing_available: false, verified_at: '2026-10-29T12:00:00Z' }));
  const cached = [
    { platformEntityId: 'own-provider', adAccountId: '111', name: 'Selected account provider', status: 'ACTIVE', spend: 100 },
    { platformEntityId: 'other-provider', adAccountId: '112', name: 'Other account provider', status: 'PAUSED', spend: 900 },
  ].map(campaign => ({ ...campaign, impressions: 1000, clicks: 10, lastRefreshedAt: '2026-10-29T12:00:00Z', rawData: { campaign: { objective: 'OUTCOME_TRAFFIC' } } }));
  await page.route('**/api/campaigns/accounts', route => route.fulfill({ json: { accounts } }));
  await page.route('**/api/campaigns/meta/cache/campaigns?*', route => route.fulfill({ json: { campaigns: cached } }));
  await page.route('**/api/campaigns/meta/campaigns?*', route => route.fulfill({ json: { campaigns: cached.map(campaign => ({ id: campaign.platformEntityId, name: campaign.name, status: campaign.status, effective_status: campaign.status, objective: 'OUTCOME_TRAFFIC', metricsAvailable: false })) } }));
  await page.route('**/api/campaigns/autonomous', route => route.fulfill({ json: { campaigns: [
    { id: 9, name: 'Selected account draft', ad_account_id: 'act_111', local_status: 'draft', ad_platform: 'meta', objective: 'traffic', currency: 'INR', budget_amount: 1000, created_at: '2026-10-29T12:00:00Z' },
    { id: 10, name: 'Other account draft', ad_account_id: '112', local_status: 'draft', ad_platform: 'meta', objective: 'traffic', currency: 'INR', budget_amount: 1000, created_at: '2026-10-29T12:00:00Z' },
  ] } }));
  await page.goto('/dashboard/ads?tab=campaigns&layout=cards&account=12&period=7d');
  await expect(page.getByRole('heading', { name: 'Selected account provider', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Selected account draft', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Other account provider', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Other account draft', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Campaign inventory summary')).toContainText('₹100');
  const selector = page.getByRole('combobox', { name: 'Ad account', exact: true });
  await selector.click();
  await page.getByRole('option', { name: /ID 112/ }).click();
  await expect(page.getByRole('heading', { name: 'Other account provider', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Selected account provider', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Campaign inventory summary')).toContainText('₹900');
  expect(new URL(page.url()).searchParams.get('period')).toBe('7d');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('account-scoped-cards.png'), fullPage: true });
  await page.goto('/dashboard/ads?tab=recommendations&research=1&account=13');
  const researchAccount = page.getByRole('combobox', { name: 'Meta account', exact: true });
  await expect(researchAccount.getByRole('option', { name: 'Sample hospitality · ID 111', exact: true })).toHaveCount(1);
  await expect(researchAccount.getByRole('option', { name: 'Sample hospitality · ID 112', exact: true })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('creative comparison leaves a usable placement preview at ordinary desktop widths', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto(provider + '&tab=creative');
  const preview = page.locator('[aria-label="Creative placement preview"]');
  const box = await rectangle(preview);
  // Guards the former 280px sidebar squeezing the placement into a few characters.
  expect(box.width).toBeGreaterThan(290);
  await page.getByRole('combobox', { name: 'Creative', exact: true }).click();
  await page.getByRole('option', { name: 'Sample · Pet friendly escapes', exact: true }).click();
  await expect(preview.getByText('Sample · Pet friendly escapes', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Instagram', exact: true }).click();
  await expect(preview.getByText('@sample.stays', { exact: true }).first()).toBeVisible();
  if (info.project.name.startsWith('desktop')) {
    const comparison = await card(page, 'Creative comparison');
    expect(box.x).toBeGreaterThan(comparison.x + comparison.width - 2);
  }
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('saved creative media falls back or discloses expired links without provider changes', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  const detail = populatedDetail(false);
  detail.units = detail.units.map(unit => !('creative' in unit) ? unit : {
    ...unit, creative: { ...unit.creative,
      imageUrl: unit.targetKey === 'ad-3' ? 'http://127.0.0.1:3462/__marketing_fixture/2.svg' : 'http://127.0.0.1:3462/__marketing_fixture/expired-primary.jpg',
      thumbnailUrl: unit.targetKey === 'ad-2' ? 'http://127.0.0.1:3462/__marketing_fixture/expired-thumbnail.jpg' : 'http://127.0.0.1:3462/__marketing_fixture/0.svg',
    },
  });
  await page.route('**/api/campaigns/analytics/provider/meta/**', route => route.fulfill({ json: detail }));
  await page.route('**/__marketing_fixture/*.jpg', route => route.fulfill({ status: 410, body: '' }));
  await page.goto(provider + '&tab=creative');
  const preview = page.locator('[aria-label="Creative placement preview"]');
  const image = preview.getByRole('img', { name: 'Creative for Sample · Poolside mornings', exact: true });
  await expect(image).toHaveAttribute('src', /\/0\.svg$/);
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText('3/3 have saved creative evidence', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Creative', exact: true }).click();
  await page.getByRole('option', { name: 'Sample · Pet friendly escapes', exact: true }).click();
  await expect(preview.getByRole('status')).toContainText('The saved provider media links could not be loaded.');
  await expect(preview.getByText('Make room for a slower weekend. Explore our sample resort collection.', { exact: true })).toBeVisible();
  await expect(preview.getByRole('img')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('expired-creative-media.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Creative', exact: true }).click();
  await page.getByRole('option', { name: 'Sample · Garden dining', exact: true }).click();
  const recovered = preview.getByRole('img', { name: 'Creative for Sample · Garden dining', exact: true });
  await expect.poll(() => recovered.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(preview.getByText('Media preview unavailable', { exact: true })).toHaveCount(0);
  clean(audit);
});

test('campaign automation and technical evidence keep controls and recorded values available', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto('/dashboard/ads/campaigns/managed/7?period=30d&tab=automation');
  await expect(page.getByRole('switch', { name: 'Allow AI pause' })).not.toBeChecked();
  await expect(page.getByLabel('Target CPL (INR)')).toHaveValue('120');
  const safety = await card(page, 'Automation safety');
  const eligibility = await card(page, 'Pause eligibility');
  if (info.project.name.startsWith('desktop')) expect(Math.abs(safety.y - eligibility.y)).toBeLessThan(3);
  await page.getByRole('tab', { name: 'Technical details', exact: true }).click();
  await expect(page.getByText('Threshold overrides', { exact: true })).toBeVisible();
  await expect(page.getByText('Sync windows', { exact: true })).toBeVisible();
  await expect(page.getByText('Raw rule evidence', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('social content selection connects the table to its inline or mobile conversation', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto(social + '&tab=content');
  const table = page.getByRole('table', { name: 'Published content', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(8);
  const select = table.getByRole('button', { name: /^Select post: Sample · Resort enquiries/ });
  await select.click();
  const conversation = info.project.name.startsWith('desktop')
    ? page.locator('aside[aria-label="Post preview and conversation"]')
    : page.getByRole('dialog', { name: 'Post comments', exact: true });
  await expect(conversation.getByRole('link', { name: 'View post details', exact: false })).toHaveAttribute('href', /posts\/124\?/);
  await expect(conversation.getByText('Is the pool open during the weekend?', { exact: true })).toBeVisible();
  await conversation.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(conversation.getByRole('button', { name: /Publish reply|Send reply/i })).toBeDisabled();
  if (info.project.name.startsWith('desktop')) {
    const left = await rectangle(table.locator('..').locator('..'));
    const right = await rectangle(conversation);
    expect(right.x).toBeGreaterThan(left.x + left.width - 2);
  } else {
    await page.keyboard.press('Escape');
    await expect(conversation).toBeHidden();
  }
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('social post detail uses three desktop columns without losing comments or metrics', async ({ page }, info) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto('/dashboard/marketing/analytics/posts/123?platform=instagram&account=26&start=2026-10-01&end=2026-10-30');
  const conversation = await rectangle(page.locator('[aria-label="Post conversation"]'));
  const performance = await rectangle(page.locator('[aria-labelledby="post-performance-heading"]'));
  if (info.project.name.startsWith('desktop')) {
    expect(performance.x).toBeGreaterThan(conversation.x + conversation.width - 2);
    expect(Math.abs(performance.y - conversation.y)).toBeLessThan(3);
  } else expect(performance.y).toBeGreaterThan(conversation.y);
  await expect(page.getByText('Your account', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to posts', exact: false })).toHaveAttribute('href', /start=2026-10-01/);
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('report actions remain accessible from the compact menu and schedule drawer', async ({ page }) => {
  const audit = await installPopulatedMarketing(page);
  await page.goto(social + '&tab=reports');
  const table = page.getByRole('table', { name: 'Saved reports' });
  await expect(table.locator('tbody tr')).toHaveCount(4);
  await table.getByRole('button', { name: 'More actions for Sample · Weekly social pulse', exact: true }).click();
  for (const name of ['Export CSV', 'Export PDF', 'Export JSON', 'Duplicate', 'Pause', 'Delete']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await table.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: 'Edit report', exact: true });
  await expect(editor.getByLabel('Report name', { exact: true })).toHaveValue('Sample · Weekly social pulse');
  await expect(editor.getByRole('combobox', { name: /^Frequency/ })).toHaveValue('weekly');
  await expectNoHorizontalOverflow(page);
  clean(audit);
});

test('no-account setup keeps prerequisites clear and disables dependent tabs', async ({ page }) => {
  const audit = await installPopulatedMarketing(page, { connected: false });
  await page.goto('/dashboard/marketing/analytics');
  await expect(page.getByRole('heading', { name: 'Connect your social accounts', exact: true })).toBeVisible();
  await expect(page.getByText('No social accounts connected yet', { exact: true })).toBeVisible();
  const listening = page.getByRole('tab', { name: 'Listening', exact: true });
  if (await listening.isVisible()) await expect(listening).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Integrate accounts', exact: true }).first()).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  clean(audit);
});
