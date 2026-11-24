import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

// Synthetic API fixture; retain Next's local HMR socket so dev hydration can
// finish. fixtures/app replaces every application WebSocket independently.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|wallet|chat\/threads|notifications\/unread\/count|organizations)$/.test(path)) return route.fallback();
    if (path === '/api/settings/business-profiles') return route.fulfill({ json: [{ id: 72, companyName: 'Synthetic studio', isDefault: true, isApproved: true, website: 'https://example.test' }] });
    if (path === '/api/content/brand-toolkits') return route.fulfill({ json: [{ id: 71, brandName: 'Synthetic brand', isDefault: true, isActive: true, isApproved: true }] });
    if (path === '/api/content/assets') return route.fulfill({ json: [] });
    if (path === '/api/content/studio/estimates') return route.fulfill({ json: { text: { ready: true, credits: 1 }, image: { ready: true, credits: 1 }, video: { ready: true, credits: 1 } } });
    if (!['GET', 'HEAD'].includes(route.request().method())) return route.fulfill({ status: 409, json: { error: 'Unexpected audit mutation blocked' } });
    return route.fulfill({ json: {} });
  });
});

const creators = [
  { channel: 'email', endpoint: 'email', label: 'Email Prompt', result: { subject: 'Synthetic subject', body: 'Synthetic saved email proof.' }, proof: 'Synthetic saved email proof.' },
  { channel: 'sms', endpoint: 'sms', label: 'SMS Prompt', result: { message: 'Synthetic SMS proof. Reply STOP to opt out.' }, proof: 'Synthetic SMS proof.' },
  { channel: 'dm', endpoint: 'social-message', label: 'DM Prompt', result: { message: 'Synthetic saved DM proof.' }, proof: 'Synthetic saved DM proof.' },
  { channel: 'social', endpoint: 'social', label: 'Social Post Prompt', result: { caption: 'Synthetic social proof.', content: 'Synthetic social proof.', mediaGeneration: { imageQueued: false, videoQueued: false, warnings: [] } }, proof: 'Synthetic social proof.' },
  { channel: 'ads', endpoint: 'ad-copy-content', label: 'Ad Prompt', result: { headline: 'Synthetic ad', primaryText: 'Synthetic ad proof.', mediaGeneration: { imageQueued: false, videoQueued: false, warnings: [] } }, proof: 'Synthetic ad proof.' },
  { channel: 'blog', endpoint: 'blog-post', label: 'Blog Prompt', result: { title: 'Synthetic blog', content: 'Synthetic blog proof.' }, proof: 'Synthetic blog proof.' },
  { channel: 'image', endpoint: 'image', label: 'Image Prompt', result: { imageUrl: '/__studio-fixture.svg' }, proof: '' },
];

for (const creator of creators) test(`${creator.channel}: synthetic creator retains its submitted proof after prompt edits`, async ({ page }, testInfo) => {
  let generated = 0;
  await page.route('**/__studio-fixture.svg*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#dbeafe"/></svg>' }));
  await page.route(`**/api/content/studio/${creator.endpoint}`, route => {
    generated++;
    return route.fulfill({ headers: { 'Content-Request-Confirmed': 'true' }, json: { success: true, persisted: true, assetId: 9001, ...creator.result } });
  });
  await page.goto(`/dashboard/saved-templates/${creator.channel}/generate`);
  await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel(creator.label, { exact: true }).fill('Synthetic informational brief');
  const action = page.locator('[data-creator-action-proxy]');
  await (await action.isVisible() ? action : page.locator('[data-creator-action]')).click();
  const tabs = page.getByRole('tablist', { name: 'Creation workspace' });
  if (await tabs.isVisible()) await tabs.getByRole('tab', { name: 'Preview', exact: true }).click();
  const stage = page.locator('[data-creator-stage]');
  if (creator.channel === 'image') await expect(stage.getByAltText('Image proof')).toHaveAttribute('src', /__studio-fixture.svg/);
  else await expect(stage).toContainText(creator.proof);
  if (await tabs.isVisible()) await tabs.getByRole('tab', { name: 'Compose', exact: true }).click();
  await page.getByLabel(creator.label, { exact: true }).fill('A second brief that has not been submitted');
  if (await tabs.isVisible()) await tabs.getByRole('tab', { name: 'Preview', exact: true }).click();
  if (creator.channel !== 'image') await expect(stage).toContainText(creator.proof);
  expect(generated).toBe(1);
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath(`${creator.channel}-normal-zoom.png`), fullPage: true });
});

test('video creator discloses durable background jobs and unsupported running cancellation', async ({ page }, testInfo) => {
  await page.goto('/dashboard/saved-templates/video/generate');
  await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('tablist', { name: 'Creation workspace' });
  if (await composer.isVisible()) await composer.getByRole('tab', { name: 'Compose', exact: true }).click();
  await expect(page.getByText('running provider jobs cannot currently be cancelled.', { exact: false })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('video-normal-zoom.png'), fullPage: true });
});
