import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

async function isolateContext(page: Page, theme: string, name = 'Regression Company') {
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Workspace context fixture blocks mutations.' } });
    }
    if (path === '/api/settings/preferences') return route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } });
    if (path === '/api/settings/outreach/assistants/catalog') return route.fulfill({ json: {
      runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
      permissions: { canManage: false, description: 'Read-only workspace context fixture.' },
    } });
    if (path === '/api/settings/business-profiles') return route.fulfill({ json: [{ id: 4102, companyName: name, isDefault: true, isApproved: true, role: 'owner', canManageTeam: true }] });
    if (/^\/api\/(auth|platform|organizations|wallet|chat|notifications|crm)/.test(path)) return route.fallback();
    return route.fulfill({ json: [] });
  });
  return writes;
}

for (const theme of ['light', 'dark']) {
  test(`narrow app bar keeps workspace context below the controls in ${theme}`, async ({ page, audit }, info) => {
    const writes = await isolateContext(page, theme);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/dashboard/home');
    const header = page.getByTestId('header');
    const context = header.locator('[aria-label="Current workspace: Regression Company"]');
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 640, height: 900 }, { width: 820, height: 1180 }]) {
      await page.setViewportSize(viewport);
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      await expect(context).toBeVisible();
      const measurements = await context.evaluate(node => ({
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, bounds: node.getBoundingClientRect().toJSON(),
        viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale, dpr: devicePixelRatio },
      }));
      await info.attach(`workspace-context-${viewport.width}`, { contentType: 'application/json', body: JSON.stringify(measurements) });
      expect(measurements.viewport).toMatchObject({ ...viewport, scale: 1 });
      expect(measurements.clientWidth).toBeGreaterThanOrEqual(viewport.width - 48);
      expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.clientWidth + 1);
      expect((await header.boundingBox())!.height).toBe(64);
      const controls = ['Show sidebar', 'Find a page in Regression Company', 'Account menu', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode']
        .map(name => header.getByRole('button', { name, exact: true }));
      controls.push(header.getByTestId('button-notifications'), header.getByRole('link', { name: /^Available credits:/ }));
      for (const button of controls) {
        await expect(button).toBeInViewport({ ratio: 1 });
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(measurements.bounds.y).toBeGreaterThanOrEqual(box.y + box.height);
      }
      await expectNoHorizontalOverflow(page);
      await header.screenshot({ path: info.outputPath(`workspace-${viewport.width}-${theme}.png`) });
    }
    expect(writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
  });

  test(`desktop context follows sidebar visibility and keyboard finder closure in ${theme}`, async ({ page, audit }) => {
    const writes = await isolateContext(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/home');
    const context = page.getByTestId('header').locator('[aria-label="Current workspace: Regression Company"]');
    await expect(page.getByRole('button', { name: /Switch business profile\. Current:/ })).toBeVisible();
    await expect(context).toBeHidden();
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await expect(context).toBeVisible();
    const opener = page.getByRole('button', { name: 'Find a page in Regression Company', exact: true });
    for (let cycle = 0; cycle < 2; cycle++) {
      await opener.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Search AskSales.AI', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close search', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
      await expect(page).toHaveURL(/\/dashboard\/home$/);
    }
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await expect(context).toBeHidden();
    expect(writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
  });
}

test('a long narrow workspace name keeps its full accessible context and bounded display', async ({ page, audit }, info) => {
  const name = 'Regression workspace with a deliberately long business name '.repeat(5).trim();
  const writes = await isolateContext(page, 'light', name);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/dashboard/home');
  const context = page.getByTestId('header').locator('[aria-label^="Current workspace:"]');
  await expect(context).toHaveAttribute('aria-label', `Current workspace: ${name}`);
  await expect(context).toHaveAttribute('title', `Current workspace: ${name}`);
  expect(await context.evaluate(node => node.clientWidth)).toBeGreaterThanOrEqual(272);
  await expectNoHorizontalOverflow(page);
  const opener = page.getByRole('button', { name: `Find a page in ${name}`, exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Search AskSales.AI', exact: true });
  await expect(dialog).toBeVisible();
  const caption = dialog.getByText(`Pages in ${name}`, { exact: true });
  await expect(caption).toHaveAttribute('aria-label', `Pages in ${name}`);
  await expect(caption).toHaveAttribute('title', `Pages in ${name}`);
  expect(await caption.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(32);
  const close = dialog.getByRole('button', { name: 'Close search', exact: true });
  await expect(close).toBeInViewport({ ratio: 1 });
  expect((await dialog.boundingBox())!.y + (await dialog.boundingBox())!.height).toBeLessThanOrEqual(560);
  await dialog.screenshot({ path: info.outputPath('long-workspace-finder.png'), animations: 'disabled', style: 'nextjs-portal{display:none}' });
  await close.focus(); await page.keyboard.press('Space');
  await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  expect(writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});
