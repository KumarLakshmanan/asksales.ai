import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

// Synthetic local UI acceptance. All application APIs are fixtures; no live
// generation, sending, publishing or credential is used.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|wallet|chat\/threads|notifications\/unread\/count|organizations)$/.test(path)) return route.fallback();
    if (path === '/api/settings/business-profiles') return route.fulfill({ json: [{ id: 72, companyName: 'Synthetic studio', isDefault: true, isApproved: true, website: 'https://example.test' }] });
    if (path === '/api/content/brand-toolkits') return route.fulfill({ json: [{ id: 71, brandName: 'Synthetic brand', isDefault: true, isActive: true, isApproved: true }] });
    if (path === '/api/content/assets') return route.fulfill({ json: [] });
    if (path === '/api/content/studio/estimates') return route.fulfill({ json: {
      text: { ready: true, credits: 1, model: 'synthetic-text', basis: 'Synthetic text quote' },
      image: { ready: true, credits: 4, model: 'synthetic-image', basis: 'Synthetic image quote' },
      video: { ready: true, credits: 12, model: 'synthetic-video', basis: 'Synthetic video quote' },
    } });
    return route.fulfill({ status: ['GET', 'HEAD'].includes(route.request().method()) ? 200 : 409, json: {} });
  });
});

test('partial video requests disclose the accepted queued job', async ({ page }, testInfo) => {
  let accepted = false; let submissions = 0;
  await page.route('**/api/content/assets?*', route => route.fulfill({ json: accepted ? [{
    id: 123, type: 'video', title: 'Synthetic queued video', content: '{}', status: 'pending', createdAt: '2026-10-23',
    performance: { mediaGeneration: { video: { status: 'queued' } } },
  }] : [] }));
  await page.route('**/api/content/studio/video', route => {
    submissions++;
    if (submissions === 1) { accepted = true; return route.fulfill({ status: 202, headers: { 'Content-Request-Confirmed': 'true' }, json: { success: true, persisted: true, assetId: 123, jobId: 'content-video-123-0' } }); }
    return route.fulfill({ status: 503, json: { error: 'Synthetic submission failure' } });
  });
  await page.goto('/dashboard/saved-templates/video/generate');
  await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Video Prompt', { exact: true }).fill('Reviewed synthetic scene');
  await page.getByRole('button', { name: 'Generation Settings', exact: true }).click();
  await page.getByRole('button', { name: '2', exact: true }).click();
  const proxy = page.locator('[data-creator-action-proxy]');
  await (await proxy.isVisible() ? proxy : page.locator('[data-creator-action]')).click();
  await expect(page.getByText(/0 completed, 1 queued, 1 failed of 2 requested/)).toBeVisible();
  expect(submissions).toBe(2);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('video-partial-queue.png'), fullPage: true });
});

test('paused video checks refresh the same saved operation without generation', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.clock.install(); let polls = 0; let submissions = 0;
  await page.route('**/api/content/assets?*', route => route.fulfill({ json: [{
    id: 123, type: 'video', title: 'Synthetic saved video', content: '{}', status: 'pending', createdAt: '2026-10-23',
    performance: { operationName: 'operations/synthetic' },
  }] }));
  await page.route('**/api/content/studio/video/status/*', route => { polls++; return route.fulfill({ json: { success: true, done: false } }); });
  await page.route('**/api/content/studio/video', route => { submissions++; return route.fulfill({ status: 409, json: { error: 'Unexpected generation blocked' } }); });
  await page.goto('/dashboard/saved-templates/video/generate');
  await expect(page.getByText('Brand context ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  const tabs = page.getByRole('tablist', { name: 'Creation workspace' });
  if (await tabs.isVisible()) await tabs.getByRole('tab', { name: /^Recent/ }).click();
  else await page.getByRole('tablist', { name: 'Proofing area' }).getByRole('tab', { name: /^Recent/ }).click();
  await expect(page.getByText('1 video request is pending', { exact: true })).toBeVisible();
  for (let attempt = 1; attempt <= 120; attempt++) {
    await page.clock.runFor(5000);
    await expect.poll(() => polls).toBe(attempt);
  }
  await expect(page.getByText(/Automatic status checks have paused/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh saved video status', exact: true }).click();
  await page.clock.runFor(5000);
  await expect.poll(() => polls).toBe(121);
  expect(submissions).toBe(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('video-status-resumed.png'), fullPage: true });
});

for (const item of [
  { kind: 'image', credits: 4, manual: 'Upload an image' },
  { kind: 'video', credits: 12, manual: 'Upload a video' },
  { kind: 'email', credits: 1, manual: 'Write an email' },
]) test(`${item.kind} quotes only its AI action and hides generation costs in manual mode`, async ({ page }, testInfo) => {
  await page.goto(`/dashboard/saved-templates/${item.kind}/generate`);
  const setup = page.getByLabel('Generation setup and saving');
  await expect(setup.getByText('Brand context ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  await setup.locator('summary').click();
  await expect(setup).not.toContainText('Estimated');
  const quote = page.getByLabel('Generation estimate', { exact: true });
  await expect(quote).toHaveCount(1);
  await expect(quote).toContainText(`Estimated ${item.credits} ${item.credits === 1 ? 'credit' : 'credits'}`);
  await quote.scrollIntoViewIfNeeded();
  await expect(quote).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => ({ width: innerWidth, scale: visualViewport?.scale, dpr: devicePixelRatio }))).toEqual({ width: testInfo.project.use.viewport!.width, scale: 1, dpr: 1 });
  await page.screenshot({ path: testInfo.outputPath(`${item.kind}-scoped-estimate.png`), fullPage: true });
  await page.getByRole('button', { name: item.manual, exact: true }).click();
  await expect(quote).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
