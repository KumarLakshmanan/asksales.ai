import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import type { Page } from '@playwright/test';

const seed = () => ({
  email: { enabled: true, providerState: 'available', subject: 'Saved {{ticket_number}}', text: 'Saved {{ticket_url}}',
    preview: { subject: 'Saved ticket', text: 'Saved ticket', html: '<p>Saved ticket</p>' } },
  whatsapp: { enabled: false, providerState: 'connected', templateId: null, templates: [] },
  recipients: [{ memberId: 3, memberName: 'Support QA', teamName: 'Support', active: true,
    emailReady: true, emailHint: 'q***@example.test', whatsappReady: false, whatsappHint: null,
    memberProfileUrl: '/dashboard/support/teams/1/members/3' }],
});
const failedHealth = { recentFailures: [{ id: 19, channel: 'email', status: 'failed', destination_hint: 'q***@example.test' }], recentDeliveries: [] };
const emptyHealth = { recentFailures: [], recentDeliveries: [] };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function mockBoundary(page: Page) {
  const unexpectedMutations: string[] = [];
  // Every API request is fulfilled locally, including unexpected mutations.
  // No test request can reach a backend or provider through the rewrite.
  await page.route('**/api/**', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      unexpectedMutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Unexpected local test mutation' } });
    }
    return route.fulfill({ json: {} });
  });
  await installAppShellMocks(page);
  return unexpectedMutations;
}

async function viewportEvidence(page: Page) {
  await expectNoHorizontalOverflow(page);
  const size = page.viewportSize()!;
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale, zoom: getComputedStyle(document.documentElement).zoom })))
    .toEqual({ ...size, scale: 1, zoom: '1' });
}

test('unknown health, safe keyboard read retry, stale activity and genuine empty feedback', async ({ page, audit }, testInfo) => {
  const unexpected = await mockBoundary(page);
  let health: 'error' | 'failed' | 'empty' = 'error';
  const healthMethods: string[] = [];
  await page.route('**/api/support/notification-settings', route => route.fulfill({ json: seed() }));
  await page.route('**/api/support/notification-health', route => {
    healthMethods.push(route.request().method());
    return route.fulfill(health === 'error' ? { status: 503, json: { error: 'Mock health unavailable' } }
      : { json: health === 'failed' ? failedHealth : emptyHealth });
  });
  await page.goto('/dashboard/support/notifications');
  const region = page.getByRole('region', { name: 'Delivery health' });
  await expect(region.getByText('Status unknown', { exact: true })).toBeVisible();
  await expect(region.getByRole('alert')).toContainText('Current health is unknown');
  await expect(region.getByText('0 issues', { exact: true })).toHaveCount(0);
  await region.getByRole('button', { name: /Delivery activity/ }).click();
  await expect(region.getByText('No failed deliveries.', { exact: true })).toHaveCount(0);
  await expect(region.getByText('No delivery activity yet.', { exact: true })).toHaveCount(0);
  await viewportEvidence(page);
  await page.screenshot({ path: testInfo.outputPath('health-unavailable.png'), fullPage: true });
  const initialHealthReads = healthMethods.length; // Development Strict Mode may read on both mounts.
  health = 'failed';
  const retryRead = region.getByRole('button', { name: 'Retry status read' });
  await retryRead.focus();
  await expect(retryRead).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(region.getByText('1 issues', { exact: true })).toBeVisible();
  await expect(region.getByRole('button', { name: 'Retry delivery 19' })).toBeEnabled();
  health = 'error';
  await region.getByRole('button', { name: 'Refresh delivery status' }).click();
  await expect(region.getByText('1 issues · stale', { exact: true })).toBeVisible();
  await expect(region.getByRole('alert')).toContainText('Showing stale activity; current health is unknown');
  await expect(region.getByRole('button', { name: 'Retry delivery 19' })).toBeDisabled();
  await viewportEvidence(page);
  await page.screenshot({ path: testInfo.outputPath('health-stale.png'), fullPage: true });
  health = 'empty';
  await region.getByRole('button', { name: 'Retry status read' }).click();
  await expect(region.getByText('0 issues', { exact: true })).toBeVisible();
  await expect(region.getByText('No failed deliveries.', { exact: true })).toBeVisible();
  await expect(region.getByText('No delivery activity yet.', { exact: true })).toBeVisible();
  await expect(region.getByRole('status')).toContainText('Delivery status loaded');
  expect(healthMethods.every(method => method === 'GET')).toBe(true);
  expect(healthMethods.slice(initialHealthReads)).toEqual(['GET', 'GET', 'GET']);
  expect(unexpected).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});

