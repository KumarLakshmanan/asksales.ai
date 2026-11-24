import { captureCrmScreenshot } from './fixtures/crm-screenshots';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration';
import { AUTOMATION_ACTIONS, AUTOMATION_CONDITION_FIELDS, AUTOMATION_PLACEHOLDERS, AUTOMATION_TRIGGERS } from '../../shared/crmAutomations';

test.setTimeout(180_000);
test.use({ actionTimeout: 45_000, timezoneId: 'Asia/Kolkata' });
const screenshotDirectory = process.env.CRM_QA_SCREENSHOT_DIR || 'test-results';
const configuration: CrmConfiguration = {
  stages: [DEFAULT_CRM_CONFIGURATION.stages[0],
    { key: 'discovery', label: 'Discovery call', type: 'active', color: '#8b5cf6', inFlow: true },
    { key: 'contract_accepted', label: 'Contract accepted', type: 'won', color: '#10b981', inFlow: false },
    { key: 'offer_declined', label: 'Offer declined', type: 'lost', color: '#f59e0b', inFlow: true }],
  preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences, platform: ['email', 'whatsapp'] },
};
const initialContact = { id: 42, leadId: 7, firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.test',
  phone: '+919876543210', company: 'Acme', role: 'Operations Manager', pipelineStatus: 'discovery', status: 'interested',
  priority: 'medium', source: 'email', currency: 'USD', dealValue: '1250', tags: ['qualified'],
  notes: 'Requested a proposal after the discovery call.', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' };

test.beforeEach(async ({ page }) => {
  page.on('dialog',dialog=>void dialog.accept());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/crm/assignees',route=>route.fulfill({json:{success:true,data:[]}}));
  await page.route('**/api/crm/reminders?*',route=>route.fulfill({json:{success:true,data:[]}}));
  await page.route('**/api/crm/configuration', route => route.fulfill({ json: { success: true, data: configuration } }));
  await page.route('**/api/proposals/related?*', route => route.fulfill({ json: [] }));
});

test('Pipeline keeps custom outcomes visible and uses configured labels in flow analytics', async ({ page, audit }) => {
  let contact = { ...initialContact };
  const moves: Record<string, unknown>[] = [];
  await page.route('**/api/crm/contacts?*', route => {const stage=new URL(route.request().url()).searchParams.get('pipelineStatus');const contacts=stage===contact.pipelineStatus ? [contact] : [];return route.fulfill({json:{success:true,contacts,total:contacts.length,totalPages:1}});});
  await page.route('**/api/crm/pipeline/summary?*',route=>route.fulfill({json:{success:true,data:{stages:configuration.stages.map(stage=>({key:stage.key,count:stage.key===contact.pipelineStatus ? 1 : 0,dealValueByCurrency:stage.key===contact.pipelineStatus ? {USD:'1250'} : {}}))}}}));
  await page.route('**/api/crm/pipeline/analytics**', route => route.fulfill({ json: { success: true, data: {
    winRate: 50, totalPipelineValueByCurrency: { USD: '1250' }, preferences: configuration.preferences,
    stuckContacts: 1, flows: [{ from: 'new', to: 'discovery', count: 3 }],
  } } }));
  await page.route('**/api/crm/contacts/42/pipeline-status', async route => {
    const body = route.request().postDataJSON();
    moves.push(body);
    contact = { ...contact, ...body, status: 'won' };
    await route.fulfill({ json: { success: true, data: contact } });
  });
  await page.goto('/dashboard/crm/pipeline');
  await expect(page.getByRole('heading', { name: 'Sales pipeline', exact: true })).toBeVisible();
  await expect(page.getByText('Contract accepted', { exact: true }).first()).toBeAttached();
  await expect(page.getByText('Offer declined', { exact: true })).toBeAttached();
  await expect(page.getByText('Won', { exact: true })).toHaveCount(0);
  await page.locator('summary').filter({ hasText: 'Reporting summary' }).click();
  await expect(page.locator('details').filter({ hasText: 'Reporting summary' })).toContainText('Email, WhatsApp');
  await expect(page.getByText('3 moves', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Pipeline stage' }).click();
  await page.getByRole('option', { name: 'Contract accepted', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Pipeline stage' })).toHaveText('Contract accepted');
  expect(moves).toEqual([{ pipelineStatus: 'contract_accepted' }]);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-pipeline-configured-${test.info().project.name}.png`);
  expect(audit.consoleErrors).toEqual([]);
});

test('Contact details use configured labels and colors and save a custom Won stage', async ({ page, audit }) => {
  let contact = { ...initialContact };
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/crm/contacts/42**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/workspace-summary')) return route.fulfill({json:{success:true,data:{counts:{conversations:0,sentMessages:0,activities:1,tickets:0,openTickets:0,unreadConversations:0},owner:null,nextReminder:null,upcomingReminders:[],ticketsDue:[],unansweredConversations:[],stageEnteredAt:null}}});
    if (path.endsWith('/activities')) return route.fulfill({ json: { success: true, data: [
      { id: 1, type: 'pipeline_change', subject: 'Pipeline: Not Categorized → Discovery call', createdAt: '2026-09-30T00:00:00Z' },
    ] } });
    if (path.endsWith('/conversations')) return route.fulfill({ json: { conversations: [], sentMessages: [] } });
    if (path.endsWith('/tickets')) return route.fulfill({ json: { tickets: [] } });
    if (req.method() !== 'GET') {
      const body = req.postDataJSON();
      writes.push({ method: req.method(), body });
      contact = { ...contact, ...body, ...(path.endsWith('/pipeline-status') ? { status: 'won' } : {}) };
    }
    return route.fulfill({ json: { success: true, data: contact } });
  });
  await page.goto('/dashboard/crm/contacts/42');
  await expect(page.getByRole('heading', { name: 'Alex Morgan', exact: true })).toBeVisible();
  await expect(page.getByText('Discovery call', { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contact-detail-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Edit contact', exact: true }).click();
  await expect(page.getByLabel('First Name', { exact: true })).toHaveValue('Alex');
  await page.getByLabel('Company', { exact: true }).fill('Acme Growth');
  await page.getByRole('combobox', { name: 'Pipeline Status', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Contract accepted', exact: true })).toBeVisible();
  await page.getByRole('option', { name: 'Contract accepted', exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contact-edit-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Acme Growth', { exact: true }).first()).toBeVisible();
  if(test.info().project.name.startsWith('mobile')) await page.getByRole('button',{name:'Contact details',exact:true}).click();
  const overview=test.info().project.name.startsWith('mobile') ? page.getByRole('dialog',{name:'Contact overview'}) : page.getByRole('complementary',{name:'Contact overview'});
  const badge=overview.getByText('Contract accepted',{exact:true});
  await expect(badge).toBeVisible();
  await expect(badge).toHaveCSS('color', 'rgb(16, 185, 129)');
  expect(writes.map(write => write.method)).toEqual(['PUT']);
  expect(writes[0].body).toMatchObject({pipelineStatus:'contract_accepted',expectedUpdatedAt:initialContact.updatedAt});
  if(test.info().project.name.startsWith('mobile')) await page.getByRole('dialog',{name:'Contact overview'}).getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('tab', { name: /^Activity/ }).click();
  const subject = page.getByText('Pipeline: Not Categorized → Discovery call', { exact: true });
  await expect(subject).toBeVisible();
  const activityType = page.getByRole('list',{name:'Contact activity'}).getByText('pipeline change', { exact: true });
  await expect(activityType).toBeVisible();
  const timestamp = page.getByRole('list', { name: 'Contact activity' }).locator('time').first();
  const boxes = await Promise.all([subject.boundingBox(), activityType.boundingBox(), timestamp.boundingBox()]);
  expect(boxes.every(Boolean)).toBe(true);
  for (const other of boxes.slice(1)) {
    const first = boxes[0]!;
    expect(first.x < other!.x + other!.width && other!.x < first.x + first.width
      && first.y < other!.y + other!.height && other!.y < first.y + first.height).toBe(false);
  }
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contact-activity-${test.info().project.name}.png`);
  expect(audit.consoleErrors).toEqual([]);
});

test('Alert stage selectors and saved rules display configured stage names', async ({ page, audit }) => {
  let alerts: Record<string, unknown>[] = [];
  await page.route('**/api/crm/alerts**', async route => {
    const req = route.request();
    if (new URL(req.url()).pathname.endsWith('/logs')) return route.fulfill({ json: { success: true, data: [] } });
    if (req.method() === 'POST') {
      alerts = [{ id: 1, enabled: true, createdAt: '2026-09-30T00:00:00Z', ...req.postDataJSON() }];
      return route.fulfill({ json: { success: true, data: alerts[0] } });
    }
    return route.fulfill({ json: { success: true, data: alerts } });
  });
  await page.goto('/dashboard/crm/alerts');
  await page.getByRole('button', { name: 'Create Alert', exact: true }).first().click();
  await page.getByLabel('Alert Name *').fill('Contract accepted notification');
  await page.getByLabel('When Status Changes To').click();
  await expect(page.getByRole('option', { name: 'Contract accepted', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Won', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Contract accepted', exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-alert-editor-${test.info().project.name}.png`);
  await page.getByRole('dialog').getByRole('button', { name: 'Create Alert', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Stage: Contract accepted', { exact: true })).toBeVisible();
  expect(alerts[0].conditions).toEqual({ stage: 'contract_accepted' });
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-alerts-${test.info().project.name}.png`);
  expect(audit.consoleErrors).toEqual([]);
});

test('Automation create, edit and run history retain configured stage keys and names', async ({ page, audit }) => {
  const definition = { version: 2, trigger: { type: 'pipeline_status_change', config: { toStatus: 'discovery' } },
    conditions: { match: 'all', rules: [] }, actions: [
      { id: 'stage', type: 'update_pipeline_status', config: { pipelineStatus: 'contract_accepted' } },
      { id: 'tags', type: 'update_tags', config: { tags: ['customer'] } },
    ] };
  const rule = { id: 1, name: 'Contract completion', definition, revision: 1, triggerType: 'pipeline_status_change',
    triggerConfig: definition.trigger.config, action: 'update_pipeline_status', actionConfig: definition.actions[0].config,
    isActive: true, executionCount: 1, priority: 0, createdAt: '2026-09-30T00:00:00Z' };
  const run = { id: 51, automationId: 1, automationName: rule.name, revision: 1, eventType: 'pipeline_status_change',
    status: 'success', contactName: 'Alex Morgan', createdAt: '2026-09-30T00:00:00Z' };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/crm/automations**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/catalog')) return route.fulfill({ json: { success: true, data: {
      triggers: AUTOMATION_TRIGGERS, actions: AUTOMATION_ACTIONS, fields: AUTOMATION_CONDITION_FIELDS,
      placeholders: AUTOMATION_PLACEHOLDERS, runtimeEnabled: true, accounts: [], campaigns: [], members: [], whatsappTemplates: [],
    } } });
    if (path.endsWith('/logs')) return route.fulfill({ json: { success: true, data: [] } });
    if (path.endsWith('/1/runs')) return route.fulfill({ json: { success: true, data: { runs: [run], nextCursor: null } } });
    if (path.endsWith('/runs/51')) return route.fulfill({ json: { success: true, data: { ...run, steps: [
      { id: 1, stepId: 'stage', position: 0, actionType: 'update_pipeline_status', status: 'success', attempts: 1, result: { pipelineStatus: 'contract_accepted' } },
      { id: 2, stepId: 'tags', position: 1, actionType: 'update_tags', status: 'success', attempts: 1, result: { tags: ['customer'] } },
    ] } } });
    if (req.method() === 'PUT') { writes.push(req.postDataJSON()); return route.fulfill({ json: { success: true, data: rule } }); }
    return route.fulfill({ json: { success: true, data: path.endsWith('/automations') ? [rule] : rule } });
  });
  await page.goto('/dashboard/crm/automations');
  await expect(page.getByText(rule.name, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Any stage → Discovery call', { exact: true }).filter({ visible: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-automations-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Create automation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New automation' })).toBeVisible();
  await page.getByLabel('Automation name').fill('New contract workflow');
  await page.getByLabel('Search triggers').fill('Pipeline stage changes');
  await page.getByRole('button', { name: /Pipeline stage changes/ }).click();
  await page.getByLabel('To stage').selectOption('discovery');
  await page.getByLabel('Add action').selectOption('update_pipeline_status');
  await page.getByLabel('Destination stage').selectOption('contract_accepted');
  await expect(page.getByLabel('Destination stage').locator('option:checked')).toHaveText('Contract accepted');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-automation-new-${test.info().project.name}.png`);
  // The draft is deliberately not saved: editing the persisted rule checks reload independently.
  await page.goto('/dashboard/crm/automations/1');
  await expect(page.getByRole('heading', { name: 'Edit automation' })).toBeVisible();
  await expect(page.getByLabel('To stage')).toHaveValue('discovery');
  await expect(page.getByLabel('Destination stage')).toHaveValue('contract_accepted');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-automation-edit-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/automations$/);
  expect(writes).toHaveLength(1);
  expect(writes[0].definition).toEqual(definition);
  await page.getByRole('button', { name: `Run history for ${rule.name}` }).click();
  await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
  await page.getByRole('button', { name: /Run #51 · revision 1/ }).click();
  await expect(page.getByRole('region', { name: 'Run step details' })).toContainText('Contract accepted');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-automation-runs-${test.info().project.name}.png`);
  expect(audit.consoleErrors).toEqual([]);
});
