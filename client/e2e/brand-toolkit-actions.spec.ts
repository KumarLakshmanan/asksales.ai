import { expect, installAppShellMocks, test } from './fixtures/app';

const brands = [
  { id: 71, name: 'Acorn & Co', isDefault: true },
  { id: 72, name: 'Northstar', isDefault: false },
];

test.beforeEach(async ({ page }) => {
  if (test.info().project.name === 'desktop-chromium') {
    await page.setViewportSize({ width: 1311, height: 841 });
  }
  // All API requests use disposable fixtures; no session or brand records are changed.
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
  await page.route('**/api/content/brand-toolkits', route => route.fulfill({ json: brands }));
});

for (const key of ['Enter', 'Space']) {
  test(`AS007: brand-specific action names, Tab visibility, ${key} and Escape`, async ({ page, audit }) => {
    const mutations: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) {
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    await page.goto('/dashboard/brand-toolkit');
    await expect(page.getByRole('heading', { name: 'Brand Toolkit', exact: true })).toBeVisible();
    const triggers = page.locator('#main-content button[aria-haspopup="menu"]');
    await expect(triggers).toHaveCount(2);
    await page.mouse.move(0, 0);
    await page.getByRole('button', { name: 'Add Brand', exact: true }).focus();

    for (const brand of brands) {
      const name = `Actions for ${brand.name}`;
      // Radix temporarily hides the background from accessibility APIs while its modal menu is open.
      const trigger = page.getByRole('button', { name, exact: true, includeHidden: true });
      await expect(trigger).toHaveCount(1);
      await expect(trigger).toHaveAccessibleName(name);
      await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      await expect(trigger.locator('svg')).toHaveAttribute('aria-hidden', 'true');
      // Opacity-hidden controls remain in the tab order and become visible on focus.
      await expect(trigger).toHaveCSS('opacity', '0');
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('Tab');
        if (await trigger.evaluate(element => element === document.activeElement)) break;
      }
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveCSS('opacity', '1');
      await expect(trigger).toBeVisible();
      await page.keyboard.press(key);
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Edit Brand', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAccessibleName(name);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toHaveCSS('opacity', '1');
    }
    expect(mutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
  });
}
