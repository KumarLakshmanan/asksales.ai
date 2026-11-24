import type { Locator, Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/api/whatsapp/config', route => route.fulfill({ json: { configured: true, config: { businessAccountId: 'test-waba', wabaName: 'Test Business', connectionStatus: 'ready', tokenStatus: 'valid' } } }));
});

async function openComponents(page: Page) {
  const toggle = page.getByRole('button', { name: 'Template components', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}

async function dragComponent(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  if (!from) throw new Error('Drag source is not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 2 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error('Drag destination is not visible');
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(40, to.height / 2), { steps: 15 });
  await page.mouse.up();
}

test('default builder creates, switches views, saves incomplete-safe drafts, and edits the message', async ({ page, audit }, testInfo) => {
  let saved: Record<string, unknown> | null = null;
  const writes: { method: string; payload: Record<string, unknown> }[] = [];
  await page.route(/\/api\/whatsapp\/templates(?:\?.*)?$/, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { success: true, templates: saved ? [saved] : [] } });
    const payload = route.request().postDataJSON();
    writes.push({ method: route.request().method(), payload });
    saved = { ...payload, id: 17, status: 'DRAFT', wabaTemplateId: null, metaStatus: null, hasLocalChanges: true };
    return route.fulfill({ json: { success: true, template: saved } });
  });
  await page.route('**/api/whatsapp/templates/17', async route => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON();
      writes.push({ method: 'PUT', payload });
      saved = { ...saved, ...payload };
    }
    await route.fulfill({ json: { success: true, template: saved } });
  });

  await page.goto('/dashboard/integrations/whatsapp/templates/create');
  await expect(page.getByRole('button', { name: 'Builder', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel(/Template name/).fill('builder_offer');
  await page.getByLabel('Body', { exact: true }).fill('Hello Alex.');
  await page.getByLabel('Body', { exact: true }).evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(6, 10));
  await page.getByRole('button', { name: 'Bold text', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hello *Alex*.');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add text header', exact: true }).click();
  await page.getByLabel('Header text', { exact: true }).fill('Hello ');
  await page.getByRole('button', { name: 'Add header variable', exact: true }).click();
  await page.getByLabel('Example for header {{1}}', { exact: true }).fill('Customer');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add URL button', exact: true }).click();
  await page.getByLabel('Button 1 text', { exact: true }).fill('Shop now');
  await page.getByLabel('Button 1 URL', { exact: true }).fill('https://example.com');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add quick reply', exact: true }).click();
  await page.getByLabel('Button 2 text', { exact: true }).fill('Get details');
  await page.getByRole('button', { name: 'Move button 2 up', exact: true }).click();

  const mobile = testInfo.project.name === 'mobile-chromium';
  await page.getByRole('heading', { name: 'Create template', exact: true }).scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  if (mobile) {
    await page.screenshot({ path: '/tmp/whatsapp-builder-mobile-editor.png', fullPage: true });
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  }
  const phone = page.getByRole('region', { name: 'Template preview' });
  await expect(phone).toBeVisible();
  await expect(phone.getByText('Hello Customer', { exact: true })).toBeVisible();
  await expect(phone.locator('strong')).toHaveText('Alex');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `/tmp/whatsapp-builder-${testInfo.project.name}.png`, fullPage: true });
  if (mobile) await page.getByRole('tab', { name: 'Editor', exact: true }).click();

  await page.getByRole('button', { name: 'Guided', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hello *Alex*.');
  await expect(page.getByLabel('Button 1 text', { exact: true })).toHaveValue('Get details');
  await page.getByRole('button', { name: 'Builder', exact: true }).click();
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/whatsapp\/templates$/);
  expect(writes[0].payload.buttons).toEqual([
    { type: 'QUICK_REPLY', text: 'Get details' },
    { type: 'URL', text: 'Shop now', url: 'https://example.com' },
  ]);

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/17(?:\?.*)?$/);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/17\/edit(?:\?.*)?$/);
  await expect(page.getByRole('button', { name: 'Builder', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Example for header {{1}}', { exact: true })).toHaveValue('Customer');
  await page.getByLabel('Body', { exact: true }).fill('Your appointment has been updated.');
  await page.getByRole('button', { name: 'Save WhatsApp template changes', exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/17(?:\?.*)?$/);
  expect(writes[1]).toMatchObject({ method: 'PUT', payload: { body: 'Your appointment has been updated.' } });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('component drops and keyboard alternatives preserve section order and the button limit', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/integrations/whatsapp/templates/create');
  await expect(page.getByRole('button', { name: 'Builder', exact: true })).toBeVisible();
  await openComponents(page);
  await page.getByRole('button', { name: 'Add URL button', exact: true }).click();
  await page.getByLabel('Button 1 text', { exact: true }).fill('Shop now');
  await page.getByLabel('Button 1 URL', { exact: true }).fill('https://example.com');
  await openComponents(page);
  const mobile = testInfo.project.name === 'mobile-chromium';
  if (mobile) {
    await page.getByRole('button', { name: 'Add document header', exact: true }).click();
    await openComponents(page);
    await page.getByRole('button', { name: 'Add quick reply', exact: true }).click();
    await page.getByRole('button', { name: 'Move button 1 down', exact: true }).click();
  } else {
    await dragComponent(page, page.getByRole('button', { name: 'Drag document header', exact: true }), page.getByTestId('header-drop-target'));
    await expect(page.getByLabel('Header type', { exact: true })).toHaveValue('DOCUMENT');
    await openComponents(page);
    await dragComponent(page, page.getByRole('button', { name: 'Drag text header', exact: true }), page.getByRole('heading', { name: 'Create template', exact: true }));
    await expect(page.getByLabel('Header type', { exact: true })).toHaveValue('DOCUMENT');
    await dragComponent(page, page.getByRole('button', { name: 'Drag quick reply', exact: true }), page.getByTestId('buttons-drop-target'));
    await expect(page.getByLabel('Button 2 text', { exact: true })).toHaveValue('Reply');
    await dragComponent(page, page.getByRole('button', { name: 'Reorder button 1', exact: true }), page.getByTestId('template-button-2'));
  }
  await expect(page.getByLabel('Button 1 text', { exact: true })).toHaveValue('Reply');
  await expect(page.getByLabel('Button 2 URL', { exact: true })).toHaveValue('https://example.com');
  if (!mobile) {
    await page.getByRole('button', { name: 'Reorder button 1', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'Reorder button 1', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Reorder button 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('status').filter({ hasText: 'button position 2' })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByLabel('Button 1 text', { exact: true })).toHaveValue('Shop now');
  }
  await openComponents(page);
  await page.getByRole('button', { name: 'Add quick reply', exact: true }).click();
  await openComponents(page);
  await expect(page.getByRole('button', { name: 'Add URL button', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Drag URL button', exact: true })).toBeDisabled();
  await page.getByLabel('WhatsApp header media URL', { exact: true }).fill('https://example.test/sample.pdf');
  await expectNoHorizontalOverflow(page);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  if (mobile) await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Template preview' })).toBeVisible();
  await page.screenshot({ path: `/tmp/whatsapp-builder-dark-${testInfo.project.name}.png`, fullPage: true });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
