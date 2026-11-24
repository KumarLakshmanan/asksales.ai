import { type Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_WIDGET_SETTINGS } from '../../shared/supportWidgetSettings';

const preferenceKey = 'navigation:4101:sidebar';
const preferences = { open: true, sections: { crm: false, support: false, campaigns: false, 'content-agent': false, 'performance-marketing': false, settings: false, integrations: false } };
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary navigation' });

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
test.beforeEach(async ({ page, audit }) => {
  await page.addInitScript(({ key, value }) => {
    // Seed once: reload and history checks must observe real stored preferences.
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: preferenceKey, value: preferences });
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') audit.blockedMutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: route.request().method() === 'GET' ? 200 : 409, json: {} });
  });
  await installAppShellMocks(page);
  await page.route('**/api/crm/reminders', route => route.fulfill({ json: [] }));
  await page.route('**/api/crm/contacts?*', route => route.fulfill({ json: { contacts: [], total: 0, totalPages: 1 } }));
  await page.route('**/api/crm/analytics', route => route.fulfill({ json: { totalContacts: 0, winRate: 0, pipelineValueByCurrency: {} } }));
  await page.route('**/api/crm/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/support-widget/token', route => route.fulfill({ json: [{ teamId: 71, teamName: 'Fixture support team', settings: DEFAULT_WIDGET_SETTINGS }] }));
  await page.route('**/api/settings/outreach/assistants/catalog', route => route.fulfill({ json: { runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [], permissions: { canManage: false, description: 'Read-only fixture' } } }));
  await page.route('**/api/settings/outreach/assistants?*', route => route.fulfill({ json: { assistants: [], runtimeEnabled: false, nextCursor: null } }));
  await page.route('**/api/suggestions', route => route.fulfill({ json: { success: true, suggestions: [] } }));
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: {}, completedTasks: ['brand'], connectedChannels: [] } }));
});
test.afterEach(async ({ audit }) => expect(audit.blockedMutations).toEqual([]));

async function openNavigation(page: Page) {
  if (await primary(page).isHidden()) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(primary(page)).toBeVisible();
}
async function unchangedPreferences(page: Page) {
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), preferenceKey)).toEqual(preferences);
}

async function nextFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const userScrolls of [false, true]) {
  test(`delayed cold campaign link ${userScrolls ? 'preserves user scrolling' : 'reveals the exact destination'}`, async ({ page, audit }, info) => {
    await page.setViewportSize({ width: 1024, height: 720 });
    let release!: () => void;
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const requestStarted = new Promise<void>(resolve => { requested = resolve; });
    await page.route('**/api/chat/threads?*', async route => {
      requested(); await responseGate;
      await route.fulfill({ json: { threads: Array.from({ length: 10 }, (_, index) => ({ id: 500 + index, title: `Saved campaign ${500 + index}` })), total: 10 } });
    });
    await page.route('**/api/chat/threads/509', route => route.fulfill({ json: { id: 509, title: 'Saved campaign 509', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' } }));
    await page.route('**/api/chat/threads/509/messages', route => route.fulfill({ json: { messages: [], hasMore: false, nextCursor: null } }));
    await page.route('**/api/chat/threads/509/context-window', route => route.fulfill({ json: { threadId: 509, messageCount: 0, tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000, modelName: 'Fixture model', usagePercent: 0 }, summary: null, lastCompactedAt: null, canCompact: false } }));
    await page.goto('/dashboard/conversations/509');
    await requestStarted;
    const nav = primary(page);
    await expect(nav.getByRole('link', { name: 'Campaign History', exact: true }).and(nav.locator('[aria-current="location"]'))).toBeInViewport({ ratio: 1 });
    await nextFrames(page);
    // Retain an existing scroll position before the delayed rows arrive.
    await nav.evaluate(node => { node.scrollTop = 50; });
    await expect.poll(() => nav.evaluate(node => node.scrollTop)).toBe(50);
    const focused = page.getByRole('button', { name: /^Find a page in/ });
    await focused.focus();
    if (userScrolls) {
      await nav.hover(); await page.mouse.wheel(0, -500);
      await expect.poll(() => nav.evaluate(node => node.scrollTop)).toBe(0);
    }
    release();
    const current = nav.getByRole('link', { name: 'Saved campaign 509', exact: true }).and(nav.locator('[aria-current="page"]'));
    await expect(current).toBeVisible();
    if (userScrolls) {
      await nextFrames(page);
      await expect(current).not.toBeInViewport();
      expect(await nav.evaluate(node => node.scrollTop)).toBe(0);
    } else {
      await expect(current).toBeInViewport({ ratio: 1, timeout: 5000 });
      await page.screenshot({ path: info.outputPath('sidebar-delayed-campaign.png') });
    }
    await expect(focused).toBeFocused();
    await expect(nav.getByRole('button', { name: 'CRM pages' })).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('button', { name: 'Support pages' })).toHaveAttribute('aria-expanded', 'false');
    await unchangedPreferences(page);
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale }))).toEqual({ width: 1024, height: 720, scale: 1 });
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('delayed workspace verification reveals Assistants without moving focus', async ({ page, audit }, info) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings/business-profiles', async route => {
    await responseGate;
    await route.fulfill({ json: [{ id: 4102, name: 'Delayed member workspace', isDefault: true, role: 'member' }] });
  });
  await page.goto('/dashboard/settings/outreach');
  const nav = primary(page);
  await expect(nav.getByRole('link', { name: 'Settings', exact: true }).and(nav.locator('[aria-current="location"]'))).toBeInViewport({ ratio: 1 });
  await expect(nav.getByRole('link', { name: 'Assistants', exact: true })).toHaveCount(0);
  await nextFrames(page);
  const focused = page.getByRole('button', { name: /^Find a page in/ }); await focused.focus();
  release();
  const current = nav.getByRole('link', { name: 'Assistants', exact: true }).and(nav.locator('[aria-current="page"]'));
  await expect(current).toBeInViewport({ ratio: 1, timeout: 5000 });
  await expect(focused).toBeFocused();
  await unchangedPreferences(page);
  await page.screenshot({ path: info.outputPath('sidebar-delayed-assistants.png') });
  expect(audit.consoleErrors).toEqual([]);
});

