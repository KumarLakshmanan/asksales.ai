import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { Page } from '@playwright/test';
import { captureMSG91Page } from './fixtures/msg91-screenshots';

const providers = [
  ['instagram', 'Instagram', 'Continue with Instagram'], ['whatsapp', 'WhatsApp', 'Connect WhatsApp Business'],
  ['facebook', 'Facebook', 'Continue with Facebook'], ['email', 'Email', 'Connect Gmail'],
  ['meta', 'Meta Ads', 'Connect Meta Ads'], ['google-ads', 'Google Ads', 'Connect with Google'],
  ['msg91', 'SMS', 'Set up SMS'], ['youtube', 'YouTube', 'Continue with Google'],
] as const;

async function mockConnections(page: Page, connected = false) {
  const state = { connected, selection: false, unavailable: false, denied: false, selectedId: 1, mutations: [] as string[] };
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test' }));
    sessionStorage.setItem('active-business-profile:4101', '11');
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/settings/business-profiles') return reply([{ id: 11, name: 'Orchid Studio', isDefault: true }]);
    if (path.includes('csrf')) return reply({ csrfToken: 'fixture-csrf' });
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) return route.fallback();
    if (path.endsWith('/authorize') && /instagram|facebook/.test(path)) return reply({ error: 'The shared Meta app is unavailable. Contact support.' }, 503);
    if (/\/(instagram|facebook)\/oauth\/status$/.test(path)) {
      if (state.unavailable) return reply({ error: 'Could not check the provider connection' }, 503);
      const instagram = path.includes('instagram');
      return reply({ officialApi: { connected: state.connected && !state.selection && !state.denied, authorized: state.connected,
        selectionRequired: state.selection, username: state.connected ? instagram ? 'orchidstudio' : 'Orchid Studio' : null,
        pageId: state.connected ? 'page-1' : null, instagramAccountId: state.connected ? 'ig-1' : null, credentialId: state.connected ? state.selectedId : null,
        tokenExpired: false, expiresAt: '2099-01-01T00:00:00Z', pageName: 'Orchid Studio', followersCount: state.connected ? 240 : null,
        grantedScopes: state.denied ? [] : ['pages_messaging', 'instagram_manage_messages'], webhookSubscribed: state.connected,
        capabilities: [], }, webhookUrl: '', webhookVerifyToken: '' });
    }
    if (/\/channel-accounts\/(instagram_api|facebook_api)$/.test(path)) return reply(state.connected ? [
      { id: 1, accountIdentifier: 'account-1', accountName: 'Orchid Studio', pageId: 'page-1', isSelected: !state.selection && state.selectedId === 1 },
      { id: 2, accountIdentifier: 'account-2', accountName: 'Orchid Store', pageId: 'page-2', isSelected: !state.selection && state.selectedId === 2 },
    ] : []);
    if (path.endsWith('/select')) { state.selection = false; state.selectedId = route.request().postDataJSON().credentialId; state.mutations.push(path); return reply({ success: true }); }
    if (path.endsWith('/disconnect')) { state.connected = false; state.mutations.push(path); return reply({ success: true }); }
    if (path === '/api/whatsapp/config') return reply({ success: true, configured: state.connected, enabled: true, config: state.connected ? { verifiedName: 'Orchid Studio', displayPhoneNumber: '+91 90000 00000', phoneNumberId: 'phone-1', businessAccountId: 'business-1', connectionStatus: 'ready', tokenStatus: 'active' } : null });
    if (path === '/api/gmail/oauth/status') return reply({ connected: state.connected, email: state.connected ? 'hello@orchid.test' : null, hasConfig: true });
    if (path === '/api/resend/domains') return reply({ domains: [] });
    if (path === '/api/email-senders') return reply({ senders: [] });
    if (path === '/api/meta/oauth/platforms') return reply({ platforms: state.connected ? [{ id: 1, platform: 'meta', isActive: true, accountName: 'Orchid Ads', adAccountId: '100', pageId: 'page-1', connectedAt: '2026-09-01' }] : [] });
    if (path === '/api/meta/oauth/selection') return reply({ adAccounts: [{ id: '100', name: 'Orchid Ads' }], pages: [{ id: 'page-1', name: 'Orchid Studio' }], selectedAdAccountId: '100', selectedPageId: 'page-1' });
    if (path === '/api/integrations/google-ads/config') return reply({ success: true, config: state.connected ? { ready: true, providerConfigured: true, hasRefreshToken: true, connectedViaOAuth: true, customerId: '1234567890' } : null, providerConfigured: true });
    if (path === '/api/integrations/google-ads/accounts') return reply({ accounts: state.connected ? [{ customerId: '1234567890', name: 'Orchid Ads', manager: false }] : [] });
    if (path === '/api/msg91-settings') return reply({ success: true, configured: state.connected, connected: state.connected, settings: state.connected ? { hasAuthKey: true, senderId: 'ORCHID', flowId: 'flow_1', messageVariable: 'message', connectionStatus: 'ready' } : null });
    if (path === '/api/webhooks/config') return reply({ success: true, webhooks: { sms: { url: 'https://app.example.test/api/webhooks/sms/fixture', deliveryUrl: 'https://app.example.test/api/webhooks/sms/fixture/delivery' } } });
    if (path === '/api/youtube/oauth/status') return reply({ connected: state.connected, channelName: state.connected ? 'Orchid Video' : null, channelId: state.connected ? 'channel-1' : null, readiness: state.connected ? 'ready' : 'disconnected' });
    if (path === '/api/channel-accounts/youtube') return reply(state.connected ? [{ id: 1, accountIdentifier: 'channel-1', accountName: 'Orchid Video', isSelected: true }] : []);
    if (path === '/api/youtube/manage/readiness') return reply({ ready: state.connected, capabilities: {}, limitations: [] });
    if (/^\/api\/instagram\/automations\/[^/]+\/readiness$/.test(path)) return reply({ success: true, data: {
      authorized: state.connected, enabled: false, messages: false, comments: false,
      profile: false, richMessages: false, reasons: ['Live automation access awaits administrator setup.'],
      checks: [{ id: 'connection', title: 'Account authorization', ready: state.connected,
        action: state.connected ? null : 'reconnect' }],
    } });
    return reply({ success: true });
  });
  return state;
}

