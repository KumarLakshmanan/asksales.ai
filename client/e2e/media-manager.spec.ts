import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, video: 'off' });

const shellReads = new Set([
  '/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/organizations',
  '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet',
  '/api/chat/threads', '/api/notifications/unread/count',
]);
const image = '/uploads/fixture-image.png', video = '/uploads/fixture-video.mp4';
const addedImage = '/uploads/fixture-new.png', addedVideo = '/uploads/fixture-new.mp4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
const mp4 = readFileSync(resolve(__dirname, 'fixtures/whatsapp-preview.mp4'));

async function mediaFixtures(page: Page) {
  const state = {
    asset: {
      id: 812, type: 'social_post', title: 'Disposable media draft', content: JSON.stringify({ caption: 'Keep this draft body' }),
      channel: 'instagram', status: 'draft', createdAt: '2026-10-01T12:00:00Z', threadId: 171,
      imageUrl: image, imageUrls: [image], videoUrl: video, videoUrls: [video],
    },
    writes: [] as { method: string; path: string; body: unknown }[],
    pageErrors: [] as string[],
    unexpected: [] as string[], failNext: false, holdGeneration: false, generationPending: false,
    releaseGeneration: () => {},
    holdNextPath: null as string | null, retiredPending: false, retiredSettled: false, releaseRetired: () => {},
  };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  const origin = new URL(test.info().project.use.baseURL as string || 'http://127.0.0.1:3000').origin;
  // No connector, provider, or application request may leave this local fixture.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { state.unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`); return route.abort(); }
    return route.fallback();
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (shellReads.has(path) && method === 'GET') return route.fallback();
    if (path === '/api/auth/csrf-token') return route.fulfill({ json: { csrfToken: 'disposable-media-csrf' } });
    if (path.startsWith('/api/uploads/fixture-')) return route.fulfill({ contentType: path.endsWith('.mp4') ? 'video/mp4' : 'image/png', body: path.endsWith('.mp4') ? mp4 : png });
    if (method === 'GET') {
      if (path === '/api/content/assets/812') return route.fulfill({ json: state.asset });
      if (path === '/api/content/assets') return route.fulfill({ json: [state.asset] });
      if (path === '/api/content/templates') return route.fulfill({ json: { templates: [], total: 0 } });
      return route.fulfill({ json: {} });
    }
    const body = path.endsWith('/upload') ? 'Disposable intercepted multipart file' : request.postDataJSON();
    state.writes.push({ method, path, body });
    if (!['/api/content/assets/upload', '/api/content/studio/image', '/api/content/studio/video', '/api/content/assets/812'].includes(path)) {
      state.unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Unconfigured disposable fixture mutation' } });
    }
    if (state.failNext) { state.failNext = false; return route.fulfill({ status: 422, json: { error: 'Disposable media failure' } }); }
    if (state.holdNextPath === path) {
      state.holdNextPath = null; state.retiredPending = true;
      await new Promise<void>(resolve => { state.releaseRetired = resolve; });
      const retiredUrl = '/uploads/fixture-retired.png';
      const retiredResponse = path.endsWith('/upload') ? { success: true, url: retiredUrl }
        : path.endsWith('/image') ? { success: true, persisted: true, assetId: 812, imageUrl: retiredUrl }
          : { ...state.asset, ...body };
      await route.fulfill({ json: retiredResponse });
      state.retiredSettled = true;
      return;
    }
    if (path === '/api/content/assets/812') {
      Object.assign(state.asset, body);
      return route.fulfill({ json: state.asset });
    }
    if (path === '/api/content/studio/image' && state.holdGeneration) {
      state.generationPending = true;
      await new Promise<void>(resolve => { state.releaseGeneration = resolve; });
      state.generationPending = false;
    }
    const isVideo = path.endsWith('/video') || (path.endsWith('/upload') && request.postData()?.includes('video/mp4'));
    const url = isVideo ? addedVideo : addedImage;
    const field = isVideo ? 'videoUrls' : 'imageUrls';
    state.asset[field] = [...new Set([...state.asset[field], url])];
    return route.fulfill({ json: path.endsWith('/upload') ? { success: true, url } : { success: true, persisted: true, assetId: 812, [isVideo ? 'videoUrl' : 'imageUrl']: url } });
  });
  await page.addInitScript(() => localStorage.setItem('token', 'disposable-intercepted-session'));
  return state;
}

