import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration';
import { captureCrmScreenshot } from './fixtures/crm-screenshots';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { AUTOMATION_ACTIONS, AUTOMATION_CONDITION_FIELDS, AUTOMATION_PLACEHOLDERS, AUTOMATION_TRIGGERS } from '../../shared/crmAutomations';

test.setTimeout(90_000);
test.use({ actionTimeout: 45_000, timezoneId: 'Asia/Kolkata' });
const screenshotDirectory = process.env.CRM_QA_SCREENSHOT_DIR || 'test-results';

const contact = { id: 42, leadId: null, firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.test', company: 'Acme', phone: null, pipelineStatus: 'new', status: 'new', currency: 'USD', dealValue: '1250', tags: [], createdAt: '2026-01-01T00:00:00Z' };
const analytics = { totalContacts: 1, winRate: 0, pipelineValueByCurrency: { USD: '1250' }, totalPipelineValueByCurrency: { USD: '1250' } };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    // Every request in these browser tests is isolated from real accounts and delivery.
    await route.fulfill({ json: {} });
  });
  const { installAppShellMocks } = await import('./fixtures/app');
  await installAppShellMocks(page);
});

test('Contacts: create, filter, edit and delete with refreshed analytics', async ({ page, isMobile }) => {
  let contacts = [{ ...contact }];
  let creates = 0;
  await page.route('**/api/crm/**', async route => {
    const req = route.request(); const url = new URL(req.url());
    if (url.pathname.endsWith('/configuration')) return route.fallback();
    if (url.pathname.endsWith('/analytics')) return route.fulfill({ json: { success: true, data: { ...analytics, totalContacts: contacts.length } } });
    if (req.method() === 'POST') { creates++; contacts.push({ ...contact, id: 43, ...req.postDataJSON() }); return route.fulfill({ json: { success: true, data: contacts.at(-1) } }); }
    if (req.method() === 'PUT') { contacts = contacts.map(c => c.id === 42 ? { ...c, ...req.postDataJSON() } : c); return route.fulfill({ json: { success: true, data: contacts[0] } }); }
    if (req.method() === 'DELETE') { contacts = contacts.filter(c => c.id !== 42); return route.fulfill({ json: { success: true } }); }
    const search = url.searchParams.get('search');
    const filtered = search ? contacts.filter(c => c.firstName.toLowerCase().includes(search.toLowerCase())) : contacts;
    return route.fulfill({ json: { success: true, contacts: filtered, total: filtered.length, totalPages: 1 } });
  });
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add Contact', exact: true }).first().click();
  await page.getByLabel('First name', { exact: true }).fill('Sam');
  await page.getByLabel('Last name', { exact: true }).fill('Morgan');
  await page.getByLabel('Email', { exact: true }).fill('sam@example.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Add Contact', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(creates).toBe(1);
  await page.getByRole('textbox', { name: 'Search contacts' }).fill('Sam');
  await expect(page.getByText('Sam Morgan', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search contacts' }).fill('missing');
  await expect(page.getByText('No Contacts Found')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('Alex Morgan', { exact: true }).filter({ visible: true })).toBeVisible();
  if (!isMobile) {
    await page.getByRole('button', { name: 'Edit Alex Morgan' }).click();
    await page.getByRole('textbox', { name: 'Company', exact: true }).fill('Updated Acme');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Updated Acme', { exact: true })).toBeVisible();
  }
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contacts-${test.info().project.name}.png`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'More actions for Alex Morgan', exact: true }).click();
  await page.getByRole('menuitem', { name: /Delete/ }).click();
  await expect(page.getByText('Alex Morgan', { exact: true }).filter({ visible: true })).not.toBeVisible();
  expect(contacts).toHaveLength(1);
});

test('Pipeline: includes later pages and uses the final stage and materialized ID', async ({ page }) => {
  const pages: string[] = [];
  let records = [{ ...contact, id: -42 }, ...Array.from({ length: 19 }, (_, index) => ({ ...contact, id: 1000 + index, firstName: `Fixture ${index}` })), { ...contact, id: 43, firstName: 'Later' }];
  await page.route('**/api/crm/**', async route => {
    const req = route.request(); const url = new URL(req.url());
    if (url.pathname.endsWith('/configuration')) return route.fallback();
    if (url.pathname.endsWith('/analytics')) return route.fulfill({ json: { success: true, data: analytics } });
    if (req.method() === 'PATCH') {
      records = records.map(item => item.id === -42 ? { ...item, id: 99, pipelineStatus: 'won' } : item);
      return route.fulfill({ json: { success: true, data: records.find(item => item.id === 99) } });
    }
    if (url.pathname.endsWith('/pipeline/summary')) return route.fulfill({ json: { success: true, stages: DEFAULT_CRM_CONFIGURATION.stages.map(stage => ({ ...stage, count: records.filter(item => item.pipelineStatus === stage.key).length, dealValueByCurrency: {} })), total: records.length } });
    const current = Number(url.searchParams.get('page') || 1); pages.push(String(current));
    const matching = records.filter(item => item.pipelineStatus === url.searchParams.get('pipelineStatus'));
    return route.fulfill({ json: { success: true, contacts: matching.slice((current - 1) * 20, current * 20), total: matching.length, totalPages: Math.ceil(matching.length / 20), page: current, dealValueByCurrency: {} } });
  });
  await page.goto('/dashboard/crm/pipeline');
  const entry = page.getByRole('region', { name: `${DEFAULT_CRM_CONFIGURATION.stages[0].label} stage`, exact: true });
  await entry.getByRole('button', { name: 'Load more · 20 of 21', exact: true }).click();
  await expect(page.getByText('Later Morgan', { exact: true })).toBeAttached();
  expect(pages).toContain('2');
  await expectNoHorizontalOverflow(page);
  const card = page.locator('.group').filter({ has: page.getByText('Alex Morgan', { exact: true }) }).last();
  await card.getByRole('combobox', { name: 'Pipeline stage' }).click();
  await page.getByRole('option', { name: 'Interested', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Won stage', exact: true }).getByText('Alex Morgan', { exact: true })).toBeAttached();
  expect(records.find(item => item.id === 99)?.pipelineStatus).toBe('won');
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-pipeline-${test.info().project.name}.png`);
});

test('Reminders: create a general task with an absolute timestamp, then edit overdue text and complete', async ({ page }) => {
  await page.context().setDefaultTimeout(15000);
  const reminders = [{ id: 7, contactId: null, title: 'Old follow up', description: '', dueDate: '2020-01-01T10:00:00Z', priority: 'medium', reminderType: 'followup', status: 'pending', contactName: null }];
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/crm/reminders**', async route => {
    const req = route.request();
    if (req.method() !== 'GET') {
      const body = req.postDataJSON(); writes.push(body);
      if (req.method() === 'POST') reminders.push({ ...reminders[0], ...body, id: 8 });
      else Object.assign(reminders[0], body);
      return route.fulfill({ json: { success: true, data: reminders[0] } });
    }
    return route.fulfill({ json: { success: true, data: reminders } });
  });
  await page.goto('/dashboard/crm/reminders');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
  await page.getByLabel('Title *', { exact: true }).fill('Call tomorrow');
  await page.getByLabel('Due Date *', { exact: true }).fill('2030-01-02T10:00');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Add Reminder', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(writes[0]).not.toHaveProperty('contactId');
  expect(writes[0].dueDate).toBe('2030-01-02T04:30:00.000Z');
  await page.getByRole('button', { name: 'Edit Old follow up' }).click();
  await page.getByLabel('Title *', { exact: true }).fill('Overdue follow up');
  await page.getByRole('button', { name: 'Update Reminder' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(writes[1]).not.toHaveProperty('dueDate');
  await page.getByRole('button', { name: 'Mark Overdue follow up complete' }).click();
  await expect(page.getByRole('button', { name: /completed \(1\)/i })).toBeVisible();
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-reminders-${test.info().project.name}.png`);
});

test('Alerts: create, pause and recover failed history without a false empty state', async ({ page }) => {
  let alerts: Record<string, unknown>[] = []; let historyFails = true;
  await page.route('**/api/crm/alerts**', async route => {
    const req = route.request();
    if (new URL(req.url()).pathname.endsWith('/logs')) return route.fulfill({ status: historyFails ? 500 : 200, json: historyFails ? { error: 'History unavailable' } : { success: true, data: [] } });
    if (req.method() === 'POST') { alerts = [{ id: 1, enabled: true, ...req.postDataJSON() }]; return route.fulfill({ json: { success: true, data: alerts[0] } }); }
    if (req.method() === 'PUT') { Object.assign(alerts[0], req.postDataJSON()); return route.fulfill({ json: { success: true, data: alerts[0] } }); }
    return route.fulfill({ json: { success: true, data: alerts } });
  });
  await page.goto('/dashboard/crm/alerts');
  await page.getByRole('button', { name: 'Create Alert', exact: true }).first().click();
  await page.getByLabel('Alert Name *').fill('Watch stage changes');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Create Alert', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Pause Watch stage changes' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('Alert history could not be loaded')).toBeVisible();
  await expect(page.getByText('No Alert History', { exact: true })).not.toBeVisible();
  historyFails = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No Alert History', { exact: true })).toBeVisible();
});

test('Automations: build, preview, activate, refresh and inspect ordered run history', async ({ page }) => {
  let rules: Record<string, unknown>[] = [], previewCalls=0, listLoads=0;
  const run={id:51,automationId:1,automationName:'Tag qualified',revision:1,eventType:'pipeline_status_change',status:'success',contactName:'Alex Morgan',createdAt:'2026-01-01T00:00:00Z'};
  await page.route('**/api/crm/automations**', async route => {
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if (path.endsWith('/catalog')) return route.fulfill({json:{success:true,data:{triggers:AUTOMATION_TRIGGERS,actions:AUTOMATION_ACTIONS,
      fields:AUTOMATION_CONDITION_FIELDS,placeholders:AUTOMATION_PLACEHOLDERS,runtimeEnabled:true,
      accounts:[{channel:'email',id:'7',senderId:7,label:'Verified team sender',ready:true}],campaigns:[],members:[],whatsappTemplates:[]}}});
    if (path.endsWith('/test')) {previewCalls++;return route.fulfill({json:{success:true,data:{matches:true,triggerMatches:true,
      conditions:[{id:req.postDataJSON().definition.conditions.rules[0].id,matches:true}],
      actions:[{id:'preview-1',type:'update_tags',ready:true,rendered:{tags:['qualified']}},{id:'preview-2',type:'send_notification',ready:true,recipient:'manager@example.test',rendered:{subject:'Qualified lead',message:'Alex Morgan reached Won'}}],warnings:['Preview only.']}}});}
    if (path.endsWith('/logs')) return route.fulfill({json:{success:true,data:[]}});
    if (path.endsWith('/1/runs')) return route.fulfill({json:{success:true,data:{runs:[run],nextCursor:null}}});
    if (path.endsWith('/runs/51')) return route.fulfill({json:{success:true,data:{...run,steps:[
      {id:1,stepId:'first',position:0,actionType:'update_tags',status:'success',attempts:1,result:{tags:['qualified']}},
      {id:2,stepId:'second',position:1,actionType:'send_notification',status:'success',attempts:1,providerStatus:'accepted',result:{recipient:'manager@example.test'}}]}}});
    if (req.method()==='POST') {const body=req.postDataJSON();rules=[{...body,id:1,revision:1,isActive:false,triggerType:body.definition.trigger.type,
      triggerConfig:body.definition.trigger.config,action:body.definition.actions[0].type,actionConfig:body.definition.actions[0].config,executionCount:0,createdAt:'2026-01-01T00:00:00Z'}];
      return route.fulfill({json:{success:true,data:rules[0]}});}
    if (req.method()==='PUT') {Object.assign(rules[0],req.postDataJSON());return route.fulfill({json:{success:true,data:rules[0]}});}
    if (path.endsWith('/automations')) {listLoads++;return route.fulfill({json:{success:true,data:rules}});}
    return route.fulfill({json:{success:true,data:rules[0]}});
  });
  await page.goto('/dashboard/crm/automations');
  await page.getByRole('button', { name: 'Create automation', exact: true }).click();
  await expect(page.getByRole('heading',{name:'New automation'})).toBeVisible();
  await page.getByLabel('Automation name').fill('Tag qualified');
  await page.getByLabel('Search triggers').fill('Pipeline stage changes');
  await page.getByRole('button',{name:/Pipeline stage changes/}).click();
  await page.getByLabel('To stage').selectOption('won');
  await page.getByRole('button',{name:'Continue to conditions'}).click();
  await page.getByRole('button',{name:'Add condition'}).click();
  await page.getByLabel('Condition 1 field').selectOption('contact.pipelineStatus');
  await page.getByLabel('Condition 1 value').selectOption('won');
  await page.getByRole('button',{name:'Continue to actions'}).click();
  await page.getByLabel('Add action').selectOption('update_tags');
  await page.getByLabel('Tags').fill('qualified, priority');
  await page.getByLabel('Add action').selectOption('send_notification');
  await page.getByLabel('Verified sender').selectOption('7');
  await page.getByLabel('Recipient').selectOption('fixed');
  await page.getByLabel('Recipient email').fill('manager@example.test');
  await page.getByLabel('Email subject').fill('Qualified lead');
  await page.getByLabel('Email message').fill('{{contact.name}} reached {{contact.pipelineStatus}}');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button',{name:'Test',exact:true}).click();
  await page.getByRole('button',{name:'Run preview'}).click();
  await expect(page.getByText('This event qualifies')).toBeVisible();
  await expect(page.getByText('To: manager@example.test')).toBeVisible();
  expect(previewCalls).toBe(1);expect(rules).toHaveLength(0);
  await page.getByRole('button',{name:'Save paused draft',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/crm\/automations$/);
  expect(rules[0].isActive).toBe(false);
  expect((rules[0].definition as {actions:{type:string}[]}).actions.map(action=>action.type)).toEqual(['update_tags','send_notification']);
  await page.getByRole('switch', { name: 'Enable Tag qualified' }).click();
  await expect(page.getByText('Active',{exact:true})).toBeVisible();
  rules[0].executionCount=1;
  const beforeRefresh=listLoads;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(()=>listLoads).toBeGreaterThan(beforeRefresh);
  await expect(page.getByText('1 runs')).toBeVisible();
  await page.getByRole('button',{name:'Run history for Tag qualified'}).click();
  await expect(page.getByRole('heading',{name:'Run history'})).toBeVisible();
  await page.getByRole('button',{name:/Run #51 · revision 1/}).click();
  await expect(page.getByRole('region',{name:'Run step details'})).toContainText('Delivery: accepted');
  await expectNoHorizontalOverflow(page);
});

test('Import: preview quoted multiline CSV, import and open contacts', async ({ page }) => {
  let imported = false;
  await page.route('**/api/crm/contacts/import', async route => {
    imported = true;
    await route.fulfill({ json: { success: true, data: { importId: 5, totalRecords: 1, successCount: 1, duplicateCount: 0, errorCount: 0, skippedCount: 0, warningCount: 0, issues: [] } } });
  });
  await page.route('**/api/crm/contacts?*', route => route.fulfill({ json: { contacts: [contact], total: 1, totalPages: 1 } }));
  await page.route('**/api/crm/analytics', route => route.fulfill({ json: analytics }));
  await page.goto('/dashboard/crm/import');
  await page.getByLabel('Upload CSV file').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('email,company,notes\na@example.test,"Acme, Inc.","First line\nSecond line"') });
  await expect(page.getByText('Acme, Inc.', { exact: true })).toBeVisible();
  await expect(page.getByText('First line Second line', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-import-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Import Contacts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import Complete' })).toBeVisible();
  expect(imported).toBe(true);
  await page.getByRole('button', { name: 'View Contacts' }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts$/);
});

test('Tablet contacts keep actions available without a squeezed desktop table', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.route('**/api/crm/contacts?*', route => route.fulfill({ json: { contacts: [contact], total: 1, totalPages: 1 } }));
  await page.route('**/api/crm/analytics', route => route.fulfill({ json: analytics }));
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'More actions for Alex Morgan', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Add reminder', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Lead-backed reminder opens with its contact and prevents duplicate saves', async ({ page }) => {
  let posted: Record<string, unknown> | undefined;
  let finishSave: (() => void) | undefined;
  await page.route('**/api/crm/reminders**', async route => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      await new Promise<void>(resolve => { finishSave = resolve; });
      await route.fulfill({ json: { success: true, data: { id: 7 } } });
    } else await route.fulfill({ json: { success: true, data: [] } });
  });
  await page.goto('/dashboard/crm/reminders?contactId=-77&contactName=Alex');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Title *', { exact: true }).fill('Call Alex');
  await page.getByLabel('Due Date *', { exact: true }).fill('2030-01-02T10:00');
  const save = page.getByRole('dialog').getByRole('button', { name: 'Add Reminder', exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await expect.poll(() => posted?.contactId).toBe(-77);
  expect(posted?.notifyContact).toBe(false);
  finishSave!();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
