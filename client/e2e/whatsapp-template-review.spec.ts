import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, TestInfo } from '@playwright/test';
import { validateWhatsAppTemplateInput } from '../../server/utils/whatsappTemplatePayload';
import { expect as appExpect, expectNoHorizontalOverflow, test } from './fixtures/app';

const expect = appExpect.configure({ timeout: 60_000 });

test.beforeEach(async ({ page, audit }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/api/whatsapp/config', route => route.fulfill({ json: { configured: true, config: { businessAccountId: 'test-waba', wabaName: 'Test Business', connectionStatus: 'ready', tokenStatus: 'valid' } } }));
  // Next's development badge covers the compact mobile back button. Hide only
  // the development UI; runtime errors still fail the console audit.
  page.on('pageerror', error => audit.consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const hideDevelopmentUI = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      document.head.appendChild(style);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideDevelopmentUI, { once: true });
    else hideDevelopmentUI();
  });
});

const templatesPath = '/dashboard/integrations/whatsapp/templates';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xXikAAAAASUVORK5CYII=', 'base64');
const draft = {
  id: 17, name: 'appointment_reminder', language: 'en_US', category: 'UTILITY', status: 'DRAFT',
  headerType: 'TEXT', header: 'Appointment update', body: 'Hi {{1}}, your appointment is tomorrow at *10:30 AM*.',
  footer: 'Reply for help', buttons: [{ type: 'URL', text: 'View appointment', url: 'https://example.com/appointment' }],
  examples: { 'body:1': 'Alex' }, wabaTemplateId: null, metaStatus: null, submissionStatus: 'local_draft',
  hasLocalChanges: true, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
};
type RecordData = Record<string, unknown>;

