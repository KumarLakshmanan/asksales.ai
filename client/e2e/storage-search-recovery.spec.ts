import type { Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import type { WorkspaceFile } from '../src/lib/storage-workspace';

const documents: WorkspaceFile[] = Array.from({ length: 5 }, (_, index) => ({
  id: 701 + index, fileName: `brief-${index + 1}.txt`, originalName: `Filtered brief ${index + 1}.txt`,
  mimeType: 'text/plain', fileSizeBytes: 500 - index, category: 'document', storageKey: '', url: null,
  createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', businessProfileId: 4102,
  referenceType: 'user_upload', referenceId: null, workspace: { tags: ['launch'], collection: 'Autumn' },
  source: null, dependency: { linked: false, needsReview: false, message: 'No source link recorded.' },
}));
const shellReads = new Set(['/api/auth/me', '/api/platform/access', '/api/settings/preferences',
  '/api/organizations', '/api/wallet', '/api/crm/configuration', '/api/notifications/unread/count',
  '/api/settings/outreach/assistants/catalog']);

async function workspace(page: Page) {
  const state = { writes: [] as string[], forbiddenReads: [] as string[],
    reads: [] as { url: string; profile: string | undefined }[],
    holdFiles: false, release: undefined as (() => void) | undefined };
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101, name: 'Regression Alpha' }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  // Every API read is a disposable fixture; every mutation/content/download is blocked.
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const ok = (data: unknown) => route.fulfill({ json: { success: true, data } });
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Storage search fixture blocks every mutation.' } });
    }
    if (/\/storage\/.*(?:download|content|thumbnail)/.test(path)) {
      state.forbiddenReads.push(path);
      return route.fulfill({ status: 409, json: { error: 'Storage search fixture blocks file content and downloads.' } });
    }
    if (shellReads.has(path)) return route.fallback();
    if (path === '/api/settings/business-profiles') return route.fulfill({ json: [
      { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
      { id: 4103, name: 'Other workspace', companyName: 'Other workspace', role: 'owner' },
    ] });
    if (path === '/api/chat/threads') return route.fulfill({ json: { threads: [], total: 0 } });
    const profile = request.headers()['x-business-profile-id'];
    if (path.startsWith('/api/settings/storage/workspace')) state.reads.push({ url: path + url.search, profile });
    if (path === '/api/settings/storage/workspace') return ok({
      storageUsedBytes: 1000, maxStorageBytes: 5000, fileCount: 6, usagePercent: 20, planName: 'Starter',
      businessProfileId: Number(profile), businessName: profile === '4103' ? 'Other workspace' : 'Regression Company',
      activeCount: 5, activeBytes: 2490, trashCount: 1, trashBytes: 500, collections: ['Autumn'], retentionDays: 30,
      breakdown: [{ category: 'document', count: 5, bytes: 2490 }],
    });
    if (path === '/api/settings/storage/workspace/files') {
      if (state.holdFiles && !url.searchParams.has('search')) {
        state.holdFiles = false;
        await new Promise<void>(resolve => { state.release = resolve; });
      }
      const params = url.searchParams;
      let files = profile === '4103'
        ? [{ ...documents[0], id: 799, originalName: 'Other workspace brief.txt', businessProfileId: 4103 }]
        : documents;
      if (params.get('view') === 'trash') files = [{ ...files[0], workspace: { ...files[0].workspace, trashedAt: '2026-10-01T00:00:00Z' } }];
      if (params.has('search')) files = files.filter(file => file.originalName!.toLowerCase().includes(params.get('search')!.toLowerCase()));
      if (params.has('category')) files = files.filter(file => file.category === params.get('category'));
      if (params.get('type') === 'document') files = files.filter(file => file.mimeType === 'text/plain');
      if (params.has('after')) files = files.filter(file => file.createdAt >= params.get('after')!);
      if (params.has('before')) files = files.filter(file => file.createdAt < params.get('before')!);
      if (params.has('minSize')) files = files.filter(file => file.fileSizeBytes >= Number(params.get('minSize')));
      if (params.has('maxSize')) files = files.filter(file => file.fileSizeBytes <= Number(params.get('maxSize')));
      if (params.has('tag')) files = files.filter(file => file.workspace.tags?.includes(params.get('tag')!));
      if (params.has('collection')) files = files.filter(file => file.workspace.collection === params.get('collection'));
      if (params.get('sort') === 'size') files = [...files].sort((a, b) => b.fileSizeBytes - a.fileSizeBytes);
      const offset = Number(params.get('cursor') || 0);
      return ok({ files: files.slice(offset, offset + 2), total: files.length,
        nextCursor: offset + 2 < files.length ? String(offset + 2) : null });
    }
    if (path.endsWith('/activity')) return ok({ events: [{ id: 1, name: 'Fixture activity', action: 'uploaded',
      at: documents[0].createdAt, actor_user_id: 4101 }], total: 1 });
    if (path.endsWith('/folders')) return ok({ folders: [], total: 0 });
    return route.fulfill({ json: {} });
  });
  return state;
}

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name.startsWith('mobile')
    ? { width: 390, height: 844 } : { width: 1180, height: 757 });
});
test.afterEach(async ({ audit }) => {
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  // Header cancels a stale unread-count read when the selected business hydrates
  // or changes. Keep all Storage failures (and all other notification errors)
  // visible while allowing that unrelated, intentional AbortController cleanup.
  expect(audit.failedRequests.filter(request =>
    !/^GET https?:\/\/[^/]+\/api\/notifications\/unread\/count: net::ERR_ABORTED$/.test(request),
  )).toEqual([]);
});
async function evidence(page: Page, info: TestInfo, label: string) {
  await expectNoHorizontalOverflow(page);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    scale: visualViewport?.scale, zoom: getComputedStyle(document.documentElement).zoom,
    scrollWidth: document.documentElement.scrollWidth, activeTag: document.activeElement?.tagName,
    activeName: document.activeElement?.getAttribute('aria-label') }));
  expect(dimensions.width).toBe(page.viewportSize()?.width);
  expect(dimensions.height).toBe(page.viewportSize()?.height);
  expect(dimensions.scale).toBe(1);
  expect(dimensions.zoom).toBe('1');
  await info.attach(`${label}-dimensions-focus`, { body: JSON.stringify(dimensions), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true });
}
function noActions(state: Awaited<ReturnType<typeof workspace>>) {
  expect(state.writes).toEqual([]);
  expect(state.forbiddenReads).toEqual([]);
  expect(state.reads.every(read => read.profile === '4102' || read.profile === '4103')).toBe(true);
}

