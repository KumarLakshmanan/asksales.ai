import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
});

test('ongoing editor retains a stale draft, reloads explicitly and saves the current version', async ({ page }, info) => {
  let saved = { id: 42, name: 'Saved brand', version: 4, isDefault: true };
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/api/content/brand-toolkits**', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body);
      if (writes.length === 1) {
        saved = { ...saved, name: 'Another tab brand', version: 5 };
        return route.fulfill({ status: 409, json: { code: 'TOOLKIT_VERSION_CONFLICT', error: 'This brand toolkit changed. Reload it before saving.' } });
      }
      expect(body.expectedVersion).toBe(saved.version);
      saved = { ...saved, ...body, version: saved.version + 1 };
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/42') ? saved : [saved] });
  });
  await page.goto('/dashboard/brand-toolkit/42');
  await page.getByRole('textbox', { name: 'Brand Name', exact: true }).fill('My unsaved draft');
  await page.getByRole('button', { name: 'Social Media', exact: true }).click();
  await page.getByRole('button', { name: 'Update Toolkit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reload saved toolkit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update Toolkit', exact: true })).toBeDisabled();
  expect(writes[0].expectedVersion).toBe(4);
  await page.getByRole('button', { name: 'Brand Details', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Brand Name', exact: true })).toHaveValue('My unsaved draft');
  await expect(page.getByRole('heading', { name: 'Brand Details', exact: true }).locator('../..')).toHaveCSS('opacity', '1');
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  await page.screenshot({ path: info.outputPath('retained-conflict.png') });
  await page.getByRole('button', { name: 'Reload saved toolkit' }).click();
  await expect(page.getByRole('textbox', { name: 'Brand Name', exact: true })).toHaveValue('Another tab brand');
  await page.getByRole('textbox', { name: 'Brand Name', exact: true }).fill('Reviewed current brand');
  await page.getByRole('button', { name: 'Social Media', exact: true }).click();
  await page.getByRole('button', { name: 'Update Toolkit', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/brand-toolkit$/);
  await expect(page.getByRole('heading', { name: 'Reviewed current brand', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reviewed current brand', exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1].expectedVersion).toBe(5);
  await expectNoHorizontalOverflow(page);
});

test('a failed toolkit load has an explicit retry and never submits fallback form data', async ({ page }) => {
  let available = false; const writes: string[] = [];
  await page.route('**/api/content/brand-toolkits/42', route => {
    if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.fulfill({ status: 409, json: {} }); }
    return !available ? route.fulfill({ status: 503, json: { error: 'Synthetic temporary outage' } }) : route.fulfill({ json: { id: 42, name: 'Recovered brand', version: 9 } });
  });
  await page.goto('/dashboard/brand-toolkit/42');
  await expect(page.getByRole('heading', { name: 'Unable to load this brand toolkit' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Brand Name', exact: true })).toHaveCount(0);
  available = true;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Brand Name', exact: true })).toHaveValue('Recovered brand');
  expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
});

test('calendar renders editorial cancellation and timezone-aware dates after reload', async ({ page }, info) => {
  await page.route('**/api/settings/preferences', route => route.fulfill({ json: { theme: 'light', language: 'en', timezone: 'America/New_York' } }));
  await page.clock.setFixedTime(new Date('2026-11-01T06:30:00Z'));
  const reads: string[] = [];
  await page.route('**/api/content/calendar?*', route => {
    reads.push(route.request().url());
    return route.fulfill({ json: { success: true, items: [{ id: 17, sourceKey: 'plan-8-17', title: 'Cancelled editorial plan', content: 'Editorial copy', contentPlanId: 8, plan_id: 8, platform: 'instagram', scheduled_date: '2026-11-01', scheduled_time: '01:30', type: 'post', status: 'cancelled', providerBacked: false }] } });
  });
  await page.goto('/dashboard/content-calendar');
  await expect(page.getByText(/scheduled social publishing · America\/New_York/)).toBeVisible();
  await page.getByRole('button', { name: 'Open Cancelled editorial plan', exact: true }).click();
  const drawer = page.getByTestId('calendar-day-drawer-scroll-region');
  await expect(drawer).toBeVisible();
  await expect.poll(async () => {
    const bounds = await page.getByRole('dialog').boundingBox();
    return Boolean(bounds && bounds.x >= -1 && bounds.x + bounds.width <= page.viewportSize()!.width + 1);
  }).toBe(true);
  await expect(drawer.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /Publish|Retry this destination/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('calendar-cancelled-drawer.png') });
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  expect(reads.some(url => new URL(url).searchParams.get('timezone') === 'America/New_York')).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Cancelled editorial plan', exact: true })).toBeVisible();
});

test('inline logo upload blocks saving while pending and carries the attachment version into the final save', async ({ page }) => {
  let saved = { id: 42, name: 'Saved brand', version: 4, isDefault: true };
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/api/content/brand-toolkits**', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postData()).toMatch(/name="expectedVersion"\r\n\r\n4/);
      await pending;
      saved = { ...saved, version: 5 };
      return route.fulfill({ json: { url: '/uploads/fixture-logo.svg', toolkit: saved } });
    }
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON()); saved = { ...saved, ...writes[0], version: 6 };
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/42') ? saved : [saved] });
  });
  await page.route('**/api/uploads/fixture-logo.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="purple"/></svg>' }));
  await page.goto('/dashboard/brand-toolkit/42');
  await page.getByRole('textbox', { name: 'Brand Name', exact: true }).fill('Unsaved name with new logo');
  await page.getByRole('button', { name: 'Visual Identity', exact: true }).click();
  await page.getByLabel('Brand Logo', { exact: true }).setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByRole('button', { name: 'Upload brand logo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Social Media', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Update Toolkit', exact: true })).toBeDisabled();
  expect(writes).toEqual([]); release();
  await expect(page.getByRole('button', { name: 'Update Toolkit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Update Toolkit', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/brand-toolkit$/);
  expect(writes[0]).toMatchObject({ name: 'Unsaved name with new logo', expectedVersion: 5, logoUrl: '/uploads/fixture-logo.svg' });
  await expectNoHorizontalOverflow(page);
});

test('new toolkit retry reuses its creation receipt after a response failure', async ({ page }) => {
  const writes: Array<Record<string, unknown>> = []; let saved: Record<string, unknown> | undefined;
  await page.route('**/api/content/brand-toolkits', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); writes.push(body);
      if (!saved) { saved = { ...body, id: 88, version: 1 }; return route.fulfill({ status: 503, json: { error: 'Synthetic response lost after commit; retry the same save' } }); }
      expect(body.idempotencyKey).toBe(saved.idempotencyKey);
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: saved ? [saved] : [] });
  });
  await page.goto('/dashboard/brand-toolkit/new');
  await page.getByRole('textbox', { name: 'Brand Name', exact: true }).fill('Creation retry brand');
  await page.getByRole('button', { name: 'Social Media', exact: true }).click();
  await page.getByRole('button', { name: 'Create Toolkit', exact: true }).click();
  await expect(page.getByText('Synthetic response lost after commit; retry the same save')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Toolkit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Create Toolkit', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/brand-toolkit$/);
  await expect(page.getByRole('heading', { name: 'Creation retry brand', exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[0].idempotencyKey).toEqual(expect.any(String));
});
