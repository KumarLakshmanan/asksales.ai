import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { emptyAssistantDraft, type AssistantCatalog, type OutreachAssistant } from '../../shared/outreachAssistants';
import { setupCatalog } from '../src/__tests__/fixtures/assistantSetupCatalog';

test.use({ video: 'off' });
test.setTimeout(120_000);
const api = '/api/settings/outreach/assistants';
const id = 'c1a11111-1111-4111-8111-111111111111';
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVFEAAAAASUVORK5CYII=', 'base64');

async function install(page: Page) {
  const draft = emptyAssistantDraft();
  Object.assign(draft, { name: 'Synthetic guest assistant', agentType: 'hotel_sales', instructions: 'Use approved sources.', replyModel: { provider: 'openai', model: 'fixture-gpt' }, bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'same-id' }], knowledge: { mode: 'selected', ids: [11] }, documents: { mode: 'selected', ids: [21] }, galleries: { mode: 'selected', ids: [31] }, tools: { mode: 'selected', names: ['check_room_availability', 'create_booking'], approvalRequired: ['create_booking'] }, playbooks: { mode: 'selected', assignments: [{ playbookId: 41, channel: 'whatsapp', surface: 'private', intent: 'booking', priority: 100 }] }, followUps: { mode: 'selected', sequences: [{ channel: 'whatsapp', steps: [{ delayMinutes: 60, messageMode: 'ai', templateId: 0 }] }] } });
  draft.privacy.permittedCollectionFields = ['name'];
  let current: OutreachAssistant = { id, businessProfileId: 4102, state: 'live', draft, published: structuredClone(draft), enabledBindings: draft.bindings, draftVersion: 6, publishedRevision: 4, updatedAt: '2026-10-31T03:00:00Z', readiness: { ready: true, checks: [{ key: 'sources', label: 'Permitted resources', ok: true, detail: 'Synthetic resources permitted.' }] } };
  const catalog: AssistantCatalog = { ...structuredClone(setupCatalog), runtimeEnabled: false, accounts: setupCatalog.accounts.map(account => ({ ...account, assignedAssistantId: account.accountId === 'same-id' && account.channel === 'whatsapp' ? 'another-assistant' : undefined })), knowledge: [{ id: 11, name: 'Hotel address', channels: ['whatsapp'], preview: 'Synthetic hotel address.', sourceVersion: 1 }], documents: [{ id: 21, name: 'ORO factsheet', channels: ['whatsapp', 'web'] }], galleries: [{ id: 31, name: 'Pool Villa', channels: ['whatsapp'] }], playbooks: [{ id: 41, name: 'Booking enquiry', agentType: 'hotel_sales', channels: ['whatsapp'], collectionFields: ['name', 'email'], intent: 'booking' }], tools: [{ name: 'check_room_availability', label: 'Check room availability', approvalRequired: false }, { name: 'create_booking', label: 'Create booking', approvalRequired: true }] };
  const state = { resourceError: false, failReadiness: false, writes: [] as Array<{ path: string; method: string; body: unknown }> };
  let gallery = { id: 31, title: 'Pool Villa', description: 'Synthetic gallery', status: 'draft', version_status: 'draft', asset_count: 2, published_asset_count: 1, helpful_auto_attach: true, audience: 'customer', allowed_channels: ['whatsapp'], current_published_version_id: 1, version_id: 2, assets: [{ id: 1, name: 'Garden room', alt_text: 'Synthetic room', owner_description: 'Synthetic room description with windows, furnishings and a terrace. '.repeat(12), publication_state: 'published', sort_order: 0 }, { id: 2, name: 'Patio', alt_text: 'Synthetic patio', publication_state: 'ready_for_review', sort_order: 1 }] };
  let deliveries = [{ id: 71, channel: 'whatsapp', name: 'Pool exterior', status: 'uncertain', conversation_id: 101, updated_at: new Date().toISOString() }];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path.startsWith(api)) {
      expect(request.headers()['x-business-profile-id']).toBe('4102');
      if (method !== 'GET') state.writes.push({ path, method, body: request.postDataJSON() });
      if (path === `${api}/catalog`) return json(catalog);
      if (path === `${api}/diagnostics`) return json({ assignments: [{ ...catalog.accounts[0], assistantId: id, assistantName: current.draft.name, revision: 4, state: 'live', runtimeEnabled: false, checks: [{ key: 'runtime', label: 'Assistant routing', ok: false, detail: 'Assistant routing disabled.' }] }] });
      if (path.includes('/resources/')) {
        if (state.resourceError) return json({ error: 'Synthetic resource lookup unavailable' }, 503);
        const category = path.split('/').at(-1)! as 'knowledge' | 'documents' | 'galleries' | 'playbooks';
        const items = (catalog[category] || []).map(item => ({ ...item, id: String(item.id), category }));
        return json({ items, total: items.length, page: 1, pageSize: 20, hasMore: false });
      }
      if (path.endsWith('/readiness')) return json(state.failReadiness ? { ready: false, checks: [{ key: 'galleries', label: 'Galleries', ok: false, detail: 'Gallery permission withdrawn.' }] } : current.readiness);
      if (path.endsWith('/publish')) { current = { ...current, published: current.draft, publishedRevision: 5, state: 'needs_attention' }; return json(current); }
      if (path.endsWith('/simulate')) return json({ reply: 'Synthetic preview reply.', outcome: 'auto_sent', conversationId: -91, previewSessionToken: 'synthetic-preview-token', sideEffectsSuppressed: true, privacyOutcome: { mandatory: true, redactedInput: request.postDataJSON().message }, resolvedAssistant: { assistantId: id, revision: 4 }, stages: [{ stage: 'reply_generation', status: 'executed', durationMs: 4 }] });
      if (path.endsWith('/scenarios')) return json({ items: [] });
      if (path.endsWith('/history')) return json({ history: [], nextCursor: null });
      if (path.endsWith('/revisions')) return json({ items: [{ revision: 4, current: true, publishedAt: current.updatedAt, configuration: current.draft }], nextCursor: null });
      if (path === `${api}/${id}` && method === 'PUT') { current = { ...current, draft: request.postDataJSON().draft, draftVersion: 7 }; return json(current); }
      if (path === `${api}/${id}`) return json(current);
      if (path === api && method === 'POST') { current = { ...current, draft: request.postDataJSON().draft }; return json(current); }
      if (path === api) return json({ assistants: [current], runtimeEnabled: false, nextCursor: null });
      throw new Error(`Unexpected assistant request: ${method} ${path}`);
    }
    if (path.startsWith('/api/settings/media-')) {
      if (method !== 'GET') state.writes.push({ path, method, body: request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : request.postData() });
      if (path.endsWith('/content')) return route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng });
      if (path === '/api/settings/media-galleries' && method === 'POST') return json({ id: 32 });
      if (path.endsWith('/images') && method === 'POST') return json({ assets: [{ publication_state: 'ready_for_review' }], outcomes: [] });
      if (path.endsWith('/review') && method === 'POST') { gallery = { ...gallery, assets: gallery.assets.map(asset => asset.id === 2 ? { ...asset, publication_state: 'published' } : asset) }; return json(gallery); }
      if (path.endsWith('/reconcile')) { deliveries = []; return json({ success: true }); }
      if (path === '/api/settings/media-galleries') return json([gallery]);
      if (path === '/api/settings/media-galleries/31') return json(gallery);
      if (path === '/api/settings/media-deliveries/uncertain') return json(deliveries);
      throw new Error(`Unexpected media request: ${method} ${path}`);
    }
    if (['/api/auth/me', '/api/platform/access', '/api/settings/business-profiles', '/api/settings/preferences', '/api/organizations', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count', '/api/chat/threads'].includes(path)) return route.fallback();
    if (method !== 'GET') throw new Error(`Unexpected mutation: ${method} ${path}`);
    return json({ data: [], items: [], notifications: [], count: 0 });
  });
  return state;
}

