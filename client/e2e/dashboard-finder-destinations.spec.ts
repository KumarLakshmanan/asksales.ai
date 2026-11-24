import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_WIDGET_SETTINGS } from '../src/lib/support-widget-settings';
import { availableNavigationSections } from '../src/lib/sidebarConfig';
import { assertOnlyIntentionalWidgetCleanup, classifyWidgetRequestFailures, installWidgetRequestAudit } from './helpers/widget-request-audit';

test.use({ launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH } });

const shellReads = new Set(['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/organizations', '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/chat/threads', '/api/notifications/unread/count']);
let reads: { path: string; business: string | undefined }[];
let pageErrors: string[];
let canManage: boolean;
let widgetRequests: Awaited<ReturnType<typeof installWidgetRequestAudit>>;

// Every API call stays in this fixture; every write fails before a backend can
// receive it. Destination navigation must never start generation or delivery.
test.beforeEach(async ({ page, audit }) => {
  reads = []; pageErrors = []; canManage = true;
  widgetRequests = await installWidgetRequestAudit(page);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Finder journey blocks every mutation.' } });
    }
    reads.push({ path: url.pathname, business: request.headers()['x-business-profile-id'] });
    if (shellReads.has(url.pathname)) return route.fallback();
    if (url.pathname === '/api/content/templates') return route.fulfill({ json: { templates: [], total: 0 } });
    if (url.pathname === '/api/content/assets' || url.pathname === '/api/sent-messages') return route.fulfill({ json: [] });
    if (url.pathname === '/api/content/brand-toolkits') return route.fulfill({ json: [{ id: 4103, name: 'Synthetic brand', isDefault: true, isApproved: true }] });
    if (url.pathname === '/api/content/studio/estimates') {
      const estimate = { credits: null, ready: false, basis: 'Synthetic provider is unconfigured' };
      return route.fulfill({ json: { text: estimate, image: estimate, video: estimate } });
    }
    if (url.pathname === '/api/settings/outreach/assistants/catalog') return route.fulfill({ json: {
      runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
      permissions: { canManage, description: canManage ? 'Synthetic owner' : 'Synthetic read-only member' },
    } });
    if (url.pathname === '/api/settings/outreach/assistants') return route.fulfill({ json: { assistants: [], runtimeEnabled: false, nextCursor: null } });
    if (url.pathname === '/api/support-widget/token') return route.fulfill({ json: [
      { teamId: 4104, teamName: 'Synthetic support team', settings: DEFAULT_WIDGET_SETTINGS },
      { teamId: 4105, teamName: 'Second synthetic support team', settings: DEFAULT_WIDGET_SETTINGS },
    ] });
    if (url.pathname.endsWith('/follow-ups')) return route.fulfill({ json: { enableAutoFollowUp: false, followUpSteps: [{ delayHours: 24, templateId: null }] } });
    if (url.pathname === '/api/campaigns/analytics/dashboard') return route.fulfill({ json: { campaigns: [], dailyTrends: [], currency: 'USD', availableCurrencies: ['USD'] } });
    if (url.pathname === '/api/campaigns/accounts') return route.fulfill({ json: { accounts: [] } });
    if (url.pathname === '/api/campaigns/creative-intelligence/capabilities') return route.fulfill({ json: { enabled: false, commercialLibraryCountries: [] } });
    if (url.pathname === '/api/campaigns/creative-intelligence/briefs') return route.fulfill({ json: [] });
    if (url.pathname === '/api/meta/oauth/platforms') return route.fulfill({ json: { platforms: [] } });
    if (url.pathname.includes('/campaigns/meta/') || url.pathname === '/api/campaigns/autonomous') return route.fulfill({ json: { campaigns: [], lastRefreshedAt: null } });
    return route.fulfill({ json: {} });
  });
});

