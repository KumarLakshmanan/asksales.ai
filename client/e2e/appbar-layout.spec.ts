import { test, expect, installAppShellMocks, expectNoHorizontalOverflow } from './fixtures/app';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-appbar-qa');
    localStorage.setItem('selectedBusinessProfileId', '4102');
  });
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
});

for (const width of [320, 390, 640, 768, 835, 1024, 1440]) {
  test(`app bar controls remain distinct at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard/home');
    const header = page.getByTestId('header');
    const search = header.getByRole('button', { name: /Find a page/ });
    const credits = header.getByRole('link', { name: /Available credits/ });
    const notifications = header.getByRole('button', { name: /Notifications/ });
    await expect(search).toBeVisible();
    await expect(credits).toBeVisible();
    await expect(notifications).toBeVisible();
    await expect(header.getByRole('link', { name: 'Documentation', exact: true })).toHaveCount(0);
    const headerBox = (await header.boundingBox())!;
    if (width === 1440) {
      const account = header.getByRole('button', { name: /account|profile/i }).last();
      const accountBox = (await account.boundingBox())!;
      expect(headerBox.x + headerBox.width - (accountBox.x + accountBox.width)).toBeLessThan(32);
    }
    const controls = header.locator('button:visible, a:visible');
    const boxes = (await Promise.all((await controls.all()).map(control => control.boundingBox()))).filter(box => box !== null);
    for (const [index, box] of boxes.entries()) {
      expect(box.x).toBeGreaterThanOrEqual(headerBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(headerBox.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 1);
      for (const other of boxes.slice(index + 1)) {
        expect(box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y).toBe(false);
      }
    }
    await expectNoHorizontalOverflow(page);
    if (width === 835) await header.screenshot({ path: test.info().outputPath('appbar-835.png') });
  });
}
