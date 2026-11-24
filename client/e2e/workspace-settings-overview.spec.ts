import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

const evidenceDirectory = process.env.ASKSALES_SETTINGS_EVIDENCE_DIR || '../qa/settings-scope-overview/evidence';
const moduleKeys = ['campaigns', 'lead_generation', 'content', 'performance_marketing', 'ai_visibility', 'outreach', 'crm', 'support', 'support_ai', 'proposals', 'knowledge_base', 'integrations', 'billing', 'storage'];
const north = { id: 4102, companyName: 'North fixture workspace', role: 'owner', isDefault: true, canManageTeam: true };
const south = { id: 4103, companyName: 'South fixture workspace', role: 'member', isDefault: false, canManageTeam: false };
const widgetSettings = { displayName: '', greeting: 'Fixture greeting', primaryColor: '#6366f1', logoUrl: '', launcherPosition: 'right' };

async function installSettingsFixtures(page: Page) {
  const state = { profiles: [north] as Array<typeof north>, disabled: [] as string[], failProfiles: false, writes: [] as string[], reads: [] as string[] };
  // Every API request is synthetic. Unsafe methods fail before reaching any API,
  // including account/security writes, provider jobs and external sends.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Settings discovery fixture blocks every mutation.' } });
    }
    state.reads.push(path);
    if (path === '/api/settings/business-profiles') return route.fulfill({ status: state.failProfiles ? 503 : 200, json: state.failProfiles ? { error: 'Fixture workspace lookup unavailable.' } : state.profiles });
    if (/^\/api\/settings\/business-profiles\/\d+$/.test(path)) return route.fulfill({ json: state.profiles.find(profile => profile.id === Number(path.split('/').at(-1))) });
    if (path === '/api/platform/access') return route.fulfill({ json: { maintenance: { enabled: false, message: '' }, modules: moduleKeys.map(key => ({ key, name: key, description: '', enabled: !state.disabled.includes(key), status: 'available', mode: state.disabled.includes(key) ? 'disabled' : 'inherit', message: null })) } });
    const shellReads = ['/api/auth/me', '/api/settings/preferences', '/api/organizations', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count'];
    if (shellReads.includes(path)) return route.fallback();
    if (path === '/api/settings/profile') return route.fulfill({ json: { name: 'Fixture account', email: 'regression-alpha@example.test', avatar: '', phone: '', bio: '' } });
    if (path.endsWith('/profile/notification-preferences')) return route.fulfill({ json: { leadAlerts: true, campaignUpdates: true } });
    if (path === '/api/support-widget/token') return route.fulfill({ json: [
      { teamId: 51, teamName: 'Fixture customer care', token: 'synthetic-widget-key', settings: widgetSettings, installation: null },
      { teamId: 52, teamName: 'Fixture reservations', token: 'synthetic-widget-key-two', settings: widgetSettings, installation: null },
    ] });
    if (path === '/api/proposals/review-policy') return route.fulfill({ json: { policy: { requireReviewBeforeAiSend: true, enabled: false, discountThresholdPct: 10, amountThreshold: null, currency: 'USD', reviewManualPricing: true, reviewerMemberIds: [] }, reviewers: [] } });
    if (path.endsWith('/outreach/assistants/catalog')) {
      const selected = Number(request.headers()['x-business-profile-id']);
      const canManage = state.profiles.find(profile => profile.id === selected)?.role === 'owner';
      return route.fulfill({ json: { runtimeEnabled: true, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [], permissions: { canManage, description: 'Fixture workspace permissions.' } } });
    }
    if (path.endsWith('/outreach/assistants')) return route.fulfill({ json: { runtimeEnabled: true, assistants: [], nextCursor: null } });
    return route.fulfill({ json: [] });
  });
  return state;
}

