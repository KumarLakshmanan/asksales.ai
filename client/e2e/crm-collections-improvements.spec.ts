import { captureCrmScreenshot } from './fixtures/crm-screenshots';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration';

test.setTimeout(180_000);
test.use({ actionTimeout: 30_000, timezoneId: 'Asia/Kolkata' });
const screenshotDirectory = process.env.CRM_QA_SCREENSHOT_DIR || 'test-results';
const configuration: CrmConfiguration = {
  stages: [DEFAULT_CRM_CONFIGURATION.stages[0], { key: 'review', label: 'Proposal review', type: 'active', color: '#2563eb', inFlow: true },
    { key: 'accepted', label: 'Contract accepted', type: 'won', color: '#10b981', inFlow: true }, DEFAULT_CRM_CONFIGURATION.stages[9]],
  preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences, platform: ['email', 'sms'] },
};
const contactFixture = { id: 42, leadId: 7, firstName: 'Priya', lastName: 'Raman', email: 'priya@harbor.example',
  phone: '+919876543210', company: 'Harbor Commerce', role: 'Head of operations', status: 'interested', pipelineStatus: 'review',
  priority: 'high', assignedTo: 4101, source: 'website', currency: 'INR', dealValue: '245000', lastSentimentStatus: 'positive',
  tags: ['Enterprise'], nextFollowUpAt: '2026-10-04T04:30:00Z', lastActivityAt: '2026-10-02T04:30:00Z',
  createdAt: '2026-09-20T04:30:00Z', updatedAt: '2026-10-02T04:30:00Z' };
const assignees = [{ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test', role: 'owner' },
  { id: 4105, name: 'Asha Patel', email: 'asha@harbor.example', role: 'member' }];
const basicAnalytics = { totalContacts: 25, winRate: 50, pipelineValueByCurrency: { INR: '245000' }, totalPipelineValueByCurrency: { INR: '245000' },
  stages: configuration.stages.map(stage => ({ ...stage, count: stage.key === 'review' ? 25 : 0, stuckCount: 0, dealValueByCurrency: stage.key === 'review' ? { INR: '245000' } : {} })),
  preferences: configuration.preferences, stuckContacts: 1, flows: [{ from: 'new', to: 'review', count: 4 }] };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [
    { id: 4102, name: 'Harbor Commerce', companyName: 'Harbor Commerce', isDefault: true, role: 'owner' },
    { id: 4103, name: 'Lighthouse Operations', companyName: 'Lighthouse Operations', isDefault: false, role: 'owner' },
  ] }));
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/crm/configuration', route => route.fulfill({ json: { success: true, data: configuration } }));
  await page.route('**/api/crm/assignees', route => route.fulfill({ json: { success: true, data: assignees } }));
  await page.route('**/api/crm/analytics', route => route.fulfill({ json: { success: true, data: basicAnalytics } }));
  await page.route('**/api/crm/pipeline/analytics', route => route.fulfill({ json: { success: true, data: basicAnalytics } }));
});

