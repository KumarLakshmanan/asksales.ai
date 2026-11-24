import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';
import { setupCatalog } from '../src/__tests__/fixtures/assistantSetupCatalog';
import { emptyAssistantDraft } from '../../shared/outreachAssistants';
import type { AdminAssistantModelCatalog } from '../../shared/assistantModelCatalog';

test('admin model names and availability feed multi-channel assistant setup and survive draft creation', async ({ page, audit }, info) => {
  const data: AdminAssistantModelCatalog = { canManage: true, connections: [
    { id: 1, provider: 'openai', name: 'Primary connection', connected: true },
    { id: 2, provider: 'openrouter', name: 'Router connection', connected: true },
  ], models: setupCatalog.models.map((model, index) => ({ ...model, id: index + 1, description: model.description || '', enabled: true, connected: true, order: index + 1, credentialId: index + 1, connectionName: 'Primary connection', version: 1 })) };
  const effects: string[] = [];
  let draft = emptyAssistantDraft();
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === '/api/admin/me') return json({ admin: { id: 1, role: 'super_admin', name: 'Fixture Admin', email: 'admin@example.test' } });
    if (path.startsWith('/api/admin/assistant-models')) {
      if (request.method() === 'GET') return json(data);
      const body = request.postDataJSON();
      const id = Number(path.split('/').at(-1));
      const entry = data.models.find(item => item.id === id);
      expect(entry).toBeDefined(); expect(body.expectedVersion).toBe(entry!.version);
      Object.assign(entry!, body, { version: entry!.version + 1 });
      effects.push(`${request.method()} ${path}`);
      return json({ success: true, id });
    }
    if (path === '/api/settings/outreach/assistants/catalog') return json({ ...setupCatalog, models: data.models.filter(model => model.enabled && model.connected).map(model => ({ provider: model.provider, model: model.model, label: model.label, description: model.description, controls: [] })) });
    if (path === '/api/settings/outreach/assistants' && request.method() === 'POST') {
      expect(request.headers()['x-business-profile-id']).toBe('4102');
      draft = request.postDataJSON().draft;
      effects.push('create_draft');
      return json({ id: 'fixture-draft' });
    }
    if (path === '/api/settings/outreach/assistants/fixture-draft') return json({ id: 'fixture-draft', businessProfileId: 4102, state: 'draft', draft, draftVersion: 1, publishedRevision: null, published: null, readiness: { ready: false, checks: [] }, updatedAt: '2026-10-19T00:00:00Z' });
    if (path.startsWith('/api/settings/outreach/assistants/')) return json({ items: [], history: [], nextCursor: null });
    if (['/api/auth/me', '/api/platform/access', '/api/settings/business-profiles', '/api/settings/preferences', '/api/organizations', '/api/wallet', '/api/notifications/unread/count', '/api/chat/threads', '/api/crm/configuration'].includes(path)) return route.fallback();
    if (request.method() !== 'GET') throw new Error(`Unexpected effect: ${request.method()} ${path}`);
    return json({ items: [], notifications: [], count: 0 });
  });
  await installAppShellMocks(page);
  // Register this last to override the shell's deliberately disabled assistant catalog.
  await page.route('**/api/settings/outreach/assistants/catalog', route => route.fulfill({ json: { ...setupCatalog, models: data.models.filter(model => model.enabled && model.connected).map(model => ({ provider: model.provider, model: model.model, label: model.label, description: model.description, controls: [] })) } }));

  await page.goto('/admin/dashboard/integrations/llm/models');
  await page.getByRole('button', { name: 'Edit GPT Luna', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('Customer GPT');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('admin-model-editor.png') });
  await page.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Customer GPT', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Make Gemini 3.5 Plus available to assistants' }).click();
  await expect(page.getByRole('radio', { name: 'Gemini 3.5 Plus' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Make Gemini 3.5 Plus available to assistants' })).not.toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('admin-model-catalog.png'), fullPage: true });

  await page.goto('/dashboard/settings/outreach/new');
  await page.getByLabel('Assistant name', { exact: true }).fill('Customer care');
  await page.getByRole('radio', { name: 'Hotel Sales Agent', exact: true }).check();
  await expect(page.getByRole('radio', { name: 'Gemini 3.5 Plus' })).toHaveCount(0);
  await expect(page.getByLabel('AI provider', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('assistant-presets.png'), fullPage: true });
  await page.getByRole('checkbox', { name: 'WhatsApp: Orchid business line', exact: true }).check();
  await page.getByRole('checkbox', { name: 'WhatsApp: Orchid reservations', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'WhatsApp: Offline line', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Instagram', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Instagram: @orchid.stays', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Email', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Email: support@orchid.example', exact: true }).check();
  await page.getByRole('radio', { name: 'Customer GPT', exact: true }).check();
  await page.getByRole('radio', { name: 'Customer GPT', exact: true }).scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('assistant-accounts-model.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create draft', exact: true }).click();
  await expect(page).toHaveURL(/assistants\/fixture-draft$/);
  await expect(page.getByRole('heading', { name: 'Customer care', exact: true })).toBeVisible();
  expect(draft.bindings.map(binding => `${binding.channel}:${binding.accountId}`)).toEqual(['whatsapp:same-id', 'whatsapp:second-line', 'instagram:same-id', 'email:support@orchid.example']);
  expect(draft.replyModel).toEqual({ provider: 'openai', model: 'fixture-gpt' });
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Hotel Sales Agent', exact: true })).toBeChecked();
  expect(effects).toEqual(['PUT /api/admin/assistant-models/1', 'PUT /api/admin/assistant-models/2', 'create_draft']);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
