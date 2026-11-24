import { expect, test } from '@playwright/test';

const users = Array.from({ length: 25 }, (_, index) => ({
  id: index + 1,
  name: `Scroll fixture user ${index + 1}`,
  email: `scroll-user-${index + 1}@example.test`,
  role: 'user',
  isVerified: true,
  isSetupComplete: true,
  isApproved: true,
  createdAt: '2026-09-01T00:00:00.000Z',
}));

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/me', route => route.fulfill({ json: {
    admin: { id: 1, name: 'Scroll fixture admin', email: 'admin@example.test', role: 'super_admin' },
  } }));
  await page.route('**/api/admin/notifications', route => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.route('**/api/admin/users', route => route.fulfill({ json: users }));
  await page.route('**/api/auth/csrf-token', route => route.fulfill({ json: { csrfToken: 'scroll-fixture' } }));

  await page.goto('/admin/dashboard/users');
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();
  await expect(page.getByText('Scroll fixture user 25')).toBeAttached();
});

test('wheel scrolling over an admin page advances the document', async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(Math.min(600, page.viewportSize()!.width - 20), 350);
  await page.mouse.wheel(0, 750);

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('the admin navigation remains independently scrollable', async ({ page, isMobile }) => {
  if (isMobile) {
    await page.getByRole('button', { name: 'Open admin navigation' }).click();
  }

  const navigation = page.locator('aside:visible nav').first();
  await expect(navigation).toBeVisible();
  for (let index = 0; index < 10 && await navigation.locator('button[aria-expanded="false"]').count(); index++) {
    await navigation.locator('button[aria-expanded="false"]').first().click();
  }
  await expect.poll(() => navigation.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  await navigation.evaluate(element => { element.scrollTop = 0; });
  const bounds = await navigation.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.wheel(0, 500);

  await expect.poll(() => navigation.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test('wide admin tables can scroll horizontally on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile);

  const table = page.getByLabel('User management table; scroll horizontally to view all columns').locator('div.overflow-auto');
  await expect.poll(() => table.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
  const bounds = await table.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + Math.min(80, bounds!.height / 2));
  await page.mouse.wheel(500, 0);

  await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});