test.afterEach(async ({ audit, page }, testInfo) => {
  await widgetRequests.flush();
  const classification = classifyWidgetRequestFailures(widgetRequests.audit);
  await testInfo.attach('finder-network-audit', { body: JSON.stringify({ viewport: page.viewportSize(), reads, audit, expectedCancellations: classification.expected, requestIdentityAudit: widgetRequests.audit, unexpectedFailures: classification.unexpected, pageErrors }, null, 2), contentType: 'application/json' });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  // Compare every failure event, retaining duplicates, before enforcing the
  // identity-based policy. A matching URL/string can never erase another event.
  expect(audit.failedRequests).toEqual(widgetRequests.audit.failures.map(failure => `${failure.method} ${failure.url}: ${failure.error}`));
  assertOnlyIntentionalWidgetCleanup(widgetRequests.audit);
  expect(pageErrors).toEqual([]);
});

async function openFinder(page: Page, query: string, href?: string, parent?: string) {
  await page.getByRole('button', { name: 'Find a page in Regression Company', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Search AskSales.AI', exact: true });
  const input = dialog.getByRole('combobox', { name: 'Search pages, actions, and settings', exact: true });
  await expect(input).toBeFocused();
  await expect(dialog.getByText('Pages in Regression Company', { exact: true })).toBeVisible();
  await input.fill(query);
  if (href) {
    const first = dialog.getByRole('option').first();
    await expect(first).toHaveAttribute('data-value', href);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    if (parent) {
      const context = first.getByText(parent, { exact: true });
      await expect(context).toBeVisible(); await expect(context).toBeInViewport({ ratio: 1 });
      expect(await context.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
  }
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  return { dialog, input };
}

async function findAndOpen(page: Page, query: string, href: string, parent?: string) {
  const { input, dialog } = await openFinder(page, query, href, parent);
  await input.press('Enter'); await expect(dialog).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(href);
}

test('Blog, Email and DM task queries open their libraries with context and keyboard focus', async ({ page }, testInfo) => {
  await page.goto('/dashboard/saved-templates');
  await expect(page.getByRole('heading', { name: 'Content library', exact: true })).toBeVisible();
  for (const query of ['blog', 'blog posts']) {
    const { input, dialog } = await openFinder(page, query, '/dashboard/saved-templates/blog', 'Content Creator / Content library');
    await dialog.screenshot({ path: testInfo.outputPath(`finder-${query.replace(' ', '-')}.png`) });
    await input.press('Escape');
    await expect(page.getByRole('button', { name: 'Find a page in Regression Company', exact: true })).toBeFocused();
  }
  for (const [query, href, heading] of [
    ['blog posts', '/dashboard/saved-templates/blog', 'Blog posts'],
    ['email library', '/dashboard/saved-templates/email', 'Email templates'],
    ['dm library', '/dashboard/saved-templates/dm', 'Social DM templates'],
  ]) {
    await findAndOpen(page, query, href, 'Content Creator / Content library');
    await expect(page.getByRole('main').getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  expect(reads.filter(read => ['/api/content/templates', '/api/content/assets'].includes(read.path)).every(read => read.business === '4102')).toBe(true);
});

test('Follow-ups and history, widget settings and assistants open real task destinations', async ({ page }) => {
  await page.goto('/dashboard/saved-templates');
  await findAndOpen(page, 'follow-ups', '/dashboard/outreach/follow-ups', 'Outreach');
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await findAndOpen(page, 'follow-up history', '/dashboard/outreach/follow-ups?tab=history', 'Outreach / Follow-ups');
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Follow-up history', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/tab=settings/);
  await findAndOpen(page, 'follow-up history', '/dashboard/outreach/follow-ups?tab=history', 'Outreach / Follow-ups');
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
  await findAndOpen(page, 'widget settings', '/dashboard/support-ai/widget-settings', 'Workspace configuration / Customer support & replies / Support team');
  await expect(page.getByRole('heading', { name: 'Widget settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Support team', exact: true })).toHaveValue('4104');
  await page.goto('/dashboard/support-ai/widget-settings?team=4105');
  await expect(page.getByRole('combobox', { name: 'Support team', exact: true })).toHaveValue('4105');
  await findAndOpen(page, 'widget configuration', '/dashboard/support-ai/widget-settings?team=4105', 'Workspace configuration / Customer support & replies / Support team');
  await expect(page.getByRole('combobox', { name: 'Support team', exact: true })).toHaveValue('4105');
  await page.goto('/dashboard/saved-templates?team=4105&tab=appearance');
  await findAndOpen(page, 'widget settings', '/dashboard/support-ai/widget-settings?team=4105', 'Workspace configuration / Customer support & replies / Support team');
  await expect(page.getByRole('combobox', { name: 'Support team', exact: true })).toHaveValue('4105');
  await findAndOpen(page, 'Outreach Settings', '/dashboard/settings/outreach', 'Workspace configuration / Customer support & replies');
  await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
  expect(reads.filter(read => ['/api/settings/outreach/assistants/catalog', '/api/support-widget/token', '/api/sent-messages'].includes(read.path)).every(read => read.business === '4102')).toBe(true);
});

test('Unrelated signal and transport aborts at the identical widget URL stay fatal', async ({ page, context, audit }, testInfo) => {
  await page.goto('/dashboard/saved-templates');
  let releaseWidgetReads!: () => void;
  const heldWidgetReads = new Promise<void>(resolve => { releaseWidgetReads = resolve; });
  await page.route('**/api/support-widget/token', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Pending-read probe blocks every mutation.' } });
    }
    reads.push({ path: new URL(request.url()).pathname, business: request.headers()['x-business-profile-id'] });
    await heldWidgetReads;
    await route.fulfill({ json: [{ teamId: 4104, teamName: 'Synthetic support team', settings: DEFAULT_WIDGET_SETTINGS }] });
  });
  try {
    await findAndOpen(page, 'widget settings', '/dashboard/support-ai/widget-settings');
    await expect(page.getByRole('heading', { name: 'Widget settings', exact: true })).toBeVisible();
    await expect.poll(() => widgetRequests.audit.requests.filter(request => !widgetRequests.audit.events.some(event => event.operationId === request.operationId && event.stage === 'signal-abort')).length).toBeGreaterThan(0);
    await findAndOpen(page, 'assistants', '/dashboard/settings/outreach');
    await expect.poll(() => classifyWidgetRequestFailures(widgetRequests.audit).expected.length).toBeGreaterThan(0);
  } finally {
    releaseWidgetReads();
  }
  await widgetRequests.flush();
  const cleanup = assertOnlyIntentionalWidgetCleanup(widgetRequests.audit).expected[0];
  const probePage = await context.newPage();
  const probe = await installWidgetRequestAudit(probePage);
  const probeWrites: string[] = [];
  let releaseProbe!: () => void;
  const heldProbe = new Promise<void>(resolve => { releaseProbe = resolve; });
  await probePage.route('**/finder-cancellation-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated cancellation identity probe</title>' }));
  await probePage.route('**/api/**', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      probeWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Probe blocks every mutation.' } });
    }
    if (request.headers()['x-finder-probe-kind'] === 'unrelated-signal') {
      await heldProbe;
      return route.fulfill({ json: [] });
    }
    return route.abort('aborted');
  });
  try {
    await probePage.goto(new URL('/finder-cancellation-probe', page.url()).href);
    await probePage.evaluate(url => {
      const browser = window as typeof window & { __unrelatedFinderController: AbortController };
      browser.__unrelatedFinderController = new AbortController();
      void fetch(url, { signal: browser.__unrelatedFinderController.signal, headers: { 'x-finder-probe-kind': 'unrelated-signal' } }).catch(() => {});
    }, cleanup.url);
    await expect.poll(() => probe.audit.requests.length).toBe(1);
    await probePage.evaluate(() => {
      (window as typeof window & { __unrelatedFinderController: AbortController }).__unrelatedFinderController.abort();
    });
    await expect.poll(() => probe.audit.failures.length).toBe(1);
    await probePage.evaluate(url => { void fetch(url, { headers: { 'x-finder-probe-kind': 'transport' } }).catch(() => {}); }, cleanup.url);
    await expect.poll(() => probe.audit.failures.length).toBe(2);
    await probe.flush();
    expect(probe.audit.failures.map(failure => [failure.method, failure.url, failure.error])).toEqual([
      ['GET', cleanup.url, 'net::ERR_ABORTED'], ['GET', cleanup.url, 'net::ERR_ABORTED'],
    ]);
    expect(new Set(probe.audit.failures.map(failure => failure.operationId)).size).toBe(2);
    const combined = {
      requests: [...widgetRequests.audit.requests, ...probe.audit.requests],
      failures: [...widgetRequests.audit.failures, ...probe.audit.failures],
      events: [...widgetRequests.audit.events, ...probe.audit.events],
    };
    const classification = classifyWidgetRequestFailures(combined);
    expect(classification.expected).toContainEqual(cleanup);
    expect(classification.unexpected).toEqual(probe.audit.failures);
    expect(() => assertOnlyIntentionalWidgetCleanup(combined)).toThrow('Unmatched request failures');
    expect(probeWrites).toEqual([]);
    expect(await probePage.evaluate(() => window.visualViewport?.scale)).toBe(1);
    await testInfo.attach('finder-negative-cancellation-audit', { body: JSON.stringify({ viewport: probePage.viewportSize(), probeWrites, probe: probe.audit, classification }, null, 2), contentType: 'application/json' });
  } finally {
    releaseProbe();
    await probePage.close();
  }
});

