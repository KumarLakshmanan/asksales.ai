import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import type { Page, Route } from '@playwright/test';

const runtimeErrors = new WeakMap<Page, string[]>();

async function observeMockedChatSends(page: Page) {
  await page.evaluate(() => {
    const fixtureSocket = new WebSocket('ws://brand-toolkit-regression.invalid');
    const prototype = Object.getPrototypeOf(fixtureSocket);
    if (prototype.constructor.name !== 'RegressionWebSocket') throw new Error('Application WebSocket fixture required');
    const state = window as Window & { brandToolkitMockedChatSends?: string[] };
    state.brandToolkitMockedChatSends = [];
    prototype.send = (data: string) => {
      if (JSON.parse(data).type === 'send_chat_message') state.brandToolkitMockedChatSends!.push(data);
    };
    fixtureSocket.close();
  });
}

async function expectNoMockedChatSend(page: Page) {
  expect(await page.evaluate(() => (window as Window & { brandToolkitMockedChatSends?: string[] }).brandToolkitMockedChatSends)).toEqual([]);
  await expect(page.getByText('I just created a new brand toolkit. Please use my latest brand toolkit for campaigns.', { exact: true })).toHaveCount(0);
}

async function finishMockedResponse(page: Page, route: Route, status: number, json: unknown) {
  const response = page.waitForResponse(candidate => candidate.request() === route.request());
  await route.fulfill({ status, json });
  await (await response).finished();
  // Let response parsing, React updates and paint finish before asserting focus.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.beforeEach(async ({ page, audit }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  // Every API read is synthetic and every unhandled write is rejected. Deferred
  // lifecycle tests fulfill only explicitly matched saves/uploads in-process.
  // No toolkit, upload, model or provider job can reach a server.
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'No writes in the Brand Toolkit modal regression.' } });
    }
    if (path === '/api/settings/business-profiles') return json([
      { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
      { id: 4202, name: 'Second Synthetic Business', companyName: 'Second Synthetic Business', role: 'owner' },
    ]);
    if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/business-profiles',
      '/api/settings/outreach/assistants/catalog', '/api/wallet', '/api/notifications/unread/count'].includes(path)) return route.fallback();
    if (path === '/api/chat/threads') return json({ threads: [], total: 0 });
    if (path === '/api/chat/threads/509') return json({ id: 509, title: 'Synthetic Brand Toolkit review', businessId: 4102, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });
    if (path === '/api/settings/business-profiles/4102') return json({ id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' });
    if (path === '/api/chat/threads/509/messages') return json({ messages: [{
      id: 5091, role: 'agent', agentType: 'orchestrator', content: 'Review brand guidance with a local form.',
      createdAt: '2026-10-01T00:00:00Z', metadata: { actionButtons: [{
        id: 'synthetic-create-brand', label: 'Create Brand Toolkit', action: 'CREATE_BRAND_TOOLKIT',
      }] },
    }], hasMore: false, nextCursor: null });
    if (path === '/api/chat/threads/509/tabs') return json([{ tabId: 'overview-509', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: true }]);
    if (path === '/api/chat/threads/509/context-window') return json({ threadId: 509, messageCount: 1, summary: null, lastCompactedAt: null, canCompact: false,
      tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000, modelName: 'Synthetic fixture', usagePercent: 0 } });
    if (path === '/api/widgets') return json({ widgets: [] });
    if (path === '/api/chat/threads/509/overview') return json({ thread: { id: 509, title: 'Synthetic Brand Toolkit review' }, stats: { messageCount: 1, contentAssetsCount: 0, agentExecutionsCount: 0, scrapingCount: 0 }, icp: null, activeAgents: [], workflowExecutions: [], timeline: [] });
    if (path === '/api/icp/thread/509') return json(null);
    return json([]);
  });
  await page.goto('/dashboard/conversations/509');
  await page.getByRole('button', { name: 'Create Brand Toolkit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create Brand Toolkit' })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
});