test('gallery publication badges remain readable beside long descriptions without writes', async ({ page, audit }, info) => {
  const state = await install(page);
  await page.goto('/dashboard/knowledge-base/media');
  await page.getByRole('button', { name: 'Open Pool Villa gallery', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pool Villa', exact: true });
  await expect(dialog).toBeVisible();
  const badge = dialog.getByText('published', { exact: true });
  await expect(badge).toBeVisible();
  const dimensions = await badge.evaluate(element => ({
    width: element.clientWidth,
    contentWidth: element.scrollWidth,
    right: element.getBoundingClientRect().right,
    parentRight: element.parentElement!.getBoundingClientRect().right,
  }));
  expect(dimensions.width).toBeGreaterThanOrEqual(dimensions.contentWidth);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.parentRight + 1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('gallery-status.png') });
  expect(state.writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('all eight editor sections retain controls, draft save and responsive layout', async ({ page, audit }, info) => {
  const state = await install(page);
  await page.goto(`/dashboard/settings/outreach/assistants/${id}`);
  await expect(page.getByRole('heading', { name: 'Synthetic guest assistant', exact: true })).toBeVisible();
  for (const step of ['basic', 'ai', 'knowledge', 'privacy', 'playbooks', 'followups', 'tools', 'availability']) {
    await page.locator(`[data-assistant-tab="${step}"]`).click();
    await expectNoHorizontalOverflow(page);
    if (step === 'followups') await expect(page.locator('.assistant-followups').getByText('Receiving account:', { exact: true })).toBeVisible();
    if (['basic', 'ai', 'followups', 'availability'].includes(step)) await page.screenshot({ path: info.outputPath(`${step}.png`), fullPage: true });
  }
  await page.getByRole('radio', { name: /Weekly schedule/ }).check();
  await page.getByRole('button', { name: 'Use weekdays 9–5', exact: true }).click();
  await expect(page.getByLabel('Monday open', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Copy Monday to all', exact: true }).click();
  await expect(page.getByLabel('Sunday open', { exact: true })).toBeChecked();
  await page.locator('.ak-schedule-row').first().scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('availability-weekly.png'), fullPage: true });
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  if (page.viewportSize()!.width < 640) {
    const footer = await page.locator('.ak-save-bar').boundingBox();
    expect(footer!.height).toBeLessThan(page.viewportSize()!.height / 4);
  }
  await page.locator('[data-assistant-tab="tools"]').click();
  await expect(page.getByRole('checkbox', { name: 'Approval mandatory' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Approval mandatory' })).toBeDisabled();
  await page.locator('[data-assistant-tab="basic"]').click();
  await page.getByLabel('Assistant name', { exact: true }).fill('Renamed synthetic assistant');
  await expect(page.getByRole('button', { name: 'Review & publish' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText(/Draft saved. Customer replies keep using/)).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ method: 'PUT', path: `${api}/${id}`, body: { expectedDraftVersion: 6, draft: { name: 'Renamed synthetic assistant' } } });
  expect(audit.consoleErrors).toEqual([]);
});

test('account diagnostics keep account identity, readiness details and filtering usable', async ({ page, audit }, info) => {
  const state = await install(page);
  await page.goto('/dashboard/settings/outreach');
  await page.getByRole('button', { name: 'Account assignments', exact: true }).click();
  const assignments = page.locator('.ak-assignment-list');
  await expect(assignments.getByText('Orchid business line', { exact: true })).toBeVisible();
  await expect(assignments.getByText('Private messages', { exact: true })).toBeVisible();
  await expect(assignments.getByText('Needs attention', { exact: true }).first()).toBeVisible();
  await assignments.getByText(/Readiness details/).click();
  await expect(assignments.getByText(/Assistant routing disabled\./)).toBeVisible();
  await expect(assignments.getByRole('link', { name: 'Review assistant' })).toHaveAttribute('href', `/dashboard/settings/outreach/assistants/${id}`);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('account-assignments.png') });
  await page.getByLabel('Search account assignments').fill('No matching synthetic account');
  await expect(page.getByText('No accounts match this search.')).toBeVisible();
  await page.getByLabel('Search account assignments').clear();
  await expect(assignments.getByText('Orchid business line', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  expect(audit.consoleErrors).toEqual([]);
});

test('saved preview and revision history remain available without customer side effects', async ({ page, audit }, info) => {
  const state = await install(page);
  await page.goto(`/dashboard/settings/outreach/assistants/${id}`);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Published revisions', exact: true });
  await expect(history.getByText('Revision 4 · Current')).toBeVisible();
  await expect(history.getByRole('button', { name: 'Compare & review rollback' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('revision-history.png') });
  await history.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('button', { name: 'Test assistant', exact: true }).first().click();
  const preview = page.getByRole('dialog', { name: 'Test assistant', exact: true });
  await preview.getByLabel('Test customer message', { exact: true }).fill('Synthetic customer enquiry');
  await preview.getByRole('button', { name: 'Test saved configuration', exact: true }).click();
  await expect(preview.getByText('Synthetic preview reply.', { exact: true })).toBeVisible();
  await expect(preview.getByText(/No side effects/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('test-assistant.png') });
  await preview.getByRole('button', { name: 'Reset test conversation' }).click();
  await expect(preview.getByText('New isolated preview conversation.')).toBeVisible();
  await expect(preview.getByText('Synthetic preview reply.', { exact: true })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: `${api}/${id}/simulate`, method: 'POST', body: { message: 'Synthetic customer enquiry', channel: 'whatsapp', revision: 'draft' } });
  expect(audit.consoleErrors).toEqual([]);
});

test('resource errors preserve selection and publish still requires readiness and reassignment', async ({ page }, info) => {
  const state = await install(page);
  await page.goto(`/dashboard/settings/outreach/assistants/${id}?tab=knowledge`);
  state.resourceError = true;
  await page.getByRole('button', { name: 'Change selection', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Knowledge sources', exact: true });
  await expect(drawer.getByText('Resources could not be loaded. Your selection is retained.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Apply selection (1)' })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('resource-error.png') });
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.writes).toHaveLength(0);
  state.failReadiness = true;
  await page.getByRole('button', { name: 'Review & publish' }).click();
  let review = page.getByRole('dialog', { name: 'Review assistant assignments' });
  await expect(review.getByText('Gallery permission withdrawn.')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Publish assistant', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('publish-blocked.png') });
  await review.getByRole('button', { name: 'Back to draft' }).click();
  state.failReadiness = false;
  await page.getByRole('button', { name: 'Review & publish' }).click();
  review = page.getByRole('dialog', { name: 'Review assistant assignments' });
  await expect(review.getByRole('button', { name: 'Publish assistant', exact: true })).toBeDisabled();
  await review.getByRole('checkbox', { name: /Replace existing assistant assignments/ }).check();
  await review.getByRole('button', { name: 'Publish assistant', exact: true }).click();
  await expect(page.getByText('Published revision 5. Customer delivery remains blocked until assistant runtime is enabled.')).toBeVisible();
  expect(state.writes.at(-1)).toMatchObject({ path: `${api}/${id}/publish`, body: { expectedDraftVersion: 6, confirmAssignments: true, reassign: true } });
});

test('three-step creation saves the existing draft contract and opens knowledge', async ({ page }, info) => {
  const state = await install(page);
  await page.goto('/dashboard/settings/outreach/new');
  await page.getByLabel('Assistant name', { exact: true }).fill('New synthetic assistant');
  await page.getByRole('radio', { name: 'Hotel Sales Agent', exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('checkbox', { name: 'WhatsApp: Orchid business line', exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: 'GPT Luna', exact: true }).check();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('create-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create draft', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${id}\\?tab=knowledge`));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ method: 'POST', path: api, body: { draft: { name: 'New synthetic assistant', bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'same-id' }] } } });
});

test('media review and uncertain-delivery verification retain their distinct contracts', async ({ page, audit }, info) => {
  const state = await install(page);
  await page.goto('/dashboard/knowledge-base/media');
  await page.getByRole('button', { name: 'Open Pool Villa gallery', exact: true }).click();
  let detail = page.getByRole('dialog', { name: 'Pool Villa', exact: true });
  await detail.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review Patio', exact: true });
  await expect(review.getByRole('button', { name: 'Record review' })).toBeDisabled();
  await review.getByLabel('Media review reason').fill('Synthetic owner review evidence');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('image-review.png') });
  await review.getByRole('button', { name: 'Record review' }).click();
  await expect(review).toHaveCount(0);
  detail = page.getByRole('dialog', { name: 'Pool Villa', exact: true });
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Verify outcome', exact: true }).click();
  const verify = page.getByRole('dialog', { name: 'Verify image delivery', exact: true });
  await verify.getByLabel('Delivery verification evidence').fill('Synthetic provider conversation verified');
  await expect(verify.getByRole('button', { name: 'Record outcome' })).toBeDisabled();
  await verify.getByLabel('Provider message ID').fill('synthetic-receipt-71');
  await page.screenshot({ path: info.outputPath('verify-delivery.png') });
  await verify.getByRole('button', { name: 'Record outcome' }).click();
  await expect(verify).toHaveCount(0);
  expect(state.writes).toEqual([
    { path: '/api/settings/media-galleries/31/assets/2/review', method: 'POST', body: { decision: 'approve', reason: 'Synthetic owner review evidence' } },
    { path: '/api/settings/media-deliveries/71/reconcile', method: 'POST', body: { outcome: 'delivered', reason: 'Synthetic provider conversation verified', providerMessageId: 'synthetic-receipt-71' } },
  ]);
  expect(audit.consoleErrors).toEqual([]);
});

test('gallery creation keeps file, audience, rights and scan controls usable', async ({ page }, info) => {
  const state = await install(page);
  await page.goto('/dashboard/knowledge-base/media');
  await page.getByRole('button', { name: 'New gallery', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create media gallery', exact: true });
  await dialog.getByLabel('Gallery title *', { exact: true }).fill('Synthetic garden gallery');
  await dialog.getByLabel('Images *', { exact: true }).setInputFiles({ name: 'synthetic-garden.png', mimeType: 'image/png', buffer: tinyPng });
  await dialog.getByRole('checkbox', { name: /I certify lawful authority/ }).check();
  await expect(dialog.getByLabel('Name for synthetic-garden.png')).toHaveValue('synthetic-garden');
  await expect(dialog.getByText(/5 MB each/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('button', { name: 'Create and scan' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('create-gallery.png') });
  await dialog.getByRole('button', { name: 'Create and scan' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({ path: '/api/settings/media-galleries', method: 'POST', body: { title: 'Synthetic garden gallery', audience: 'customer', rightsCertified: true } });
  expect(state.writes[1]).toMatchObject({ path: '/api/settings/media-galleries/32/images', method: 'POST' });
});
