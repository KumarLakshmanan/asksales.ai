import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

// Exercise the deployed UI with deterministic provider receipts. No real post
// is sent by this suite; provider/lifecycle behavior has separate integration tests.
test.use({ channel: 'chrome' });
test.beforeEach(async ({ page }) => {
  // Any mutation must be explicitly fulfilled by this test. This also makes the
  // suite safe when its base URL points at a deployed frontend.
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) return route.fulfill({ status: 409, json: { error: 'Unmocked mutation blocked by publishing UI regression.' } });
    const path = new URL(route.request().url()).pathname;
    // These routes are supplied by the app-shell fixture. Other reads must
    // remain isolated too: a production 401 from an unrelated sidebar request
    // would log the fixture user out, unlike a local offline development API.
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) return route.fallback();
    return route.fulfill({ json: {} });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) return;
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  expect(await page.evaluate(() => window.innerWidth)).toBe(testInfo.project.use.viewport?.width);
});

test('calendar opens posts, scrolls details and offers scoped schedule actions', async ({ page }, testInfo) => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: 900 + index, contentAssetId: 900 + index, sourceKey: `asset-${900 + index}`, title: `Publishing regression ${index + 1}`,
    content: 'A reviewed caption. '.repeat(15), platform: index % 2 ? 'facebook' : 'instagram',
    scheduled_date: day, scheduled_time: '23:45', scheduledAt: `${day}T18:15:00.000Z`, status: 'scheduled', type: 'post', version: 2,
    publishAttempts: [{ id: 1900 + index, platform: index % 2 ? 'facebook' : 'instagram', status: 'pending', attemptCount: 0, maxAttempts: 5, capabilities: { retry: false, reconcile: false, publishNow: true } }],
  }));
  await page.route('**/api/settings/preferences', route => route.fulfill({ json: { timezone: 'Asia/Kolkata', theme: 'light' } }));
  await page.route('**/api/content/calendar?*', route => route.fulfill({ json: { items } }));
  await page.goto('/dashboard/content-calendar');
  await page.getByRole('button', { name: 'Open Publishing regression 1', exact: true }).click();
  const drawer = page.getByTestId('calendar-day-drawer-scroll-region');
  await expect(drawer).toBeVisible();
  await drawer.hover();
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => drawer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('calendar-drawer-scrolled.png') });
  await page.getByRole('button', { name: 'Actions for Publishing regression 8', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Cancel schedule', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Reschedule', exact: true }).click();
  await expect(page.getByRole('dialog').last()).toContainText('destination');
  await expect(page.getByRole('dialog').last()).toContainText('Asia/Kolkata');
});

test('publisher retains all images, auto-selects a single account, and reviews an IST schedule', async ({ page }, testInfo) => {
  let reviewedRequest: Record<string, unknown> | undefined;
  const image = 'https://example.test/review.jpg';
  await page.route('**/review.jpg*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#dbeafe"/></svg>' }));
  await page.route('**/api/settings/preferences', route => route.fulfill({ json: { timezone: 'Asia/Kolkata', theme: 'light' } }));
  await page.route('**/api/content/assets/950', route => route.fulfill({ json: { id: 950, version: 1, publishingReviewToken: 'fixture-review', type: 'social_post', title: 'Reviewed launch', content: JSON.stringify({ caption: 'Reviewed launch caption' }), imageUrls: [image, `${image}?2`], channel: 'facebook', status: 'draft' } }));
  await page.route('**/api/content/publishing/accounts*', route => route.fulfill({ json: { accounts: [
    { platform: 'instagram', credentialId: 10, accountName: 'Aimplify Instagram QA', providerAccountId: 'ig-fixture', readiness: 'ready', isSelected: true, expired: false },
    { platform: 'facebook', credentialId: 11, accountName: 'Aimplify Facebook QA', providerAccountId: 'fb-fixture', readiness: 'ready', isSelected: true, expired: false },
  ] } }));
  await page.route('**/api/content/assets/950/publish', route => {
    reviewedRequest = route.request().postDataJSON();
    return route.fulfill({ json: { success: true, scheduled: true, accepted: false, results: { facebook: { success: true, status: 'pending', assetId: 950, attemptId: 1950 } } } });
  });
  await page.goto('/dashboard/saved-templates/social/publish?assetId=950');
  await expect(page.getByRole('dialog', { name: 'Publish social post' })).toBeVisible();
  await expect(page.getByText('Aimplify Facebook QA', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/first image/i)).toHaveCount(0);
  await expect(page.getByText('2/2', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next media' }).click();
  await expect(page.getByText('2/2', { exact: true })).toBeVisible();
  await expect(page.getByText(/Asia\/Kolkata/).first()).toBeVisible();
  await page.getByRole('switch', { name: 'Schedule for later' }).click();
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86_400_000));
  await page.getByLabel('Scheduled date and time').fill(`${tomorrow}T10:30`);
  await expect(page.getByText(/Will publish:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule post', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('publisher-ist-schedule.png') });
  const scrollRegion = page.getByTestId('social-publisher-scroll-region');
  await scrollRegion.hover();
  await page.mouse.wheel(0, 4000);
  if (testInfo.project.name.includes('mobile')) await expect.poll(() => scrollRegion.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('publisher-preview-scrolled.png') });
  await page.getByRole('button', { name: 'Schedule post', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Post scheduled', exact: true })).toBeVisible();
  expect(reviewedRequest).toMatchObject({ expectedVersion: 1, expectedReviewToken: 'fixture-review', timezone: 'Asia/Kolkata', scheduledFor: `${tomorrow}T05:00:00.000Z`, targets: [{ platform: 'facebook', credentialId: 11, caption: 'Reviewed launch caption', postType: 'photo' }] });
  await page.screenshot({ path: testInfo.outputPath('publisher-scheduled-receipt.png') });
});

test('an interrupted publication retries the same request after retry and reload', async ({ page }, testInfo) => {
  const keys: string[] = [];
  await page.route('**/api/content/assets/951', route => route.fulfill({ json: {
    id: 951, publishingReviewToken: 'fixture-review', type: 'social_post', title: 'Receipt recovery fixture', content: JSON.stringify({ caption: 'Exact recovery copy' }), channel: 'facebook', status: 'draft', version: 1,
  } }));
  await page.route('**/api/content/publishing/accounts*', route => route.fulfill({ json: { accounts: [
    { platform: 'facebook', credentialId: 11, accountName: 'Fixture Facebook', providerAccountId: 'fixture-page', readiness: 'ready', isSelected: true, expired: false },
  ] } }));
  await page.route('**/api/content/assets/951/publish', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) return route.abort('failed');
    return route.fulfill({ status: 202, json: { success: false, accepted: true, results: { facebook: { success: false, status: 'claimed', assetId: 951, attemptId: 1951 } } } });
  });
  await page.goto('/dashboard/saved-templates/social/publish?assetId=951');
  await page.getByRole('button', { name: 'Publish post', exact: true }).click();
  await expect(page.getByText(/retry unchanged settings/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish post', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Publishing in progress', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('accepted-retry-receipt.png') });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Publish post', exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  await page.getByRole('button', { name: 'Publish post', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Publishing in progress', exact: true })).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(keys[0]).toBeTruthy();
  expect(new Set(keys).size).toBe(1);
});

