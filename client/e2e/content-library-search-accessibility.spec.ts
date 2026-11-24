import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

const noMatch = 'zzqa-no-match-20261009';
const shellReads = new Set([
  '/api/auth/me', '/api/platform/access', '/api/settings/preferences',
  '/api/organizations', '/api/settings/business-profiles', '/api/crm/configuration',
  '/api/wallet', '/api/chat/threads', '/api/notifications/unread/count',
]);

// Exercise the real local frontend with synthetic records and no backend writes.
test.beforeEach(async ({ page, audit }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Unexpected mutation in search regression.' } });
    }
    if (shellReads.has(url.pathname)) return route.fallback();
    if (url.pathname === '/api/content/studio/estimates') {
      return route.fulfill({ json: {
        text: { credits: 1, ready: true }, image: { credits: 5, ready: true },
        video: { credits: 10, ready: true }, sms: { creditsPerMessage: 1 },
      } });
    }
    if (url.pathname === '/api/content/templates') {
      const templates = ['Alpha welcome', 'Beta reminder'].map((name, index) => ({
        id: index + 1, userId: 4101, type: url.searchParams.get('type'), name,
        content: 'Synthetic template body', subject: 'Synthetic email subject', usageCount: 0,
        createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
      })).filter(template => template.name.toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase()));
      return route.fulfill({ json: { templates, total: templates.length } });
    }
    if (url.pathname === '/api/content/assets' && url.searchParams.get('paginated') === 'true') {
      return route.fulfill({ json: { assets: [], total: 0 } });
    }
    if (url.pathname === '/api/content/assets' || url.pathname === '/api/content/brand-toolkits') {
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: {} });
  });
});

test('email library keeps a stable accessible search name through filtering, no-match and keyboard clear', async ({ page, audit }, testInfo) => {
  if (testInfo.project.name === 'desktop-chromium') await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/saved-templates/email');
  const search = page.getByRole('textbox', { name: 'Search email templates', exact: true });
  await expect(search).toHaveCount(1, { timeout: 10_000 });
  await expect(search).toHaveAttribute('placeholder', 'Search templates...');
  expect(await search.ariaSnapshot()).toContain('textbox "Search email templates"');
  await expect(page.getByText('Alpha welcome', { exact: true })).toBeVisible();
  await expect(page.getByText('Beta reminder', { exact: true })).toBeVisible();

  await search.focus();
  await search.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  expect(await search.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');

  await search.fill('alpha');
  await expect(page.getByText('Alpha welcome', { exact: true })).toBeVisible();
  await expect(page.getByText('Beta reminder', { exact: true })).toHaveCount(0);
  const noMatchResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/content/templates' && url.searchParams.get('search') === noMatch;
  });
  await search.fill(noMatch);
  await noMatchResponse;
  await expect(page.getByText('No templates match your search', { exact: true })).toBeVisible();
  await expect(search).toHaveAccessibleName('Search email templates');
  expect(await search.ariaSnapshot()).toContain('textbox "Search email templates"');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('email-search-no-match.png'), fullPage: true });
  await testInfo.attach('email-search-accessibility', { body: await search.ariaSnapshot(), contentType: 'text/plain' });

  await search.press('ControlOrMeta+a');
  await search.press('Backspace');
  await expect(search).toHaveValue('');
  await expect(search).toHaveAccessibleName('Search email templates');
  await expect(search).toBeFocused();
  await expect(page.getByText('Alpha welcome', { exact: true })).toBeVisible();
  await expect(page.getByText('Beta reminder', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('email-search-cleared.png'), fullPage: true });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

const siblingSearches = [
  ['sms', 'Search SMS templates'], ['dm', 'Search DM templates'],
  ['social', 'Search social templates'], ['blog', 'Search blog posts'],
  ['ads', 'Search ad templates'], ['image', 'Search images'], ['video', 'Search videos'],
  ['email/generate', 'Search emails'], ['sms/generate', 'Search SMS'],
  ['dm/generate', 'Search DMs'], ['social/generate', 'Search recent social posts'],
  ['blog/generate', 'Search blog posts'], ['ads/generate', 'Search ad copy'],
  ['image/generate', 'Search images'], ['video/generate', 'Search videos'],
] as const;

for (const [path, name] of siblingSearches) {
  test(`${path} search has a unique stable accessible name`, async ({ page, audit }) => {
    await page.goto(`/dashboard/saved-templates/${path}`);
    const search = page.getByRole('textbox', { name, exact: true });
    await expect(search).toHaveCount(1);
    await expect(search).toBeVisible();
    expect(await search.ariaSnapshot()).toContain(`textbox "${name}"`);
    await search.fill(noMatch);
    await expect(search).toHaveAccessibleName(name);
    expect(await search.ariaSnapshot()).toContain(`textbox "${name}"`);
    await search.clear();
    await expect(search).toHaveValue('');
    await expect(search).toHaveAccessibleName(name);
    await expectNoHorizontalOverflow(page);
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
  });
}
