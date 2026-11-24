import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { documentationArticles } from '../src/content/documentation';

const guide = '/dashboard/documentation';

test.beforeEach(async ({ page }) => {
  // The shell uses synthetic sessions/providers. No request can reach an API
  // mutation, including if a future guide accidentally introduces one.
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      await route.fulfill({ status: 409, json: { error: 'Documentation is read-only.' } });
      throw new Error(`Unexpected mutation: ${route.request().method()} ${route.request().url()}`);
    }
    await route.fallback();
  });
});

test('authenticated guide supports search, no-results recovery and topic navigation', async ({ page }, info) => {
  await page.goto(guide);
  await expect(page.getByRole('heading', { name: 'Learn your workspace' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search documentation' });
  await search.fill('held work');
  await expect(page.getByRole('heading', { name: 'Search documentation', exact: true })).toBeVisible();
  const results = page.getByRole('region', { name: 'Documentation search results' });
  await expect(results.getByRole('link').first()).toBeVisible();
  await search.fill('no-such-topic-9z');
  await expect(page.getByText(/No topics match/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('link', { name: 'Read Getting started', exact: true }).click();
  await expect(page).toHaveURL(`${guide}/getting-started`);
  await expect(page.getByRole('heading', { name: 'Getting started', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('getting-started.png'), fullPage: true });
});

test('every topic and diagram loads in the deployed route structure', async ({ page, audit }, info) => {
  test.setTimeout(240_000);
  const mutations: string[] = [];
  page.on('request', request => { if (/\/api\//.test(request.url()) && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
  for (const article of documentationArticles) {
    await page.goto(`${guide}/${article.slug}`);
    await expect(page.getByRole('heading', { name: article.title, exact: true })).toBeVisible();
    for (const section of article.sections) {
      await expect(page.locator(`#${section.id}`)).toHaveCount(1);
      if (section.diagram) {
        const image = page.getByRole('img', { name: section.diagram.description, exact: true });
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
      }
    }
    await expectNoHorizontalOverflow(page);
  }
  expect(mutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests.filter(item => !item.includes('net::ERR_ABORTED'))).toEqual([]);
  await page.goto(`${guide}/assistants#delivery-block`);
  await expect(page.getByText('Customer delivery is blocked while assistant runtime is disabled.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('assistants-gate.png'), fullPage: true });
  await page.getByRole('img').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('assistant-diagram.png'), fullPage: true });
});

test('small screens keep diagrams and tables inside named keyboard-scroll regions', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${guide}/integrations`);
  await expect(page.getByRole('heading', { name: 'Channels, accounts and integrations', exact: true })).toBeVisible();
  const table = page.getByRole('region', { name: 'Reference table, scroll horizontally if needed' });
  await table.scrollIntoViewIfNeeded();
  await expect(table).toHaveAttribute('tabindex', '0');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('mobile-table-320.png'), fullPage: true });
  await page.goto(`${guide}/manual-follow-ups`);
  const diagram = page.getByRole('region', { name: /Campaign and batch isolation, scroll/ });
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram).toHaveAttribute('tabindex', '0');
  await diagram.focus();
  await expect(diagram).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('mobile-diagram-320.png'), fullPage: true });
});

test('member session can read generic help without administrator action links', async ({ page }) => {
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 4102, name: 'Synthetic member business', isDefault: true, role: 'member' }] }));
  await page.goto(`${guide}/integrations`);
  await expect(page.getByRole('heading', { name: 'Channels, accounts and integrations', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open All Integrations' })).toHaveCount(0);
  await page.goto(`${guide}/support`);
  await expect(page.getByRole('link', { name: 'Open Teams', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open Tickets', exact: true })).toBeVisible();
});

test('existing dashboard authentication and module restrictions remain in force', async ({ page }) => {
  await page.route('**/api/platform/access', route => route.fulfill({ json: { maintenance: { enabled: false, message: '' }, modules: [] } }));
  await page.goto(`${guide}/assistants`);
  await expect(page.getByRole('heading', { name: 'Assistants and delivery readiness', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Assistants', exact: true })).toHaveCount(0);
  await page.goto('/dashboard/outreach/inbox');
  await expect(page.getByRole('heading', { name: /unavailable/i })).toBeVisible();
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Synthetic signed-out session' } }));
  await page.goto(`${guide}/assistants`);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Assistants and delivery readiness', exact: true })).toHaveCount(0);
});

test('contextual help and concise runtime notice retain the actual delivery block', async ({ page }, info) => {
  await page.route('**/api/settings/outreach/assistants?*', route => route.fulfill({ json: { assistants: [], nextCursor: null, runtimeEnabled: false } }));
  await page.goto('/dashboard/settings/outreach');
  await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
  const notice = page.getByRole('status').filter({ hasText: 'Customer delivery is blocked:' });
  await expect(notice).toContainText('assistant runtime is disabled');
  await expect(notice.getByRole('link', { name: 'Documentation', exact: true })).toHaveAttribute('href', `${guide}/assistants#delivery-block`);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('assistants-concise-notice.png'), fullPage: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    // The shell clips horizontal overflow, so also inspect the actual header.
    expect(await page.locator('header').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Documentation for this page' })).toBeVisible();
  await page.keyboard.press('Escape');
  await notice.getByRole('link').click();
  await expect(page).toHaveURL(`${guide}/assistants#delivery-block`);
  await expect(page.getByText('Setup does not automatically replay held work.')).toBeVisible();
});

test('TOC anchors work in dark mode and unknown topics have a recovery link', async ({ page }, info) => {
  await page.goto(`${guide}/manual-follow-ups`);
  await expect(page.getByRole('heading', { name: 'Campaign manual follow-ups', exact: true })).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Reuse for another batch or revise unsent enrollments' }).click();
  await expect(page).toHaveURL(/#reuse-and-revision$/);
  await expect(page.getByRole('heading', { name: 'Reuse for another batch or revise unsent enrollments', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('dark-mode-guide.png'), fullPage: true });
  await page.goto(`${guide}/unknown-topic`);
  await expect(page.getByRole('heading', { name: 'Documentation topic not found', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse documentation', exact: true })).toHaveAttribute('href', guide);
  await expect(page.getByRole('heading', { name: 'Learn your workspace', exact: true })).toHaveCount(0);
});
