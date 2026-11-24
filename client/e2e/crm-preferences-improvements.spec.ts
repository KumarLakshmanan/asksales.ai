import type { Page } from '@playwright/test';
import { captureCrmScreenshot } from './fixtures/crm-screenshots';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration';
import { AUTOMATION_ACTIONS, AUTOMATION_CONDITION_FIELDS, AUTOMATION_TRIGGERS, type AutomationCatalog, type AutomationRun, type AutomationRunStep } from '../../shared/crmAutomations';
import type { CrmReminder } from '../src/components/crm/ContactReminders';

test.setTimeout(180_000);
test.use({ actionTimeout: 45_000, timezoneId: 'Asia/Kolkata' });
const screenshotDirectory = process.env.CRM_QA_SCREENSHOT_DIR || 'test-results';
const recoveryKey = 'crm-configuration-draft:4102:4101';
const originalRevision = 'a'.repeat(64);
const concurrentRevision = 'b'.repeat(64);
const savedRevision = 'c'.repeat(64);
const conflictMessage = 'CRM configuration changed while you were editing. Your draft is preserved. Reload the saved configuration and review those changes before saving again.';
const initialConfiguration = (): CrmConfiguration => ({
  stages: structuredClone(DEFAULT_CRM_CONFIGURATION.stages.filter(stage => ['new', 'contacted', 'won', 'lost'].includes(stage.key))),
  preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences }, revision: originalRevision,
});
const assignees = [
  { id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test', role: 'owner' },
  { id: 4103, name: 'Jordan Ellis', email: 'jordan@example.test', role: 'member' },
];
const catalog: AutomationCatalog = {
  triggers: [...AUTOMATION_TRIGGERS], actions: [...AUTOMATION_ACTIONS], fields: [...AUTOMATION_CONDITION_FIELDS],
  placeholders: [], runtimeEnabled: true, campaigns: [], members: assignees, whatsappTemplates: [],
  accounts: [
    { channel: 'email', id: 'email-4102', label: 'Workspace email', ready: true },
    { channel: 'whatsapp', id: 'whatsapp-4102', label: 'Harbor WhatsApp', ready: false, reason: 'Reconnect the sending account.' },
  ],
};

async function installScopedMocks(page: Page) {
  // Every application API is intercepted; these fixtures cannot dispatch a real message.
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/crm/assignees', route => route.fulfill({ json: { success: true, data: assignees } }));
  await page.route('**/api/crm/automations/catalog', route => route.fulfill({ json: { success: true, data: catalog } }));
  await page.route('**/api/crm/contacts?*', route => route.fulfill({ json: { success: true, contacts: [], total: 0, page: 1, limit: 20, totalPages: 0 } }));
  await page.route('**/api/crm/analytics', route => route.fulfill({ json: { success: true, data: { totalContacts: 0, winRate: 0, pipelineValueByCurrency: {} } } }));
}

test.beforeEach(async ({ page }) => { await installScopedMocks(page); });

test('Preferences show connection status, recover only this tab’s draft, and preserve edits when a newer configuration rejects the save', async ({ page, audit }) => {
  let configuration = initialConfiguration();
  const writes: Array<{ body: CrmConfiguration; profile: string | undefined }> = [];
  const routeConfiguration = async (target: Page) => {
    await target.route('**/api/crm/configuration', async route => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as CrmConfiguration;
        writes.push({ body, profile: route.request().headers()['x-business-profile-id'] });
        if (body.revision !== configuration.revision) return route.fulfill({ status: 409, json: { success: false, error: conflictMessage } });
        configuration = { ...body, revision: savedRevision };
      }
      return route.fulfill({ json: { success: true, data: configuration } });
    });
  };
  await routeConfiguration(page);
  let dismissGuard = true;
  const dialogs: Array<{ type: string; message: string }> = [];
  page.on('dialog', dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    void (dismissGuard && dialog.type() === 'confirm' ? dialog.dismiss() : dialog.accept());
  });
  await page.goto('/dashboard/crm/configuration');
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Ongoing');
  await page.getByLabel('Stage name 2').fill('Discovery');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const emailCard = page.locator('label').filter({ has: page.getByRole('checkbox', { name: 'Email', exact: true }) });
  const whatsappCard = page.locator('label').filter({ has: page.getByRole('checkbox', { name: 'WhatsApp', exact: true }) });
  await expect(emailCard).toContainText('1 connected account');
  await expect(whatsappCard).toContainText('Connection needs attention');
  await expect(page.getByRole('link', { name: 'Manage messaging accounts', exact: true })).toHaveAttribute('href', '/dashboard/integrations');
  await page.getByRole('checkbox', { name: 'Email', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Email', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Email', exact: true })).toBeChecked();
  await expect(page.getByText('Keep at least one platform selected, or choose All Platforms.', { exact: true })).toBeVisible();
  // An account that needs reconnection can still be selected for historical reports.
  await page.getByRole('checkbox', { name: 'WhatsApp', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'All Platforms', exact: true })).not.toBeChecked();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  await page.getByLabel('Date Range', { exact: true }).selectOption('custom');
  await page.getByLabel('Start date', { exact: true }).fill('2026-09-01');
  await page.getByLabel('End date', { exact: true }).fill('2026-09-30');
  await page.getByLabel('Top Flows', { exact: true }).fill('9');
  await expect(page.getByText('Both dates are included. Reports use UTC calendar dates.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(key => {
    const draft = JSON.parse(sessionStorage.getItem(key) || 'null')?.value?.preferences;
    return { end: draft?.dateEnd, topFlows: draft?.topFlows };
  }, recoveryKey)).toEqual({ end: '2026-09-30', topFlows: 9 });
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-preferences-custom-dates-${test.info().project.name}.png`);

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(dialogs).toContainEqual({ type: 'confirm', message: 'You have unsaved changes. Leave without saving?' });
  await expect(page).toHaveURL(/\/dashboard\/crm\/configuration$/);
  await expect(page.getByLabel('Top Flows', { exact: true })).toHaveValue('9');
  expect(writes).toHaveLength(0);

  // A separately opened tab has its own sessionStorage even for the same actor and business.
  const secondTab = await page.context().newPage();
  try {
    await secondTab.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      class FixtureSocket extends EventTarget {
        static readonly OPEN = 1;
        readyState = 1;
        onopen: ((event: Event) => void) | null = null;
        constructor(readonly url: string | URL) {
          super();
          queueMicrotask(() => { const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); });
        }
        send() {}
        close() { this.readyState = 3; }
      }
      class RoutedFixtureSocket {
        static readonly OPEN = 1;
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(String(url), window.location.href);
          // Next.js needs its native development socket to finish loading the page.
          return target.host === window.location.host && target.pathname === '/_next/webpack-hmr'
            ? new NativeSocket(url, protocols) : new FixtureSocket(url);
        }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: RoutedFixtureSocket });
    });
    await installScopedMocks(secondTab);
    await routeConfiguration(secondTab);
    await secondTab.goto('/dashboard/crm/configuration');
    await expect(secondTab.getByLabel('Stage name 2')).toHaveValue('Ongoing');
    await expect(secondTab.getByRole('button', { name: 'Restore unfinished draft', exact: true })).toHaveCount(0);
    expect(await secondTab.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeNull();
  } finally { await secondTab.close(); }

  await page.reload();
  await expect(page.getByText('Unfinished configuration draft', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Ongoing');
  await page.getByRole('button', { name: 'Restore unfinished draft', exact: true }).click();
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Discovery');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Email', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'WhatsApp', exact: true })).toBeChecked();
  await expect(page.getByLabel('Start date', { exact: true })).toHaveValue('2026-09-01');
  await expect(page.getByLabel('End date', { exact: true })).toHaveValue('2026-09-30');
  await expect(page.getByLabel('Top Flows', { exact: true })).toHaveValue('9');

  configuration = { ...initialConfiguration(), revision: concurrentRevision, preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences, topFlows: 12 } };
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('2026-09-01 – 2026-09-30 (UTC)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByText('Configuration was not saved', { exact: true })).toBeVisible();
  await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ profile: '4102', body: { revision: originalRevision, preferences: { platform: ['email', 'whatsapp'], dateRange: 'custom', dateStart: '2026-09-01', dateEnd: '2026-09-30', topFlows: 9 } } });
  expect(configuration.preferences.topFlows).toBe(12);
  await page.getByRole('button', { name: 'Edit preferences', exact: true }).click();
  await expect(page.getByLabel('Top Flows', { exact: true })).toHaveValue('9');
  await expect(page.getByLabel('Start date', { exact: true })).toHaveValue('2026-09-01');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-preferences-conflict-${test.info().project.name}.png`);

  dismissGuard = false;
  await page.getByRole('button', { name: 'Load latest saved configuration', exact: true }).click();
  expect(dialogs).toContainEqual({ type: 'confirm', message: 'Discard your current edits and load the latest saved configuration?' });
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Ongoing');
  await expect(page.getByRole('button', { name: 'Restore unfinished draft', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Top Flows', { exact: true })).toHaveValue('12');
  await page.getByRole('checkbox', { name: 'Email', exact: true }).check();
  await page.getByRole('checkbox', { name: 'WhatsApp', exact: true }).check();
  await page.getByLabel('Date Range', { exact: true }).selectOption('custom');
  await page.getByLabel('Start date', { exact: true }).fill('2026-09-01');
  await page.getByLabel('End date', { exact: true }).fill('2026-09-30');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts$/);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ profile: '4102', body: { revision: concurrentRevision, preferences: { dateRange: 'custom', dateStart: '2026-09-01', dateEnd: '2026-09-30', platform: ['email', 'whatsapp'], topFlows: 12 } } });
  expect(configuration.revision).toBe(savedRevision);
  expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeNull();
  expect(audit.blockedMutations).toEqual([]);
});

