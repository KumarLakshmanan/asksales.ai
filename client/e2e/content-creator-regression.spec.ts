import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

// Real Chrome + the deployed frontend, but no real API reads, paid generation,
// uploads, publishing, Meta submission, or customer data. Each test gets a fresh
// browser context; it never borrows the user's Chrome profile or credentials.
test.use({ channel: 'chrome', serviceWorkers: 'block' });

const imageUrl = 'https://example.test/creator-regression.png';
const shellReads = /^\/api\/(auth\/me|platform\/access|settings\/preferences|wallet|chat\/threads|notifications\/unread\/count)$/;

test.beforeEach(async ({ page, audit }) => {
  // Do not connect a same-origin application socket to the live account either.
  await page.routeWebSocket('**', () => {});
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Unmocked mutation blocked by creator regression.' } });
    }
    if (shellReads.test(path)) return route.fallback();
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/content/brand-toolkits', route => route.fulfill({ json: [{ id: 71, brandName: 'Regression brand', isDefault: true, isActive: true, isApproved: true }] }));
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 72, companyName: 'Regression company', isDefault: true, isApproved: true, website: 'https://example.test' }] }));
  await page.route('**/api/content/assets?*', route => route.fulfill({ json: [] }));
  await page.route('**/api/content/studio/estimates?*', route => route.fulfill({ json: {
    text: { credits: 1, ready: true, model: 'Fixture text', basis: 'UI regression only' },
    image: { credits: 5, ready: true, model: 'Fixture image', basis: 'UI regression only' },
    video: { credits: 10, ready: true, model: 'Fixture video', basis: 'UI regression only' },
    sms: { creditsPerMessage: 1, basis: 'UI regression only' },
  } }));
  await page.route(imageUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#dbeafe"/><text x="40" y="320" font-size="30">Fixture image proof</text></svg>' }));
});

async function showPreview(page: Page) {
  const tabs = page.getByRole('tablist', { name: 'Creation workspace' });
  if (await tabs.isVisible()) await tabs.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.locator('[data-creator-stage]')).toBeVisible();
}

async function showComposer(page: Page) {
  const tabs = page.getByRole('tablist', { name: 'Creation workspace' });
  if (await tabs.isVisible()) await tabs.getByRole('tab', { name: 'Compose', exact: true }).click();
  await expect(page.locator('[data-creator-composer]')).toBeVisible();
}

async function expectVisibleSavingNotice(page: Page) {
  const setup = page.getByRole('complementary', { name: 'Generation setup and saving' });
  await expect(setup.locator('details')).toHaveJSProperty('open', false);
  await expect(setup.getByText('AI generation saves a draft to Recent and your library.', { exact: false })).toBeVisible();
}

const creators = [
  { channel: 'email', endpoint: 'email', label: 'Email Prompt', response: { subject: 'Fixture email subject', body: 'Saved email proof from the fixture.' }, proof: 'Saved email proof from the fixture.' },
  { channel: 'sms', endpoint: 'sms', label: 'SMS Prompt', response: { message: 'Saved SMS proof. Reply STOP to unsubscribe.' }, proof: 'Saved SMS proof. Reply STOP to unsubscribe.' },
  { channel: 'dm', endpoint: 'social-message', label: 'DM Prompt', response: { message: 'Saved direct message proof from the fixture.' }, proof: 'Saved direct message proof from the fixture.' },
  { channel: 'social', endpoint: 'social', label: 'Social Post Prompt', response: { content: 'Saved social proof from the fixture.', caption: 'Saved social proof from the fixture.', mediaGeneration: { imageQueued: false, videoQueued: false, warnings: [] } }, proof: 'Saved social proof from the fixture.' },
  { channel: 'ads', endpoint: 'ad-copy-content', label: 'Ad Prompt', response: { headline: 'Fixture ad headline', primaryText: 'Saved ad proof from the fixture.', mediaGeneration: { imageQueued: false, videoQueued: false, warnings: [] } }, proof: 'Saved ad proof from the fixture.' },
  { channel: 'blog', endpoint: 'blog-post', label: 'Blog Prompt', response: { title: 'Fixture blog title', content: 'Saved blog proof from the fixture.' }, proof: 'Saved blog proof from the fixture.' },
  { channel: 'image', endpoint: 'image', label: 'Image Prompt', response: { imageUrl, saved: true, persisted: true }, proof: '' },
] as const;

