import { test as base, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';

// Every API request stays synthetic. Record and reject writes and provider
// authorization/refresh jobs even if their endpoint uses GET.
const test = base.extend<{ entryRequests: { effects: string[]; reads: string[] } }>({
  entryRequests: [async ({ page }, use) => {
    const entryRequests = { effects: [] as string[], reads: [] as string[] };
    const isEffect = (method: string, path: string) => !['GET', 'HEAD'].includes(method) || /\/(authorize|auth|refresh|fetch-now|execute|sync)$/.test(path);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return;
      if (isEffect(request.method(), url.pathname)) entryRequests.effects.push(`${request.method()} ${url.pathname}`);
      else entryRequests.reads.push(url.pathname + url.search);
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (isEffect(request.method(), path)) {
        return route.fulfill({ status: 409, json: { error: 'Safe entry must not perform an action.' } });
      }
      const reply = (json: unknown) => route.fulfill({ json });
      if (path === '/api/setup/onboarding-status') return reply({ profile: { applicationUses: ['advertising'] }, completedTasks: [], connectedChannels: [] });
      if (path === '/api/suggestions') return reply({ success: true, suggestions: [] });
      if (path === '/api/meta/oauth/platforms') return reply({ platforms: [{ id: 1, platform: 'meta', isActive: true, adAccountId: 'fixture-ads', pageId: 'fixture-page', accountName: 'Fixture Meta' }] });
      if (path === '/api/meta/oauth/selection') return reply({ adAccounts: [{ id: 'fixture-ads', name: 'Fixture Meta' }], pages: [{ id: 'fixture-page', name: 'Fixture Page' }], selectedAdAccountId: 'fixture-ads', selectedPageId: 'fixture-page' });
      if (path === '/api/integrations/google-ads/config') return reply({ success: true, config: { ready: true, providerConfigured: true, hasRefreshToken: true, customerId: '1234567890' } });
      if (path === '/api/integrations/google-ads/accounts') return reply({ accounts: [{ customerId: '1234567890', manager: false, name: 'Fixture Google' }] });
      if (/\/api\/(instagram|facebook)\/oauth\/status$/.test(path)) return reply({ officialApi: { connected: true, authorized: true, username: 'fixture', credentialId: 1, tokenExpired: false, capabilities: [
        { scope: 'instagram_content_publish', tokenGranted: true, status: 'available', appReviewStatus: 'approved' },
        { scope: 'instagram_manage_insights', tokenGranted: true, status: 'available', appReviewStatus: 'approved' },
        { scope: 'pages_manage_posts', tokenGranted: true, status: 'available', appReviewStatus: 'approved' },
        { scope: 'pages_read_engagement', tokenGranted: true, status: 'available', appReviewStatus: 'approved' },
      ] } });
      if (path === '/api/channel-accounts/instagram_api') return reply([{ id: 31, accountIdentifier: 'fixture-instagram', accountName: 'Fixture Instagram', isSelected: true, analyticsReady: true }]);
      if (path === '/api/channel-accounts/facebook_api') return reply([{ id: 32, accountIdentifier: 'fixture-facebook', accountName: 'Fixture Facebook', isSelected: true, analyticsReady: true }]);
      if (path.startsWith('/api/channel-accounts/')) return reply([]);
      if (path === '/api/social-analytics/competitors') return reply([]);
      if (path === '/api/social-analytics/dashboard') return reply({ summary: {}, trends: [], recommendation: { recommendation: null, citations: [] }, bestTime: null, previousPeriod: null, freshness: { latestSnapshotAt: null, snapshotCount: 0, evidenceSourceCount: 0 } });
      if (path === '/api/youtube/oauth/status') return reply({ connected: true, readiness: 'ready', channelName: 'Fixture Video' });
      if (path === '/api/campaigns/accounts') return reply({ accounts: [] });
      if (path === '/api/campaigns/analytics/dashboard') return reply({ campaigns: [], dailyTrends: [], currency: 'USD', availableCurrencies: ['USD'] });
      if (path === '/api/content/assets') return reply([]);
      if (path === '/api/content/templates') return reply({ templates: [], total: 0 });
      if (path === '/api/support-widget/token') return reply([]);
      return reply({});
    });
    await installAppShellMocks(page);
    await page.route('**/api/**', route => isEffect(route.request().method(), new URL(route.request().url()).pathname)
      ? route.fulfill({ status: 409, json: { error: 'Safe entry must not perform an action.' } })
      : route.fallback());
    await use(entryRequests);
    expect(entryRequests.effects).toEqual([]);
    expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBeCloseTo(1, 2);
  }, { auto: true }],
});

