import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { installOutreachReview } from './fixtures/outreach-review';
import { createHash } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { responseWrapper } from '../../server/middleware/responseWrapper';

test.use({ timezoneId: 'Asia/Kolkata', actionTimeout: 15_000, video: 'off' });
test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('followUpBrowserErrors', () => errors);
});
test.afterEach(async ({ page, audit }) => {
  expect(await page.evaluate(() => (window as unknown as { followUpBrowserErrors: () => Promise<string[]> }).followUpBrowserErrors())).toEqual([]);
  expect(audit.consoleErrors.filter(error => !/status of (409|503)|net::ERR_(FAILED|ABORTED)/.test(error))).toEqual([]);
});

async function installContracts(page: Page) {
  const base = await installOutreachReview(page, 'light');
  const state = {
    templateFailure: false, settingsFailure: false, templatePosts: 0, settingsPuts: 0, settingsCompleted: 0, allowEnabledSave: false,
    saveBarrier: null as Promise<void> | null, loseSaveResponse: false, staleReads: 0, loseTemplateResponse: false,
    readBarrier: null as Promise<void> | null, settingsHeldReads: 0,
    settingsReads: [] as string[],
    previousSettings: null as { enableAutoFollowUp: boolean; followUpSteps: Array<Record<string, unknown>>; revision: string } | null,
    templateReceipts: new Map<string, { body: string; template: Record<string, unknown> }>(),
    templates: [{ id: 77, name: 'Synthetic approved follow-up', type: 'email', content: 'Hi {{first_name}}', isApproved: true }],
    settings: {} as Record<string, { enableAutoFollowUp: boolean; followUpSteps: Array<Record<string, unknown>>; revision: string; fenced: boolean }>,
  };
  const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const wire = (body: unknown, status = 200) => {
    const res = { statusCode: status, json: (value: unknown) => value };
    responseWrapper({} as never, res as never, () => {});
    return res.json(body);
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: wire(body, status) });
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    if (path === '/api/outreach-conversations/bulk') throw new Error('Campaign execution is disabled in this fixture');
    const channel = path.match(/^\/api\/settings\/integrations\/(\w+)\/follow-ups$/)?.[1];
    if (channel) {
      const business = req.headers()['x-business-profile-id'] || '4102';
      const settingsKey = business === '4102' ? channel : `${business}:${channel}`;
      if (req.method() === 'GET') {
        state.settingsReads.push(business);
        if (state.readBarrier) { state.settingsHeldReads++; await state.readBarrier; }
      }
      const saved = state.settings[settingsKey] ||= { enableAutoFollowUp: false, followUpSteps: [
        { id: 1, delayValue: 1, delayUnit: 'hours', delayHours: 1, templateId: -1, templateName: 'Auto-generate' },
        { id: 2, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: -1, templateName: 'Auto-generate' },
      ], revision: revision(settingsKey), fenced: true };
      if (req.method() === 'PUT') {
        state.settingsPuts++;
        const body = req.postDataJSON();
        if (body.enableAutoFollowUp !== false && !state.allowEnabledSave) throw new Error('Synthetic sequences must stay disabled');
        if (state.saveBarrier) await state.saveBarrier;
        const current = state.settings[settingsKey];
        state.settingsCompleted++;
        const identical = JSON.stringify([body.enableAutoFollowUp, body.followUpSteps]) === JSON.stringify([current.enableAutoFollowUp, current.followUpSteps]);
        if (state.settingsFailure || (body.expectedRevision !== current.revision && !identical)) return json(route, { error: 'These follow-up settings changed elsewhere.', code: 'FOLLOW_UP_SETTINGS_CONFLICT' }, 409);
        state.previousSettings = current;
        const advanced = !(identical && body.expectedRevision !== current.revision);
        const updated = !advanced ? current : { ...body, revision: revision([settingsKey, state.settingsCompleted, body.followUpSteps]), fenced: true };
        state.settings[settingsKey] = updated;
        if (state.loseSaveResponse) return route.abort('failed');
        return json(route, { success: true, advanced, ...updated });
      }
      if (state.staleReads > 0 && state.previousSettings) { state.staleReads--; return json(route, state.previousSettings); }
      return json(route, saved);
    }
    if (path === '/api/content/templates' && req.method() === 'POST') {
      state.templatePosts++;
      const body = req.postDataJSON();
      if (state.templateFailure) return json(route, { error: 'Approve the selected business profile before generating content.', code: 'BUSINESS_PROFILE_NOT_APPROVED' }, 409);
      if (!['email', 'whatsapp', 'sms', 'social_message'].includes(body.type)) return json(route, { error: 'Invalid type' }, 400);
      const key = req.headers()['idempotency-key'];
      if (!key) throw new Error('Template creates require a synthetic recovery key');
      const replay = state.templateReceipts.get(key);
      if (replay && replay.body !== JSON.stringify(body)) return json(route, { error: 'Different content', code: 'TEMPLATE_CREATE_KEY_CONFLICT' }, 409);
      const saved = replay?.template || { ...body, id: 100 + state.templatePosts, isApproved: true };
      if (!replay) { state.templates.push(saved as typeof state.templates[number]); state.templateReceipts.set(key, { body: JSON.stringify(body), template: saved }); }
      if (state.loseTemplateResponse) return route.abort('failed');
      return route.fulfill({ status: 201, json: wire(saved, 201), headers: {
        'Content-Request-Confirmed': 'true',
        'Access-Control-Expose-Headers': 'Content-Request-Confirmed, Idempotency-Replayed',
      } });
    }
    if (path === '/api/content/templates' && req.method() === 'GET') {
      const templates = state.templates.filter(template => template.type === url.searchParams.get('type'));
      return json(route, { templates, total: templates.length });
    }
    if (path.startsWith('/api/content/templates/') && req.method() === 'PUT') {
      const item = state.templates.find(template => template.id === Number(path.split('/').at(-1)));
      if (!item) return json(route, { error: 'Not found' }, 404);
      Object.assign(item, req.postDataJSON()); return json(route, item);
    }
    if (path.startsWith('/api/content/templates/') && req.method() === 'DELETE') {
      state.templates = state.templates.filter(template => template.id !== Number(path.split('/').at(-1)));
      return json(route, { message: 'Template deleted' });
    }
    return route.fallback();
  });
  return { state, base };
}

