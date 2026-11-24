import { type Route } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

const templates = [
  { id: 2401, name: 'Alpha launch guide', type: 'social_message', content: 'A fictional launch article.', isPredefined: false, createdAt: '2026-10-01T00:00:00Z' },
  { id: 2402, name: 'Beta reusable guide', type: 'social_message', content: 'A fictional reusable article.', isPredefined: true, createdAt: '2026-10-01T00:00:00Z' },
];
const assets = [{ id: 2403, title: 'Gamma saved draft', type: 'social_dm', channel: 'instagram', content: 'A fictional saved draft.', status: 'draft', createdAt: '2026-10-01T00:00:00Z' }];
const noMatch = 'zzqa-as024-unmatched';

test.describe('AS024 dashboard Social DM list', () => {
  let empty: boolean;
  let failTemplates: boolean;
  let failAssets: boolean;
  let waitForTemplates: Promise<void> | undefined;
  let waitForAssets: Promise<void> | undefined;
  let writes: string[];
  let searches: string[];
  let expectedHttpErrors: number;

  test.beforeEach(async ({ page }) => {
    empty = false;
    failTemplates = false;
    failAssets = false;
    waitForTemplates = undefined;
    waitForAssets = undefined;
    writes = [];
    searches = [];
    expectedHttpErrors = 0;
    await page.route('**/api/**', async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        writes.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 409, json: { error: 'Local AS024 fixture blocks every mutation.' } });
      }
      if (url.pathname === '/api/content/templates') {
        const search = url.searchParams.get('search') || '';
        searches.push(search);
        if (search) await waitForTemplates;
        if (failTemplates) {
          expectedHttpErrors++;
          return route.fulfill({ status: 500, json: { error: 'Synthetic templates unavailable' } });
        }
        const matching = empty ? [] : templates.filter(item => `${item.name} ${item.content}`.toLowerCase().includes(search.toLowerCase()));
        return route.fulfill({ json: { templates: matching, total: matching.length } });
      }
      if (url.pathname === '/api/content/assets') {
        await waitForAssets;
        if (failAssets) {
          expectedHttpErrors++;
          return route.fulfill({ status: 500, json: { error: 'Synthetic drafts unavailable' } });
        }
        return route.fulfill({ json: empty ? [] : assets });
      }
      if (/^\/api\/(auth|platform|settings|organizations|wallet|chat|notifications|crm)/.test(url.pathname)) return route.fallback();
      return route.fulfill({ json: {} });
    });
  });

  test.afterEach(async ({ audit }) => {
    expect(writes).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.failedRequests).toEqual([]);
    if (expectedHttpErrors) {
      expect(audit.consoleErrors).toHaveLength(expectedHttpErrors);
      expect(audit.consoleErrors.every(message => /500 \(Internal Server Error\)/.test(message))).toBe(true);
    } else {
      expect(audit.consoleErrors).toEqual([]);
    }
  });

  test('zero matches have search copy and keyboard clear restores records and permissions', async ({ page }, testInfo) => {
    await page.goto('/dashboard/saved-templates/dm');
    for (const name of ['Alpha launch guide', 'Beta reusable guide', 'Gamma saved draft']) await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Alpha launch guide', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Beta reusable guide', exact: true })).toHaveCount(0);
    const search = page.getByRole('textbox', { name: 'Search DM templates', exact: true });
    await search.fill('Gamma');
    await expect(page.getByText('Gamma saved draft', { exact: true })).toBeVisible();
    await expect(page.getByText('Alpha launch guide', { exact: true })).toHaveCount(0);
    const response = page.waitForResponse(response => new URL(response.url()).searchParams.get('search') === noMatch);
    await search.fill(noMatch);
    await response;
    // This screenshot captures the same fixture before and after the runtime fix.
    await page.screenshot({ path: testInfo.outputPath('blog-no-matches.png'), fullPage: true });
    await expect(page.getByRole('heading', { name: 'No matching DM templates', exact: true })).toBeVisible();
    await expect(page.getByText('Try a different search or clear it to see all DM templates.')).toBeVisible();
    await expect(page.getByText('No DM templates yet', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create Template', exact: true })).toHaveCount(0);
    await expect(search).toHaveValue(noMatch);
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Build reusable template' }).click();
    await expect(page.getByRole('dialog', { name: 'Create DM Template' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(search).toHaveValue(noMatch);
    await search.focus();
    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    await search.focus();
    for (let index = 0; index < 8 && !await clear.evaluate(node => node === document.activeElement); index++) await page.keyboard.press('Tab');
    await expect(clear).toBeFocused();
    expect(await clear.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await clear.press('Enter');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    for (const name of ['Alpha launch guide', 'Beta reusable guide', 'Gamma saved draft']) await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Alpha launch guide', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete Beta reusable guide', exact: true })).toHaveCount(0);
    await search.fill('Alpha');
    await expect(page.getByText('Alpha launch guide', { exact: true })).toBeVisible();
    await search.press('ControlOrMeta+a');
    await search.press('Backspace');
    await expect(search).toBeFocused();
    await expect(page.getByText('Gamma saved draft', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('blog-cleared.png'), fullPage: true });
    expect(searches).toContain(noMatch);
  });

  test('empty collection keeps create workflows and search recovery', async ({ page }, testInfo) => {
    empty = true;
    await page.goto('/dashboard/saved-templates/dm');
    await expect(page.getByRole('heading', { name: 'No DM templates yet', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Template', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Template', exact: true })).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search DM templates', exact: true });
    await search.fill('   ');
    await expect(page.getByRole('heading', { name: 'No DM templates yet', exact: true })).toBeVisible();
    await search.fill(noMatch);
    await expect(page.getByRole('heading', { name: 'No matching DM templates', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(page.getByRole('heading', { name: 'No DM templates yet', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('blog-empty.png'), fullPage: true });
  });

  test('pending sources and search requests show loading before reporting no matches', async ({ page }) => {
    let releaseAssets!: () => void;
    waitForAssets = new Promise(resolve => { releaseAssets = resolve; });
    await page.goto('/dashboard/saved-templates/dm');
    await expect(page.getByText('Alpha launch guide', { exact: true })).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search DM templates', exact: true });
    await search.fill(noMatch);
    await expect(page.getByRole('status')).toHaveText('Loading DM templates…');
    await expect(page.getByText('No matching DM templates', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No DM templates yet', { exact: true })).toHaveCount(0);
    releaseAssets();
    await expect(page.getByRole('heading', { name: 'No matching DM templates', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(page.getByText('Alpha launch guide', { exact: true })).toBeVisible();
    let releaseTemplates!: () => void;
    waitForTemplates = new Promise(resolve => { releaseTemplates = resolve; });
    const request = page.waitForRequest(request => new URL(request.url()).searchParams.get('search') === 'waiting-for-search');
    await search.fill('waiting-for-search');
    await request;
    await expect(page.getByRole('status')).toHaveText('Loading DM templates…');
    await expect(page.getByText('No matching DM templates', { exact: true })).toHaveCount(0);
    releaseTemplates();
    await expect(page.getByRole('heading', { name: 'No matching DM templates', exact: true })).toBeVisible();
  });

  test('source errors take priority over empty and filtered states, with retry preserving search', async ({ page }, testInfo) => {
    failAssets = true;
    await page.goto('/dashboard/saved-templates/dm');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Saved drafts could not be loaded');
    await expect(page.getByText('Alpha launch guide', { exact: true })).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search DM templates', exact: true });
    await search.fill(noMatch);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('DM templates could not be loaded');
    await expect(search).toHaveValue(noMatch);
    await expect(page.getByText('No matching DM templates', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No DM templates yet', { exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('blog-error.png'), fullPage: true });
    failAssets = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No matching DM templates', exact: true })).toBeVisible();
    await expect(search).toHaveValue(noMatch);
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(page.getByText('Gamma saved draft', { exact: true })).toBeVisible();
  });

  test('failed template search keeps available drafts and retries without resetting the filter', async ({ page }) => {
    await page.goto('/dashboard/saved-templates/dm');
    await expect(page.getByText('Gamma saved draft', { exact: true })).toBeVisible();
    failTemplates = true;
    const search = page.getByRole('textbox', { name: 'Search DM templates', exact: true });
    await search.fill('Gamma');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Some reusable templates could not be loaded');
    await expect(page.getByText('Gamma saved draft', { exact: true })).toBeVisible();
    failTemplates = false;
    await page.getByRole('button', { name: 'Retry missing content', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await expect(search).toHaveValue('Gamma');
    await expect(page.getByText('Gamma saved draft', { exact: true })).toBeVisible();
  });
});
