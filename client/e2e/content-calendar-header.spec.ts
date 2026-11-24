import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

// Render the real calendar and dashboard shell with an empty, isolated calendar.
// Every API request is mocked; navigation must never mutate a post.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page, audit }) => {
  await page.clock.setFixedTime(new Date('2026-09-08T12:00:00Z'));
  await page.routeWebSocket(url => !url.pathname.startsWith('/_next/'), () => {});
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Calendar navigation must be read-only.' } });
    }
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|organizations|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) return route.fallback();
    return route.fulfill({ json: path === '/api/content/calendar' ? { items: [] } : {} });
  });
});

async function expectUsableNavigation(page: Page, mode: 'month' | 'week') {
  const title = page.getByRole('heading', { name: 'Content calendar', exact: true });
  const subtitle = page.getByText('Plan, review, and manage scheduled social publishing', { exact: false });
  const textBounds = await Promise.all([title.boundingBox(), subtitle.boundingBox()]);
  for (const name of [`Previous ${mode}`, `Next ${mode}`]) {
    const control = page.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    // Use 44 CSS pixels as the conservative navigation hit-area target.
    expect(bounds!.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(bounds!.height, `${name} height`).toBeGreaterThanOrEqual(44);
    for (const text of textBounds) {
      expect(text).not.toBeNull();
      const intersects = bounds!.x < text!.x + text!.width && bounds!.x + bounds!.width > text!.x
        && bounds!.y < text!.y + text!.height && bounds!.y + bounds!.height > text!.y;
      expect(intersects, `${name} intersects header text`).toBe(false);
    }
    // Check both edges are actual pointer targets, not merely visible bounds.
    expect(await control.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return [rect.left + 2, rect.right - 2].every(x => node.contains(document.elementFromPoint(x, rect.top + rect.height / 2)));
    })).toBe(true);
  }
  await expectNoHorizontalOverflow(page);
}

for (const width of [320, 390, 768, 1024, 1311, 1920, 2560]) {
  test(`calendar navigation keeps usable bounds at ${width}px`, async ({ page, audit }, testInfo) => {
    await page.setViewportSize({ width, height: 841 });
    await page.goto('/dashboard/content-calendar');
    await expect(page.getByRole('button', { name: 'Previous month', exact: true })).toBeVisible();
    for (const sidebar of width >= 1024 ? ['expanded', 'collapsed'] : ['mobile']) {
      if (sidebar === 'collapsed') {
        await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
        await expect(page.locator('[data-sidebar-state]')).toHaveAttribute('data-sidebar-state', 'hidden');
        // Wait for the sidebar transition to settle before measuring the layout.
        await expect.poll(() => page.locator('[data-sidebar-state]').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
      }
      await expectUsableNavigation(page, 'month');
      await page.getByRole('button', { name: 'Weekly', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expectUsableNavigation(page, 'week');
      await page.getByRole('button', { name: 'Monthly', exact: true }).click();
      await expectUsableNavigation(page, 'month');
      await page.screenshot({ path: testInfo.outputPath(`calendar-${width}-${sidebar}.png`) });
    }
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('previous, next and Today work with pointer and keyboard in both views', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/content-calendar');
  for (const mode of ['month', 'week'] as const) {
    if (mode === 'week') await page.getByRole('button', { name: 'Weekly', exact: true }).click();
    const previous = page.getByRole('button', { name: `Previous ${mode}`, exact: true });
    const next = page.getByRole('button', { name: `Next ${mode}`, exact: true });
    const label = previous.locator('..').locator('span');
    const initial = mode === 'month' ? 'September, 2026' : 'Week of September 6, 2026';
    const earlier = mode === 'month' ? 'August, 2026' : 'Week of August 30, 2026';
    const later = mode === 'month' ? 'October, 2026' : 'Week of September 13, 2026';
    await expect(label).toHaveText(initial);
    await previous.click({ position: { x: 2, y: 22 } });
    await expect(label).toHaveText(earlier);
    await next.click();
    await expect(label).toHaveText(initial);
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(label).toHaveText(later);
    await previous.focus();
    await page.keyboard.press('Space');
    await expect(label).toHaveText(initial);
    await previous.click();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(label).toHaveText(initial);
    await next.click();
    await page.getByRole('button', { name: 'Today', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(label).toHaveText(initial);
    await expectUsableNavigation(page, mode);
  }
  expect(audit.blockedMutations).toEqual([]);
});

test('long date labels and 200% zoom reflow preserve navigation bounds', async ({ page, audit }, testInfo) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/content-calendar');
  await expect(page.getByRole('button', { name: 'Previous month', exact: true })).toBeVisible();
  // The calendar currently uses English month names. Stress the actual DOM with
  // a long localized label without adding localization behavior to this fix.
  for (const mode of ['month', 'week'] as const) {
    if (mode === 'week') await page.getByRole('button', { name: 'Weekly', exact: true }).click();
    const label = page.getByRole('button', { name: `Previous ${mode}`, exact: true }).locator('..').locator('span');
    await label.evaluate(node => { node.textContent = 'Saptambar / Septembro / September, 2026'; });
    await expectUsableNavigation(page, mode);
    // CSS zoom exercises enlarged text/control geometry; a halved CSS viewport
    // separately exercises the reflow expected from 200% browser zoom.
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expectUsableNavigation(page, mode);
    await page.screenshot({ path: testInfo.outputPath(`calendar-${mode}-zoom-200-long-label.png`) });
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await page.setViewportSize({ width: 655, height: 420 });
    await expectUsableNavigation(page, mode);
    await page.setViewportSize({ width: 1311, height: 841 });
  }
  expect(audit.blockedMutations).toEqual([]);
});
