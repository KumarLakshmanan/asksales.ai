import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH } });

test('email counts describe the current view and search reset preserves the tab', async ({ page, audit }, testInfo) => {
  const createdAt = '2026-10-09T12:00:00.000Z';
  const reusable = { id: 1, name: 'Welcome reusable', type: 'email', subject: 'Welcome', content: 'Welcome reusable body', createdAt, updatedAt: createdAt };
  const drafts = Array.from({ length: 37 }, (_, index) => ({ id: index + 1, title: `Launch draft ${index + 1}`, type: 'email_template', channel: 'email', content: 'Launch body', status: 'draft', createdAt }));
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      audit.blockedMutations.push(route.request().method());
      return route.fulfill({ status: 409, json: { error: 'UX004 regression blocks mutations.' } });
    }
    const url = new URL(route.request().url());
    if (/^\/api\/(auth\/me|platform\/access|settings\/(preferences|business-profiles)|organizations|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(url.pathname)) return route.fallback();
    if (url.pathname === '/api/content/templates') {
      const query = (url.searchParams.get('search') || '').toLowerCase();
      const templates = [reusable].filter(item => `${item.name} ${item.content}`.toLowerCase().includes(query));
      return route.fulfill({ json: { templates, total: templates.length } });
    }
    if (url.pathname === '/api/content/assets') return route.fulfill({ json: drafts });
    return route.fulfill({ json: {} });
  });
  await page.goto('/dashboard/saved-templates/email');
  await expect(page.getByRole('status').filter({ hasText: 'Showing 38 of 38 items' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'All content (38)', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Saved drafts (37)', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Reusable templates (1)', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Showing 1 of 38 items' })).toBeVisible();
  const search = page.getByPlaceholder('Search templates...');
  await search.fill('zzqa-no-match-20261009');
  await expect(page.getByText('No templates match your search', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Showing 0 of 38 items' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ux004-no-results.png') });
  const reset = page.getByRole('button', { name: 'Clear search', exact: true }).last();
  await reset.focus();
  await expect(reset).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Reusable templates (1)', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Showing 1 of 38 items' })).toBeVisible();
  await page.getByRole('tab', { name: 'Saved drafts (37)', exact: true }).click();
  await search.fill('Launch draft 37');
  await expect(page.getByRole('status').filter({ hasText: 'Showing 1 of 38 items' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Saved drafts (37)', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Showing 37 of 38 items' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ux004-reset-drafts.png') });
  expect(audit.blockedMutations).toEqual([]);
});
