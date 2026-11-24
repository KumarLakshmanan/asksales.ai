import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { installLibrary } from './fixtures/outreach-local';

test.use({ actionTimeout: 20_000, video: 'off' });

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('getLibraryBrowserErrors', () => errors);
});
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as unknown as Window & { getLibraryBrowserErrors: () => Promise<string[]> }).getLibraryBrowserErrors())).toEqual([]);
});

test('Content Templates opens saved categories and a newly saved SMS survives reopening and reuse', async ({ page }, testInfo) => {
  await installLibrary(page);
  await page.goto('/dashboard/content/templates', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/dashboard\/saved-templates$/);
  await expect(page.getByRole('heading', { name: 'Content library' })).toBeVisible();
  const smsCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'SMS templates', exact: true }) });
  await expect(smsCard).toContainText('1 saved');
  await expect(page.getByRole('heading', { name: 'WhatsApp templates', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-template-categories.png'), fullPage: true });
  await smsCard.getByRole('button', { name: 'Open library' }).click();
  await page.getByRole('button', { name: 'Build reusable template' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template Name', { exact: true }).fill('New saved SMS');
  await dialog.getByLabel('Message Content', { exact: true }).fill('Welcome {{first_name}}');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('New saved SMS', { exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('New saved SMS', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('saved-sms-after-reopen.png'), fullPage: true });
  await page.goto('/dashboard/outreach/create?channel=sms&leadId=1', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Saved message').selectOption({ label: 'New saved SMS' });
  await expect(page.getByLabel('Message body', { exact: true })).toHaveValue('Welcome {{first_name}}');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('saved-sms-reused-in-outreach.png'), fullPage: true });
});

test('all saved text libraries keep available templates visible when saved drafts fail', async ({ page }, testInfo) => {
  const mock = await installLibrary(page); mock.state.failAssets = true;
  for (const [route, type] of [['email', 'email'], ['sms', 'sms'], ['dm', 'social_message'], ['social', 'social'], ['blog', 'blog'], ['ads', 'ad_copy']]) {
    await page.goto(`/dashboard/saved-templates/${route}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`Saved ${type} template`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry missing content' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`saved-${route}-partial-load.png`), fullPage: true });
  }
  mock.state.failAssets = false;
  await page.getByRole('button', { name: 'Retry missing content' }).click();
  await expect(page.getByRole('button', { name: 'Retry missing content' })).toHaveCount(0);
  await expect(page.getByText('Saved ad_copy template', { exact: true })).toBeVisible();
});

test('email creator preserves formatting, caret and variables with outreach-only follow-ups', async ({ page }, testInfo) => {
  const mock = await installLibrary(page);
  mock.state.followUpsEnabled = true;
  await page.goto('/dashboard/outreach/create?channel=email&leadId=1', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Saved template', { exact: true }).selectOption({ label: 'Saved email template' });
  const field = page.getByRole('textbox', { name: 'Message body', exact: true });
  await expect(field.locator('b,strong')).toHaveText('Hello {{first_name}}');
  await field.fill('Hello'); await field.press('ArrowLeft'); await field.press('ArrowLeft'); await field.press('X');
  await expect(field).toHaveText('HelXlo');
  await field.press('ControlOrMeta+a');
  await field.locator('..').getByRole('button', { name: 'Bold', exact: true }).click();
  // Replacing a selected formatted draft inherits its bold style. Toggle it
  // off and on to verify the native editor command in both directions.
  await expect(field.locator('b,strong')).toHaveCount(0);
  await field.locator('..').getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(field.locator('b,strong')).toHaveText('HelXlo');
  await field.press('ArrowRight');
  await page.getByRole('button', { name: 'Company · {{company_name}}', exact: true }).click();
  await expect(field).toContainText('HelXlo{{company_name}}');
  await page.getByText('Edit HTML', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message body', exact: true })).toHaveValue(/<(b|strong)>/);
  await page.getByText('Edit HTML', { exact: true }).click();
  await expect(field).toContainText('HelXlo{{company_name}}');
  await page.getByRole('switch', { name: 'Enable follow-ups for this outreach' }).check();
  await page.getByLabel('Follow-up 1 delay', { exact: true }).fill('120');
  await page.getByLabel('Follow-up 1 message', { exact: true }).fill('Checking in with {{first_name}}');
  await field.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('email-creator-formatted.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review outreach', exact: true }).click();
  await expect(page.getByText('HelXloOrchid Labs', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('email-creator-formatted-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send to 1 recipient', exact: true }).click();
  await expect.poll(() => mock.state.batches.length).toBe(1);
  const messages = mock.state.batches[0].messages as Array<{ message: string; htmlContent: string; followUps: unknown[] }>;
  expect(messages[0].message).toBe('HelXloOrchid Labs');
  expect(messages[0].htmlContent).toMatch(/<(b|strong)>/);
  expect(mock.state.batches[0].followUpSource).toBe('outreach');
  expect(mock.state.batches[0].useSavedFollowUpSettings).toBeUndefined();
  expect(mock.state.globalSettingsRequests).toEqual([]);
  expect(messages[0].followUps).toEqual([{ delayMinutes: 120, message: 'Checking in with Asha' }]);
});

for (const channel of ['email', 'whatsapp', 'instagram', 'facebook', 'sms']) {
  test(`${channel} outreach offers local follow-ups without changing global settings`, async ({ page }, testInfo) => {
    const mock = await installLibrary(page); mock.state.followUpsEnabled = true;
    await page.goto(`/dashboard/outreach/create?channel=${channel}&leadId=1`, { waitUntil: 'domcontentloaded' });
    const settings = page.getByRole('region', { name: 'Follow-ups for this outreach' });
    await expect(settings).toContainText('Your channel defaults stay unchanged.');
    const enabled = settings.getByRole('switch', { name: 'Enable follow-ups for this outreach' });
    await expect(enabled).not.toBeChecked();
    await enabled.check();
    await settings.getByLabel('Follow-up 1 delay', { exact: true }).fill('2');
    await settings.getByLabel('Follow-up 1 delay unit').selectOption('hours');
    if (channel === 'whatsapp') {
      await settings.getByRole('button', { name: /Choose a template/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: /welcome/ }).click();
      await page.getByLabel('Body variable 1').fill('{{first_name}}');
      await page.getByRole('button', { name: 'Use template', exact: true }).click();
      await expect(settings.getByRole('button', { name: /welcome/ })).toBeVisible();
    } else await settings.getByLabel('Follow-up 1 message').fill('Checking in with {{first_name}}');
    await settings.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`local-${channel}-follow-ups.png`), fullPage: true });
    expect(mock.state.globalSettingsRequests).toEqual([]);
    expect(mock.state.batches).toHaveLength(0);
  });
}

test('global settings failure does not block reviewing a local outreach', async ({ page }) => {
  const mock = await installLibrary(page); mock.state.followUpFailures = 99;
  await page.goto('/dashboard/outreach/create?channel=email&leadId=1');
  await page.getByLabel('Subject', { exact: true }).fill('Local outreach');
  await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Keep this Email draft');
  await expect(page.getByRole('button', { name: 'Review outreach', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review outreach', exact: true }).click();
  await expect(page.getByText('Keep this Email draft', { exact: true })).toBeVisible();
  expect(mock.state.globalSettingsRequests).toEqual([]);
});