test('Contact collections save scoped views, filter on the server, update checked contacts, and export the filtered result', async ({ page, audit }) => {
  let contact = { ...contactFixture };
  const queries: URLSearchParams[] = [];
  const profileHeaders: (string | undefined)[] = [];
  const bulkWrites: Record<string, unknown>[] = [];
  const exportQueries: string[] = [];
  await page.route('**/api/crm/contacts?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    const profileHeader = route.request().headers()['x-business-profile-id']; profileHeaders.push(profileHeader);
    const scopedContact = profileHeader === '4103' ? { ...contact, id: 84, firstName: 'Jordan', lastName: 'Lee' } : contact;
    const matches = (!query.has('ownerUserId') || query.get('ownerUserId') === String(scopedContact.assignedTo)) && (!query.has('priority') || query.get('priority') === scopedContact.priority);
    return route.fulfill({ json: { success: true, contacts: matches ? [scopedContact] : [], total: matches ? 1 : 0, page: 1, limit: 20, totalPages: matches ? 1 : 0, dealValueByCurrency: matches ? { INR: '245000' } : {} } });
  });
  await page.route('**/api/crm/contacts/bulk', async route => {
    const body = route.request().postDataJSON(); bulkWrites.push(body);
    contact = { ...contact, tags: [...contact.tags, ...(body.addTags || [])], assignedTo: body.ownerUserId ?? contact.assignedTo };
    await route.fulfill({ json: { success: true, data: { contacts: [contact], updatedCount: 1 } } });
  });
  await page.route('**/api/crm/contacts/export?*', route => {
    exportQueries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { success: true, csv: 'Name,Email\r\nPriya Raman,priya@harbor.example\r\n', filename: 'crm-contacts.csv', total: 1, exported: 1, truncated: false } });
  });
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('link', { name: 'Priya Raman', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Advanced filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Advanced filters', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByLabel('Assigned to', { exact: true }).selectOption('4101');
  await page.getByLabel('Sort contacts', { exact: true }).selectOption('dealValue');
  await page.getByLabel('Sort direction', { exact: true }).selectOption('asc');
  await expect.poll(() => queries.some(query => query.get('priority') === 'high' && query.get('ownerUserId') === '4101' && query.get('sortBy') === 'dealValue' && query.get('sortOrder') === 'asc')).toBe(true);
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').getByLabel('View name', { exact: true }).fill('High-priority customers');
  await page.getByRole('dialog').getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByLabel('Saved view', { exact: true }).locator('option:checked')).toHaveText('High-priority customers');
  const savedViews = await page.evaluate(() => JSON.parse(localStorage.getItem('crm-contact-views:4101:4102') || '[]'));
  expect(savedViews).toHaveLength(1); expect(savedViews[0].filters).toMatchObject({ priority: 'high', ownerUserId: '4101', sortBy: 'dealValue', sortOrder: 'asc' });
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contacts-saved-view-${test.info().project.name}.png`);
  await page.getByRole('checkbox', { name: 'Select Priya Raman', exact: true }).check();
  await page.getByLabel('Assign to', { exact: true }).selectOption('4105');
  await page.getByLabel('Add tags', { exact: true }).fill('Customer, Q4');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contacts-selected-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Apply to selected', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Update selected contacts' })).toHaveCount(0);
  expect(bulkWrites).toEqual([{ contactIds: [42], addTags: ['Customer', 'Q4'], ownerUserId: 4105 }]);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export filtered CSV', exact: true }).click();
  const download = await downloadEvent; expect(download.suggestedFilename()).toBe('crm-contacts.csv');
  expect(exportQueries).toHaveLength(1); expect(exportQueries[0]).toContain('priority=high'); expect(exportQueries[0]).not.toContain('page=');
  await page.evaluate(() => { sessionStorage.setItem('active-business-profile:4101', '4103'); window.dispatchEvent(new Event('business-profile-changed')); });
  await expect.poll(() => profileHeaders.includes('4103')).toBe(true);
  await expect(page.getByLabel('Saved view', { exact: true }).locator('option')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('crm-contact-views:4101:4103'))).toBeNull();
  await expect(page.getByRole('link', { name: 'Jordan Lee', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Priya Raman', exact: true })).toHaveCount(0);
  expect(audit.blockedMutations).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

test('Inline contact editing uses one atomic request and retains field errors and unsaved values for retry', async ({ page, audit }) => {
  let contact = { ...contactFixture }, fail = true;
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/crm/contacts?*', route => route.fulfill({ json: { success: true, contacts: [contact], total: 1, page: 1, totalPages: 1 } }));
  await page.route('**/api/crm/contacts/42**', async route => {
    const body = route.request().postDataJSON(); writes.push({ method: route.request().method(), body });
    if (fail) return route.fulfill({ status: 409, json: { error: 'Another team member updated this contact. Reload before saving.' } });
    contact = { ...contact, ...body };
    return route.fulfill({ json: { success: true, data: contact } });
  });
  await page.goto('/dashboard/crm/contacts');
  await page.getByRole('button', { name: 'More actions for Priya Raman', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit contact', exact: true }).click();
  await page.getByLabel('Company', { exact: true }).fill('Harbor Customer Operations');
  await page.getByRole('combobox', { name: 'Pipeline stage', exact: true }).selectOption('accepted');
  await page.getByLabel('Deal value', { exact: true }).fill('280000');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-contacts-inline-edit-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Another team member updated this contact.' })).toBeVisible();
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Harbor Customer Operations');
  fail = false;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Company', { exact: true })).toHaveCount(0);
  expect(writes.map(write => write.method)).toEqual(['PUT', 'PUT']);
  expect(writes[1].body).toEqual({ company: 'Harbor Customer Operations', dealValue: '280000', pipelineStatus: 'accepted', expectedUpdatedAt: contactFixture.updatedAt });
  expect(audit.consoleErrors.filter(message => message !== 'Failed to load resource: the server responded with a status of 409 (Conflict)')).toEqual([]);
});

test('Pipeline uses bounded stage pages, full filtered totals, recoverable load-more, and keyboard stage moves', async ({ page, audit }) => {
  const contacts = Array.from({ length: 25 }, (_, index) => ({ ...contactFixture, id: 42 + index, firstName: index ? `Customer ${index}` : 'Priya', lastName: index ? 'Harbor' : 'Raman' }));
  const queries: URLSearchParams[] = [];
  let failMore = true;
  await page.route('**/api/crm/pipeline/summary?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const matching = query.get('search') ? contacts.filter(contact => `${contact.firstName} ${contact.lastName}`.toLowerCase().includes(query.get('search')!.toLowerCase())) : contacts;
    return route.fulfill({ json: { success: true, stages: configuration.stages.map(stage => ({ ...stage, count: matching.filter(contact => contact.pipelineStatus === stage.key).length, dealValueByCurrency: stage.key === 'review' ? { INR: '6125000' } : {} })), total: matching.length } });
  });
  await page.route('**/api/crm/contacts?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    const pageNumber = Number(query.get('page') || 1), limit = Number(query.get('limit') || 20);
    if (pageNumber === 2 && failMore) return route.fulfill({ status: 503, json: { error: 'This page is temporarily unavailable.' } });
    const matching = contacts.filter(contact => contact.pipelineStatus === query.get('pipelineStatus') && (!query.get('search') || `${contact.firstName} ${contact.lastName}`.toLowerCase().includes(query.get('search')!.toLowerCase())));
    return route.fulfill({ json: { success: true, contacts: matching.slice((pageNumber - 1) * limit, pageNumber * limit), total: matching.length, totalPages: Math.ceil(matching.length / limit), page: pageNumber, dealValueByCurrency: matching.length ? { INR: String(matching.length * 245000) } : {} } });
  });
  await page.route('**/api/crm/contacts/42/pipeline-status', route => {
    const body = route.request().postDataJSON(); contacts[0] = { ...contacts[0], ...body };
    return route.fulfill({ json: { success: true, data: contacts[0] } });
  });
  await page.goto('/dashboard/crm/pipeline');
  const stage = page.getByRole('region', { name: 'Proposal review stage', exact: true });
  await expect(stage.getByText('Priya Raman', { exact: true })).toBeVisible();
  await expect(stage.getByRole('link', { name: 'Proposal review 25', exact: true })).toBeVisible();
  expect(queries.every(query => query.get('limit') === '20' && query.has('pipelineStatus'))).toBe(true);
  expect(queries.filter(query => query.get('page') === '2')).toHaveLength(0);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-pipeline-paginated-${test.info().project.name}.png`);
  await stage.getByRole('button', { name: 'Load more · 20 of 25', exact: true }).click();
  await expect(stage.getByRole('alert')).toContainText('This page is temporarily unavailable.');
  failMore = false;
  await stage.getByRole('button', { name: 'Retry stage', exact: true }).click();
  await expect(stage.getByText('Customer 24 Harbor', { exact: true })).toBeAttached();
  await expect(stage.getByText('Priya Raman', { exact: true })).toBeAttached();
  await page.getByRole('textbox', { name: 'Search contacts', exact: true }).fill('Priya');
  await expect(stage.getByRole('link', { name: 'Proposal review 1', exact: true })).toBeVisible();
  const picker = stage.getByRole('combobox', { name: 'Pipeline stage', exact: true });
  await picker.focus(); await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'Contract accepted', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Contract accepted stage', exact: true }).getByText('Priya Raman', { exact: true })).toBeAttached();
  expect(audit.consoleErrors.filter(message => message !== 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)')).toEqual([]);
});