test('LinkedIn reviews a pinned account and schedules an exact-version text publication', async ({ page }, testInfo) => {
  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/content/assets/956', route => route.fulfill({ json: { id: 956, version: 3, publishingReviewToken: 'linkedin-reviewed-source', type: 'social_post', title: 'Reviewed LinkedIn draft', content: 'Reviewed LinkedIn text', channel: 'linkedin', status: 'draft' } }));
  await page.route('**/api/content/publishing/accounts*', route => route.fulfill({ json: { accounts: [{ platform: 'linkedin', credentialId: 13, accountName: 'Reviewed LinkedIn author', providerAccountId: 'urn:li:person:fixture', expired: false }] } }));
  await page.route('**/api/content/assets/956/publish', route => {
    requestBody = route.request().postDataJSON();
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    return route.fulfill({ json: { success: true, scheduled: true, results: { linkedin: { success: true, status: 'pending', attemptId: 1956 } } } });
  });
  await page.goto('/dashboard/saved-templates/social/publish?assetId=956');
  await expect(page.getByRole('region', { name: 'LinkedIn destination settings' })).toBeVisible();
  await expect(page.getByText('LinkedIn text post').first()).toBeVisible();
  await page.getByRole('switch', { name: 'Schedule for later' }).click();
  const tomorrow = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400000));
  await page.getByLabel('Scheduled date and time').fill(`${tomorrow}T12:30`);
  await page.getByRole('button', { name: 'Schedule post', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Post scheduled', exact: true })).toBeVisible();
  expect(requestBody).toMatchObject({ expectedVersion: 3, expectedReviewToken: 'linkedin-reviewed-source', targets: [{ platform: 'linkedin', credentialId: 13, postType: 'text', caption: 'Reviewed LinkedIn text' }] });
  await page.screenshot({ path: testInfo.outputPath('linkedin-reviewed-schedule.png') });
});

test('YouTube upload recovery checks the retained session after a reload', async ({ page }, testInfo) => {
  let initiated = 0; let chunks = 0; let checked = 0; let finalized = 0;
  await page.route('**/api/youtube/oauth/status', route => route.fulfill({ json: { connected: true, readiness: 'ready', channelId: 'fixture-channel', channelName: 'Fixture channel' } }));
  await page.route('**/api/channel-accounts/youtube', route => route.fulfill({ json: [{ id: 11, accountName: 'Fixture channel', accountIdentifier: 'fixture-channel', isSelected: true }] }));
  await page.route('**/api/youtube/manage/readiness?*', route => route.fulfill({ json: { ready: true } }));
  await page.route('**/api/youtube/manage/uploads/initiate', route => { initiated++; return route.fulfill({ json: { sessionToken: 'fixture-session', expiresAt: '2099-01-01T00:00:00Z' } }); });
  await page.route('**/api/youtube/manage/uploads/chunk', route => { chunks++; return route.abort('failed'); });
  await page.route('**/api/youtube/manage/uploads/status', route => { checked++; return route.fulfill({ json: { complete: true, video: { id: 'MOCK_VIDEO' } } }); });
  await page.route('**/api/youtube/manage/uploads/finalize', route => { finalized++; return route.fulfill({ json: { videoId: 'MOCK_VIDEO', processingStatus: 'processing' } }); });
  await page.goto('/dashboard/integrations/youtube');
  await page.getByLabel('Video file', { exact: true }).setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(16) });
  await page.getByPlaceholder('Video title', { exact: true }).fill('Reviewed fixture');
  await page.getByRole('button', { name: 'Upload in chunks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check upload status', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByPlaceholder('Video title', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check upload status', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Uploaded MOCK_VIDEO');
  expect({ initiated, chunks, checked, finalized }).toEqual({ initiated: 1, chunks: 1, checked: 1, finalized: 1 });
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('youtube-upload:v1:')))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('youtube-recovered-after-reload.png') });
});