test('A genuine widget transport rejection stays fatal after later ordinary cleanup', async ({ page, context }, testInfo) => {
  await page.goto('/dashboard/saved-templates');
  const probePage = await context.newPage();
  const probe = await installWidgetRequestAudit(probePage);
  const probeWrites: string[] = [];
  const probeReads: { path: string; business: string | undefined }[] = [];
  const probeConsoleErrors: string[] = [];
  const probePageErrors: string[] = [];
  probePage.on('console', message => { if (message.type() === 'error') probeConsoleErrors.push(message.text()); });
  probePage.on('pageerror', error => probePageErrors.push(error.message));
  let transportOperationId: string | null = null;
  let releaseReads!: () => void;
  const heldReads = new Promise<void>(resolve => { releaseReads = resolve; });
  await installAppShellMocks(probePage);
  await probePage.routeWebSocket(/\/api\//, () => {});
  await probePage.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      probeWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Settlement probe blocks every mutation.' } });
    }
    probeReads.push({ path, business: request.headers()['x-business-profile-id'] });
    if (shellReads.has(path)) return route.fallback();
    if (path === '/api/support-widget/token') {
      await heldReads;
      if (request.headers()['x-finder-widget-read-id'] === transportOperationId) return route.abort('aborted');
      return route.fulfill({ json: [{ teamId: 4104, teamName: 'Synthetic support team', settings: DEFAULT_WIDGET_SETTINGS }] });
    }
    if (path.endsWith('/assistants/catalog')) return route.fulfill({ json: {
      runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
      permissions: { canManage: true, description: 'Synthetic owner' },
    } });
    if (path.endsWith('/assistants')) return route.fulfill({ json: { assistants: [], runtimeEnabled: false, nextCursor: null } });
    return route.fulfill({ json: {} });
  });
  try {
    await probePage.goto(new URL('/dashboard/support-ai/widget-settings', page.url()).href);
    await expect(probePage.getByRole('heading', { name: 'Widget settings', exact: true })).toBeVisible();
    const pendingRequests = () => probe.audit.requests.filter(request => probe.audit.events.some(event => event.operationId === request.operationId && event.stage === 'fetch-start')
      && !probe.audit.events.some(event => event.operationId === request.operationId && event.stage !== 'fetch-start'));
    await expect.poll(() => pendingRequests().length).toBeGreaterThan(0);
    transportOperationId = pendingRequests()[0].operationId;
    expect(transportOperationId).not.toBeNull();
    releaseReads();
    await expect.poll(() => probe.audit.events.filter(event => event.operationId === transportOperationId && event.stage === 'fetch-rejected').length).toBe(1);
    await expect.poll(() => probe.audit.failures.filter(failure => failure.operationId === transportOperationId).length).toBe(1);
    await probe.flush();
    const failedRead = probe.audit.failures.find(failure => failure.operationId === transportOperationId)!;
    const beforeCleanup = classifyWidgetRequestFailures(probe.audit);
    expect(beforeCleanup.unexpected).toEqual([failedRead]);
    expect(probe.audit.events.filter(event => event.operationId === transportOperationId && event.stage === 'signal-abort')).toEqual([]);
    expect(() => assertOnlyIntentionalWidgetCleanup(probe.audit)).toThrow(failedRead.networkRequestId);

    await findAndOpen(probePage, 'assistants', '/dashboard/settings/outreach');
    await expect(probePage.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
    await expect.poll(() => probe.audit.events.filter(event => event.operationId === transportOperationId && event.stage === 'signal-abort').length).toBe(1);
    await probe.flush();
    const operationEvents = probe.audit.events.filter(event => event.operationId === transportOperationId);
    const start = operationEvents.find(event => event.stage === 'fetch-start')!;
    const rejection = operationEvents.find(event => event.stage === 'fetch-rejected')!;
    const cleanup = operationEvents.find(event => event.stage === 'signal-abort')!;
    expect(rejection.errorName).toBe('TypeError');
    expect(rejection.sequence).toBeLessThan(cleanup.sequence);
    expect(failedRead.observedSequence).toBeLessThan(cleanup.observedSequence);
    expect(cleanup.fetchState).toBe('rejected');
    expect(cleanup.controllerId).toBe(start.controllerId);
    expect(cleanup.signalId).toBe(start.signalId);
    for (const proof of [start.createdSource, start.fetchSource, cleanup.abortSource]) {
      expect(proof?.moduleId).toContain('client/src/app/dashboard/(main)/support-ai/widget-settings/page.tsx [app-client]');
    }
    const afterCleanup = classifyWidgetRequestFailures(probe.audit);
    expect(afterCleanup.unexpected).toEqual([failedRead]);
    expect(() => assertOnlyIntentionalWidgetCleanup(probe.audit)).toThrow(failedRead.networkRequestId);
    expect(probeWrites).toEqual([]);
    expect(probePageErrors).toEqual([]);
    expect(probeConsoleErrors.filter(error => error !== 'Failed to load resource: net::ERR_ABORTED')).toEqual([]);
    expect(probeReads.filter(read => read.path === '/api/support-widget/token').every(read => read.business === '4102')).toBe(true);
    expect(await probePage.evaluate(() => window.visualViewport?.scale)).toBe(1);
    await testInfo.attach('finder-negative-settlement-audit', { body: JSON.stringify({ viewport: probePage.viewportSize(), probeWrites, probeReads, probeConsoleErrors, probePageErrors, failedRead, beforeCleanup, afterCleanup, probe: probe.audit }, null, 2), contentType: 'application/json' });
  } finally {
    releaseReads();
    await probePage.close();
  }
});