async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.WHATSAPP_REVIEW_ARTIFACT_DIR || info.outputDir;
  await mkdir(directory, { recursive: true });
  await expectNoHorizontalOverflow(page);
  const file = path.join(directory, `${info.project.name}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled', scale: 'css' });
  await info.attach(name, { path: file, contentType: 'image/png' });
}

async function openComponents(page: Page) {
  const toggle = page.getByRole('button', { name: 'Template components', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}

async function openOptional(page: Page, title: string) {
  const section = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: new RegExp(`^${title}`) }) }).first();
  if (await section.count() && !await section.evaluate((details: HTMLDetailsElement) => details.open)) await section.locator('summary').click();
}

async function openPreview(page: Page) {
  const tab = page.getByRole('tab', { name: 'Preview', exact: true });
  if (await tab.isVisible()) await tab.click();
  await expect(page.getByRole('region', { name: 'Template preview', exact: true })).toBeVisible();
}

async function openEditor(page: Page) {
  const tab = page.getByRole('tab', { name: 'Editor', exact: true });
  if (await tab.isVisible()) await tab.click();
}

async function moveToStart(page: Page) {
  await page.getByLabel('Body', { exact: true }).press('ControlOrMeta+A');
  await page.getByLabel('Body', { exact: true }).press('ArrowLeft');
}

async function installTemplates(page: Page, initial: RecordData[] = [draft]) {
  const records = new Map<number, RecordData>(initial.map((record) => [Number(record.id), { ...record }]));
  const writes: { method: string; id: number; payload: RecordData }[] = [];
  let nextId = 100;
  const save = async (route: Route, id: number) => {
    const payload = route.request().postDataJSON();
    // Unlike a permissive fixture, this rejects the same invalid data as the API.
    const result = validateWhatsAppTemplateInput(payload, { draftOnly: payload.draftOnly === true });
    if (result.error) return route.fulfill({ status: 400, json: { error: result.error } });
    writes.push({ method: route.request().method(), id, payload });
    const record = { ...draft, ...records.get(id), ...result.data, id, status: 'DRAFT', hasLocalChanges: true };
    records.set(id, record);
    await route.fulfill({ json: { success: true, template: record } });
  };
  await page.route(/\/api\/whatsapp\/templates(?:\?.*)?$/, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { success: true, templates: [...records.values()] } });
    return save(route, nextId++);
  });
  await page.route(/\/api\/whatsapp\/templates\/\d+$/, async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    if (route.request().method() === 'PUT') return save(route, id);
    await route.fulfill({ status: records.has(id) ? 200 : 404, json: records.has(id) ? { success: true, template: records.get(id) } : { error: 'Template not found' } });
  });
  return { records, writes };
}

test('builder create, review, save, details and edit all preserve the validated message', async ({ page, audit }, info) => {
  const { writes } = await installTemplates(page, []);
  await page.goto(`${templatesPath}/create`);
  await expect(page.getByRole('button', { name: 'Builder', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, info, '01-create-builder');
  await page.getByLabel(/Template name/).fill('reviewed_appointment');
  await page.getByLabel('Body', { exact: true }).fill('Hi {{1}}, your appointment is tomorrow at *10:30 AM*.\n\nReply to confirm.');
  await page.getByLabel('Example for body {{1}}').fill('Alex');
  await openComponents(page);
  await page.getByRole('button', { name: 'Utility', exact: true }).click();
  await page.getByRole('button', { name: 'Add text header', exact: true }).click();
  await expect(page.getByLabel('Header text')).toBeFocused();
  await page.getByLabel('Header text').fill('Appointment reminder');
  await openOptional(page, 'Footer');
  await page.getByLabel('Footer', { exact: true }).fill('Reply for help');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add URL button', exact: true }).click();
  await page.getByLabel('Button 1 text').fill('Shop now');
  await page.getByLabel('Button 1 URL').fill('https://example.com');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add quick reply', exact: true }).click();
  await expect(page.getByLabel('Button 2 text')).toBeFocused();
  await page.getByLabel('Button 2 text').fill('Confirm appointment');
  await page.getByRole('button', { name: 'Move button 2 up', exact: true }).click();
  await openPreview(page);
  await expect(page.getByRole('region', { name: 'Template preview', exact: true }).getByText(/Hi Alex/)).toBeVisible();
  await screenshot(page, info, '02-builder-preview');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review your template' })).toBeFocused();
  await screenshot(page, info, '03-review-template');
  await page.getByRole('button', { name: 'Back to builder', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Button 1 text')).toHaveValue('Confirm appointment');
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}$`));
  expect(writes).toHaveLength(1);
  expect(writes[0].payload.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Confirm appointment' }, { type: 'URL', text: 'Shop now', url: 'https://example.com' }]);
  await screenshot(page, info, '04-my-templates');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}/100(?:\?.*)?$`));
  await expect(page.getByRole('heading', { name: 'reviewed_appointment', exact: true })).toBeVisible();
  await screenshot(page, info, '05-template-details');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'reviewed_appointment', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}/100/edit(?:\?.*)?$`));
  await expect(page.getByLabel('Example for body {{1}}')).toHaveValue('Alex');
  await screenshot(page, info, '06-edit-builder');
  await page.getByLabel('Body', { exact: true }).fill('Hi {{1}}, your appointment has moved to *Friday*.');
  await page.getByRole('button', { name: 'Save WhatsApp template changes', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}/100(?:\?.*)?$`));
  expect(writes.at(-1)).toMatchObject({ method: 'PUT', payload: { body: 'Hi {{1}}, your appointment has moved to *Friday*.' } });
  expect(audit.consoleErrors).toEqual([]);
});

test('cursor controls, formatting toggles, validation and limits work with keyboard input', async ({ page, audit }, info) => {
  await page.goto(`${templatesPath}/create`);
  await page.getByRole('button', { name: 'Add a template name', exact: true }).click();
  await expect(page.getByLabel(/Template name/)).toBeFocused();
  await page.getByLabel(/Template name/).fill('invalid-name');
  await expect(page.getByLabel(/Template name/)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Save new WhatsApp template' })).toBeDisabled();
  await page.getByLabel(/Template name/).fill('formatted_message');
  await page.getByLabel('Body', { exact: true }).fill('Hello Alex');
  for (const [label, delimiter, tag] of [['Bold text', '*', 'strong'], ['Italic text', '_', 'em'], ['Strikethrough text', '~', 's'], ['Monospace text', '```', 'code']]) {
    await moveToStart(page);
    for (let i = 0; i < 5; i++) await page.getByLabel('Body', { exact: true }).press('Shift+ArrowRight');
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByLabel('Body', { exact: true })).toHaveValue(`${delimiter}Hello${delimiter} Alex`);
    await openPreview(page);
    await expect(page.getByRole('region', { name: 'Template preview', exact: true }).locator(tag)).toHaveText('Hello');
    await openEditor(page);
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hello Alex');
  }
  await openComponents(page);
  await page.getByRole('button', { name: 'Add text header', exact: true }).click();
  await page.getByLabel('Header text').fill('Hello ');
  await page.getByRole('button', { name: 'Add header variable', exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Order  is ready.');
  await moveToStart(page);
  for (let i = 0; i < 6; i++) await page.getByLabel('Body', { exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Add body variable', exact: true }).click();
  await expect(page.getByLabel('Header text')).toHaveValue('Hello {{1}}');
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Order {{1}} is ready.');
  await expect(page.getByRole('button', { name: 'Review template', exact: true })).toBeEnabled();
  await page.getByLabel('Example for header {{1}}').fill('Customer');
  await page.getByLabel('Example for body {{1}}').fill('ORDER-42');
  await openPreview(page);
  await expect(page.getByRole('region', { name: 'Template preview', exact: true }).getByText('Order ORDER-42 is ready.')).toBeVisible();
  await screenshot(page, info, '07-variables-and-formatting');
  await openEditor(page);
  await page.getByLabel('Body', { exact: true }).fill('x'.repeat(1024));
  await page.getByRole('button', { name: 'Add body variable', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '1024-character limit' })).toBeVisible();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('x'.repeat(1024));
  await page.getByLabel('Body', { exact: true }).fill('A clear message.');
  await page.getByLabel('Header text').fill('h'.repeat(60));
  await page.getByRole('button', { name: 'Add header variable', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '60-character limit' })).toBeVisible();
  await page.getByLabel('Header text').fill('An update');
  await openOptional(page, 'Footer');
  await page.getByLabel('Footer', { exact: true }).fill('f'.repeat(60));
  await openComponents(page);
  await page.getByRole('button', { name: 'Add URL button', exact: true }).click();
  await expect(page.getByLabel('Button 1 URL')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a complete website URL, such as https://example.com.')).toBeVisible();
  await page.getByRole('button', { name: 'Complete button 1', exact: true }).click();
  await expect(page.getByLabel('Button 1 URL')).toBeFocused();
  await page.getByLabel('Button 1 URL').fill('https://example.com/help');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add phone call', exact: true }).click();
  await page.getByLabel('Button 2 phone number').fill('+14155550123');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add quick reply', exact: true }).click();
  await openComponents(page);
  await expect(page.getByRole('button', { name: 'Add quick reply', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add button', exact: true })).toBeDisabled();
  await screenshot(page, info, '08-button-validation');
  expect(audit.consoleErrors).toEqual([]);
});

for (const headerType of ['IMAGE', 'VIDEO', 'DOCUMENT'] as const) {
  test(`${headerType} files survive header and view changes and save as multipart uploads`, async ({ page, audit }, info) => {
    const { records, writes } = await installTemplates(page, []);
    const file = headerType === 'IMAGE' ? { name: 'offer.png', mimeType: 'image/png', buffer: png }
      : headerType === 'VIDEO' ? { name: 'offer.mp4', mimeType: 'video/mp4', buffer: await readFile(path.join(process.cwd(), 'e2e/fixtures/whatsapp-preview.mp4')) }
        : { name: 'offer.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF') };
    let uploads = 0;
    await page.route('**/api/whatsapp/templates/*/media', async route => {
      uploads += 1;
      expect(route.request().headers()['content-type']).toContain('multipart/form-data');
      expect(route.request().postDataBuffer()?.toString('latin1')).toContain(`filename="${file.name}"`);
      const url = `/uploads/review/${file.name}`;
      const record = { ...records.get(100), headerMediaUrl: url };
      records.set(100, record);
      await route.fulfill({ json: { success: true, url, template: record } });
    });
    await page.route('**/uploads/review/*', route => route.fulfill({ contentType: file.mimeType, body: file.buffer }));
    await page.goto(`${templatesPath}/create`);
    await page.getByLabel(/Template name/).fill(`review_${headerType.toLowerCase()}`);
    await openComponents(page);
    await page.getByRole('button', { name: `Add ${headerType.toLowerCase()} header`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Upload file', exact: true })).toBeFocused();
    if (headerType === 'IMAGE') {
      await page.getByLabel('Upload file', { exact: true }).setInputFiles({ name: 'unsupported.gif', mimeType: 'image/gif', buffer: png });
      await expect(page.getByRole('alert').filter({ hasText: 'Images must be JPEG or PNG.' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save new WhatsApp template' })).toBeEnabled();
      await page.getByLabel('Upload file', { exact: true }).setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
      await expect(page.getByRole('alert').filter({ hasText: 'Image files must be 5 MB or smaller.' })).toBeVisible();
      await screenshot(page, info, '30-invalid-header-file');
    }
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload file', exact: true }).press('Enter');
    await (await chooser).setFiles(file);
    await expect(page.getByLabel('Replace file', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Remove file', exact: true }).click();
    await page.getByLabel('Upload file', { exact: true }).setInputFiles(file);
    await openPreview(page);
    if (headerType === 'IMAGE') await expect(page.getByAltText('WhatsApp template header')).toHaveJSProperty('naturalWidth', 1);
    if (headerType === 'VIDEO') await expect.poll(() => page.getByLabel('WhatsApp template header video', { exact: true }).evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
    if (headerType === 'DOCUMENT') await expect(page.getByText('Document attached', { exact: true })).toBeVisible();
    await screenshot(page, info, `09-${headerType.toLowerCase()}-preview`);
    await openEditor(page);
    await page.getByLabel('Header type').selectOption('NONE');
    await page.getByLabel('Header type').selectOption(headerType);
    await expect(page.getByLabel('Replace file', { exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Guided', exact: true }).click();
    await screenshot(page, info, `10-${headerType.toLowerCase()}-guided-setup`);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByLabel('Replace file', { exact: true })).toBeAttached();
    await page.getByRole('heading', { name: 'Create template', exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, info, `11-${headerType.toLowerCase()}-guided-editor`);
    await page.getByRole('button', { name: 'Builder', exact: true }).click();
    await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${templatesPath}$`));
    expect(writes).toHaveLength(1);
    expect(uploads).toBe(1);
    expect(records.get(100)).toMatchObject({ headerType, header: null, headerMediaUrl: `/uploads/review/${file.name}` });
    await page.goto(`${templatesPath}/100/edit`);
    await expect(page.getByLabel('WhatsApp header media URL')).toHaveValue(`/uploads/review/${file.name}`);
    await expect(page.getByRole('button', { name: 'Save WhatsApp template changes' })).toBeEnabled();
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('public HTTPS video plays and media URL checks recover without saving the draft', async ({ page, audit }, info) => {
  const { writes } = await installTemplates(page, []);
  const video = await readFile(path.join(process.cwd(), 'e2e/fixtures/whatsapp-preview.mp4'));
  const url = 'https://media.example.test/preview.mp4';
  await page.route(url, route => route.fulfill({ contentType: 'video/mp4', body: video }));
  let checks = 0;
  await page.route('**/api/whatsapp/templates/media-preflight', async route => {
    checks += 1;
    expect(route.request().postDataJSON()).toEqual({ url, headerType: 'VIDEO' });
    await route.fulfill(checks === 1
      ? { status: 422, json: { error: 'This URL does not return an MP4 video. Check the link and try again.' } }
      : { json: { mimeType: 'video/mp4', sizeBytes: video.length, note: 'Media is reachable and matches the header type.' } });
  });
  await page.goto(`${templatesPath}/create`);
  await page.getByLabel(/Template name/).fill('public_video');
  await page.getByLabel('Body', { exact: true }).fill('Watch the latest product update.');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add video header', exact: true }).click();
  await page.getByLabel('WhatsApp header media URL').fill(url);
  await page.getByRole('button', { name: 'Check public media URL', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'does not return an MP4 video' })).toBeVisible();
  await page.getByRole('button', { name: 'Check public media URL', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Media is reachable' })).toBeVisible();
  expect(writes).toHaveLength(0);
  await openPreview(page);
  const preview = page.getByLabel('WhatsApp template header video', { exact: true });
  await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await preview.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await screenshot(page, info, '28-public-video-preview');
  expect(audit.consoleErrors.filter((message) => !message.includes('422') && !message.includes('Failed to load resource'))).toEqual([]);
});

test('failed uploads retain the file and show progress while retrying the same draft', async ({ page, audit }, info) => {
  const { records, writes } = await installTemplates(page, []);
  let uploads = 0;
  let releaseUpload: () => void = () => {};
  await page.route('**/api/whatsapp/templates/*/media', async route => {
    uploads += 1;
    if (uploads === 1) return route.fulfill({ status: 500, json: { error: 'Upload interrupted. Retry this file.' } });
    await new Promise<void>((resolve) => { releaseUpload = resolve; });
    const template = { ...records.get(100), headerMediaUrl: '/uploads/review/retry.png' };
    records.set(100, template);
    await route.fulfill({ json: { success: true, url: template.headerMediaUrl, template } });
  });
  await page.goto(`${templatesPath}/create`);
  await page.getByLabel(/Template name/).fill('retry_upload');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add image header', exact: true }).click();
  await page.getByLabel('Upload file', { exact: true }).setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'your selected file is still here' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}/create$`));
  await expect(page.getByLabel('Replace file', { exact: true })).toBeAttached();
  await screenshot(page, info, '12-upload-retry');
  await page.getByRole('button', { name: 'Save new WhatsApp template', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Header media upload progress' })).toBeVisible();
  await expect(page.getByLabel('Body', { exact: true })).toBeDisabled();
  await screenshot(page, info, '13-upload-progress');
  await expect.poll(() => uploads).toBe(2);
  releaseUpload();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}$`));
  expect(writes.map((write) => write.method)).toEqual(['POST', 'PUT']);
  expect(uploads).toBe(2);
  expect(audit.consoleErrors.filter((message) => !message.includes('500') && !message.includes('Failed to load resource'))).toEqual([]);
});

test('AI generation blocks conflicting edits, normalizes copy, and recovers from a provider error', async ({ page, audit }, info) => {
  let release: () => void = () => {};
  let attempts = 0;
  await page.route('**/api/content/studio/social-message', async route => {
    attempts += 1;
    expect(route.request().postDataJSON()).toMatchObject({ platform: 'whatsapp', persist: false });
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'Copy generation unavailable. Try again.' } });
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { success: true, subject: 'Appointment reminder', message: 'Hi {{customer}}, your appointment is at {{time}}. Reply to {{customer}} to confirm.' } });
  });
  await page.goto(`${templatesPath}/create`);
  await page.getByLabel(/Template name/).fill('generated_reminder');
  await openOptional(page, 'Generate copy with AI');
  await page.getByLabel('WhatsApp AI brief').fill('An appointment reminder with the customer name and time');
  await page.getByRole('button', { name: 'Generate copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate copy', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Body', { exact: true })).toBeEnabled();
  await expect(page.getByText('Copy generation unavailable. Try again.', { exact: true })).toBeVisible();
  await screenshot(page, info, '29-ai-error');
  await page.getByRole('button', { name: 'Generate copy', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save new WhatsApp template' })).toBeDisabled();
  await screenshot(page, info, '14-ai-generating');
  await expect.poll(() => attempts).toBe(2);
  release();
  await expect(page.getByRole('button', { name: 'Apply generated copy', exact: true })).toBeVisible();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Apply generated copy', exact: true }).click();
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hi {{1}}, your appointment is at {{2}}. Reply to {{1}} to confirm.');
  await expect(page.getByLabel('Header text')).toHaveValue('Appointment reminder');
  await page.getByLabel('Example for body {{1}}').fill('Alex');
  await page.getByLabel('Example for body {{2}}').fill('10:30 AM');
  await openPreview(page);
  await screenshot(page, info, '15-ai-result');
  expect(audit.consoleErrors.filter((message) => !message.includes('503') && !message.includes('Failed to load resource'))).toEqual([]);
});

test('presets, cloning and language variants retain their separate drafts', async ({ page, audit }, info) => {
  const { writes } = await installTemplates(page);
  await page.goto(`${templatesPath}/17`);
  await expect(page.getByRole('heading', { name: draft.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clone as new draft', exact: true }).click();
  await expect(page.getByLabel(/Template name/)).toHaveValue('appointment_reminder_copy');
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue(draft.body);
  await screenshot(page, info, '16-clone-draft');
  await page.goto(`${templatesPath}/17`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create language variant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review template', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Choose a different language', exact: true }).click();
  await expect(page.getByLabel('Language', { exact: true })).toBeFocused();
  await page.getByLabel('Language', { exact: true }).selectOption('ta');
  await expect(page.getByRole('button', { name: 'Review template', exact: true })).toBeEnabled();
  await screenshot(page, info, '17-language-variant');
  expect(writes).toHaveLength(0);
  await page.goto(templatesPath);
  await page.getByRole('button', { name: 'Pattern library', exact: true }).click();
  await screenshot(page, info, '18-pattern-library');
  await page.getByRole('button', { name: 'Use template', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Builder', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel(/Template name/)).not.toHaveValue('');
  await screenshot(page, info, '19-preset-builder');
  expect(audit.consoleErrors).toEqual([]);
});

test('Meta submission ordering and linked, pending and uncertain field locks remain enforced', async ({ page, audit }, info) => {
  const { records, writes } = await installTemplates(page);
  const submitted: string[] = [];
  records.set(18, { ...draft, id: 18, name: 'approved_reminder', wabaTemplateId: 'meta-18', metaStatus: 'APPROVED', status: 'APPROVED', hasLocalChanges: false });
  records.set(19, { ...draft, id: 19, name: 'pending_reminder', wabaTemplateId: 'meta-19', metaStatus: 'PENDING', status: 'PENDING' });
  records.set(20, { ...draft, id: 20, name: 'uncertain_reminder', wabaTemplateId: 'meta-20', submissionStatus: 'submission_uncertain' });
  records.set(21, { ...draft, id: 21, name: 'conflicted_reminder', submissionStatus: 'identity_conflict' });
  await page.route('**/api/whatsapp/templates/*/submit', async route => {
    expect(writes.at(-1)).toMatchObject({ method: 'PUT', id: 18 });
    submitted.push(new URL(route.request().url()).pathname);
    records.set(18, { ...records.get(18), status: 'PENDING', metaStatus: 'PENDING', hasLocalChanges: false });
    await route.fulfill({ status: 202, json: { success: true } });
  });
  await page.goto(`${templatesPath}/18/edit`);
  await expect(page.getByLabel(/Template name/)).toBeDisabled();
  await expect(page.getByLabel('Language', { exact: true })).toBeDisabled();
  await openComponents(page);
  await expect(page.getByRole('button', { name: 'Marketing', exact: true })).toBeDisabled();
  await page.getByLabel('Body', { exact: true }).fill('Hi {{1}}, your appointment has moved to Friday.');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await screenshot(page, info, '20-linked-template-review');
  await page.getByRole('button', { name: 'Submit to Meta', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}$`));
  expect(submitted).toEqual(['/api/whatsapp/templates/18/submit']);
  for (const id of [19, 20]) {
    await page.goto(`${templatesPath}/${id}/edit`);
    await expect(page.getByLabel('Body', { exact: true })).toBeDisabled();
    await openComponents(page);
    await expect(page.getByRole('button', { name: 'Add image header', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save WhatsApp template changes' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Review template', exact: true })).toBeDisabled();
    await screenshot(page, info, id === 19 ? '21-pending-template' : '22-uncertain-template');
    await page.getByRole('button', { name: 'Guided', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  }
  await page.goto(`${templatesPath}/21/edit`);
  await expect(page.getByLabel('Body', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeDisabled();
  expect(audit.consoleErrors).toEqual([]);
});

test('load and save errors recover without replacing the draft or creating duplicate writes', async ({ page, audit }, info) => {
  const { records, writes } = await installTemplates(page);
  let failLoads = true;
  await page.route(/\/api\/whatsapp\/templates\/17$/, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill(failLoads ? { status: 500, json: { error: 'Template lookup unavailable' } } : { json: { template: records.get(17) } });
  });
  await page.goto(`${templatesPath}/17/edit`);
  await expect(page.getByRole('heading', { name: 'Template could not be loaded' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save WhatsApp template changes' })).toHaveCount(0);
  await screenshot(page, info, '23-load-error');
  failLoads = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel(/Template name/)).toHaveValue(draft.name);
  let saveAttempts = 0;
  await page.route(/\/api\/whatsapp\/templates\/17$/, async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saveAttempts += 1;
    if (saveAttempts === 1) return route.fulfill({ status: 500, json: { error: 'Save interrupted' } });
    return route.fallback();
  });
  await page.getByLabel('Body', { exact: true }).fill('Hi {{1}}, the updated message remains here.');
  await page.getByRole('button', { name: 'Save WhatsApp template changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Save interrupted' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Save interrupted' })).toContainText('Your edits are still here.');
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue('Hi {{1}}, the updated message remains here.');
  await screenshot(page, info, '24-save-error');
  await page.getByRole('button', { name: 'Save WhatsApp template changes' }).click();
  await expect(page).toHaveURL(new RegExp(`${templatesPath}/17(?:[?].*)?$`));
  expect(writes.map((write) => write.method)).toEqual(['PUT']);
  expect(audit.consoleErrors.filter((message) => !message.includes('500') && !message.includes('Failed to load resource'))).toEqual([]);
});

test('tablet, smaller desktop, mobile preview and dark mode keep fields and actions usable', async ({ page, audit }, info) => {
  await installTemplates(page);
  const sizes = info.project.name === 'desktop-chromium'
    ? [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 820, height: 900 }]
    : [{ width: 390, height: 844 }, { width: 375, height: 667 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.goto(`${templatesPath}/17/edit`);
    await expect(page.getByLabel('Body', { exact: true })).toBeVisible();
    await expect.poll(() => page.locator('section').evaluateAll((sections) => sections.every((section) => section.scrollWidth <= section.clientWidth + 1))).toBe(true);
    const actions = page.getByTestId('template-editor-actions');
    await expect.poll(() => actions.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(150);
    await page.getByRole('heading', { name: 'Edit template', exact: true }).scrollIntoViewIfNeeded();
    if (size.width >= 1280) {
      const phone = page.getByRole('region', { name: 'Template preview', exact: true });
      await expect(phone.getByText('Preview only · not sent')).toBeVisible();
      await expect.poll(async () => (await phone.boundingBox())!.y + (await phone.boundingBox())!.height <= (await actions.boundingBox())!.y + 1).toBe(true);
    }
    await screenshot(page, info, `25-editor-${size.width}`);
    if (size.width < 1280) {
      await openPreview(page);
      const phone = page.getByRole('region', { name: 'Template preview', exact: true });
      await expect(phone.getByText('Preview only · not sent')).toBeVisible();
      await expect.poll(async () => {
        const bottom = await phone.evaluate((element) => element.getBoundingClientRect().bottom);
        const top = await actions.evaluate((element) => element.getBoundingClientRect().top);
        return bottom <= top + 1;
      }).toBe(true);
      await screenshot(page, info, `26-preview-${size.width}`);
      await page.getByRole('tab', { name: 'Preview', exact: true }).press('ArrowLeft');
      await expect(page.getByRole('tab', { name: 'Editor', exact: true })).toBeFocused();
      await page.getByRole('tab', { name: 'Editor', exact: true }).press('End');
      await expect(page.getByRole('tab', { name: 'Preview', exact: true })).toBeFocused();
    }
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await screenshot(page, info, `27-dark-${size.width}`);
  }
  expect(audit.consoleErrors).toEqual([]);
});

test('message preview scrolls long content and keeps actions reachable', async ({ page }, info) => {
  await installTemplates(page, []);
  await page.goto(`${templatesPath}/create`);
  await page.getByLabel('Body', { exact: true }).fill(Array.from({ length: 30 }, (_, index) => `Appointment reminder line ${index + 1}`).join('\n'));
  await openPreview(page);
  const phone = page.getByRole('region', { name: 'Template preview', exact: true });
  const conversation = page.getByRole('region', { name: 'Preview conversation', exact: true });
  const actions = page.getByTestId('template-editor-actions');
  const assertFrame = async () => {
    await expect(phone.getByText('Preview only · not sent')).toBeVisible();
    await expect.poll(async () => (await phone.boundingBox())!.y + (await phone.boundingBox())!.height <= (await actions.boundingBox())!.y + 1).toBe(true);
    await expect.poll(() => conversation.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  };
  await assertFrame();
  await conversation.focus();
  await conversation.press('End');
  await expect.poll(() => conversation.evaluate(element => element.scrollTop > 0)).toBe(true);
  await screenshot(page, info, '29-proportional-phone');
  const size = info.project.name === 'desktop-chromium' ? { width: 1440, height: 740 } : { width: 390, height: 700 };
  await page.setViewportSize(size);
  await assertFrame();
  await screenshot(page, info, '30-proportional-phone-short-viewport');
});
