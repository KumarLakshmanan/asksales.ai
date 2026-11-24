import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { Page } from '@playwright/test';
import type { MSG91SettingsResponse } from '../../shared/msg91';
import { captureMSG91Page } from './fixtures/msg91-screenshots';

async function mockSMS(page: Page, connected = false) {
  const state = {
    saved: { success: true, configured: connected, connected, settings: connected ? {
      senderId: 'ORCHID', flowId: 'template-42', messageVariable: 'message', hasAuthKey: true, connectionStatus: 'ready',
    } : null } as MSG91SettingsResponse,
    unavailable: false,
    callbacksUnavailable: false,
    mutations: [] as Array<{ path: string; body: Record<string, string> | null }>,
  };
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test' }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (endpoint.includes('csrf')) return reply({ csrfToken: 'fixture-csrf' });
    if (endpoint === '/api/msg91-settings' || endpoint === '/api/msg91-settings/test') {
      if (request.method() === 'GET') return state.unavailable ? reply({ error: 'SMS connection unavailable' }, 503) : reply(state.saved);
      const body = request.method() === 'DELETE' ? null : request.postDataJSON();
      state.mutations.push({ path: endpoint, body });
      if (request.method() === 'DELETE') state.saved = { success: true, configured: false, connected: false, settings: null };
      else if (endpoint === '/api/msg91-settings') state.saved = { success: true, configured: true, connected: true,
        settings: { senderId: body.senderId, flowId: body.flowId, messageVariable: body.messageVariable, hasAuthKey: true, connectionStatus: 'ready', lastVerifiedAt: '2026-09-29T06:00:00Z' } };
      return reply({ success: true });
    }
    if (endpoint === '/api/webhooks/config') return state.callbacksUnavailable ? reply({ error: 'Callback setup unavailable' }, 503) : reply({ success: true, webhooks: { sms: {
      url: 'https://app.example.test/api/webhooks/sms/fixture-token', deliveryUrl: 'https://app.example.test/api/webhooks/sms/fixture-token/delivery',
    } } });
    if (endpoint === '/api/integrations/msg91/webhook-events') return reply({ events: [
      { id: 1, event_type: 'sms_delivery_delivered', processed: true, signature_valid: true, created_at: '2026-09-29T06:00:00Z', payload: { status: 'delivered' } },
      { id: 2, event_type: 'sms_delivery_failed', processed: true, signature_valid: true, created_at: '2026-09-29T06:01:00Z', payload: { failureReason: 'Recipient unavailable' } },
    ] });
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|organizations|wallet|chat\/threads|notifications\/unread\/count)$/.test(endpoint)) return route.fallback();
    // Any unexpected request is fulfilled locally, including all send endpoints.
    return reply({ error: `Unexpected SMS test request: ${endpoint}` }, 404);
  });
  return state;
}

test('MSG91 setup verifies a draft, saves the sender, exposes callbacks, and disconnects', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state = await mockSMS(page);
  await page.goto('/dashboard/integrations/msg91');
  const connection = page.getByRole('region', { name: 'SMS connection' });
  await expect(connection.getByRole('heading', { name: 'Connect SMS', exact: true })).toBeVisible();
  await captureMSG91Page(page, testInfo, 'msg91-disconnected');
  await expect(page.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  await page.getByLabel('MSG91 Auth Key').fill('fixture-auth-key');
  await page.getByLabel('Approved Sender ID').fill('orchid');
  await page.getByLabel('SMS Template ID').fill('template-42');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  await expect(page.getByLabel('MSG91 Auth Key')).toHaveValue('fixture-auth-key');
  await expect(connection.getByText('Not connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(connection.getByText('Connected', { exact: true })).toBeVisible();
  await expect(connection.getByRole('heading', { name: 'ORCHID', exact: true })).toBeVisible();
  await expect(page.getByLabel('MSG91 Auth Key')).toHaveValue('');
  await expect(page.getByLabel('Delivery callback URL', { exact: true })).toHaveValue('https://app.example.test/api/webhooks/sms/fixture-token/delivery');
  await expect(page.getByLabel('Incoming SMS callback URL', { exact: true })).toHaveValue('https://app.example.test/api/webhooks/sms/fixture-token');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('heading', { name: 'SMS', exact: true }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-connected');
  await page.getByLabel('Approved Sender ID').scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-sender-settings');
  await page.getByRole('heading', { name: 'Delivery and replies' }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-callbacks');
  await page.getByLabel('Incoming SMS callback URL', { exact: true }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-incoming-callback');
  await page.getByRole('button', { name: 'Copy delivery callback URL' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://app.example.test/api/webhooks/sms/fixture-token/delivery');
  await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(connection.getByRole('heading', { name: 'Connect SMS', exact: true })).toBeVisible();
  expect(state.mutations.map(item => item.path)).toEqual(['/api/msg91-settings/test', '/api/msg91-settings', '/api/msg91-settings']);
});

test('MSG91 status failures block overwriting saved settings and the shared guide works on mobile', async ({ page }, testInfo) => {
  const state = await mockSMS(page, true);
  state.unavailable = true;
  await page.goto('/dashboard/integrations/msg91');
  await expect(page.getByRole('heading', { name: 'SMS status unavailable' })).toBeVisible();
  await captureMSG91Page(page, testInfo, 'msg91-status-error');
  await expect(page.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  state.unavailable = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ORCHID', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'How to connect' }).click();
  await expect(page.getByRole('heading', { name: 'How to connect MSG91 SMS' })).toBeVisible();
  await expect(page.getByText('Verify and save in AskSales', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'msg91-guide');
  await page.getByRole('button', { name: 'Open sender settings' }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-guide-finish');
  await page.getByRole('button', { name: 'Open sender settings' }).click();
  await expect(page.getByRole('heading', { name: 'How to connect MSG91 SMS' })).toHaveCount(0);
  await expect(page.getByLabel('Approved Sender ID')).toHaveValue('ORCHID');
  expect(state.mutations).toEqual([]);
});

test('MSG91 events use the shared activity view and show delivery failures', async ({ page }, testInfo) => {
  const state = await mockSMS(page, true);
  await page.goto('/dashboard/integrations/msg91/events');
  await expect(page.getByRole('heading', { name: 'Events and activity' })).toBeVisible();
  await expect(page.getByText('SMS delivered', { exact: true })).toBeVisible();
  await captureMSG91Page(page, testInfo, 'msg91-events-list');
  await page.getByRole('button', { name: /SMS delivery failed/ }).click();
  await expect(page.getByRole('complementary', { name: 'Activity details' }).getByText('Needs attention')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Activity details' })).toContainText('Recipient unavailable');
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'msg91-events');
  expect(state.mutations).toEqual([]);
});

test('MSG91 callback errors can be retried without changing the verified sender', async ({ page }, testInfo) => {
  const state = await mockSMS(page, true);
  state.callbacksUnavailable = true;
  await page.goto('/dashboard/integrations/msg91');
  await expect(page.getByRole('region', { name: 'Delivery and replies' }).getByRole('alert')).toContainText('Callback setup unavailable');
  state.callbacksUnavailable = false;
  await page.getByRole('button', { name: 'Retry callback setup' }).click();
  await expect(page.getByLabel('Delivery callback URL', { exact: true })).toHaveValue('https://app.example.test/api/webhooks/sms/fixture-token/delivery');
  await expect(page.getByRole('region', { name: 'SMS connection' }).getByRole('heading', { name: 'ORCHID', exact: true })).toBeVisible();
  await page.getByLabel('Delivery callback URL', { exact: true }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-callback-recovery');
  expect(state.mutations).toEqual([]);
});