test('repeated keyboard and pointer Clear search recover no matches and settled input focus', async ({ page }, info) => {
  const state = await workspace(page);
  await page.goto('/dashboard/storage');
  await expect(page.getByText('Showing 2 of 5 files')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search files' });
  for (const [attempt, activation] of ['Enter', 'Enter', 'Space', 'pointer'].entries()) {
    await search.fill(`no-match-${attempt}`);
    await expect(page.getByRole('heading', { name: 'No matching files' })).toBeVisible();
    if (attempt === 0) await evidence(page, info, 'no-match');
    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    if (activation === 'pointer') await clear.click();
    else {
      await search.focus();
      await page.keyboard.press('Tab');
      await expect(clear).toBeFocused();
      await page.keyboard.press(activation);
    }
    await evidence(page, info, `clear-${attempt}-${activation}`);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(clear).toHaveCount(0);
    await expect(page.getByText('Showing 2 of 5 files')).toBeVisible();
    // Check after the search debounce and a newer keyboard focus action too.
    await page.keyboard.press('Tab');
    const sort = page.getByRole('combobox', { name: 'Sort files' });
    await expect(sort).toBeFocused();
    await page.waitForTimeout(300);
    await expect(sort).toBeFocused();
    expect(new URL(page.url()).searchParams.has('search')).toBe(false);
  }
  noActions(state);
});

test('clearing retains file filters, sort, loaded pagination, grid view and workspace', async ({ page }, info) => {
  const state = await workspace(page);
  const retained = new URLSearchParams({ category: 'document', sort: 'size', type: 'document',
    after: '2026-09-01', before: '2026-10-01', minSize: '100', maxSize: '1000', tag: 'launch', collection: 'Autumn' });
  await page.goto(`/dashboard/storage?${retained}`);
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText('Showing 4 of 5 files')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search files' });
  await search.fill('no-match');
  await expect(page.getByRole('heading', { name: 'No matching files' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page.getByText('Showing 4 of 5 files')).toBeVisible();
  expect(new URL(page.url()).searchParams.toString()).toBe(retained.toString());
  await expect(page.getByRole('combobox', { name: 'Sort files' })).toHaveValue('size');
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('active-business-profile:4101'))).toBe('4102');
  expect(state.reads.filter(read => read.url.includes('/workspace/files?')).every(read => {
    const params = new URL(read.url, 'https://fixture.test').searchParams;
    return Array.from(retained).every(([key, value]) => params.get(key) === value);
  })).toBe(true);
  await evidence(page, info, 'filters-pagination-recovered');
  noActions(state);
});

test('a delayed clear response preserves newer focus', async ({ page }, info) => {
  const state = await workspace(page);
  await page.goto('/dashboard/storage?search=no-match');
  await expect(page.getByRole('heading', { name: 'No matching files' })).toBeVisible();
  state.holdFiles = true;
  const search = page.getByRole('searchbox', { name: 'Search files' });
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toBeFocused();
  await expect.poll(() => typeof state.release).toBe('function');
  const sort = page.getByRole('combobox', { name: 'Sort files' });
  await sort.focus();
  state.release!();
  await expect(page.getByText('Showing 2 of 5 files')).toBeVisible();
  await expect(sort).toBeFocused();
  await page.waitForTimeout(300);
  await expect(sort).toBeFocused();
  await evidence(page, info, 'newer-focus-retained');
  noActions(state);
});

test('newer search, Storage navigation, history and workspace selection keep ownership of state and focus', async ({ page }, info) => {
  const state = await workspace(page);
  await page.goto('/dashboard/storage?search=no-match');
  await expect(page.getByRole('heading', { name: 'No matching files' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).press('Enter');
  const search = page.getByRole('searchbox', { name: 'Search files' });
  await search.fill('brief');
  await expect(page).toHaveURL(/search=brief/);
  await expect(page.getByText('Showing 2 of 5 files')).toBeVisible();
  await search.focus();
  await expect(search).toBeFocused();
  const browse = page.getByRole('combobox', { name: 'Browse storage' });
  // The persistent compact control is CSS-hidden on desktop; use the visible navigation there.
  if (await browse.isVisible()) {
    await browse.selectOption('activity');
    await browse.focus();
    await expect(browse).toBeFocused();
  } else {
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
  }
  await expect(page.getByText('Fixture activity', { exact: true })).toBeVisible();
  await expect(search).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(search).toHaveCount(0);
  await page.goBack();
  await expect(search).toHaveValue('brief');
  await expect(page.getByText('Showing 2 of 5 files')).toBeVisible();
  // Emit the existing selection event to exercise the Storage consumer without opening shared dialogs.
  await page.evaluate(() => {
    sessionStorage.setItem('active-business-profile:4101', '4103');
    window.dispatchEvent(new Event('business-profile-changed'));
  });
  await expect(page.getByRole('button', { name: 'Other workspace brief.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filtered brief 1.txt', exact: true })).toHaveCount(0);
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue('brief');
  await evidence(page, info, 'newer-workspace-retained');
  noActions(state);
});

test('conditional clear also recovers Trash, cleanup and folder empty states', async ({ page }, info) => {
  const state = await workspace(page);
  for (const view of ['trash', 'cleanup', 'folders']) {
    await page.goto(`/dashboard/storage?view=${view}&search=no-match`);
    await expect(page.getByText(view === 'trash' ? 'Trash is empty' : view === 'cleanup'
      ? 'No files match these cleanup criteria' : /No folders found/)).toBeVisible();
    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    await clear.press('Enter');
    await expect(page.getByRole('searchbox', { name: 'Search files' })).toBeFocused();
    expect(new URL(page.url()).searchParams.get('view')).toBe(view);
    await expect(page.getByRole('button', { name: view === 'folders'
      ? 'Documents 5 files · 2.43 KB' : 'Filtered brief 1.txt', exact: true })).toBeVisible();
  }
  await evidence(page, info, 'folder-recovered');
  noActions(state);
});

test('320x568 actual viewport supports repeated keyboard clear at normal zoom', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const state = await workspace(page);
  await page.goto('/dashboard/storage');
  const search = page.getByRole('searchbox', { name: 'Search files' });
  for (let attempt = 0; attempt < 2; attempt++) {
    await search.fill('no-match');
    await expect(page.getByRole('heading', { name: 'No matching files' })).toBeVisible();
    await search.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await expect(page.getByText('Showing 2 of 5 files')).toBeVisible();
  }
  await evidence(page, info, '320x568-recovered');
  noActions(state);
});
