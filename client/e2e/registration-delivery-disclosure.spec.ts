import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { fixtures } from './fixtures/ui-navigation';

test('registration with unconfirmed email delivery offers verification without claiming a code was sent', async ({ page }) => {
  const state = await fixtures(page); state.public = true;
  await page.route('**/api/auth/register', route => route.fulfill({ json: { verificationEmailSent: false } }));
  await page.goto('/login?mode=register');
  await page.getByLabel('Full name').fill('Synthetic Mail Recovery');
  await page.getByLabel('Work email', { exact: true }).fill('mail-recovery@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic!123');
  await page.getByLabel('Confirm password', { exact: true }).fill('Synthetic!123');
  await page.locator('button[type=submit]').click();
  const dialog = page.getByRole('dialog', { name: 'Check your email' });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('We sent a verification code');
  await expect(dialog).toContainText('Your account was created, but the verification email could not be sent to');
  await expect(dialog).toContainText('Request another code on the verification page.');
  await expect(dialog.getByRole('button', { name: 'Open verification' })).toBeFocused();
});

for (const status of [400, 503]) {
  test(`interrupted registration can continue existing verification after HTTP ${status} without another write`, async ({ page }) => {
    const state = await fixtures(page); state.public = true;
    let registrations = 0, resends = 0;
    const email = 'Recovery+Audit@Example.test';
    const normalizedEmail = email.toLowerCase();
    await page.route('**/api/auth/register', route => {
      registrations++;
      return route.fulfill({ status, json: { error: status === 400 ? 'Synthetic duplicate registration' : 'Synthetic response unavailable' } });
    });
    await page.route('**/api/auth/resend-verification', route => { resends++; return route.fulfill({ status: 409, json: { error: 'No automatic code requests' } }); });
    if (test.info().project.name === 'mobile-chromium' && status === 503) await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/login?mode=register');
    await page.getByLabel('Full name').fill('Synthetic Registration Recovery');
    await page.getByLabel('Work email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Synthetic!123');
    await page.getByLabel('Confirm password', { exact: true }).fill('Synthetic!123');
    await page.locator('button[type=submit]').click();
    await expect(page.getByRole('alert').filter({ hasText: status === 400 ? 'Synthetic duplicate registration' : 'Synthetic response unavailable' })).toBeVisible();
    const recovery = page.getByRole('link', { name: 'Continue email verification' });
    await expect(recovery).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `${process.env.UI_FIX_SCREENSHOTS || '/tmp'}/${test.info().project.name}-registration-recovery-${status}.png`, fullPage: true, animations: 'disabled' });
    await recovery.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/verify-email\?/);
    expect(new URL(page.url()).searchParams.get('email')).toBe(normalizedEmail);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    expect(registrations).toBe(1); expect(resends).toBe(0); expect(state.errors).toEqual([]);
  });
}