test('Paid Ads aliases select only the four accepted tabs', async ({ page }) => {
  const marketingSection = availableNavigationSections(['performance_marketing'], 'owner')
    .find(section => section.section === 'performance-marketing');
  expect(marketingSection).toBeDefined();
  await page.goto('/dashboard/saved-templates');
  for (const [query, tab, label] of [
    ['paid ads overview', 'overview', 'Overview'], ['ads campaigns', 'campaigns', 'Campaigns'],
    ['paid ads recommendations', 'recommendations', 'Recommendations'], ['ads activity', 'automation', 'Automation & activity'],
  ]) {
    await findAndOpen(page, query, `/dashboard/ads?tab=${tab}`, `${marketingSection!.label} / Paid Ads`);
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Paid Ads', exact: true })).toBeVisible();
  }
});

test('Form-entry aliases open editors without generation, sends, publishing or assistant creation', async ({ page }) => {
  await page.goto('/dashboard/saved-templates');
  for (const [query, href, heading] of [
    ['new blog post', '/dashboard/saved-templates/blog/generate', 'Blog generation'],
    ['generate email', '/dashboard/saved-templates/email/generate', 'Email generation'],
    ['new dm template', '/dashboard/saved-templates/dm/generate', 'DM generation'],
    ['new assistant', '/dashboard/settings/outreach/new', 'Create assistant'],
  ]) {
    await findAndOpen(page, query, href);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('Assistant name', { exact: true })).toHaveValue('');
});