async function createTemplate(page: Page, name: string, content: string) {
  await page.getByRole('button', { name: 'Create template for step 1', exact: true }).click();
  await page.getByLabel('Template name', { exact: true }).fill(name);
  await page.getByLabel('Message', { exact: true }).fill(content);
}

for (const channel of ['email', 'whatsapp'] as const) {
  test(`${channel} create template after timing, save, reload, edit and cancelled dialog`, async ({ page, audit }, info) => {
    const { state, base } = await installContracts(page);
    await page.goto(`/dashboard/outreach/follow-ups?channel=${channel}`);
    await page.getByLabel('Step 1 delay', { exact: true }).fill('2');
    await createTemplate(page, `Synthetic ${channel} follow-up`, 'Hello {{first_name}}, checking in.');
    await page.getByRole('button', { name: 'Create template', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose template for step 1' })).toContainText(`Synthetic ${channel} follow-up`);
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeEnabled();
    await page.reload();
    await expect(page.getByLabel('Step 1 delay', { exact: true })).toHaveValue('2');
    await expect(page.getByRole('button', { name: 'Choose template for step 1' })).toContainText(`Synthetic ${channel} follow-up`);
    await page.getByLabel('Step 1 delay', { exact: true }).fill('3');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeEnabled();
    await page.reload();
    await expect(page.getByLabel('Step 1 delay', { exact: true })).toHaveValue('3');
    await createTemplate(page, 'Discard synthetic draft', 'Discard synthetic private wording');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Create template for step 1', exact: true }).click();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('tab', { name: 'Templates', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Synthetic ${channel} follow-up`, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`${channel}-saved-follow-up-template.png`), fullPage: true });
    expect(state.templatePosts).toBe(1);
    expect(state.settingsPuts).toBe(2);
    expect(base.batches).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });
}


test('lost template-create responses reconcile through the same key and create one library record', async ({ page }) => {
  const { state, base } = await installContracts(page); state.loseTemplateResponse = true;
  await page.goto('/dashboard/outreach/follow-ups?channel=email');
  await createTemplate(page, 'Synthetic lost receipt', 'Hello {{first_name}}');
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  expect(state.templates.filter(item => item.name === 'Synthetic lost receipt')).toHaveLength(1);
  state.loseTemplateResponse = false;
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose template for step 1' })).toContainText('Synthetic lost receipt');
  expect(state.templatePosts).toBe(2); expect(state.templateReceipts.size).toBe(1);
  expect(state.templates.filter(item => item.name === 'Synthetic lost receipt')).toHaveLength(1);
  expect(base.batches).toEqual([]);
});


test('a production-wrapped confirmed create can be deleted and recreated with identical content and a new key', async ({ page }) => {
  const { state, base } = await installContracts(page);
  await page.goto('/dashboard/outreach/follow-ups?channel=email');
  await createTemplate(page, 'Synthetic repeatable template', 'Hello {{first_name}}');
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose template for step 1' })).toContainText('Synthetic repeatable template');
  const first = state.templates.find(template => template.name === 'Synthetic repeatable template')!.id;
  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  await page.getByRole('link', { name: 'Open full template library', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Synthetic repeatable template', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic repeatable template', exact: true })).toHaveCount(0);
  await page.goto('/dashboard/outreach/follow-ups?channel=email');
  await createTemplate(page, 'Synthetic repeatable template', 'Hello {{first_name}}');
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose template for step 1' })).toContainText('Synthetic repeatable template');
  expect(state.templates.find(template => template.name === 'Synthetic repeatable template')!.id).not.toBe(first);
  expect(state.templateReceipts.size).toBe(2);
  expect(base.batches).toEqual([]);
});