async function editor(page: Page) {
  await page.goto('/dashboard/saved-templates/social');
  const open = page.getByRole('button', { name: 'Edit Disposable media draft', exact: true });
  await expect(open).toBeVisible(); await open.click();
  const dialog = page.getByRole('dialog', { name: 'Edit social draft', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('mixed media add/remove/selection and concurrent responses preserve the draft', async ({ page, audit }, info) => {
  const state = await mediaFixtures(page);
  const dialog = await editor(page);
  const mainImage = dialog.getByRole('img', { name: /^Image \d+$/ });
  await dialog.getByLabel('Upload image or video').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
  await expect(mainImage).toHaveAttribute('src', `/api${addedImage}`);
  await expect(dialog.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Show video 1' }).focus(); await page.keyboard.press('Space');
  await expect(dialog.getByLabel('Video 1', { exact: true })).toHaveAttribute('src', `/api${video}`);
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Disposable image description');
  state.holdGeneration = true;
  await dialog.getByRole('button', { name: 'Generate Image', exact: true }).click();
  await expect.poll(() => state.generationPending).toBe(true);
  await dialog.getByLabel('Upload image or video').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(dialog.getByRole('button', { name: 'Show video 2' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Delete media' })).toBeDisabled();
  state.releaseGeneration();
  await expect(mainImage).toHaveAttribute('src', `/api${addedImage}`);
  await expect(dialog.getByRole('button', { name: 'Show video 2' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Show video 2' }).focus(); await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Delete media' }).click();
  await expect(dialog.getByRole('button', { name: 'Show video 2' })).toHaveCount(0);
  await expect(dialog.getByLabel('Video 1', { exact: true })).toHaveAttribute('src', `/api${video}`);
  await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft body');
  const deletion = state.writes.find(write => write.method === 'PUT');
  expect(deletion?.body).toEqual({ imageUrl: image, imageUrls: [image, addedImage], videoUrl: video, videoUrls: [video] });
  expect(state.writes.filter(write => write.path === '/api/content/studio/image')[0].body).toMatchObject({ assetId: 812, threadId: 171, saveToAssets: true });
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]); expect(audit.consoleErrors).toEqual([]); expect(audit.failedRequests).toEqual([]);
  await expectNoHorizontalOverflow(page);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await page.screenshot({ path: info.outputPath('mixed-media.png'), fullPage: true });
});

test('generation labels, keyboard selects, reference removal and failure recovery', async ({ page, audit }, info) => {
  const state = await mediaFixtures(page);
  const dialog = await editor(page);
  await dialog.getByRole('button', { name: 'Generate', exact: true }).focus(); await page.keyboard.press('Enter');
  await dialog.getByText('Prompt', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Prompt', exact: true })).toBeFocused();
  await dialog.getByRole('combobox', { name: 'Aspect Ratio', exact: true }).focus(); await page.keyboard.press('Space');
  await page.getByRole('option', { name: '16:9 (Landscape)', exact: true }).press('Enter');
  await expect(dialog.getByRole('combobox', { name: 'Aspect Ratio', exact: true })).toContainText('16:9');
  await dialog.getByLabel('Reference Images', { exact: true }).setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: png }, { name: 'two.png', mimeType: 'image/png', buffer: png },
  ]);
  const removeImage = dialog.getByRole('button', { name: 'Remove reference image 2', exact: true });
  await removeImage.focus(); await page.keyboard.press('Space');
  await expect(removeImage).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Add reference images' })).toBeFocused();
  await dialog.getByRole('tab', { name: 'Video', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible();
  const duration = dialog.getByRole('combobox', { name: 'Duration (seconds)', exact: true });
  await duration.focus(); await page.keyboard.press('Space');
  await page.getByRole('option', { name: '8 seconds', exact: true }).press('Enter');
  await expect(duration).toContainText('8 seconds');
  const videoAspect = dialog.getByRole('combobox', { name: 'Aspect Ratio', exact: true });
  await videoAspect.focus(); await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await expect(videoAspect).toBeFocused();
  const removeVideo = dialog.getByRole('button', { name: 'Remove video reference image', exact: true });
  await removeVideo.focus(); await page.keyboard.press('Enter');
  await expect(removeVideo).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Add Reference Image', exact: true })).toBeFocused();
  const prompt = dialog.getByRole('textbox', { name: 'Prompt', exact: true }); await prompt.fill('Retain this failed generation prompt');
  state.failNext = true; await dialog.getByRole('button', { name: 'Generate Video', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Generate Video', exact: true })).toBeEnabled();
  await expect(prompt).toHaveValue('Retain this failed generation prompt');
  await expect(dialog.getByRole('button', { name: 'Show image 1' })).toHaveAttribute('aria-pressed', 'true');
  state.failNext = true; await dialog.getByLabel('Upload image or video').setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Show image 2' })).toHaveCount(0);
  await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft body');
  const controlIds = await dialog.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(controlIds).size).toBe(controlIds.length);
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]); expect(audit.failedRequests).toEqual([]);
  // These two failures are deliberately fulfilled HTTP 422 fixtures.
  expect(audit.consoleErrors.filter(message => !message.includes('422 (Unprocessable Entity)'))).toEqual([]);
  await expectNoHorizontalOverflow(page);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await page.screenshot({ path: info.outputPath('generation-accessibility.png'), fullPage: true });
});

for (const operation of ['upload', 'generation', 'delete'] as const) {
  test(`same draft close/reopen retires the old ${operation} receipt`, async ({ page, audit }, info) => {
    const state = await mediaFixtures(page);
    let dialog = await editor(page);
    const path = operation === 'upload' ? '/api/content/assets/upload' : operation === 'generation' ? '/api/content/studio/image' : '/api/content/assets/812';
    state.holdNextPath = path;
    if (operation === 'upload') await dialog.getByLabel('Upload image or video').setInputFiles({ name: 'retired.png', mimeType: 'image/png', buffer: png });
    else if (operation === 'delete') await dialog.getByRole('button', { name: 'Delete media' }).click();
    else {
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      await dialog.getByRole('button', { name: 'Generate Image', exact: true }).click();
    }
    await expect.poll(() => state.retiredPending).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit Disposable media draft', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Edit social draft', exact: true });
    await dialog.getByLabel('Message', { exact: true }).fill('Keep newer session draft text');
    await dialog.getByLabel('Upload image or video').setInputFiles({ name: 'newer.png', mimeType: 'image/png', buffer: png });
    await expect(dialog.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep newer session generation prompt');
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() !== 'GET');
    state.releaseRetired();
    await (await oldResponse).finished();
    await expect.poll(() => state.retiredSettled).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(dialog.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('img', { name: 'Image 2', exact: true })).toHaveAttribute('src', `/api${addedImage}`);
    await expect(dialog.getByRole('button', { name: 'Show video 1' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Show image 3' })).toHaveCount(0);
    await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('Keep newer session draft text');
    await expect(dialog.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Keep newer session generation prompt');
    expect(state.writes.map(write => write.path)).toEqual([path, '/api/content/assets/upload']);
    expect(state.unexpected).toEqual([]); expect(state.pageErrors).toEqual([]);
    expect(audit.consoleErrors).toEqual([]); expect(audit.failedRequests).toEqual([]);
    await expectNoHorizontalOverflow(page);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
    await page.screenshot({ path: info.outputPath(`reopened-${operation}.png`), fullPage: true });
  });
}