test('overview has eight cards and flat sidebar links', async ({ page }, testInfo) => {
  await mockConnections(page, true);
  await page.goto('/dashboard/integrations');
  await expect(page.getByRole('heading', { name: 'All Integrations' })).toBeVisible();
  await expect(page.getByText('8 / 8 integrations connected')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'SMS', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'YouTube', exact: true })).toBeVisible();
  const showSidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
  const sidebarWasHidden = await showSidebar.isVisible();
  if (sidebarWasHidden) await showSidebar.click();
  const section = page.getByRole('region', { name: 'Integrations', exact: true });
  await expect(section).toHaveCount(1);
  expect(await section.locator('details, summary').count()).toBe(0);
  for (const [, name] of providers) await expect(section.getByRole('link', { name, exact: true })).toHaveCount(1);
  if (sidebarWasHidden) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'integrations-overview');
  await page.getByRole('heading', { name: 'SMS', exact: true }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'integrations-sms-card');
});

test('all eight providers render disconnected and connected layouts', async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const state = await mockConnections(page);
  for (const [id, name, action] of providers) {
    state.connected = false;
    await page.goto(`/dashboard/integrations/${id}`, { waitUntil: 'domcontentloaded' });
    const connection = page.getByRole('region', { name: `${name} connection`, exact: true });
    await expect(connection.getByRole('heading', { name: `Connect ${name}`, exact: true })).toBeVisible();
    await expect(connection.getByRole('button', { name: action, exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (id === 'instagram') await page.screenshot({ path: testInfo.outputPath('instagram-disconnected.png'), fullPage: true });
    state.connected = true;
    await page.reload();
    await expect(connection.getByText('Connected', { exact: true }).first()).toBeVisible();
    await expect(connection.getByRole('button', { name: 'Disconnect', exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (id === 'instagram') await page.screenshot({ path: testInfo.outputPath('instagram-connected.png'), fullPage: true });
  }
});

test('Instagram selection and disconnect are explicit and independent', async ({ page }) => {
  const state = await mockConnections(page, true);
  state.selection = true;
  await page.goto('/dashboard/integrations/instagram');
  const connection = page.getByRole('region', { name: 'Instagram connection' });
  await expect(connection.getByText('Choose account', { exact: true })).toBeVisible();
  await connection.getByRole('button', { name: 'Choose', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose an Instagram profile' });
  await expect(dialog.getByText('Linked Facebook Page: page-2')).toBeVisible();
  await dialog.getByRole('radio', { name: /Orchid Store/ }).click();
  await dialog.getByRole('button', { name: 'Use this profile' }).click();
  await expect(connection.getByText('Connected', { exact: true })).toBeVisible();
  await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Your Facebook Page and Meta Ads connections stay connected');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(connection.getByRole('heading', { name: 'Connect Instagram' })).toBeVisible();
  expect(state.mutations).toEqual(['/api/channel-accounts/instagram_api/select', '/api/instagram/oauth/disconnect']);
});

test('load failures and denied permissions never look connected', async ({ page }) => {
  const state = await mockConnections(page, true);
  state.unavailable = true;
  await page.goto('/dashboard/integrations/facebook');
  const connection = page.getByRole('region', { name: 'Facebook connection' });
  await expect(connection.getByText('Status unavailable', { exact: true })).toBeVisible();
  state.unavailable = false; state.denied = true;
  await connection.getByRole('button', { name: 'Try again' }).click();
  await expect(connection.getByText('Action required', { exact: true })).toBeVisible();
  await expect(connection).toContainText('Messaging permission was not granted');
  await connection.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByText('The shared Meta app is unavailable. Contact support.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/facebook$/);
});


test('direct Instagram login supports an account without a Facebook Page', async ({ page }, testInfo) => {
  const state = await mockConnections(page);
  await page.goto('/dashboard/integrations/instagram');
  const connection = page.getByRole('region', { name: 'Instagram connection' });
  await expect(connection.getByRole('button', { name: 'Continue with Instagram', exact: true })).toBeVisible();
  await expect(connection).toContainText('No Facebook Page is required');
  await expect(connection).toContainText('Business or Creator');
  state.connected = true;
  await page.route('**/api/instagram/oauth/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ officialApi: {
    connected: true, authorized: true, username: 'orchidstudio', instagramAccountId: 'ig-1', credentialId: 1,
    loginMethod: 'instagram', pageId: null, pageName: null, tokenExpired: false, expiresAt: null, webhookSubscribed: true,
    grantedScopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
  } }) }));
  await page.route('**/api/channel-accounts/instagram_api', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: 1, accountIdentifier: 'ig-1', accountName: 'orchidstudio', pageId: null, isSelected: true },
  ]) }));
  await page.reload();
  await expect(connection.getByText('Connected', { exact: true })).toBeVisible();
  await expect(connection.getByRole('button', { name: 'Reconnect with Instagram', exact: true })).toBeVisible();
  await expect(connection.getByText('Linked Facebook Page', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('instagram-direct-login.png'), fullPage: true });
});

test('ordinary customers start Facebook Login with clear Page requirements', async ({ page }) => {
  await mockConnections(page);
  await page.goto('/dashboard/integrations/facebook');
  const connection = page.getByRole('region', { name: 'Facebook connection' });
  await expect(connection.getByRole('button', { name: 'Continue with Facebook', exact: true })).toBeVisible();
  await expect(connection).toContainText('Sign in with your Facebook account');
  await expect(connection).toContainText('personal profile inboxes are not supported');
  await expectNoHorizontalOverflow(page);
});
