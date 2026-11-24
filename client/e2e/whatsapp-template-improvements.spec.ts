import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { validateWhatsAppTemplateInput } from '../../server/utils/whatsappTemplatePayload';
import { test, expect as baseExpect, expectNoHorizontalOverflow } from './fixtures/app';

const expect = baseExpect.configure({ timeout: 60_000 });
const base = '/dashboard/integrations/whatsapp/templates';
const seed: Record<string, unknown> = { id: 17, name: 'appointment_reminder', language: 'en_US', category: 'UTILITY', status: 'DRAFT', headerType: 'NONE', header: null, body: 'Hello {{1}}, your appointment is tomorrow.', examples: { 'body:1': 'Alex' }, variableLabels: { 'body:1': 'Customer name' }, footer: '', buttons: [], hasLocalChanges: true, updatedAt: '2026-10-03T01:00:00Z', revision: '2026-10-03 01:00:00', activityHistory: [{ at: '2026-10-03T01:00:00Z', action: 'created', snapshot: { body: 'Hello {{1}}, your appointment is tomorrow.' } }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xXikAAAAASUVORK5CYII=', 'base64');

async function capture(page: Page, info: TestInfo, name: string) {
  const directory = process.env.WHATSAPP_REVIEW_ARTIFACT_DIR || info.outputDir;
  await mkdir(directory, { recursive: true });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(directory, `${info.project.name}-${name}.png`), fullPage: true, animations: 'disabled' });
}
async function components(page: Page) {
  const toggle = page.getByRole('button', { name: 'Template components', exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
async function preview(page: Page) {
  const toggle = page.getByRole('tab', { name: 'Preview', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}
async function editor(page: Page) {
  const toggle = page.getByRole('tab', { name: 'Editor', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}
async function install(page: Page, initial = [seed]) {
  const records = new Map(initial.map(record => [Number(record.id), { ...record }]));
  const writes: Record<string, unknown>[] = [];
  let nextId = 100;
  await page.route('**/api/whatsapp/config', route => route.fulfill({ json: { configured: true, config: { businessAccountId: 'test-waba', wabaName: 'Review Business', tokenStatus: 'valid', connectionStatus: 'ready' } } }));
  await page.route(/\/api\/whatsapp\/templates(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') {
      const payload = route.request().postDataJSON();
      const parsed = validateWhatsAppTemplateInput(payload, { draftOnly: payload.draftOnly === true });
      if (!parsed.data) return route.fulfill({ status: 400, json: { error: parsed.error } });
      writes.push(payload);
      const record = { ...seed, ...parsed.data, id: nextId++ };
      records.set(record.id, record);
      return route.fulfill({ json: { success: true, template: record } });
    }
    const query = new URL(route.request().url()).searchParams;
    const all = [...records.values()];
    const filtered = all.filter(record => (!query.get('search') || String(record.name).includes(query.get('search')!)) && (!query.get('category') || query.get('category') === 'ALL' || record.category === query.get('category')) && (!query.get('language') || query.get('language') === 'ALL' || record.language === query.get('language')) && (!query.get('status') || query.get('status') === 'ALL' || (record.wabaTemplateId ? record.metaStatus : 'LOCAL_ONLY') === query.get('status')));
    if (query.get('sort') === 'name_asc') filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const current = Number(query.get('page') || 1), size = Number(query.get('pageSize') || 6);
    await route.fulfill({ json: { success: true, templates: filtered.slice((current - 1) * size, current * size), total: filtered.length, page: current, pageSize: size, statusCounts: { LOCAL_ONLY: all.length }, languages: ['en_US', 'ta'] } });
  });
  await page.route(/\/api\/whatsapp\/templates\/\d+$/, async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON();
      const parsed = validateWhatsAppTemplateInput(payload, { draftOnly: payload.draftOnly === true });
      if (!parsed.data) return route.fulfill({ status: 400, json: { error: parsed.error } });
      writes.push(payload); records.set(id, { ...records.get(id), ...parsed.data, id });
    }
    await route.fulfill({ json: { success: true, template: records.get(id) } });
  });
  return { records, writes };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style'); style.textContent = 'nextjs-portal{display:none!important}'; document.head.appendChild(style);
    });
  });
  page.on('dialog', dialog => dialog.accept());
});