for (const creator of creators) {
  test(`${creator.channel}: prompt edits do not create or replace the submitted proof`, async ({ page, audit }, testInfo) => {
    const requests: Record<string, unknown>[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`**/api/content/studio/${creator.endpoint}`, route => {
      expect(route.request().method()).toBe('POST');
      requests.push(route.request().postDataJSON());
      return route.fulfill({ headers: { 'Content-Request-Confirmed': 'true' }, json: { success: true, assetId: 9801, ...creator.response } });
    });
    await page.goto(`/dashboard/saved-templates/${creator.channel}/generate`);
    await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible();
    await expectVisibleSavingNotice(page);
    const stage = page.locator('[data-creator-stage]');
    await showPreview(page);
    await expect(stage.getByRole('heading', { name: 'Your preview will appear here' })).toBeVisible();
    const emptyProof = await stage.innerText();
    await expectNoHorizontalOverflow(page);
    await showComposer(page);
    const prompt = `First ${creator.channel} brief: introduce a practical product to small teams.`;
    await page.getByLabel(creator.label, { exact: true }).fill(prompt);
    if (creator.channel === 'social' || creator.channel === 'ads') {
      await expect(page.getByRole('checkbox', { name: 'Generate one image', exact: true })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Generate one video', exact: true })).not.toBeChecked();
      await expect(page.getByText('Copy only. No image or video job will start.')).toBeVisible();
    }
    await showPreview(page);
    expect(await stage.innerText()).toBe(emptyProof);
    expect(requests).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
    // Submit from Preview on mobile, exercising the sticky primary action.
    const mobileAction = page.locator('[data-creator-action-proxy]');
    const action = await mobileAction.isVisible() ? mobileAction : page.locator('[data-creator-action]');
    await expect(action).toBeEnabled();
    await action.click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    if (creator.channel === 'image') {
      await expect(stage.getByAltText('Image proof')).toHaveAttribute('src', imageUrl);
      await expect(stage).toContainText(prompt);
      await expect.poll(() => stage.getByAltText('Image proof').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    } else {
      await expect(stage).toContainText(creator.proof);
    }
    await expect(stage.getByRole('heading', { name: 'Your preview will appear here' })).toHaveCount(0);
    // Wait for the action to be enabled again so a multi-platform request loop
    // cannot change the proof after we take the stable snapshot.
    await expect(action).toBeEnabled();
    const submittedProof = await stage.innerText();
    const submittedCount = requests.length;
    for (const request of requests) {
      expect(request.prompt).toEqual(expect.stringContaining(prompt));
      expect(request).toMatchObject({ brandToolkitId: 71, businessProfileId: 72 });
      if (creator.channel === 'social' || creator.channel === 'ads') expect(request.mediaGeneration).toEqual({ image: false, video: false });
    }
    await showComposer(page);
    await page.getByLabel(creator.label, { exact: true }).fill('UNSUBMITTED replacement brief. This must not appear in the proof.');
    await showPreview(page);
    expect(await stage.innerText()).toBe(submittedProof);
    await expect(stage).not.toContainText('UNSUBMITTED replacement brief');
    expect(requests).toHaveLength(submittedCount);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${creator.channel}-stable-proof.png`) });
  });
}

test('SMS: selected 320-character limit reaches generation and uses GSM segment counting', async ({ page, audit }, testInfo) => {
  let submitted: Record<string, unknown> | undefined;
  // 320 GSM-7 characters need 3 concatenated segments (153 units each), not 2.
  const optOut = ' Reply STOP to opt out.';
  const message = 'A'.repeat(320 - optOut.length) + optOut;
  await page.route('**/api/content/studio/sms', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ headers: { 'Content-Request-Confirmed': 'true' }, json: { success: true, assetId: 9802, message } });
  });
  await page.goto('/dashboard/saved-templates/sms/generate');
  await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible();
  await page.getByLabel('SMS Prompt', { exact: true }).fill('Write a longer SMS for the selected limit.');
  await page.getByRole('button', { name: '320 characters', exact: true }).click();
  await expect(page.getByRole('button', { name: '320 characters', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-creator-action]').click();
  await expect.poll(() => submitted).toMatchObject({ maxCharacters: 320 });
  await showPreview(page);
  const stage = page.locator('[data-creator-stage]');
  await expect(stage).toContainText('320/320 characters');
  await expect(stage).toContainText('GSM-7 · 320 units · 3 segments');
  const bubble = stage.getByText(message, { exact: true });
  await expect(bubble).toBeVisible();
  const dimensions = await bubble.evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
  await page.screenshot({ path: testInfo.outputPath('sms-320-unbroken-bubble.png') });
  expect.soft(dimensions.scrollWidth, `SMS bubble clips text: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await showComposer(page);
  await page.getByRole('button', { name: '160 characters', exact: true }).click();
  await showPreview(page);
  await expect(stage).toContainText('320/320 characters');
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
});

test('video: read-only prompt edits preserve the empty preview without generation', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/saved-templates/video/generate');
  await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible();
  await expectVisibleSavingNotice(page);
  const stage = page.locator('[data-creator-stage]');
  await showPreview(page);
  await expect(stage.getByRole('heading', { name: 'Your preview will appear here' })).toBeVisible();
  const emptyProof = await stage.innerText();
  await showComposer(page);
  await page.getByLabel('Video Prompt', { exact: true }).fill('UNSUBMITTED video brief. Do not start generation.');
  await showPreview(page);
  expect(await stage.innerText()).toBe(emptyProof);
  await expect(stage).not.toContainText('UNSUBMITTED video brief');
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('video-read-only-empty-proof.png') });
});

