import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test('Brand Toolkit cards handle decoded image errors, missing logos and a changed source', async ({ page, audit }, testInfo) => {
  const brokenName = 'Synthetic Studio with a long toolkit title for narrow screens';
  let firstUrl = '/uploads/synthetic-undecodable-logo.png';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 96 48"><rect width="96" height="48" fill="#223344"/><text x="8" y="30" fill="white">Studio</text></svg>';
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'No writes in the Brand Toolkit logo regression.' } });
    }
    if (path === '/api/content/brand-toolkits') return route.fulfill({ json: [
      { id: 71, name: brokenName, logoUrl: firstUrl, isDefault: true },
      { id: 72, name: 'Loaded Studio', logoUrls: ['/uploads/synthetic-valid-logo.svg'], isDefault: true },
      { id: 73, name: 'Empty Studio', logoUrl: '', isDefault: true },
      { id: 74, name: '', isDefault: true },
    ] });
    // A successful HTTP response with undecodable pixels exercises the browser
    // image error. No transport diagnosis or live asset repair is implied.
    if (path === '/api/uploads/synthetic-undecodable-logo.png') return route.fulfill({ contentType: 'image/png', body: 'synthetic undecodable image bytes' });
    if (path === '/api/uploads/synthetic-valid-logo.svg') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/business-profiles',
      '/api/settings/outreach/assistants/catalog', '/api/wallet', '/api/notifications/unread/count'].includes(path)) return route.fallback();
    if (path === '/api/chat/threads') return route.fulfill({ json: { threads: [], total: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/dashboard/brand-toolkit');
  const fallback = page.getByRole('img', { name: `${brokenName} logo unavailable`, exact: true });
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute('title', `${brokenName} logo unavailable`);
  await expect(page.getByRole('img', { name: `${brokenName} logo`, exact: true })).toHaveCount(0);
  const loaded = page.getByRole('img', { name: 'Loaded Studio logo', exact: true });
  await expect(loaded).toBeVisible();
  await expect.poll(() => loaded.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0 && node.naturalHeight > 0)).toBe(true);
  await expect(loaded).toHaveAttribute('src', '/api/uploads/synthetic-valid-logo.svg');
  await expect(page.getByRole('img', { name: 'Empty Studio has no logo', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Untitled Brand has no logo', exact: true })).toBeVisible();
  const heading = page.getByRole('heading', { name: brokenName, exact: true });
  await expect(heading).toHaveAttribute('title', brokenName);
  const card = page.locator('.group').filter({ has: heading });
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: `Actions for ${brokenName}` })).toHaveAccessibleName(`Actions for ${brokenName}`);
  const viewport = page.viewportSize()!;
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale }))).toEqual({ ...viewport, scale: 1 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('logo-error-and-empty-fallbacks.png') });
  await page.reload();
  await expect(fallback).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  // Only the in-memory response fixture changes. No stored asset is edited.
  firstUrl = '/uploads/synthetic-valid-logo.svg';
  await page.reload();
  const replacement = page.getByRole('img', { name: `${brokenName} logo`, exact: true });
  await expect.poll(() => replacement.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  await expect(fallback).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