test('mocked sync and delivery retry keep drafts, including edits during refresh and save', async ({ page, audit }, testInfo) => {
  const unexpected = await mockBoundary(page);
  let settings = seed();
  const refresh = gate();
  const save = gate();
  let pauseRefresh = false;
  let pauseSave = false;
  let rejectSave = true;
  let refreshReads = 0;
  const effects: string[] = [];
  await page.route('**/api/support/notification-settings', async route => {
    if (pauseRefresh) { refreshReads++; await refresh.promise; }
    await route.fulfill({ json: settings });
  });
  await page.route('**/api/support/notification-health', route => route.fulfill({ json: failedHealth }));
  await page.route('**/api/whatsapp/templates/sync', route => {
    effects.push(`POST ${new URL(route.request().url()).pathname}`);
    pauseRefresh = true;
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/support/notification-deliveries/19/retry', route => {
    effects.push(`POST ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/support/notification-settings/email', async route => {
    if (rejectSave) return route.fulfill({ status: 503, json: { error: 'Mock save failure' } });
    const submitted = route.request().postDataJSON();
    if (pauseSave) await save.promise;
    settings = { ...settings, email: { ...settings.email, ...submitted } };
    await route.fulfill({ json: settings });
  });
  await page.goto('/dashboard/support/notifications');
  const subject = page.getByLabel('Subject', { exact: true });
  const message = page.getByLabel('Plain-text message', { exact: true });
  await subject.fill('Draft before sync');
  await message.fill('Message before sync');
  await page.getByRole('button', { name: 'Sync from Meta' }).click();
  await expect.poll(() => refreshReads).toBe(1);
  await expect(page.getByText('Refreshing notification settings. Unsaved drafts are kept.', { exact: true })).toBeVisible();
  await subject.fill('Draft during refresh');
  await message.fill('Message during refresh');
  refresh.release();
  await expect(page.getByRole('button', { name: 'Save email changes' })).toBeEnabled();
  await expect(subject).toHaveValue('Draft during refresh');
  await expect(message).toHaveValue('Message during refresh');
  await page.getByRole('button', { name: /Delivery activity/ }).click();
  await page.getByRole('button', { name: 'Retry delivery 19' }).click();
  await expect(page.getByText('Notification retry queued', { exact: true })).toBeVisible();
  await expect(subject).toHaveValue('Draft during refresh');
  await expect(message).toHaveValue('Message during refresh');
  expect(refreshReads).toBe(1); // Delivery retry only refreshes health.
  await page.getByRole('button', { name: 'Save email changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Your draft is kept; try saving again.' })).toBeVisible();
  await expect(subject).toHaveValue('Draft during refresh');
  rejectSave = false;
  pauseSave = true;
  await page.getByRole('button', { name: 'Save email changes' }).click();
  await expect(page.getByRole('button', { name: 'Save email changes' })).toBeDisabled();
  await subject.fill('Edited during save');
  await message.fill('Message during save');
  save.release();
  await expect(page.getByText('Email settings saved. Newer edits remain unsaved.', { exact: true })).toBeVisible();
  await expect(subject).toHaveValue('Edited during save');
  await expect(message).toHaveValue('Message during save');
  await page.getByRole('button', { name: 'Discard email changes' }).click();
  await expect(subject).toHaveValue('Draft during refresh');
  await expect(message).toHaveValue('Message during refresh');
  await expect(page.getByText('Email draft discarded. Latest loaded settings restored.', { exact: true })).toBeVisible();
  await viewportEvidence(page);
  await page.screenshot({ path: testInfo.outputPath('draft-save-discard.png'), fullPage: true });
  expect(effects).toEqual(['POST /api/whatsapp/templates/sync', 'POST /api/support/notification-deliveries/19/retry']);
  expect(unexpected).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});

test('workspace switch clears drafts and ignores a late old-workspace save', async ({ page, audit }, testInfo) => {
  const unexpected = await mockBoundary(page);
  const oldSave = gate();
  let savedProfile: string | undefined;
  let saving = false;
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [
    { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
    { id: 4112, name: 'Second QA Business', companyName: 'Second QA Company', role: 'owner' },
  ] }));
  await page.route('**/api/support/notification-health', route => route.fulfill({ json: emptyHealth }));
  await page.route('**/api/support/notification-settings', route => {
    const second = route.request().headers()['x-business-profile-id'] === '4112';
    const settings = seed();
    settings.email.subject = second ? 'Second workspace saved subject' : 'First workspace saved subject';
    return route.fulfill({ json: settings });
  });
  await page.route('**/api/support/notification-settings/email', async route => {
    savedProfile = route.request().headers()['x-business-profile-id'];
    saving = true;
    await oldSave.promise;
    const settings = seed();
    settings.email.subject = 'Private first workspace draft';
    await route.fulfill({ json: settings });
  });
  await page.goto('/dashboard/support/notifications');
  const subject = page.getByLabel('Subject', { exact: true });
  await subject.fill('Private first workspace draft');
  await page.getByRole('button', { name: 'Save email changes' }).click();
  await expect.poll(() => saving).toBe(true);
  // Exercise the real selection subscription in the same document so pending
  // requests can finish. Normal chooser navigation also tears down the page.
  await page.evaluate(() => {
    sessionStorage.setItem('active-business-profile:4101', '4112');
    window.dispatchEvent(new Event('business-profile-changed'));
  });
  await expect(subject).toHaveValue('Second workspace saved subject');
  const completedOldSave = page.waitForResponse(response => response.url().endsWith('/api/support/notification-settings/email'));
  oldSave.release();
  await completedOldSave;
  await expect(page.getByRole('button', { name: 'Save email changes' })).toBeEnabled();
  await expect(subject).toHaveValue('Second workspace saved subject');
  await expect(page.getByText('Email settings saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Email notifications enabled', { exact: true })).toHaveCount(0);
  expect(savedProfile).toBe('4102');
  await viewportEvidence(page);
  await page.screenshot({ path: testInfo.outputPath('workspace-isolation.png'), fullPage: true });
  expect(unexpected).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});

test('unavailable template blocks enable with accessible recovery while disable stays available', async ({ page, audit }, testInfo) => {
  const unexpected = await mockBoundary(page);
  const approved = { id: 71, name: 'support_ticket_assignment', language: 'en_US', body: 'Ticket {{1}}', compatible: true, reasons: [], parameterCount: 7 };
  let settings = { ...seed(), whatsapp: { ...seed().whatsapp, templateId: 72,
    templates: [approved, { ...approved, id: 72, name: 'unavailable_assignment', compatible: false }] } };
  const writes: Array<{ method: string; enabled: boolean; whatsappTemplateId: number }> = [];
  await page.route('**/api/support/notification-health', route => route.fulfill({ json: emptyHealth }));
  await page.route('**/api/support/notification-settings', route => route.fulfill({ json: settings }));
  await page.route('**/api/support/notification-settings/whatsapp', route => {
    const body = route.request().postDataJSON();
    writes.push({ method: route.request().method(), enabled: body.enabled, whatsappTemplateId: body.whatsappTemplateId });
    if (body.enabled && !settings.whatsapp.templates.some(template => template.id === body.whatsappTemplateId && template.compatible && template.parameterCount === 7)) {
      return route.fulfill({ status: 400, json: { error: 'Mock server template validation rejects this selection' } });
    }
    settings = { ...settings, whatsapp: { ...settings.whatsapp, enabled: body.enabled, templateId: body.whatsappTemplateId } };
    return route.fulfill({ json: settings });
  });
  await page.goto('/dashboard/support/notifications');
  const enable = page.getByRole('switch', { name: 'Enable WhatsApp notifications' });
  await expect(enable).toBeDisabled();
  await expect(enable).toHaveAccessibleDescription(/Choose an available approved support ticket template before enabling or saving WhatsApp notifications/);
  await expect(page.getByLabel('Message template')).toHaveValue('72');
  await expect(page.locator('#support-whatsapp-template-guidance')).toHaveAttribute('role', 'status');
  await expect(page.locator('#support-whatsapp-template-guidance')).toBeVisible();
  expect(writes).toEqual([]);
  await page.locator('#support-whatsapp-template-guidance').scrollIntoViewIfNeeded();
  await expect(page.locator('#support-whatsapp-template-guidance')).toBeInViewport();
  await expect(enable).toBeInViewport();
  await viewportEvidence(page);
  await page.screenshot({ path: testInfo.outputPath('template-enable-blocked.png'), fullPage: true });

  await page.getByLabel('Message template').selectOption('71');
  await expect(enable).toBeEnabled();
  await enable.focus();
  await expect(enable).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('switch', { name: 'Disable WhatsApp notifications' })).toBeChecked();
  expect(writes).toEqual([{ method: 'PUT', enabled: true, whatsappTemplateId: 71 }]);

  // The channel is now enabled only in the local mock. Make the selected
  // template/provider unavailable and verify that disabling still works.
  settings = { ...settings, whatsapp: { ...settings.whatsapp, templates: [], providerState: 'not_connected' } };
  await page.getByRole('button', { name: 'Refresh settings' }).click();
  const disable = page.getByRole('switch', { name: 'Disable WhatsApp notifications' });
  await expect(page.locator('#support-whatsapp-template-guidance')).toContainText('You can still disable WhatsApp notifications.');
  await expect(disable).toBeEnabled();
  await page.locator('#support-whatsapp-template-guidance').scrollIntoViewIfNeeded();
  await expect(page.locator('#support-whatsapp-template-guidance')).toBeInViewport();
  await expect(disable).toBeInViewport();
  await viewportEvidence(page);
  await page.screenshot({ path: testInfo.outputPath('template-disable-available.png'), fullPage: true });
  await disable.focus();
  await page.keyboard.press('Space');
  await expect(enable).not.toBeChecked();
  await expect(enable).toBeDisabled();
  expect(writes).toEqual([{ method: 'PUT', enabled: true, whatsappTemplateId: 71 }, { method: 'PUT', enabled: false, whatsappTemplateId: 71 }]);
  expect(unexpected).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
