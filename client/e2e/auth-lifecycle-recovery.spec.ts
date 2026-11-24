import { test, expect } from '@playwright/test';

// Uses the actual local API/DB with an email-capture provider, never route.fulfill.
// Run with AUTH_LIFECYCLE_E2E=disposable-local and --project=desktop-chromium.
test('recovery delivery failure keeps a retryable form at normal responsive widths', async ({ page, request, baseURL }) => {
  test.skip(process.env.AUTH_LIFECYCLE_E2E !== 'disposable-local');
  if (baseURL !== 'http://127.0.0.1:53000') throw new Error('Explicit disposable local browser harness required');
  const api = 'http://127.0.0.1:58080';
  const email = `recovery-e2e-${Date.now()}@example.invalid`;
  await page.context().route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await request.post(api + '/__audit/delivery', { data: { fail: false } });
  const signup = await request.post(api + '/api/auth/register', { data: { email, password: 'Synthetic!Browser2026', name: 'Synthetic browser' } });
  expect(signup.status()).toBe(201);
  await request.post(api + '/__audit/delivery', { data: { fail: true } });
  try {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/forgot-password');
      await page.getByLabel('Email address', { exact: true }).fill(email);
      const response = page.waitForResponse(r => r.url().endsWith('/api/auth/forgot-password') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Request recovery code', exact: true }).click();
      expect((await response).status()).toBe(503);
      await expect(page.getByRole('alert').filter({ hasText: 'The recovery request could not be completed.' })).toBeVisible();
      await expect(page.locator('form')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await request.post(api + '/__audit/delivery', { data: { fail: false } });
    await page.getByRole('button', { name: 'Request recovery code', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  } finally { await request.post(api + '/__audit/delivery', { data: { fail: false } }); }
});
