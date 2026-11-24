import type { Locator, Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test.use({ video: 'off' });
test.setTimeout(90_000);

const campaigns = [
  { id: 'awareness', name: 'Synthetic awareness campaign', source: 'provider_cache', status: 'report_only', providerStatus: 'ACTIVE', objective: 'awareness', adPlatform: 'meta', platformCampaignId: 'awareness', accountRegistryId: 12, currency: 'INR', budgetAmount: 1000, campaignAiConsent: false, metrics: { spend: 8148.37, impressions: 2400000, reach: 2329253, clicks: 2400 }, metricsUpdatedAt: '2026-10-29T07:55:48Z' },
  { id: 7, name: 'Synthetic managed campaign', source: 'managed', status: 'paused', providerStatus: 'PAUSED', objective: 'leads', adPlatform: 'meta', currency: 'INR', budgetAmount: 2000, campaignAiConsent: false, metrics: { spend: 2000, impressions: 1000, leads: null }, metricsUpdatedAt: '2026-10-29T07:55:48Z' },
];
const settings = { defaultLifetimeBudget: 100, currency: 'USD', locations: [], autonomousOptimizationEnabled: true, liveProviderMutationsEnabled: false, analyticsSyncMinutes: 30 };
const autonomy = { mode: 'advisory', enabled: true, policyVersion: 'ads-pause-v1', consentedAt: null, notificationEmail: 'qa@example.test', defaultThresholds: {} };
const report = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic weekly report', filters: { platform: 'instagram', accountIdentifier: 'synthetic-social', relativeDays: 30, timezone: 'Asia/Kolkata' }, schedule_definition: { frequency: 'weekly', dayOfWeek: 1, localTime: '09:00', timezone: 'Asia/Kolkata' }, delivery_channel: 'in_app', paused: false };

async function expectDrawerFitsViewport(drawer: Locator) {
  await expect.poll(() => drawer.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= -1 && bounds.right <= window.innerWidth + 1
      && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
}

async function mockMarketing(page: Page, connected = false) {
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push({ path, method: request.method(), body: request.postDataJSON() });
      if (path === '/api/settings/ads' || path === '/api/settings/ads/autonomy') return route.fulfill({ json: { settings: request.postDataJSON() } });
      if (path === '/api/social-analytics/reports') return route.fulfill({ json: { ...report, ...request.postDataJSON() } });
      return route.fulfill({ status: 409, json: { error: 'Unexpected mutation blocked by the Marketing UI fixture.' } });
    }
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/outreach\/assistants\/catalog|settings\/business-profiles|organizations|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) return route.fallback();
    if (path === '/api/campaigns/accounts') return route.fulfill({ json: { accounts: [] } });
    if (path === '/api/campaigns/analytics/dashboard') return route.fulfill({ json: {
      campaigns, currency: 'INR', availableCurrencies: ['INR'], dailyTrends: [],
      summary: { totalCampaigns: 2, totalSpend: 10148.37, changes: { spend: null }, includesProviderCache: true },
      aiSummary: { settings: { mode: 'advisory', analyticsSyncMinutes: 30, policyVersion: 'ads-pause-v1' }, consentedCampaigns: 0, totalCampaigns: 1, watchedUnits: 0, pausedUnits: 0, lastEvaluationAt: null, dataFreshnessAt: '2026-10-29T07:55:48Z', recentActions: [] },
    } });
    if (path === '/api/settings/ads') return route.fulfill({ json: { settings, readiness: { meta: false, google: false, reasons: {} }, environmentMutationGate: false } });
    if (path === '/api/settings/ads/autonomy') return route.fulfill({ json: { settings: autonomy } });
    if (path.startsWith('/api/channel-accounts/')) return route.fulfill({ json: connected && path.endsWith('/instagram_api') ? [{ id: 26, accountIdentifier: 'synthetic-social', accountName: 'Synthetic social account', displayName: 'Synthetic social account', analyticsReady: true, isSelected: true }] : [] });
    if (path === '/api/social-analytics/dashboard') return route.fulfill({ json: { summary: {}, trends: [], bestTime: null, previousPeriod: null, recommendation: { recommendation: null, citations: [] }, freshness: { latestSnapshotAt: null, snapshotCount: 0, evidenceSourceCount: 0 }, sync: null } });
    if (path === '/api/social-analytics/content') return route.fulfill({ json: { items: [], nextOffset: null, totalPosts: 0, metricTotals: {}, metricCoverage: {}, formats: [], timeline: [], topContent: [], rankingMetric: 'reach', truncated: false, sync: null } });
    if (path === '/api/social-analytics/reports') return route.fulfill({ json: [report] });
    if (path.startsWith('/api/campaigns/analytics/provider/meta/')) return route.fulfill({ json: {
      campaign: { id: 'awareness', name: 'Synthetic awareness campaign', objective: 'awareness', currency: 'INR', provider_status: 'ACTIVE', ad_platform: 'meta', metrics_updated_at: '2026-10-29T07:55:48Z', reporting_window: { start: '2026-10-01', end: '2026-10-30' } },
      settings: { mode: 'advisory', analyticsSyncMinutes: 30, policyVersion: 'ads-pause-v1' }, policy: { enabled: false, reportOnly: true, policyVersion: 'ads-pause-v1', thresholds: {} },
      units: [], evaluations: [], recommendations: [], actions: [], performanceTrace: [], historicalBaselines: [], providerAggregate: campaigns[0].metrics, accountIdentity: { adAccountName: 'Synthetic account' },
      monitoring: { state: 'report_only', canImport: false }, analysisReadiness: { status: 'import_required', blockers: [], baselineAvailable: false, successfulSyncWindows: 0 },
    } });
    if (path.includes('/meta-diagnostics/')) return route.fulfill({ status: 403, json: { error: 'Reconnect Meta Ads to refresh this account.' } });
    return route.fulfill({ json: [] });
  });
  return { writes, errors };
}

