import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

test('saved email readiness survives a cancelled contact edit and fresh navigation with an unavailable provider', async ({ page, audit }) => {
  const settings = {
    email: { enabled: false, providerState: 'provider_unavailable', subject: '{{ticket_number}}', text: '{{ticket_url}}',
      preview: { subject: 'Ticket', text: 'Ticket', html: '<p>Ticket</p>' } },
    whatsapp: { enabled: false, providerState: 'not_connected', templates: [] },
    recipients: [{ memberId: 3, memberName: 'Support QA', teamName: 'Billing', active: true,
      emailReady: true, emailHint: 'su********@example.test', whatsappReady: false, whatsappHint: null,
      memberProfileUrl: '/dashboard/support/teams/1/members/3' }],
  };
  const mutations: string[] = [];
  let reads = 0;
  // Fulfill all API requests locally, including unexpected mutations; this test
  // never reaches a backend, contact store, or notification provider.
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Read-only contact regression' } });
    }
    return route.fulfill({ json: {} });
  });
  await installAppShellMocks(page);
  await page.routeWebSocket('**/api/agents/progress**', () => {});
  await page.route('**/api/support/notification-settings', route => {
    reads++;
    return route.fulfill({ json: settings });
  });
  await page.route('**/api/support/notification-health', route => route.fulfill({ json: { recentFailures: [], recentDeliveries: [] } }));
  await page.route('**/api/support/teams/1', route => route.fulfill({ json: {
    id: 1, name: 'Billing', color: '#3B82F6', members: [{ id: 3, teamId: 1, name: 'Support QA',
      email: 'support.qa@example.test', role: 'member', isActive: true }],
  } }));
  await page.route('**/api/support/teams/1/members/3/tickets', route => route.fulfill({ json: [] }));

  await page.goto('/dashboard/support/notifications');
  const recipient = page.getByRole('row').filter({ hasText: 'Support QA' });
  await expect(recipient.getByText('su********@example.test', { exact: true })).toBeVisible();
  await expect(recipient.getByText('Missing email')).toHaveCount(0);
  await expect(recipient.getByText('Missing WhatsApp', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Enable Email notifications' })).toBeDisabled();
  await recipient.getByRole('link', { name: 'Add missing contact' }).click();
  await page.getByRole('button', { name: 'Notification contact', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Support login email')).toHaveValue('support.qa@example.test');
  await expect(dialog.getByText('Current destination: su********@example.test', { exact: true })).toBeVisible();
  await dialog.getByLabel('Support login email').fill('unsaved@example.test');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Notification contact', exact: true }).click();
  await expect(dialog.getByLabel('Support login email')).toHaveValue('support.qa@example.test');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto('/dashboard/support/notifications');
  await expect(recipient.getByText('su********@example.test', { exact: true })).toBeVisible();
  await page.reload();
  await expect(recipient.getByText('su********@example.test', { exact: true })).toBeVisible();
  await expect(recipient.getByText('Missing email')).toHaveCount(0);
  expect(reads).toBeGreaterThanOrEqual(4);
  expect(mutations).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});

test('global assignment notifications save independently, survive reload, and recover from a failed save', async ({ page, audit }) => {
  let settings = {
    email: { enabled: false, providerState: 'available', subject: '{{event_title}} · {{ticket_number}}',
      text: 'Review {{ticket_number}}: {{ticket_url}}', preview: { subject: 'Ticket assignment', text: 'Review ticket', html: '<p>Review ticket</p>' } },
    whatsapp: { enabled: false, providerState: 'connected', templateId: null as number | null,
      templates: [{ id: 17, name: 'support_ticket_assignment_v1', language: 'en_US', body: 'Ticket {{1}} needs attention.', compatible: true, reasons: [], parameterCount: 7 }] },
    recipients: [{ memberId: 3, memberName: 'Support QA', teamName: 'Billing', active: true,
      emailReady: true, emailHint: 'q***@example.test', whatsappReady: true, whatsappHint: '+91 ******1234',
      memberProfileUrl: '/dashboard/support/teams/1/members/3' }],
  };
  const saves: Array<{ channel: string; enabled: boolean }> = [];
  let rejectEmail = false;
  await page.route('**/api/auth/csrf-token', route => route.fulfill({ json: { csrfToken: 'local-test' } }));
  await page.route('**/api/support/notification-health', route => route.fulfill({ json: { recentFailures: [], recentDeliveries: [] } }));
  await page.route('**/api/support/notification-settings', route => route.fulfill({ json: settings }));
  await page.route('**/api/support/notification-settings/*', async route => {
    const channel = route.request().url().split('/').at(-1)!;
    const body = route.request().postDataJSON();
    if (channel === 'email' && rejectEmail) return route.fulfill({ status: 503, json: { error: 'Temporary local test failure' } });
    saves.push({ channel, enabled: body.enabled });
    if (channel === 'email') settings = { ...settings, email: { ...settings.email, ...body } };
    if (channel === 'whatsapp') settings = { ...settings, whatsapp: { ...settings.whatsapp, enabled: body.enabled, templateId: body.whatsappTemplateId } };
    await route.fulfill({ json: settings });
  });

  await page.goto('/dashboard/support/notifications');
  await expect(page.getByRole('heading', { name: 'Support notifications', exact: true })).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(2);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Enable Email notifications' }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toBeVisible();
  await page.getByLabel('Subject', { exact: true }).fill('Assigned: {{ticket_number}}');
  await page.getByRole('button', { name: 'Save email changes', exact: true }).click();
  await expect(page.getByText('Assigned: TKT-1042', { exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Enable WhatsApp notifications' }).click();
  await expect(page.getByLabel('Message template')).toHaveValue('17');
  await expect(page.getByRole('switch')).toHaveCount(2);
  await expect(page.getByRole('textbox')).toHaveCount(2);
  await expect(page.getByText('+91 ******1234', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Disable Email notifications' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Disable WhatsApp notifications' })).toBeChecked();
  rejectEmail = true;
  await page.getByRole('switch', { name: 'Disable Email notifications' }).click();
  await expect(page.getByText('Unable to save email notifications', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Disable Email notifications' })).toBeChecked();
  rejectEmail = false;
  await page.getByRole('switch', { name: 'Disable Email notifications' }).click();
  await expect(page.getByRole('switch', { name: 'Enable Email notifications' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Disable WhatsApp notifications' })).toBeChecked();
  expect(saves.map(item => `${item.channel}:${item.enabled}`)).toEqual(['email:true', 'email:true', 'whatsapp:true', 'email:false']);
  expect(audit.blockedMutations).toEqual([]);
});
