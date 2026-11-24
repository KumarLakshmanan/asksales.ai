import path from 'node:path';
import { test, expect, installAppShellMocks, expectNoHorizontalOverflow } from './fixtures/app';

const campaignTitle = 'QA TEST 2026-10-26 — Create a draft-only campaign plan for fictional Example Analytics with a long campaign title';
const evidence = (name: string) => path.resolve('../qa-results/2026-10-26/responsive-ui', name);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-responsive-header-qa');
    localStorage.setItem('selectedBusinessProfileId', '4102');
  });
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
  await page.route('**/api/proposals?*', route => route.fulfill({ json: { success: true, data: { proposals: [], total: 0, totalPages: 1 } } }));
  await page.route('**/api/proposals/analytics', route => route.fulfill({ json: { success: true, data: { total: 0, sent: 0, viewed: 0, accepted: 0, rejected: 0, acceptanceRate: 0 } } }));
  await page.route('**/api/proposals/sources?*', route => route.fulfill({ json: { contacts: [], conversations: [], tickets: [] } }));
  await page.route('**/api/proposals/brand', route => route.fulfill({ json: {} }));
  await page.route('**/api/proposals/onboarding-resources', route => route.fulfill({ json: { teams: [], members: [] } }));
});

for (const width of [390, 615, 914, 1440]) {
  test(`proposal header reflows without squeezing its title at ${width}px`, async ({ page, audit }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard/proposals');
    const title = page.getByRole('heading', { name: 'Proposals', exact: true });
    const subtitle = page.getByText('Turn customer context into offers, decisions, and onboarding', { exact: true });
    const header = title.locator('../..').locator('..');
    await expect(title).toBeVisible();
    const subtitleBounds = (await subtitle.boundingBox())!;
    const headerBounds = (await header.boundingBox())!;
    // The title has room to read before actions use a separate row.
    expect(subtitleBounds.width).toBeGreaterThan(Math.min(280, headerBounds.width - 60));
    for (const name of ['Proposal settings', 'Catalog', 'Templates', 'Analytics', 'New proposal']) {
      const button = header.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(headerBounds.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(headerBounds.x + headerBounds.width + 1);
      if (width <= 914) expect(box.y).toBeGreaterThanOrEqual(subtitleBounds.y + subtitleBounds.height);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: evidence(`proposals-${width}.png`) });
    const loadedSources = page.waitForResponse(response => new URL(response.url()).pathname === '/api/proposals/sources' && response.status() === 200);
    await header.getByRole('button', { name: 'New proposal', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/proposals\/new$/);
    await loadedSources;
    await expect(page.getByRole('combobox', { name: 'Proposal source', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Send readiness', exact: true })).toBeVisible();
    expect(audit.consoleErrors).toEqual([]);
  });

  test(`campaign view switch stays below long header text at ${width}px`, async ({ page, audit }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/chat/threads/42', route => route.fulfill({ json: { id: 42, title: campaignTitle, businessId: 4102, metadata: {} } }));
    await page.route('**/api/chat/threads/42/messages', route => route.fulfill({ json: { messages: [], hasMore: false, nextCursor: null } }));
    await page.route('**/api/chat/threads/42/turns', route => route.fulfill({ json: { success: true, data: [] } }));
    await page.route('**/api/chat/threads/42/tabs', route => route.fulfill({ json: [{ tabId: 'overview-42', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: true }] }));
    await page.route('**/api/chat/threads/42/overview', route => route.fulfill({ json: { thread: { id: 42, title: campaignTitle }, stats: {}, activeAgents: [], workflowExecutions: [], timeline: [] } }));
    await page.route('**/api/chat/threads/42/context-window', route => route.fulfill({ json: {
      threadId: 42, messageCount: 0, canCompact: false, summary: null, lastCompactedAt: null,
      tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0,
        estimatedCurrentContextTokens: 0, usagePercent: 0, maxContextTokens: 128000, modelName: 'Synthetic QA model' },
    } }));
    await page.goto('/dashboard/conversations/42');
    const title = page.getByRole('heading', { name: campaignTitle, exact: true });
    await expect(title).toBeVisible();
    const views = page.getByRole('navigation', { name: `${campaignTitle} views`, exact: true });
    await expect(views).toBeVisible();
    const header = title.locator('xpath=ancestor::header');
    const subtitle = header.getByText(/Updated |Last activity |No activity yet/);
    const subtitleBounds = (await subtitle.boundingBox())!;
    const viewsBounds = (await views.boundingBox())!;
    expect(viewsBounds.y).toBeGreaterThanOrEqual(subtitleBounds.y + subtitleBounds.height);
    const titleBounds = (await title.boundingBox())!;
    for (const control of await header.locator('[aria-label="Campaign agents"], [aria-label="Manage agents"], [aria-label="Search workspace views"]').all()) {
      const box = (await control.boundingBox())!;
      const intersectsTitle = box.x < titleBounds.x + titleBounds.width && box.x + box.width > titleBounds.x
        && box.y < titleBounds.y + titleBounds.height && box.y + box.height > titleBounds.y;
      expect(intersectsTitle).toBe(false);
      expect(viewsBounds.y).toBeGreaterThanOrEqual(box.y + box.height);
    }
    await views.getByRole('button', { name: 'Campaign', exact: true }).click();
    await expect(views.getByRole('button', { name: 'Campaign', exact: true })).toHaveAttribute('aria-current', 'page');
    await views.getByRole('button', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(views.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: evidence(`campaign-${width}.png`) });
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('proposal actions respond to a narrow content pane inside a wide viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard/proposals');
  const title = page.getByRole('heading', { name: 'Proposals', exact: true });
  await expect(title).toBeVisible();
  const header = title.locator('../../..');
  await header.locator('..').evaluate(node => { (node as HTMLElement).style.maxWidth = '615px'; });
  const subtitle = (await header.getByText('Turn customer context into offers, decisions, and onboarding', { exact: true }).boundingBox())!;
  const action = (await header.getByRole('button', { name: 'Proposal settings', exact: true }).boundingBox())!;
  expect(action.y).toBeGreaterThanOrEqual(subtitle.y + subtitle.height);
  expect(subtitle.width).toBeGreaterThan(280);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: evidence('proposals-narrow-pane-desktop.png') });
});

test('empty lead submission gives persistent inline errors and focuses the missing information', async ({ page }) => {
  await page.setViewportSize({ width: 615, height: 900 });
  let saves = 0;
  let savedPayload: Record<string, unknown> | undefined;
  await page.route('**/api/leads', route => {
    if (route.request().method() === 'POST') {
      saves++;
      savedPayload = route.request().postDataJSON();
    }
    return route.fulfill({ json: { id: 99 } });
  });
  await page.goto('/dashboard/leads/new?returnTo=/dashboard/leads');
  await page.getByRole('button', { name: 'Create lead', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('Review the highlighted contact information');
  await expect(page.getByLabel('Display name', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Email', { exact: true })).toHaveAccessibleDescription(/Add at least one contact method/);
  expect(saves).toBe(0);
  await page.screenshot({ path: evidence('lead-validation-615.png') });
  await page.getByLabel('Display name', { exact: true }).fill('Synthetic QA contact');
  await expect(page.getByLabel('Display name', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  // The bottom action must offer the same feedback, even after scrolling.
  await page.getByRole('button', { name: 'Create lead', exact: true }).last().click();
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  expect(saves).toBe(0);
  await page.getByLabel('Phone', { exact: true }).fill('+14155550123');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Email', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Create lead', exact: true }).first().click();
  await expect(page).toHaveURL(/\/dashboard\/leads\/view\/99$/);
  expect(saves).toBe(1);
  expect(savedPayload).toMatchObject({ name: 'Synthetic QA contact', phone: '+14155550123', email: null, source: 'manual' });
});