test('pending Brand Values survives unrelated Brand Name changes', async ({ page, audit }, testInfo) => {
  const dialog = page.getByRole('dialog', { name: 'Create Brand Toolkit' });
  const input = dialog.getByPlaceholder('e.g., Innovation, Trust, Quality');
  await input.fill('Uncommitted trust');
  await dialog.getByPlaceholder('e.g., Acme Inc.').fill('Synthetic Studio');
  await expect(input).toHaveValue('Uncommitted trust');
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Unrelated description');
  const keywords = dialog.getByRole('textbox', { name: 'Brand Keywords', exact: true });
  await keywords.fill('  SaaS  ');
  await keywords.press('Enter');
  await expect(keywords).toBeFocused();
  await expect(keywords).toHaveValue('');
  await expect(input).toHaveValue('Uncommitted trust');
  await dialog.getByRole('button', { name: 'Remove SaaS from Brand Keywords' }).focus();
  await page.keyboard.press('Space');
  await expect(keywords).toBeFocused();
  await expect(input).toHaveValue('Uncommitted trust');
  await input.focus();
  const originalInput = await input.elementHandle();
  const viewport = page.viewportSize()!;
  // A real resize triggers the workspace's parent state update at normal zoom.
  await page.setViewportSize({ ...viewport, height: viewport.height - 40 });
  await page.setViewportSize(viewport);
  await expect(input).toBeFocused();
  expect(await input.evaluate((node, original) => node === original, originalInput)).toBe(true);
  await expect(input).toHaveValue('Uncommitted trust');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toHaveValue('Uncommitted trust');
  await input.press('Enter');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Remove Uncommitted trust from Brand Values' })).toBeVisible();
  await input.fill('Second pending value');
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale }));
  expect(dimensions).toEqual({ ...viewport, scale: 1 });
  await expect(dialog).toHaveJSProperty('scrollWidth', await dialog.evaluate(node => node.clientWidth));
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('pending-brand-values.png') });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('all steps have linked controls and keyboard palette actions preserve drafts and focus', async ({ page, audit }, testInfo) => {
  const dialog = page.getByRole('dialog', { name: 'Create Brand Toolkit' });
  const pending = [
    ['Brand Identity', 'Brand Values'], ['Voice & Tone', 'Personality Traits'],
    ['Content Style', 'Content Pillars'], ['Target Audience', 'Pain Points'],
  ];
  for (const [step, label] of pending) {
    await dialog.getByRole('button', { name: step, exact: true }).click();
    await dialog.getByRole('textbox', { name: label, exact: true }).fill(`Pending ${label}`);
  }
  await dialog.getByRole('button', { name: 'Visual Identity', exact: true }).click();
  const primary = dialog.getByLabel('Primary Colors 1 color picker', { exact: true });
  const originalPicker = await primary.elementHandle();
  await dialog.getByRole('textbox', { name: 'Image Style Reference', exact: true }).fill('Minimalist');
  const add = dialog.getByRole('button', { name: 'Add Primary Colors', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(add).toBeFocused();
  await expect(dialog.getByLabel('Primary Colors 2 color picker')).toHaveValue('#000000');
  expect(await primary.evaluate((node, original) => node === original, originalPicker)).toBe(true);
  const remove = dialog.getByRole('button', { name: 'Remove Primary Colors color 2 (#000000)' });
  await remove.focus();
  await expect(remove).toHaveCSS('opacity', '1');
  await page.keyboard.press('Space');
  await expect(add).toBeFocused();
  await expect(dialog.getByLabel('Primary Colors 2 color picker')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('palette-keyboard-focus.png') });
  for (const step of ['Brand Identity', 'Visual Identity', 'Voice & Tone', 'Content Style', 'Target Audience']) {
    await dialog.getByRole('button', { name: step, exact: true }).click();
    await expect(dialog.getByRole('button', { name: step, exact: true })).toHaveAttribute('aria-current', 'step');
    const unlinked = await dialog.locator('label').evaluateAll(labels => labels.filter(node => !node.getAttribute('for') || !document.getElementById(node.getAttribute('for')!)).map(node => node.textContent));
    expect(unlinked).toEqual([]);
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const control of await dialog.getByRole('textbox').all()) await expect(control).toHaveAccessibleName(/\S/);
    for (const control of await dialog.getByRole('button').all()) await expect(control).toHaveAccessibleName(/\S/);
    for (const [pendingStep, label] of pending) {
      if (step === pendingStep) await expect(dialog.getByRole('textbox', { name: label, exact: true })).toHaveValue(`Pending ${label}`);
    }
    await expect(dialog).toHaveJSProperty('scrollWidth', await dialog.evaluate(node => node.clientWidth));
    await expectNoHorizontalOverflow(page);
  }
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('blank-name validation keeps drafts and three close/reopen cycles reset the form', async ({ page, audit }, testInfo) => {
  const dialog = page.getByRole('dialog', { name: 'Create Brand Toolkit' });
  for (let cycle = 0; cycle < 3; cycle++) {
    const values = dialog.getByRole('textbox', { name: 'Brand Values', exact: true });
    await expect(values).toHaveValue('');
    await expect(dialog.getByRole('textbox', { name: /Brand Name/ })).toHaveValue('');
    await values.fill('Committed trust');
    await values.press('Enter');
    await values.fill('Still pending');
    await dialog.getByRole('button', { name: 'Target Audience', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Pain Points', exact: true }).fill('Pending audience');
    // Blank-name validation returns before the API save function is invoked.
    await dialog.getByRole('button', { name: 'Save Toolkit' }).click();
    const name = dialog.getByRole('textbox', { name: /Brand Name/ });
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('required', '');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription('Please enter a brand name.');
    await expect(values).toHaveValue('Still pending');
    await expect(dialog.getByRole('button', { name: 'Remove Committed trust from Brand Values' })).toBeVisible();
    if (cycle === 0) await page.screenshot({ path: testInfo.outputPath('validation-keeps-pending-text.png') });
    await name.fill('Unsaved studio');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await dialog.getByRole('button', { name: 'Target Audience', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Pain Points', exact: true })).toHaveValue('Pending audience');
    if (cycle === 1) await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Create Brand Toolkit', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Remove Committed trust from Brand Values' })).toHaveCount(0);
  }
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

for (const outcome of ['success', 'rejection'] as const) {
  test(`deferred save ${outcome} after Cancel/reopen keeps the current Conversations draft`, async ({ page, audit }, testInfo) => {
    await observeMockedChatSends(page);
    let pending: Route | undefined;
    await page.route('**/api/content/brand-toolkits', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      pending = route;
    });
    const dialog = page.getByRole('dialog', { name: 'Create Brand Toolkit' });
    await dialog.getByRole('textbox', { name: /Brand Name/ }).fill('Retired Synthetic Studio');
    await dialog.getByRole('button', { name: 'Target Audience', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save Toolkit', exact: true }).click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Save Toolkit', exact: true })).toBeDisabled();
    expect(pending!.request().postDataJSON().name).toBe('Retired Synthetic Studio');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Create Brand Toolkit', exact: true }).click();
    const name = dialog.getByRole('textbox', { name: /Brand Name/ });
    const draft = dialog.getByRole('textbox', { name: 'Brand Values', exact: true });
    await name.fill('Current Synthetic Studio');
    await draft.fill('Current pending trust');
    await finishMockedResponse(page, pending!, outcome === 'success' ? 200 : 422,
      outcome === 'success' ? { id: 719, brandName: 'Retired Synthetic Studio' } : { error: 'Synthetic retired save rejection' });
    await expect(dialog).toBeVisible();
    await expect(name).toHaveValue('Current Synthetic Studio');
    await expect(draft).toHaveValue('Current pending trust');
    await expect(draft).toBeFocused();
    await expect(page.getByText('Toolkit Created', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Synthetic retired save rejection', { exact: true })).toHaveCount(0);
    await expectNoMockedChatSend(page);
    const viewport = page.viewportSize()!;
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale }))).toEqual({ ...viewport, scale: 1 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`retired-save-${outcome}.png`) });
    await dialog.getByRole('button', { name: 'Target Audience', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Save Toolkit', exact: true })).toBeEnabled();
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.failedRequests).toEqual([]);
    expect(audit.consoleErrors).toEqual(outcome === 'success' ? [] : ['Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)']);
  });
}

test('overlapping mocked uploads retain both logos and a retired upload cannot change a reopened draft', async ({ page, audit }, testInfo) => {
  const pending = new Map<string, Route>();
  await page.route('**/api/content/brand-toolkits/upload-logo', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const fileName = route.request().postDataBuffer()?.toString().match(/filename="([^"]+)"/)?.[1];
    if (!fileName || !['first.png', 'second.png', 'retired.png'].includes(fileName)) return route.fallback();
    pending.set(fileName, route);
  });
  await page.route('**/api/uploads/brand-toolkit-regression-*.png', route => route.fulfill({
    contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a00kAAAAASUVORK5CYII=', 'base64'),
  }));
  const dialog = page.getByRole('dialog', { name: 'Create Brand Toolkit' });
  const draft = dialog.getByRole('textbox', { name: 'Brand Values', exact: true });
  await draft.fill('Pending during concurrent uploads');
  await dialog.getByRole('button', { name: 'Visual Identity', exact: true }).click();
  const upload = dialog.getByLabel('Logo', { exact: true });
  for (const name of ['first.png', 'second.png']) {
    await upload.setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from('synthetic fixture') });
    await expect.poll(() => pending.has(name)).toBe(true);
  }
  await finishMockedResponse(page, pending.get('second.png')!, 200, { url: '/uploads/brand-toolkit-regression-second.png' });
  await finishMockedResponse(page, pending.get('first.png')!, 200, { url: '/uploads/brand-toolkit-regression-first.png' });
  await expect(dialog.getByAltText('Logo', { exact: true })).toHaveCount(2);
  expect(await dialog.getByAltText('Logo', { exact: true }).evaluateAll(images => images.map(image => image.getAttribute('src')))).toEqual([
    '/api/uploads/brand-toolkit-regression-first.png', '/api/uploads/brand-toolkit-regression-second.png',
  ]);
  await upload.setInputFiles({ name: 'retired.png', mimeType: 'image/png', buffer: Buffer.from('synthetic fixture') });
  await expect.poll(() => pending.has('retired.png')).toBe(true);
  await dialog.getByRole('button', { name: 'Brand Identity', exact: true }).click();
  await expect(draft).toHaveValue('Pending during concurrent uploads');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Create Brand Toolkit', exact: true }).click();
  await draft.fill('Current upload draft');
  await finishMockedResponse(page, pending.get('retired.png')!, 200, { url: '/uploads/brand-toolkit-regression-retired.png' });
  await expect(draft).toHaveValue('Current upload draft');
  await expect(draft).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('retired-upload-draft.png') });
  await dialog.getByRole('button', { name: 'Visual Identity', exact: true }).click();
  await expect(dialog.getByAltText('Logo', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