test('Reports apply custom dates and multiple platforms, show honest cohort metrics, and drill down with the same filters', async ({ page, audit }) => {
  const queries: URLSearchParams[] = [];
  const report = { ...basicAnalytics, winRate: 60, stages: basicAnalytics.stages.map(stage => ({ ...stage, count: stage.key === 'review' ? 20 : stage.key === 'accepted' ? 3 : stage.key === 'lost' ? 2 : 0 })), channels: [{ channel: 'email', contacts: 20, conversations: 23, messages: 92, unread: 3 }, { channel: 'sms', contacts: 15, conversations: 15, messages: 35, unread: 1 }],
    stageDurations: [{ stageKey: 'review', label: 'Proposal review', visits: 3, averageDays: 2.5 }], filters: { platforms: ['email', 'sms'], dateRange: '30d' } };
  await page.route('**/api/crm/reports?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    return route.fulfill({ json: { success: true, data: { ...report, preferences: { ...configuration.preferences, dateRange: query.get('dateRange') || '30d' } } } });
  });
  await page.goto('/dashboard/crm/reports');
  await expect(page.getByRole('heading', { name: 'Current pipeline position', exact: true })).toBeVisible();
  await expect(page.getByText('2.5 days', { exact: true })).toBeVisible();
  await page.getByLabel('Date range', { exact: true }).selectOption('custom');
  await page.getByLabel('Start date (UTC)', { exact: true }).fill('2026-09-01');
  await page.getByLabel('End date (UTC, inclusive)', { exact: true }).fill('2026-09-30');
  await page.getByRole('button', { name: 'Apply report filters', exact: true }).click();
  await expect.poll(() => queries.some(query => query.get('dateRange') === 'custom' && query.get('from') === '2026-09-01' && query.get('to') === '2026-09-30' && query.get('platforms') === 'email,sms')).toBe(true);
  const drilldown = page.getByRole('link', { name: 'View matching contacts →', exact: true });
  await expect(drilldown).toHaveAttribute('href', /dateRange=custom/); await expect(drilldown).toHaveAttribute('href', /platforms=email%2Csms/);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-reports-overview-${test.info().project.name}.png`);
  await page.locator('summary').filter({ hasText: 'Platforms ·' }).click();
  await page.getByRole('checkbox', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('button', { name: 'Apply report filters', exact: true }).click();
  await expect.poll(() => queries.some(query => query.get('platforms') === 'email,sms,whatsapp')).toBe(true);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-reports-platforms-${test.info().project.name}.png`);
  await page.getByRole('checkbox', { name: 'All Platforms', exact: true }).check();
  await page.getByLabel('Date range', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Apply report filters', exact: true }).click();
  await expect.poll(() => queries.some(query => query.get('dateRange') === 'all' && query.get('platforms') === 'all')).toBe(true);
  expect(audit.consoleErrors).toEqual([]);
});