test('blank and incomplete drafts save and reload in builder and guided modes', async ({ page }, info) => {
  const { writes } = await install(page, []);
  await page.goto(`${base}/create`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('');
  await expect(page.getByText('Shop now', { exact: true })).toHaveCount(0);
  await capture(page, info, '01-blank-create');
  await page.getByLabel(/Template name/).fill('unfinished_appointment');
  await page.getByLabel('Body', { exact: true }).fill('Hello {{1}},');
  await components(page); await page.getByRole('button', { name: 'Add URL button', exact: true }).click();
  await expect(page.getByLabel('Button 1 URL')).toHaveValue('');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /View checklist/ }).click();
  await capture(page, info, '02-incomplete-review');
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  expect(writes[0]).toMatchObject({ draftOnly: true, examples: { 'body:1': '' }, buttons: [{ type: 'URL', url: '' }] });
  await capture(page, info, '03-template-list');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page).toHaveURL(/\/100\?returnTo=/);
  await expect(page.getByRole('heading', { name: 'unfinished_appointment', exact: true })).toBeVisible();
  await capture(page, info, '04-template-details');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hello {{1}},');
  await expect(page.getByLabel('Example for body {{1}}')).toHaveValue('');
  await page.getByRole('button', { name: 'Guided', exact: true }).click();
  await capture(page, info, '05-guided-setup');
  await expect(page.getByRole('button', { name: 'Save WhatsApp template changes', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await capture(page, info, '06-guided-message');
  await page.getByRole('button', { name: 'Save WhatsApp template changes', exact: true }).click();
  await expect(page).toHaveURL(/\/100\?returnTo=/);
  expect(writes).toHaveLength(2);
});

test('refresh recovers unfinished text and labels without pretending an unuploaded file survived', async ({ page }, info) => {
  await install(page, []);
  await page.goto(`${base}/create`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Template name/).fill('recover_message');
  await page.getByLabel('Body', { exact: true }).fill('Hi {{1}}, this text is unfinished.');
  await page.getByLabel('Label for body {{1}}').fill('Customer name');
  await components(page); await page.getByRole('button', { name: 'Add image header', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await (await chooser).setFiles({ name: 'unfinished.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText(/Recovery copy saved at/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore unfinished work', exact: true })).toBeVisible();
  await capture(page, info, '07-recovery-available');
  await page.getByRole('button', { name: 'Restore unfinished work', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hi {{1}}, this text is unfinished.');
  await expect(page.getByLabel('Label for body {{1}}')).toHaveValue('Customer name');
  await expect(page.getByText(/Reattach unfinished.png/)).toBeVisible();
  await capture(page, info, '08-recovered-draft');
});

test('message editing, labels, preview modes and approval review preserve content', async ({ page }, info) => {
  const { writes } = await install(page, []);
  await page.goto(`${base}/create`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/Template name/).fill('appointment_ready');
  await page.getByRole('button', { name: 'Utility', exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Hi {{1}}, your appointment is *tomorrow*.');
  await page.getByLabel('Label for body {{1}}').fill('Customer name');
  await page.getByLabel('Example for body {{1}}').fill('Alex');
  await components(page); await page.getByRole('button', { name: 'Add URL button', exact: true }).click();
  await page.getByLabel('Button 1 URL').fill('https://example.com/appointment');
  await capture(page, info, '09-message-builder');
  await preview(page); await page.getByRole('button', { name: 'Show sample values in preview' }).click();
  await expect(page.getByRole('region', { name: 'Template preview' })).toContainText('Hi {{1}},');
  await capture(page, info, '10-placeholder-preview');
  await editor(page); await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByText('Review Business · test-waba')).toBeVisible();
  await expect(page.getByText('Visit website → https://example.com/appointment')).toBeVisible();
  await capture(page, info, '11-complete-review');
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  expect(writes[0]).toMatchObject({ variableLabels: { 'body:1': 'Customer name' }, examples: { 'body:1': 'Alex' } });
});

test('authentication has genuine copy-code and one-tap settings and saved payloads', async ({ page }, info) => {
  const { writes } = await install(page, []);
  await page.goto(`${base}/create`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Authentication', exact: true }).click();
  await page.getByLabel(/Template name/).fill('verification_code');
  await expect(page.getByLabel('Body', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Template components', exact: true })).toHaveCount(0);
  await page.getByLabel('OTP button label').fill('Copy verification code');
  await capture(page, info, '12-authentication-copy-code');
  await page.getByLabel('OTP button type').selectOption('ONE_TAP');
  await page.getByLabel('Autofill button label').fill('Autofill code');
  await page.getByLabel('Android package name').fill('com.example.app');
  await page.getByLabel('App signature hash').fill('abcdefghijk');
  await capture(page, info, '13-authentication-one-tap');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeEnabled();
  await capture(page, info, '14-authentication-review');
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  expect(writes[0]).toMatchObject({ category: 'AUTHENTICATION', headerType: 'NONE', buttons: [], authConfig: { otpType: 'ONE_TAP', packageName: 'com.example.app', signatureHash: 'abcdefghijk' } });
});

test('AI suggestions require Apply, Undo restores the original, and oversized copy is not cut silently', async ({ page }, info) => {
  await install(page, []); let attempt = 0;
  await page.route('**/api/content/studio/social-message', route => route.fulfill({ json: { success: true, message: ++attempt === 1 ? 'Hello {{customer}}, your booking is ready.' : 'A'.repeat(1100) } }));
  await page.goto(`${base}/create`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Body', { exact: true }).fill('My original message.');
  await page.getByRole('button', { name: /^Generate with AI/ }).click();
  await page.getByLabel('WhatsApp AI brief').fill('A brief booking confirmation');
  await page.getByRole('button', { name: 'Generate copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply generated copy', exact: true })).toBeVisible();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('My original message.');
  await capture(page, info, '15-ai-suggestion');
  await page.getByRole('button', { name: 'Apply generated copy', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hello {{1}}, your booking is ready.');
  await page.getByRole('button', { name: 'Undo applied AI copy', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('My original message.');
  await page.getByRole('button', { name: 'Generate copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply generated copy', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('My original message.');
  await capture(page, info, '16-ai-length-feedback');
});

test('library table, server filters and return navigation keep the chosen view', async ({ page }, info) => {
  await install(page, Array.from({ length: 8 }, (_, i) => ({ ...seed, id: i + 1, name: `appointment_${i + 1}` })));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Table view', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await capture(page, info, '17-library-table');
  await page.getByLabel('Sort templates').selectOption('name_asc');
  await page.getByLabel('Search templates').fill('appointment_1');
  await expect(page.getByRole('status')).toHaveText('Showing 1 of 1 templates');
  await page.getByRole('row').filter({ has: page.getByText('appointment_1', { exact: true }) }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page).toHaveURL(/returnTo=/);
  await page.getByRole('button', { name: 'Back to templates', exact: true }).click();
  await expect(page.getByLabel('Search templates')).toHaveValue('appointment_1');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Pattern library', exact: true }).click();
  await capture(page, info, '18-task-pattern-library');
});

test('details refresh, history, approved comparison and secondary actions work', async ({ page }, info) => {
  const { records } = await install(page, [{ ...seed, wabaTemplateId: 'meta-17', metaStatus: 'APPROVED', approvedSnapshot: { body: 'Previously approved message.' } }]);
  await page.route('**/api/whatsapp/templates/17/refresh', route => { records.set(17, { ...records.get(17), lastSyncedAt: '2026-10-03T01:05:00Z', metaStatus: 'REJECTED', metaRejectionReason: 'Review the message category' }); return route.fulfill({ json: { success: true, template: records.get(17) } }); });
  await page.goto(`${base}/17`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Previously approved message.')).toBeVisible();
  await capture(page, info, '19-approved-history');
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByText(/Review the message category/)).toBeVisible();
  await capture(page, info, '20-rejected-status');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: /Delete/ }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await capture(page, info, '21-delete-confirmation');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
});

for (const kind of ['IMAGE', 'VIDEO', 'DOCUMENT'] as const) test(`${kind} attachments preserve selection, upload to the saved draft and reload`, async ({ page }, info) => {
  const { records, writes } = await install(page, []);
  await page.route('**/api/whatsapp/templates/*/media', async route => {
    expect(route.request().headers()['content-type']).toContain('multipart/form-data');
    expect(route.request().postDataBuffer()?.length).toBeGreaterThan(100);
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    const url = '/api/settings/storage/files/234/download'; records.set(id, { ...records.get(id), headerMediaUrl: url });
    await route.fulfill({ json: { url, template: records.get(id) } });
  });
  const media = kind === 'VIDEO' ? await readFile(path.join(__dirname, 'fixtures/whatsapp-preview.mp4')) : kind === 'IMAGE' ? png : Buffer.from('%PDF-1.4\nQA document\n%%EOF');
  await page.route('**/api/settings/storage/files/234/download', route => route.fulfill({ body: media, contentType: kind === 'IMAGE' ? 'image/png' : kind === 'VIDEO' ? 'video/mp4' : 'application/pdf' }));
  await page.goto(`${base}/create`, { waitUntil: 'domcontentloaded' }); await page.getByLabel(/Template name/).fill(`${kind.toLowerCase()}_appointment`);
  await page.getByLabel('Body', { exact: true }).fill('Your appointment is tomorrow.');
  await components(page); await page.getByRole('button', { name: `Add ${kind.toLowerCase()} header`, exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await (await chooser).setFiles({ name: kind === 'IMAGE' ? 'header.png' : kind === 'VIDEO' ? 'header.mp4' : 'header.pdf', mimeType: kind === 'IMAGE' ? 'image/png' : kind === 'VIDEO' ? 'video/mp4' : 'application/pdf', buffer: media });
  await preview(page); await capture(page, info, `22-${kind.toLowerCase()}-preview`); await editor(page);
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`${base}$`));
  expect(writes[0]).toMatchObject({ headerType: kind });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('WhatsApp header media URL')).toHaveValue('/api/settings/storage/files/234/download');
});