test('account settings discovers a grouped canonical overview at normal desktop, tablet and narrow viewport widths', async ({ page, audit }, testInfo) => {
  const state = await installSettingsFixtures(page);
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await expect(page.getByText('Account: regression-alpha@example.test', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace configuration', exact: true }).click();
  const links = page.getByRole('region', { name: 'Workspace configuration links' });
  await expect(links.getByText('Workspace: North fixture workspace', { exact: true })).toBeVisible();
  await expect(links.getByRole('link', { name: /^Assistants/ })).toHaveAttribute('href', '/dashboard/settings/outreach');
  await expect(links.getByRole('link', { name: /^Widget settings/ })).toHaveAttribute('href', '/dashboard/support-ai/widget-settings');
  await expect(links.locator('form')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `${evidenceDirectory}/${testInfo.project.name}-overview.png`, fullPage: true });
  for (const viewport of [{ width: 768, height: 1024 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale }))).toEqual({ ...viewport, scale: 1 });
    await expectNoHorizontalOverflow(page);
    await expect(links.getByRole('link', { name: /^Widget settings/ })).toBeVisible();
    await page.screenshot({ path: `${evidenceDirectory}/${testInfo.project.name}-${viewport.width}-overview.png`, fullPage: true });
  }
  await page.getByRole('link', { name: 'Account settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Workspace support', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(state.writes).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
});

test('staff sees permitted configuration and view-only staff/assistants without owner or connection-management options', async ({ page, audit }) => {
  const state = await installSettingsFixtures(page);
  state.profiles = [{ ...north, role: 'member', canManageTeam: false }];
  state.disabled = ['outreach']; // Assistants are governed by support_ai, not outreach.
  await page.goto('/dashboard/settings/workspace');
  const links = page.getByRole('region', { name: 'Workspace configuration links' });
  await expect(links.getByRole('link', { name: /^Staff/ })).toContainText('View only');
  await expect(links.getByRole('link', { name: /^Assistants/ })).toContainText('View only');
  await expect(links.getByRole('link', { name: /^Business profile|^Integrations|^Support notifications|^Support teams/ })).toHaveCount(0);
  await links.getByRole('link', { name: /^Assistants/ }).click();
  await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Setting scope' })).toContainText('receiving account, channel and message surface');
  await expect(page.getByRole('link', { name: 'Create assistant', exact: true })).toHaveCount(0);
  await page.goto('/dashboard/settings?tab=support');
  await expect(page.getByRole('heading', { name: 'Workspace support', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace configuration links' }).getByRole('link')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(state.writes).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('billing admins keep connections but cannot manage workspace profile or support administration', async ({ page, audit }) => {
  const state = await installSettingsFixtures(page);
  state.profiles = [{ ...north, role: 'billing_admin', canManageTeam: false }];
  await page.goto('/dashboard/settings/workspace');
  const links = page.getByRole('region', { name: 'Workspace configuration links' });
  await expect(links.getByRole('link', { name: /^Integrations/ })).toHaveAttribute('href', '/dashboard/integrations');
  await expect(links.getByRole('link', { name: /^Business profile|^Support notifications|^Support teams/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('disabled modules are absent from the overview and their existing direct-route guards still deny navigation', async ({ page, audit }) => {
  const state = await installSettingsFixtures(page);
  state.disabled = ['crm', 'proposals', 'integrations', 'support_ai', 'support'];
  await page.goto('/dashboard/settings/workspace');
  const links = page.getByRole('region', { name: 'Workspace configuration links' });
  await expect(links.getByText('Workspace: North fixture workspace', { exact: true })).toBeVisible();
  await expect(links.getByRole('link', { name: /^CRM configuration|^Proposal settings|^Assistants|^Widget settings|^Integrations|^Support notifications|^Support teams/ })).toHaveCount(0);
  for (const [href, key] of [['/dashboard/crm/configuration', 'crm'], ['/dashboard/proposals/settings', 'proposals'], ['/dashboard/support-ai/widget-settings', 'support_ai'], ['/dashboard/integrations', 'integrations']] as const) {
    await page.goto(href);
    await expect(page.getByRole('heading', { name: `${key} is unavailable`, exact: true })).toBeVisible();
  }
  expect(state.writes).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('workspace chooser reloads the overview with the selected role and leaves account scope unchanged', async ({ page }) => {
  const state = await installSettingsFixtures(page);
  state.profiles = [north, south];
  await page.goto('/dashboard/settings/workspace');
  await expect(page.getByRole('region', { name: 'Workspace configuration links' }).getByRole('link', { name: /^Business profile/ })).toHaveAttribute('href', '/dashboard/business-profiles/4102');
  const showSidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole('button', { name: 'Switch business profile. Current: North fixture workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Open South fixture workspace business profile', exact: true }).click();
  await page.waitForURL('**/dashboard/home');
  await page.goto('/dashboard/settings/workspace');
  const links = page.getByRole('region', { name: 'Workspace configuration links' });
  await expect(links.getByText('Workspace: South fixture workspace', { exact: true })).toBeVisible();
  await expect(links.getByRole('link', { name: /^Staff/ })).toContainText('View only');
  await expect(links.getByRole('link', { name: /^Business profile|^Integrations|^Support notifications/ })).toHaveCount(0);
  await page.goto('/dashboard/settings');
  await expect(page.getByText('Account: regression-alpha@example.test', { exact: true })).toBeVisible();
  expect(state.reads).toContain('/api/settings/business-profiles/4103');
  expect(state.writes).toEqual([]);
});

test('existing dashboard guard withholds configuration after failed/empty workspace reads and retry recovers', async ({ page }) => {
  const state = await installSettingsFixtures(page);
  state.failProfiles = true;
  await page.goto('/dashboard/settings/workspace');
  // DashboardLayout owns the outer workspace guard and intentionally prevents
  // these pages from mounting on failed/empty reads. Preserve that boundary.
  // The overview's own loading/error/empty states have component coverage.
  const failure = page.getByRole('alert').filter({ hasText: 'Your business profile could not be loaded.' });
  await expect(failure).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace configuration links' })).toHaveCount(0);
  state.failProfiles = false;
  await failure.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace configuration links' }).getByRole('link', { name: /^Widget settings/ })).toBeVisible();
  state.profiles = [];
  await page.reload();
  await expect(failure).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace configuration links' })).toHaveCount(0);
  const showSidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole('button', { name: 'Switch business profile. Current: none', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a business profile', exact: true })).toBeVisible();
  await expect(page.getByText('No business profiles yet. Add one to get started.', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('canonical CRM, proposals and widget pages identify workspace/team/channel and preserve operational contextual links', async ({ page, audit }, testInfo) => {
  const state = await installSettingsFixtures(page);
  await page.goto('/dashboard/crm/configuration');
  await expect(page.getByRole('region', { name: 'Setting scope' })).toContainText('Workspace: North fixture workspace');
  await expect(page.getByRole('button', { name: 'Back to Contacts' })).toBeVisible();
  await page.goto('/dashboard/proposals/settings');
  await expect(page.getByRole('region', { name: 'Setting scope' })).toContainText('Proposal review and approval policy');
  await expect(page.getByRole('link', { name: '← Back to proposals' })).toBeVisible();
  await page.goto('/dashboard/support-ai/embed');
  const contextualWidgetLink = page.getByRole('link', { name: 'Customize widget', exact: true }).nth(1);
  await expect(contextualWidgetLink).toHaveAttribute('href', '/dashboard/support-ai/widget-settings?team=52');
  await contextualWidgetLink.click();
  await expect(page.getByLabel('Support team', { exact: true })).toHaveValue('52');
  await expect(page.getByRole('region', { name: 'Setting scope' })).toContainText('Website channel · support team: Fixture reservations');
  await page.getByLabel('Support team', { exact: true }).selectOption('51');
  await expect(page.getByRole('region', { name: 'Setting scope' })).toContainText('support team: Fixture customer care');
  await expect(page.getByRole('link', { name: 'Embed & integrate', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `${evidenceDirectory}/${testInfo.project.name}-widget-scope.png`, fullPage: true });
  expect(state.writes).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