test('first ad next step opens a blank campaign brief without starting an agent or provider action', async ({ page, audit }, info) => {
  await page.goto('/dashboard/home');
  const entry = page.getByRole('link', { name: /Prepare your first ad campaign/ });
  await expect(entry).toHaveAttribute('href', '/dashboard/ads/create');
  await entry.click();
  await expect(page).toHaveURL(/\/dashboard\/ads\/create$/);
  await expect(page.getByRole('heading', { name: 'Create a paid campaign', exact: true })).toBeVisible();
  await expect(page.getByLabel('Campaign name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Budget guidance', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Continue with Performance Marketing' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('first-ad-brief.png'), fullPage: true });
  expect(audit.consoleErrors).toEqual([]);
});

test('Website chat next step opens installation without generating a widget key', async ({ page, audit }) => {
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: { preferredChannels: ['Website chat'] }, completedTasks: [], connectedChannels: [] } }));
  await page.goto('/dashboard/home');
  const entry = page.getByRole('link', { name: /Connect Website chat/ });
  await expect(entry).toHaveAttribute('href', '/dashboard/support-ai/embed');
  await entry.click();
  await expect(page).toHaveURL(/\/dashboard\/support-ai\/embed$/);
  await expect(page.getByRole('heading', { name: 'Embed & integrate', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No support teams yet', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});

for (const [provider, platform] of [['meta', 'meta'], ['google-ads', 'google']] as const) {
  test(`${provider} entries select campaign inventory or performance overview and the matching platform`, async ({ page, audit, entryRequests }, info) => {
    for (const [label, tab] of [['Paid campaigns', 'campaigns'], ['Ad performance', 'overview']] as const) {
      await page.goto(`/dashboard/integrations/${provider}`);
      const entry = page.getByRole('link', { name: new RegExp(`^${label}`) });
      await expect(entry).toHaveAttribute('href', `/dashboard/ads?tab=${tab}&platform=${platform}`);
      await entry.click();
      await expect(page).toHaveURL(new RegExp(`/dashboard/ads\\?tab=${tab}&platform=${platform}$`));
      await expect(page.getByRole('heading', { name: 'Paid Ads', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: tab === 'campaigns' ? 'Campaigns' : 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('combobox', { name: 'Platform', exact: true })).toHaveText(platform);
      if (tab === 'campaigns') await expect(page.getByRole('region', { name: 'Campaign inventory', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`${provider}-${tab}.png`), fullPage: true });
    }
    expect(entryRequests.reads.some(href => href.startsWith('/api/campaigns/analytics/dashboard?') && new URL(href, 'http://fixture.test').searchParams.get('platform') === platform)).toBe(true);
    expect(audit.consoleErrors).toEqual([]);
  });
}

for (const [provider, label] of [['instagram', 'Account analytics'], ['facebook', 'Page analytics']] as const) {
  test(`${provider} analytics opens its own social platform overview`, async ({ page, audit, isMobile }) => {
    await page.goto(`/dashboard/integrations/${provider}`);
    await page.getByRole('link', { name: new RegExp(`^${label}`) }).click();
    await expect(page).toHaveURL(new RegExp(`platform=${provider}`));
    await expect(page.getByRole('heading', { name: 'Social Insights', exact: true })).toBeVisible();
    if (isMobile) await expect(page.getByRole('combobox', { name: 'Social Insights section', exact: true })).toHaveValue('overview');
    else await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('publishing entries open a saved-post chooser without publishing', async ({ page, audit }) => {
  for (const [provider, label] of [['instagram', 'Content publishing'], ['facebook', 'Page publishing'], ['youtube', 'Video publishing']] as const) {
    await page.goto(`/dashboard/integrations/${provider}`);
    await page.getByRole('link', { name: new RegExp(`^${label}`) }).click();
    await expect(page).toHaveURL(/\/dashboard\/saved-templates\/social$/);
    await expect(page.getByRole('heading', { name: 'Social media posts', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  }
  expect(audit.consoleErrors).toEqual([]);
});

test('legacy marketing and ads entries remain valid safe destinations', async ({ page, audit }) => {
  for (const [href, tab] of [['/dashboard/marketing/campaigns', 'Campaigns'], ['/dashboard/ads?tab=analytics', 'Overview'], ['/dashboard/ads', 'Overview']] as const) {
    await page.goto(href);
    await expect(page).toHaveURL(/\/dashboard\/ads(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Paid Ads', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('combobox', { name: 'Platform', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.goto('/dashboard/marketing');
  await expect(page).toHaveURL(/\/dashboard\/marketing\/analytics(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'Social Insights', exact: true })).toBeVisible();
  expect(audit.consoleErrors).toEqual([]);
});