test('A read-only member cannot discover the owner-only assistant entry; disabled modules stay hidden', async ({ page }) => {
  canManage = false;
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [
    { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'member' },
  ] }));
  await page.route('**/api/platform/access', route => route.fulfill({ json: { maintenance: { enabled: false, message: '' }, modules: [
    { key: 'content', name: 'Content', enabled: true, status: 'available', mode: 'enabled' },
    { key: 'support_ai', name: 'Support AI', enabled: true, status: 'available', mode: 'enabled' },
    { key: 'integrations', name: 'Integrations', enabled: true, status: 'available', mode: 'enabled' },
  ] } }));
  await page.goto('/dashboard/saved-templates');
  const { input } = await openFinder(page, 'assistants', '/dashboard/settings/outreach');
  await expect.poll(() => reads.filter(read => read.path.endsWith('/assistants/catalog')).length).toBeGreaterThan(0);
  await input.fill('create assistant'); await expect(page.getByText('No results found', { exact: true })).toBeVisible();
  await input.fill('integrations'); await expect(page.getByRole('option', { name: /^Integrations —/ })).toHaveCount(0);
  for (const query of ['follow-ups', 'paid ads recommendations', 'LinkedIn', 'Twitter', 'AI Studio', 'Approvals']) {
    await input.fill(query); await expect(page.getByText('No results found', { exact: true })).toBeVisible();
  }
  await input.fill('widget settings'); await expect(page.getByRole('option').first()).toHaveAttribute('data-value', '/dashboard/support-ai/widget-settings');
});

