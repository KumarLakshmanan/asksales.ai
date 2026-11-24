import { expect, test } from './fixtures/app';

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/api/whatsapp/config', route => route.fulfill({ json: { configured: true, config: { businessAccountId: 'test-waba', wabaName: 'Test Business', connectionStatus: 'ready', tokenStatus: 'valid' } } }));
});

test('canonical WhatsApp create, view, edit, reload, and safe sync lifecycle', async ({ page, audit }) => {
  const providerCalls: string[] = [];
  let template = {
    id: 17,
    name: 'appointment_reminder',
    language: 'en_US',
    category: 'UTILITY',
    status: 'DRAFT',
    metaStatus: null as string | null,
    header: null,
    headerType: 'NONE',
    body: 'Hi {{1}}, your appointment is tomorrow.',
    footer: '',
    buttons: [],
    wabaTemplateId: null as string | null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };

  await page.route(/\/api\/whatsapp\/templates(?:\?.*)?$/, async route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: { success: true, templates: [template] } });
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      template = { ...template, ...body, id: 17 };
      return route.fulfill({ json: { success: true, template } });
    }
    return route.fallback();
  });
  await page.route('**/api/whatsapp/templates/17', async route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: { success: true, template } });
    if (method === 'PUT') {
      template = { ...template, ...route.request().postDataJSON() };
      return route.fulfill({ json: { success: true, template } });
    }
    return route.fallback();
  });
  await page.route('**/api/whatsapp/templates/sync', async route => {
    providerCalls.push('safe-whatsapp-sync');
    template = { ...template, wabaTemplateId: 'double-template-17', metaStatus: 'APPROVED', status: 'APPROVED' };
    await route.fulfill({ json: { success: true, count: 1 } });
  });

  await page.goto('/dashboard/integrations/whatsapp/templates/create');
  await expect(page.getByRole('heading', { name: 'Create template' })).toBeVisible();
  await page.getByRole('button', { name: 'Guided', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel(/Template name/).fill('regression_offer');
  await page.getByLabel('Body', { exact: true }).fill('Your appointment is tomorrow.');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Save new WhatsApp template' }).click();

  await expect(page).toHaveURL(/\/dashboard\/integrations\/whatsapp\/templates$/);
  await expect(page.getByText('regression_offer')).toBeVisible();
  await page.getByRole('button', { name: 'View' }).click();
  await expect(page).toHaveURL(/\/templates\/17(?:\?.*)?$/);
  await expect(page.getByRole('heading', { name: 'regression_offer' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'regression_offer' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Guided', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel(/Template name/).fill('regression_offer_v2');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Save WhatsApp template changes' }).click();
  await expect(page.getByRole('heading', { name: 'regression_offer_v2' })).toBeVisible();

  await page.goto('/dashboard/integrations/whatsapp/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  await expect.poll(() => providerCalls).toEqual(['safe-whatsapp-sync']);
  await expect(page.getByRole('article').getByText('Meta approved', { exact: true })).toBeVisible();
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