test('WhatsApp: language clone keeps component variables independent and requires a new language', async ({ page, audit }, testInfo) => {
  await page.route('**/api/whatsapp/config', route => route.fulfill({ json: {
    configured: true, config: { businessAccountId: 'synthetic-waba', connectionStatus: 'ready', tokenStatus: 'valid' },
  } }));
  await page.route('**/api/whatsapp/templates/17', route => route.fulfill({ json: { success: true, template: {
    id: 17, name: 'appointment_reminder', language: 'en_US', category: 'UTILITY',
    status: 'APPROVED', metaStatus: 'APPROVED', wabaTemplateId: 'fixture-meta-17',
    headerType: 'TEXT', header: 'Hello {{1}}', body: 'Order {{1}} is ready.',
    examples: { 'header:1': 'Customer', 'body:1': 'ORDER-42' }, footer: '', buttons: [],
  } } }));
  await page.goto('/dashboard/integrations/whatsapp/templates/create?cloneFrom=17&variant=language');
  await expect(page.getByRole('note')).toContainText('Text is not automatically translated');
  await expect(page.getByRole('button', { name: 'Builder', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const editorTab = page.getByRole('tab', { name: 'Editor', exact: true });
  const previewTab = page.getByRole('tab', { name: 'Preview', exact: true });
  const preview = page.getByRole('region', { name: 'WhatsApp phone preview', exact: true });
  const showEditor = async () => { if (await editorTab.isVisible()) await editorTab.click(); };
  const showPreview = async () => { if (await previewTab.isVisible()) await previewTab.click(); };
  await expect(page.getByLabel(/Template name/)).not.toBeDisabled();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en_US');
  // The current editor permits reviewing incomplete drafts. Actual submission,
  // with a ready synthetic account, must still reject the unchanged language.
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review your template section', exact: true });
  const checklist = review.getByRole('region', { name: 'Submission checklist', exact: true });
  await checklist.getByRole('button', { name: /^View checklist/ }).click();
  await expect(checklist.getByRole('button', { name: 'Choose a different language', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Back to builder', exact: true }).click();
  await showEditor(); await page.getByLabel('Language', { exact: true }).selectOption('ta');
  await showPreview();
  await expect(preview).toContainText('Hello Customer');
  await expect(preview).toContainText('Order ORDER-42 is ready.');
  await showEditor(); await page.getByLabel('Example for header {{1}}', { exact: true }).fill('Alex');
  await showPreview(); await expect(preview).toContainText('Hello Alex');
  await expect(preview).toContainText('Order ORDER-42 is ready.');
  const existingProof = await preview.innerText();
  await showEditor();
  await page.locator('details').filter({ has: page.locator('#whatsapp-ai') }).locator('summary').click();
  await page.getByLabel('WhatsApp AI brief', { exact: true }).fill('UNSUBMITTED WhatsApp brief');
  await showPreview(); expect(await preview.innerText()).toBe(existingProof);
  await showEditor(); await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Order {{2}} is ready.');
  await expect(page.getByRole('alert').filter({ hasText: 'Body variables must start at' })).toContainText('start at {{1}} and continue without gaps');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await checklist.getByRole('button', { name: /^View checklist/ }).click();
  await expect(checklist.getByRole('button', { name: 'Fix the message body', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Back to builder', exact: true }).click();
  await showEditor(); await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Updated order {{1}} is ready.');
  await showPreview(); await expect(preview).toContainText('Updated order ORDER-42 is ready.');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeEnabled();
  // No save, AI generation or Meta submission is activated, even when valid.
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('whatsapp-clone-variable-proof.png') });
});