test('My work combines actionable records, scopes assignment, and updates actual reminder IDs with refresh', async ({ page, audit }) => {
  type WorkItem = { id: string; entityId: number; type: string; title: string; description: string; contactId: number; contactName: string; ownerUserId: number; dueAt: string | null; priority: string; status: string; url: string };
  let items: WorkItem[] = [
    { id: 'reminder:31', entityId: 31, type: 'reminder', title: 'Follow up on the onboarding plan', description: 'Confirm the pilot start date.', contactId: 42, contactName: 'Priya Raman', ownerUserId: 4101, dueAt: '2026-01-01T04:30:00Z', priority: 'high', status: 'pending', url: '/dashboard/crm/reminders?contactId=42' },
    { id: 'conversation:81', entityId: 81, type: 'conversation', title: 'Rollout plan reply needs a response', description: 'Please share the onboarding schedule.', contactId: 42, contactName: 'Priya Raman', ownerUserId: 4101, dueAt: '2026-10-02T04:30:00Z', priority: 'high', status: 'replied', url: '/dashboard/crm/contacts/42?tab=conversations' },
    { id: 'ticket:501', entityId: 501, type: 'ticket', title: 'Invite the onboarding team', description: 'Customer is waiting for workspace access.', contactId: 42, contactName: 'Priya Raman', ownerUserId: 4105, dueAt: null, priority: 'medium', status: 'pending', url: '/dashboard/crm/contacts/42?tab=tickets' },
    { id: 'stuck_contact:42', entityId: 42, type: 'stuck_contact', title: 'Proposal review needs attention', description: 'Review the next step with Priya.', contactId: 42, contactName: 'Priya Raman', ownerUserId: 4101, dueAt: '2026-01-01T04:30:00Z', priority: 'high', status: 'review', url: '/dashboard/crm/contacts/42' },
  ];
  const writes: { id: string; body: Record<string, unknown> }[] = [];
  const queries: URLSearchParams[] = [];
  await page.route('**/api/crm/work?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    const scoped = query.has('ownerUserId') ? items.filter(item => String(item.ownerUserId) === query.get('ownerUserId')) : items;
    const filtered = query.has('type') ? scoped.filter(item => item.type === query.get('type')) : scoped;
    const counts = Object.fromEntries(['reminder', 'conversation', 'stuck_contact', 'ticket'].map(type => [type, scoped.filter(item => item.type === type).length]));
    return route.fulfill({ json: { success: true, items: filtered, counts, total: filtered.length, page: 1, limit: 20, totalPages: 1 } });
  });
  await page.route('**/api/crm/reminders/31', route => {
    const body = route.request().postDataJSON(); writes.push({ id: '31', body });
    if (body.status === 'completed') items = items.filter(item => item.id !== 'reminder:31');
    else items = items.map(item => item.id === 'reminder:31' ? { ...item, dueAt: body.snoozedUntil } : item);
    return route.fulfill({ json: { success: true, data: { id: 31, ...body } } });
  });
  await page.goto('/dashboard/crm/work');
  await expect(page.getByRole('heading', { name: 'My work', exact: true })).toBeVisible();
  await expect(page.getByText('Follow up on the onboarding plan', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review conversation', exact: true })).toHaveAttribute('href', '/dashboard/crm/contacts/42?tab=conversations');
  await expect(page.getByRole('link', { name: 'Review ticket', exact: true })).toHaveAttribute('href', '/dashboard/crm/contacts/42?tab=tickets');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-my-work-queue-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Assigned to me', exact: true }).click();
  await expect.poll(() => queries.some(query => query.get('ownerUserId') === '4101')).toBe(true);
  await expect(page.getByRole('link', { name: 'Review ticket', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Snooze 1 day', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1); expect(writes[0].body).toHaveProperty('snoozedUntil');
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(page.getByText('Follow up on the onboarding plan', { exact: true })).toHaveCount(0);
  expect(writes[1]).toEqual({ id: '31', body: { status: 'completed' } });
  await page.getByRole('button', { name: 'Unanswered conversations 1', exact: true }).click();
  await expect(page.getByText('Rollout plan reply needs a response', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-my-work-conversations-${test.info().project.name}.png`);
  expect(audit.blockedMutations).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});
