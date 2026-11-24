import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

test('ordinary preferences have named controls and retain edits through save failure and reload', async ({ page, audit }) => {
  let preferences = { language: 'en', locale: 'en-US', currency: 'USD', theme: 'light', timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h' };
  const writes: unknown[] = [];
  await page.route('**/api/settings/preferences', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (writes.length === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic save interruption' } });
      preferences = body;
    }
    return route.fulfill({ json: preferences });
  });
  await page.goto('/dashboard/settings/preferences');
  for (const label of ['Language', 'Locale', 'Timezone', 'Date Format', 'Time Format', 'Color theme', 'Currency for new records and summaries']) {
    await expect(page.getByRole('combobox', { name: label, exact: true })).toBeVisible();
  }
  const choose = async (label: string, option: string | RegExp) => {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option }).click();
  };
  await choose('Language', /हिन्दी/);
  await choose('Locale', /India.*हिन्दी/);
  await choose('Date Format', /DD\/MM\/YYYY/);
  await choose('Time Format', /24-hour/);
  await choose('Color theme', 'Dark');
  await choose('Currency for new records and summaries', /INR/);
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Failed to update preferences', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Currency for new records and summaries', exact: true })).toContainText('INR');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Preferences Saved', { exact: true })).toBeVisible();
  expect(writes).toEqual([expect.objectContaining({ language: 'hi', locale: 'hi-IN', currency: 'INR', theme: 'dark', timezone: 'UTC', dateFormat: 'DD/MM/YYYY', timeFormat: '24h' }), writes[0]]);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('combobox', { name: 'Date Format', exact: true })).toContainText('DD/MM/YYYY');
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors.filter(message => !message.includes('503 (Service Unavailable)'))).toEqual([]);
});

test('ordinary profile validation and retry preserve entered account details', async ({ page, audit }) => {
  let profile = { name: 'Synthetic owner', email: 'profile@example.invalid', avatar: '', bio: 'Original biography', phone: '' };
  const writes: unknown[] = [];
  await page.route('**/api/settings/profile', route => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic save interruption' } });
      profile = route.request().postDataJSON();
    }
    return route.fulfill({ json: profile });
  });
  await page.route('**/api/settings/profile/notification-preferences', route => route.fulfill({ json: { leadAlerts: true, campaignUpdates: true } }));
  await page.goto('/dashboard/settings');
  await page.getByLabel('Full Name', { exact: true }).fill('Revised owner');
  await page.getByLabel('Phone', { exact: true }).fill('invalid phone');
  await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
  await expect(page.getByText('Please enter a valid phone number.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByLabel('Phone', { exact: true }).fill('+1 555 010 2000');
  await page.getByLabel('Biography', { exact: true }).fill('A retained profile edit.');
  await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
  await expect(page.getByText('Failed to update profile', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Full Name', { exact: true })).toHaveValue('Revised owner');
  await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
  await expect(page.getByText('Profile Updated', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Full Name', { exact: true })).toHaveValue('Revised owner');
  await expect(page.getByLabel('Biography', { exact: true })).toHaveValue('A retained profile edit.');
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors.filter(message => !message.includes('503 (Service Unavailable)'))).toEqual([]);
});