test('Reminder owners can snooze and complete a follow-up, then review contextual automation history without sending again', async ({ page, audit }) => {
  page.on('dialog', dialog => void dialog.accept());
  let reminder: CrmReminder = { id: 701, contactId: 42, contactName: 'Priya Raman', contactEmail: 'priya@example.test', title: 'Call Priya about onboarding',
    description: 'Review onboarding questions with the contact.', dueDate: '2099-01-15T05:00:00.000Z', reminderType: 'followup', priority: 'high', status: 'pending',
    assignedTo: 4101, assignedName: 'Regression Alpha', metadata: { notifyContact: false, assignedTo: 4101 }, createdAt: '2026-10-01T04:30:00.000Z' };
  const ownerReminder: CrmReminder = { ...reminder, id: 702, contactId: null, contactName: null, title: 'Prepare weekly handover', assignedTo: null, assignedName: null, metadata: { notifyContact: false } };
  const writes: Array<{ body: Record<string, unknown>; profile: string | undefined }> = [];
  const crmMutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/crm/') && !['GET', 'HEAD'].includes(request.method())) crmMutations.push(`${request.method()} ${path}`);
  });
  await page.route('**/api/crm/reminders', route => route.fulfill({ json: { success: true, data: [reminder, ownerReminder] } }));
  await page.route('**/api/crm/reminders/701', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push({ body, profile: route.request().headers()['x-business-profile-id'] });
    if (typeof body.assignedTo === 'number') reminder = { ...reminder, assignedTo: body.assignedTo, assignedName: assignees.find(member => member.id === body.assignedTo)?.name || null, metadata: { ...reminder.metadata, assignedTo: body.assignedTo } };
    if (typeof body.snoozedUntil === 'string') reminder = { ...reminder, dueDate: body.snoozedUntil, snoozedUntil: body.snoozedUntil, status: 'snoozed' };
    if (body.status === 'completed') reminder = { ...reminder, status: 'completed' };
    return route.fulfill({ json: { success: true, data: reminder } });
  });
  await page.goto('/dashboard/crm/reminders');
  await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();
  await page.getByLabel('Filter reminders by assignee').selectOption('4101');
  await expect(page.getByText(reminder.title, { exact: true })).toBeVisible();
  await expect(page.getByText(ownerReminder.title, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Edit ${reminder.title}`, exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit Reminder', exact: true });
  await expect(editDialog.getByLabel('Due Date *', { exact: true })).toHaveValue('2099-01-15T10:30');
  await expect(editDialog.getByRole('switch', { name: 'Email Priya Raman', exact: true })).not.toBeChecked();
  await editDialog.getByLabel('Assigned to', { exact: true }).selectOption('4103');
  await editDialog.getByRole('button', { name: 'Update Reminder', exact: true }).click();
  await expect(editDialog).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ profile: '4102', body: { assignedTo: 4103, notifyContact: false } });
  expect(writes[0].body).not.toHaveProperty('dueDate');
  await page.getByLabel('Filter reminders by assignee').selectOption('4103');
  await expect(page.getByText('Jordan Ellis', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search reminders', exact: true }).fill('Priya onboarding');
  const beforeSnooze = await page.evaluate(() => Date.now());
  await page.getByRole('button', { name: `More actions for ${reminder.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Snooze one hour', exact: true }).click();
  await expect(page.getByText('Snoozed', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1].profile).toBe('4102');
  expect(Object.keys(writes[1].body)).toEqual(['snoozedUntil']);
  const snoozedAt = new Date(String(writes[1].body.snoozedUntil)).getTime();
  expect(snoozedAt).toBeGreaterThanOrEqual(beforeSnooze + 3_600_000);
  expect(snoozedAt).toBeLessThanOrEqual(await page.evaluate(() => Date.now()) + 3_600_000);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-reminder-assignment-snooze-${test.info().project.name}.png`);
  await page.getByRole('button', { name: `Mark ${reminder.title} complete`, exact: true }).click();
  await expect(page.getByRole('button', { name: /^completed \(1\)$/i })).toBeVisible();
  await page.getByRole('button', { name: /^completed \(1\)$/i }).click();
  await expect(page.getByRole('button', { name: `Mark ${reminder.title} complete`, exact: true })).toBeDisabled();
  expect(writes[2]).toEqual({ profile: '4102', body: { status: 'completed' } });

  const held: AutomationRun = { id: 901, automationId: 31, automationName: 'Onboarding handoff', revision: 4, eventType: 'pipeline_status_change', contactId: 42, contactName: 'Priya Raman',
    status: 'uncertain', createdAt: '2026-10-02T06:00:00.000Z', errorMessage: 'Provider acceptance is unknown. internal_token=fixture-secret-that-must-not-be-rendered' };
  const failed: AutomationRun = { ...held, id: 900, status: 'failed', createdAt: '2026-10-01T06:00:00.000Z', errorMessage: 'The sender connection needs reauthorization. internal_token=fixture-secret-that-must-not-be-rendered' };
  const completedStep: AutomationRunStep = { id: 1501, stepId: 'move-contact', position: 0, actionType: 'update_pipeline_status', status: 'success', attempts: 1, result: { pipelineStatus: 'contacted' } };
  const heldStep: AutomationRunStep = { id: 1502, stepId: 'notify', position: 1, actionType: 'send_notification', status: 'uncertain', attempts: 1, providerStatus: 'unknown', errorMessage: held.errorMessage,
    result: { providerStatus: 'unknown', internal_token: 'fixture-secret-that-must-not-be-rendered' } };
  const historyProfiles: Array<string | undefined> = [];
  const cursors: Array<string | null> = [];
  await page.route('**/api/crm/automations/31/runs**', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor); historyProfiles.push(route.request().headers()['x-business-profile-id']);
    return route.fulfill({ json: { success: true, data: { runs: cursor ? [failed] : [held], nextCursor: cursor ? null : 900 } } });
  });
  await page.route('**/api/crm/automations/runs/*', route => {
    historyProfiles.push(route.request().headers()['x-business-profile-id']);
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({ json: { success: true, data: id === held.id ? { ...held, steps: [completedStep, heldStep] } : { ...failed, steps: [{ ...heldStep, status: 'failed', errorMessage: failed.errorMessage }] } } });
  });
  await page.goto('/dashboard/crm/automations/31/runs?run=901');
  await expect(page.getByRole('heading', { name: 'Run history', exact: true })).toBeVisible();
  const details = page.getByRole('region', { name: 'Run step details', exact: true });
  await expect(details.getByRole('heading', { name: 'Run #901 · uncertain', exact: true })).toBeVisible();
  await expect(details.getByText(/was evaluated using revision 4 of this rule/)).toBeVisible();
  await expect(details.getByText('Stage: Ongoing', { exact: true })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Delivery needs review', exact: true }).first()).toBeVisible();
  await expect(details.getByText(/Remaining actions are held because the provider may already have accepted the message/).first()).toBeVisible();
  await expect(details.getByRole('link', { name: 'Open Priya Raman activity', exact: true })).toHaveAttribute('href', '/dashboard/crm/contacts/42?tab=activity');
  await expect(page.getByRole('link', { name: 'Review rule and test', exact: true })).toHaveAttribute('href', '/dashboard/crm/automations/31');
  await expect(page.getByText('fixture-secret-that-must-not-be-rendered', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /replay|resend|send again/i })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-automation-held-run-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Load older runs', exact: true }).click();
  await expect(page.getByRole('button', { name: /Run #900 · revision 4/ })).toBeVisible();
  expect(cursors).toContain('900');
  await page.getByRole('searchbox', { name: 'Search loaded runs', exact: true }).fill('Priya');
  await page.getByLabel('Filter runs by status').selectOption('failed');
  await expect(page.getByRole('button', { name: /Run #901 · revision 4/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Run #900 · revision 4/ }).click();
  await expect(details.getByRole('heading', { name: 'Sending connection needs attention', exact: true }).first()).toBeVisible();
  await expect(details.getByRole('link', { name: 'Review connections', exact: true }).first()).toHaveAttribute('href', '/dashboard/integrations');
  await expect(page.getByText('fixture-secret-that-must-not-be-rendered', { exact: false })).toHaveCount(0);
  expect(historyProfiles.length).toBeGreaterThanOrEqual(4);
  expect(historyProfiles.every(profile => profile === '4102')).toBe(true);
  expect(crmMutations).toEqual(['PUT /api/crm/reminders/701', 'PUT /api/crm/reminders/701', 'PUT /api/crm/reminders/701']);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