test('At an actual 320 × 568 viewport, Pipeline parents stay readable through keyboard and no-result recovery', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/dashboard/saved-templates');
  const trigger = page.getByRole('button', { name: 'Find a page in Regression Company', exact: true });
  await trigger.focus(); await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Search pages, actions, and settings', exact: true });
  await expect(input).toBeFocused(); await input.fill('pipeline');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  for (const parent of ['CRM', 'Support']) {
    const context = options.getByText(parent, { exact: true });
    await expect(context).toBeVisible(); await expect(context).toBeInViewport({ ratio: 1 });
  }
  await input.press('ArrowDown'); await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp'); await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('finder-pipeline-320x568.png') });
  await input.fill('zzzz-no-destination-98765'); await expect(page.getByText('No results found', { exact: true })).toBeVisible();
  await input.press('ControlOrMeta+a'); await input.press('Backspace'); await expect(input).toHaveValue(''); await expect(input).toBeFocused();
  await input.fill('follow-up history'); await expect(options.first()).toHaveAttribute('data-value', '/dashboard/outreach/follow-ups?tab=history');
  await expect(options.first().getByText('Outreach / Follow-ups', { exact: true })).toBeInViewport({ ratio: 1 });
  await input.fill('widget settings'); await expect(options.first()).toHaveAttribute('data-value', '/dashboard/support-ai/widget-settings');
  const widgetContext = options.first().getByText('Workspace configuration / Customer support & replies / Support team', { exact: true });
  await expect(widgetContext).toBeInViewport({ ratio: 1 });
  expect(await widgetContext.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('finder-widget-320x568.png') });
  await expectNoHorizontalOverflow(page); expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await input.press('Escape'); await expect(trigger).toBeFocused();
});