test('inventory drawer preserves browser views, columns, keyboard dismissal and campaign links', async ({ page }, info) => {
  const audit = await mockMarketing(page);
  await page.goto('/dashboard/ads?tab=campaigns');
  await expect(page.getByRole('heading', { name: 'Paid Ads', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Columns & saved views' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Columns & saved views' });
  await expect(drawer.getByRole('checkbox', { name: 'Campaign Always shown' })).toBeDisabled();
  await drawer.getByRole('checkbox', { name: 'Budget', exact: true }).check();
  await drawer.getByLabel('Saved view name').fill('Budget review');
  await drawer.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Budget review', exact: true })).toBeVisible();
  await expectDrawerFitsViewport(drawer);
  await page.screenshot({ path: info.outputPath('inventory-columns.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.reload();
  await trigger.click();
  await drawer.getByRole('button', { name: 'Budget review', exact: true }).click();
  await expect(drawer.getByRole('checkbox', { name: 'Budget', exact: true })).toBeChecked();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Synthetic awareness campaign', exact: true }).filter({ visible: true })).toHaveAttribute('href', /campaigns\/provider\/meta\/awareness/);
  await expectNoHorizontalOverflow(page);
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('social setup and data drawer preserve the no-account prerequisite', async ({ page }, info) => {
  const audit = await mockMarketing(page);
  await page.goto('/dashboard/marketing/analytics');
  await expect(page.getByRole('heading', { name: 'Connect your social accounts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Integrate accounts', exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('social-setup.png'), fullPage: true, animations: 'disabled' });
  const trigger = page.getByRole('button', { name: 'Data & connections', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Data & connections' });
  await expect(drawer.getByRole('button', { name: 'Sync official data', exact: true })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Recompute best time', exact: true })).toBeDisabled();
  await expectDrawerFitsViewport(drawer);
  await page.screenshot({ path: info.outputPath('social-connections.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expectNoHorizontalOverflow(page);
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('ad settings retain edits across sections, discard locally, and save the existing payload', async ({ page }, info) => {
  const audit = await mockMarketing(page);
  await page.goto('/dashboard/settings/ads');
  const amount = page.getByRole('spinbutton', { name: 'Amount', exact: true });
  await amount.fill('125');
  await page.getByRole('tab', { name: 'AI permissions', exact: true }).click();
  await expect(page.getByText('Server live actions disabled', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Allow publishing and manual campaign actions' })).not.toBeChecked();
  await expect(page.getByText('AI capability matrix', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('ad-permissions.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('tab', { name: 'Campaign defaults', exact: true }).click();
  await expect(amount).toHaveValue('100');
  await amount.fill('150');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => audit.writes.length).toBe(1);
  expect(audit.writes[0]).toEqual({ path: '/api/settings/ads', method: 'PUT', body: { ...settings, defaultLifetimeBudget: 150 } });
  await expectNoHorizontalOverflow(page);
  expect(audit.errors).toEqual([]);
});

test('report table and schedule drawer retain delivery inputs and submission contract', async ({ page }, info) => {
  const audit = await mockMarketing(page, true);
  await page.goto('/dashboard/marketing/analytics?platform=instagram&account=26&tab=reports');
  await expect(page.getByRole('table', { name: 'Saved reports' })).toBeVisible();
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Create report' });
  await drawer.getByLabel('Report name', { exact: true }).fill('Synthetic new report');
  await drawer.getByRole('combobox', { name: /^Frequency/ }).selectOption('weekly');
  await drawer.getByLabel('Timezone', { exact: false }).fill('Asia/Kolkata');
  await drawer.getByRole('combobox', { name: /^Delivery/ }).selectOption('email');
  await drawer.getByLabel('Recipient', { exact: false }).fill('qa@example.test');
  await expectDrawerFitsViewport(drawer);
  await page.screenshot({ path: info.outputPath('report-schedule.png'), fullPage: true, animations: 'disabled' });
  await drawer.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect.poll(() => audit.writes.length).toBe(1);
  expect(audit.writes[0]).toMatchObject({ path: '/api/social-analytics/reports', method: 'POST', body: { name: 'Synthetic new report', deliveryChannel: 'email', deliveryTarget: 'qa@example.test', schedule: { frequency: 'weekly', timezone: 'Asia/Kolkata' } } });
  await expectNoHorizontalOverflow(page);
  expect(audit.errors).toEqual([]);
});

test('campaign detail tabs preserve evidence states and offer diagnostic recovery without mutations', async ({ page }, info) => {
  const audit = await mockMarketing(page);
  await page.goto('/dashboard/ads/campaigns/provider/meta/awareness?account=12&period=30d');
  await expect(page.getByRole('heading', { name: 'Synthetic awareness campaign', exact: true })).toBeVisible();
  for (const name of ['Summary', 'Ads & ad sets', 'Creative preview', 'Recommendations', 'Automation & activity', 'Technical details']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expectNoHorizontalOverflow(page);
    if (name === 'Summary') await page.screenshot({ path: info.outputPath('campaign-summary.png'), fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('tab', { name: 'Meta diagnostics', exact: true }).click();
  await expect(page.getByText('Meta diagnostics unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review Meta Ads connection' })).toHaveAttribute('href', '/dashboard/integrations/meta');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('campaign-diagnostics.png'), fullPage: true, animations: 'disabled' });
  await expectNoHorizontalOverflow(page);
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});