test('finder reveals the destination after navigation, reload, and Back/Forward', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/home');
  const nav = primary(page);
  await expect(nav.getByRole('link', { name: 'Home', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeVisible();
  await expect(nav.getByRole('button', { name: 'CRM pages', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /^Find a page in/ }).click();
  await page.getByRole('combobox').fill('Reminders');
  await page.getByRole('option', { name: /Reminders/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/reminders$/);
  await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();
  const reminder = nav.getByRole('link', { name: 'Reminders', exact: true }).and(nav.locator('[aria-current="page"]'));
  await expect(reminder).toBeInViewport({ ratio: 1 });
  await expect(nav.getByRole('button', { name: 'CRM pages' })).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('button', { name: 'Support pages' })).toHaveAttribute('aria-expanded', 'false');
  await unchangedPreferences(page);
  await page.reload();
  await expect(reminder).toBeInViewport({ ratio: 1 });
  await unchangedPreferences(page);
  await nav.getByRole('link', { name: 'Content Creator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Content library', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Content library', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeVisible();
  await expect(nav.getByRole('button', { name: 'CRM pages' })).toHaveAttribute('aria-expanded', 'false');
  await page.goBack(); await expect(reminder).toBeInViewport({ ratio: 1 });
  await page.goForward(); await expect(nav.getByRole('link', { name: 'Content library', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeInViewport({ ratio: 1 });
  await unchangedPreferences(page);
  expect(audit.consoleErrors).toEqual([]);
});

for (const viewport of [{ width: 1311, height: 841 }, { width: 1024, height: 720 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`deep link and full contextual labels at ${viewport.width} × ${viewport.height}`, async ({ page, audit }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/dashboard/crm/reminders');
    await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();
    await openNavigation(page);
    const nav = primary(page);
    await expect(nav.getByRole('link', { name: 'Reminders', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeInViewport({ ratio: 1 });
    for (const label of ['Lead Generation', 'Content Creator', 'CRM', 'Campaign History', 'Marketing', 'Knowledge Base']) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await link.scrollIntoViewIfNeeded();
      const name = link.locator('span').last();
      expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await nav.getByRole('link', { name: 'Reminders', exact: true }).and(nav.locator('[aria-current="page"]')).scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scale: window.visualViewport?.scale }))).toEqual({ ...viewport, scale: 1 });
    await page.screenshot({ path: info.outputPath('sidebar-reminders.png') });
    await unchangedPreferences(page);
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('workspace links and native Enter/Space disclosures remain independent', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto('/dashboard/home');
  const nav = primary(page), crm = nav.getByRole('button', { name: 'CRM pages', exact: true });
  await expect(crm).toBeVisible();
  const session = await page.context().newCDPSession(page);
  const tree = await session.send('Accessibility.getFullAXTree');
  await session.detach();
  const accessibleDisclosure = tree.nodes.find(node => !node.ignored && node.name?.value === 'CRM pages' && node.role?.value === 'button');
  expect(accessibleDisclosure?.properties?.find(property => property.name === 'expanded')?.value.value).toBe(false);
  await crm.focus(); await page.keyboard.press('Enter');
  await expect(crm).toHaveAttribute('aria-expanded', 'true');
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Contacts', exact: true })).toBeFocused();
  await crm.focus(); await page.keyboard.press('Space');
  await expect(crm).toHaveAttribute('aria-expanded', 'false');
  await unchangedPreferences(page);
  await nav.getByRole('link', { name: 'CRM', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts$/);
  await expect(nav.getByRole('link', { name: 'Contacts', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeVisible();
  await crm.focus(); await page.keyboard.press('Space');
  await expect(crm).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('link', { name: 'CRM', exact: true }).and(nav.locator('[aria-current="location"]'))).toBeVisible();
  await nav.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts$/);
  await expect(nav.getByRole('link', { name: 'Contacts', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeVisible();
  await unchangedPreferences(page);
  expect(audit.consoleErrors).toEqual([]);
});

test('corrected labels open their named pages and campaign history has its own entry', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/home');
  const nav = primary(page);
  await nav.getByRole('link', { name: 'Content Creator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Content library', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Content library', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeVisible();
  await nav.getByRole('button', { name: 'Settings pages', exact: true }).click();
  await nav.getByRole('link', { name: 'Assistants', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Assistants', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeInViewport({ ratio: 1 });
  await nav.getByRole('link', { name: 'Campaign History', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/chats$/);
  await expect(page.getByRole('heading', { name: 'Campaign History', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'All Campaigns', exact: true }).and(nav.locator('[aria-current="page"]'))).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Campaign History', exact: true })).toHaveAttribute('href', '/dashboard/chats');
  expect(audit.consoleErrors).toEqual([]);
});

test('mobile navigation preserves focus, Escape, and the current destination', async ({ page, audit, isMobile }) => {
  test.skip(!isMobile, 'Requires the mobile device project.');
  await page.goto('/dashboard/crm/reminders');
  await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();
  const opener = page.getByRole('button', { name: 'Show sidebar', exact: true });
  await opener.tap();
  const dialog = page.getByRole('dialog', { name: 'Dashboard navigation' });
  await expect(dialog).toBeVisible();
  await expect(primary(page).getByRole('link', { name: 'Reminders', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Hide sidebar', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('link', { name: 'AskSales.AI', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.tap();
  await primary(page).getByRole('link', { name: 'Content Creator', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Content library', exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await opener.tap();
  await expect(primary(page).getByRole('link', { name: 'Content library', exact: true }).and(primary(page).locator('[aria-current="page"]'))).toBeInViewport({ ratio: 1 });
  await unchangedPreferences(page);
  expect(audit.consoleErrors).toEqual([]);
});

test('settings navigation honors support_ai and verified workspace roles', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.route('**/api/platform/access', route => route.fulfill({ json: { maintenance: { enabled: false, message: '' }, modules: ['content', 'outreach', 'support'].map(key => ({ key, name: key, status: 'available', mode: 'enabled', enabled: true })) } }));
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 4102, name: 'Member workspace', isDefault: true, role: 'member' }] }));
  await page.goto('/dashboard/home');
  const nav = primary(page);
  await nav.getByRole('button', { name: 'Settings pages', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Workspace config', exact: true })).toHaveAttribute('href', '/dashboard/settings/workspace');
  await expect(nav.getByRole('link', { name: 'Assistants', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Ad Settings', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Lead Settings', exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Support pages', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Teams', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Notifications', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Tickets', exact: true })).toBeVisible();
  expect(audit.consoleErrors).toEqual([]);
});

test('Widget settings navigation retains its selected team at narrow width', async ({ page, audit, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/dashboard/support-ai/widget-settings?team=71');
  await expect(page.getByRole('heading', { name: 'Widget settings', exact: true })).toBeVisible();
  await openNavigation(page);
  const widget = primary(page).getByRole('link', { name: 'Widget settings', exact: true });
  await expect(widget).toHaveAttribute('href', '/dashboard/support-ai/widget-settings?team=71');
  await expect(widget).toHaveAttribute('aria-current', 'page');
  await expect(widget).toBeInViewport({ ratio: 1 });
  await widget.click();
  await expect(page).toHaveURL(/\/dashboard\/support-ai\/widget-settings\?team=71$/);
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});
