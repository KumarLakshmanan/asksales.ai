import type { Page, Route } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

type Reply = { status: number; body: Record<string, unknown> };
type Pending = { method: string; path: string; payload: Record<string, unknown>; release: (reply: Reply) => void };
const labels = ['Template Name', 'Post Title', 'Content', 'Category (optional)', 'Tags (comma separated)', 'Description (optional)'];

async function installEditor(page: Page) {
  const templates = ['Alpha', 'Beta', 'Predefined'].map((name, index) => ({
    id: index + 1, name, type: 'blog', userId: 4101,
    content: JSON.stringify({ title: `${name} title`, body: `${name} body` }),
    isPredefined: name === 'Predefined', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  }));
  const state = { pending: [] as Pending[], blocked: [] as string[], errors: [] as string[], templateReads: 0, expectedErrors: 0 };
  page.on('pageerror', error => state.errors.push(error.message));
  // Browser-only settlement markers ensure assertions run after the mocked
  // JSON has been consumed. No timer, sleep, zoom, or forced interaction.
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    const browser = window as unknown as { blogRepliesConsumed: number };
    browser.blogRepliesConsumed = 0;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = args[1]?.method || (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET' && /\/api\/content\/(templates|studio\/blog-post)/.test(url)) {
        const read = response.json.bind(response);
        response.json = async () => {
          const body = await read();
          // Playwright observes consumption on a rendering tick, after the
          // application has resumed its response continuation.
          queueMicrotask(() => { browser.blogRepliesConsumed++; });
          return body;
        };
      }
      return response;
    };
  });
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const method = request.method();
    const save = (path === '/api/content/templates' && method === 'POST') || (/^\/api\/content\/templates\/\d+$/.test(path) && method === 'PUT');
    const generation = path === '/api/content/studio/blog-post' && method === 'POST';
    if (save || generation) {
      const reply = await new Promise<Reply>(release => state.pending.push({ method, path, payload: request.postDataJSON(), release }));
      if (reply.status >= 400) state.expectedErrors++;
      return route.fulfill({ status: reply.status, json: reply.body });
    }
    if (!['GET', 'HEAD'].includes(method)) {
      state.blocked.push(`${method} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Unexpected mutation blocked by local Blog fixture' } });
    }
    if (path === '/api/content/templates') {
      state.templateReads++;
      return route.fulfill({ json: { templates, total: templates.length } });
    }
    if (path === '/api/content/assets') return route.fulfill({ json: [] });
    if (path === '/api/content/templates/counts') return route.fulfill({ json: { blog: 3 } });
    if (path === '/api/content/assets/counts') return route.fulfill({ json: {} });
    // These exact reads are already intercepted by installAppShellMocks.
    if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/outreach/assistants/catalog', '/api/organizations', '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/chat/threads', '/api/notifications/unread/count'].includes(path)) return route.fallback();
    // Every remaining API request terminates locally, including unsupported
    // reads. No API, provider job, or settings write reaches a backend.
    return route.fulfill({ json: {} });
  });
  await page.goto('/dashboard/saved-templates/blog');
  await expect(page.getByRole('button', { name: 'Edit Alpha', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Predefined', exact: true })).toHaveCount(0);
  return state;
}

async function settle(page: Page, request: Pending, body: Record<string, unknown>, status = 200) {
  const before = await page.evaluate(() => (window as unknown as { blogRepliesConsumed: number }).blogRepliesConsumed);
  request.release({ status, body });
  await page.waitForFunction(previous => (window as unknown as { blogRepliesConsumed: number }).blogRepliesConsumed > previous, before);
}

async function open(page: Page, name: string) {
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Blog Post' })).toBeVisible();
}

test.afterEach(async ({ page, audit }) => {
  const state = states.get(page);
  if (!state) return;
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
  expect(audit.consoleErrors).toHaveLength(state.expectedErrors);
  if (state.expectedErrors) expect(audit.consoleErrors.every(message => /503 \(Service Unavailable\)/.test(message))).toBe(true);
  states.delete(page);
});
const states = new WeakMap<Page, Awaited<ReturnType<typeof installEditor>>>();
async function setup(page: Page) { const state = await installEditor(page); states.set(page, state); return state; }

test('create then Cancel/open Beta preserves the newer draft and blocks a second pending save', async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Build reusable template' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template Name', { exact: true }).fill('New Alpha');
  await dialog.getByLabel('Content', { exact: true }).fill('Alpha body');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.pending.length).toBe(1);
  expect(state.pending[0]).toMatchObject({ method: 'POST', path: '/api/content/templates', payload: { name: 'New Alpha', type: 'blog', content: 'Alpha body', description: '', category: '', tags: [] } });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0); await open(page, 'Beta');
  await dialog.getByLabel('Content', { exact: true }).fill('New Beta draft');
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  expect(state.pending).toHaveLength(1);
  await settle(page, state.pending[0], { id: 100 });
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('New Beta draft');
  await expect(dialog.getByLabel('Post Title', { exact: true })).toHaveValue('Beta title');
  await expect(page.getByText('Blog post created', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('newer-draft-after-old-create.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => state.pending.length).toBe(2);
  expect(state.pending[1]).toMatchObject({ path: '/api/content/templates/2', payload: { content: JSON.stringify({ title: 'Beta title', body: 'New Beta draft' }) } });
  await settle(page, state.pending[1], { id: 2 });
  await expect(dialog).toHaveCount(0); await expect(page.getByText('Blog post updated', { exact: true })).toBeVisible();
});

test('labels focus their actual fields and keyboard save/Escape preserve a reopened draft', async ({ page }, testInfo) => {
  const state = await setup(page); await open(page, 'Alpha');
  const dialog = page.getByRole('dialog');
  const ids: string[] = [];
  for (const label of labels) {
    await dialog.getByText(label, { exact: true }).click();
    const field = dialog.getByLabel(label, { exact: true });
    await expect(field).toBeFocused();
    ids.push(await field.getAttribute('id') || '');
  }
  expect(new Set(ids).size).toBe(6); expect(ids.every(Boolean)).toBe(true);
  const scale = await page.evaluate(() => window.visualViewport?.scale);
  expect(scale).toBe(1);
  await expectNoHorizontalOverflow(page);
  await dialog.getByLabel('Template Name', { exact: true }).fill('Keyboard Alpha');
  await dialog.getByRole('button', { name: 'Update', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.pending.length).toBe(1);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await open(page, 'Beta');
  await dialog.getByLabel('Content', { exact: true }).fill('Keyboard Beta draft');
  await settle(page, state.pending[0], { id: 1 });
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Keyboard Beta draft');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('keyboard-labels-and-newer-draft.png'), fullPage: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel' }); await cancel.focus(); await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0); await open(page, 'Beta');
  await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Beta body');
});

test('generation after manual typing leaves the draft intact and current generation still works', async ({ page }) => {
  const state = await setup(page); await open(page, 'Alpha'); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI Generate' }).click();
  await expect.poll(() => state.pending.length).toBe(1);
  await dialog.getByLabel('Content', { exact: true }).fill('Manual draft while generating');
  await settle(page, state.pending[0], { title: 'Old title', content: 'Old body' });
  await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Manual draft while generating');
  await expect(dialog.getByLabel('Post Title', { exact: true })).toHaveValue('Alpha title');
  await expect(page.getByText('AI generated blog content', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'AI Generate' }).click();
  await expect.poll(() => state.pending.length).toBe(2);
  expect(state.pending[1].payload).toEqual({ prompt: 'Alpha title', persist: false });
  await settle(page, state.pending[1], { title: 'Current title', body: 'Current body' });
  await expect(dialog.getByLabel('Post Title', { exact: true })).toHaveValue('Current title');
  await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Current body');
  await expect(dialog.getByRole('button', { name: 'AI Generate' })).toBeEnabled();
});

for (const status of [200, 503]) {
  test(`old generation ${status} after Cancel/open Beta cannot overwrite or release newer pending state`, async ({ page }) => {
    const state = await setup(page); await open(page, 'Alpha'); const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'AI Generate' }).click();
    await expect.poll(() => state.pending.length).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel' }).click(); await open(page, 'Beta');
    await dialog.getByRole('button', { name: 'AI Generate' }).click();
    await expect.poll(() => state.pending.length).toBe(2);
    await settle(page, state.pending[0], status === 200 ? { title: 'Old title', content: 'Old body' } : { error: 'Synthetic unavailable' }, status);
    await expect(dialog.getByRole('button', { name: 'AI Generate' })).toBeDisabled();
    await expect(dialog.getByLabel('Post Title', { exact: true })).toHaveValue('Beta title');
    await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Beta body');
    await expect(page.getByText('AI generation failed', { exact: true })).toHaveCount(0);
    await settle(page, state.pending[1], { content: 'New Beta generation' });
    await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('New Beta generation');
    await expect(dialog.getByRole('button', { name: 'AI Generate' })).toBeEnabled();
  });
}

for (const kind of ['create', 'update']) {
  test(`${kind} errors preserve all six fields for an exact retry`, async ({ page }, testInfo) => {
    const state = await setup(page);
    if (kind === 'create') await page.getByRole('button', { name: 'Build reusable template' }).click(); else await open(page, 'Alpha');
    const dialog = page.getByRole('dialog'), values = ['Recoverable name', 'Recoverable title', 'Recoverable body', 'Marketing', 'launch, news', 'Recoverable description'];
    for (const [index, label] of labels.entries()) await dialog.getByLabel(label, { exact: true }).fill(values[index]);
    const save = dialog.getByRole('button', { name: kind === 'create' ? 'Create' : 'Update', exact: true });
    await save.click(); await expect.poll(() => state.pending.length).toBe(1);
    await settle(page, state.pending[0], { error: 'Synthetic unavailable' }, 503);
    await expect(save).toBeEnabled();
    for (const [index, label] of labels.entries()) await expect(dialog.getByLabel(label, { exact: true })).toHaveValue(values[index]);
    await expect(page.getByText(kind === 'create' ? 'Failed to create post' : 'Failed to update post', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${kind}-error-preserves-draft.png`), fullPage: true });
    await save.click(); await expect.poll(() => state.pending.length).toBe(2);
    expect(state.pending[1].payload).toEqual(state.pending[0].payload);
    expect(Object.keys(state.pending[1].payload).sort()).toEqual(['category', 'content', 'description', 'name', 'tags', 'type']);
    await settle(page, state.pending[1], { id: kind === 'create' ? 100 : 1 });
    await expect(dialog).toHaveCount(0);
  });
}

test('route unmount fences a pending generation and the shared dark modal remains usable', async ({ page }, testInfo) => {
  const state = await setup(page); await open(page, 'Alpha');
  await page.evaluate(() => { document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-ui-layer', 'modal');
  await dialog.getByLabel('Content', { exact: true }).fill('Dark draft');
  await dialog.getByRole('button', { name: 'AI Generate' }).click();
  await expect.poll(() => state.pending.length).toBe(1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('dark-owned-editor.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Content library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Content library', exact: true })).toBeVisible();
  await settle(page, state.pending[0], { title: 'Unmounted title', content: 'Unmounted body' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('AI generated blog content', { exact: true })).toHaveCount(0);
});
