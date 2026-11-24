import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { captureMSG91Page } from './fixtures/msg91-screenshots';
import type { Page } from '@playwright/test';
import type { InboxItem } from '../../shared/outreachInbox';

async function mockSMSWorkflows(page: Page) {
  const state = {
    connected: true,
    failSend: false,
    mutations: [] as Array<{ path: string; body: Record<string, unknown> }>,
    unexpected: [] as string[],
  };
  const item: InboxItem = {
    key: 'conversation:9', kind: 'conversation', id: 9, channel: 'sms', leadId: 1,
    leadName: 'Ada Lovelace', leadEmail: 'ada@example.test', leadPhone: '919876543210',
    leadCompany: 'Analytical Engines', leadAvatar: null, recipient: '919876543210',
    subject: null, preview: 'Please send the proposal update.', activityAt: '2026-10-02T09:00:00Z',
    unreadCount: 1, totalMessages: 1, status: 'active', integrationProvider: 'msg91',
    reply: { canReply: true, reason: null, accountLabel: 'MSG91 · ORCHID', providerAccountId: 'ORCHID' },
  };
  const conversation = {
    ...item, userId: 4101, providerAccountId: 'ORCHID', providerAccountName: 'ORCHID',
    threadKey: 'sms:1:ORCHID', lastMessageAt: item.activityAt, lastMessageBy: 'lead',
    lastMessagePreview: item.preview,
  };
  const messages: Array<Record<string, unknown>> = [{
    id: 90, conversationId: 9, direction: 'inbound', content: item.preview,
    status: 'delivered', createdAt: item.activityAt, sentAt: item.activityAt,
    deliveredAt: item.activityAt, readAt: null, isRead: false,
  }];
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test' }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (/csrf/.test(path)) return reply({ csrfToken: 'msg91-workflow-csrf' });
    if (path === '/api/settings/integrations/sms/follow-ups') return reply({ enableAutoFollowUp: false, followUpSteps: [] });
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|organizations|wallet|chat\/threads|notifications\/unread\/count|crm\/configuration)$/.test(path)) return route.fallback();
    if (path === '/api/msg91-settings') return reply({ success: true, configured: state.connected, connected: state.connected,
      settings: state.connected ? { senderId: 'ORCHID', flowId: 'template-42', messageVariable: 'message', hasAuthKey: true, connectionStatus: 'ready' } : null });
    if (path === '/api/webhooks/config') return reply({ success: true, webhooks: { sms: {
      url: 'https://app.example.test/api/webhooks/sms/fixture-token', deliveryUrl: 'https://app.example.test/api/webhooks/sms/fixture-token/delivery',
    } } });
    if (/^\/api\/outreach-conversations\/unread(?:\/counts)?$/.test(path)) return reply({ sms: item.unreadCount, total: item.unreadCount });
    if (path === '/api/outreach-conversations/sms') return reply({ conversations: [conversation], unreadCount: item.unreadCount, pagination: { hasMore: false } });
    if (!state.connected) {
      item.reply.canReply = false;
      item.reply.reason = 'Reconnect your verified MSG91 sender to reply.';
    }
    if (path === '/api/outreach-conversations/inbox') return reply({ items: [item], nextCursor: null,
      unreadThreads: { all: item.unreadCount, sms: item.unreadCount, email: 0, whatsapp: 0, instagram: 0, facebook: 0 } });
    if (path === '/api/outreach-conversations/inbox/conversation/9') return reply({ item });
    if (path === '/api/outreach-conversations/sms/9/messages') {
      if (request.method() === 'GET') {
        item.unreadCount = 0;
        return reply({ conversation, messages });
      }
      const body = request.postDataJSON();
      state.mutations.push({ path, body });
      if (state.failSend) return reply({ error: 'MSG91 is temporarily unavailable. Your draft is saved.' }, 503);
      messages.push({ id: 91, conversationId: 9, direction: 'outbound', content: body.content, status: 'sent', createdAt: '2026-10-02T09:05:00Z', isRead: true });
      return reply({ success: true });
    }
    if (path.endsWith('/compose/options')) return reply({ channel: 'sms', accounts: state.connected ? [
      { id: 'msg91-42', label: 'MSG91 - ORCHID', providerAccountId: 'ORCHID', isDefault: true, ready: true, reason: null },
    ] : [] });
    if (path.endsWith('/compose/recipients')) return reply({ recipients: [{
      id: 1, name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical Engines',
      email: 'ada@example.test', phone: '919876543210', recipient: '919876543210', eligible: true, reason: null,
    }], nextCursor: null });
    if (path === '/api/outreach-conversations/compose/contact') return reply({ leadId: 1 });
    if (path === '/api/content/assets/17') return reply({ id: 17, type: 'sms', title: 'Proposal update', content: 'Hello {{first_name}}, your proposal is ready.' });
    if (path === '/api/content/assets' || path.includes('/content/templates')) return reply([]);
    if (path === '/api/crm/contacts/42') return reply({
      id: 42, leadId: 1, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', phone: '919876543210',
      company: 'Analytical Engines', role: 'Director', status: 'active', pipelineStatus: 'new', priority: 'medium',
      source: 'manual', currency: 'INR', dealValue: '75000', tags: ['proposal'], totalOutreachSent: 1,
      createdAt: '2026-09-01T09:00:00Z', updatedAt: '2026-10-02T09:00:00Z',
    });
    if (path === '/api/crm/contacts/42/workspace-summary') return reply({});
    if (path === '/api/crm/contacts/42/timeline') return reply({ data: [], pagination: { page: 1, limit: 20, total: 0, hasMore: false } });
    if (path === '/api/crm/assignees' || path === '/api/crm/reminders') return reply([]);
    if (path === '/api/crm/contacts/42/activities' || path === '/api/proposals/related') return reply([]);
    if (path === '/api/crm/contacts/42/conversations') return reply({ conversations: [], sentMessages: [] });
    if (path === '/api/crm/contacts/42/tickets') return reply({ tickets: [] });
    state.unexpected.push(`${request.method()} ${path}`);
    return reply({ error: `Unexpected SMS workflow request: ${path}` }, 404);
  });
  return state;
}

test('SMS inbox replies preserve the original sender, recipient and draft through a retry', async ({ page }, testInfo) => {
  const state = await mockSMSWorkflows(page);
  await page.goto('/dashboard/outreach/inbox');
  await page.getByRole('group', { name: 'Filter by channel' }).getByRole('button', { name: /^SMS(?:\s*\d+)?$/ }).click();
  await expect(page.getByRole('button', { name: 'Open Ada Lovelace on SMS' })).toBeVisible();
  await captureMSG91Page(page, testInfo, 'sms-inbox-list');
  await page.getByRole('button', { name: 'Open Ada Lovelace on SMS' }).click();
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  await expect(selected.getByText('MSG91 · ORCHID', { exact: true })).toBeVisible();
  await expect(selected.getByText('919876543210', { exact: true })).toBeVisible();
  await expect(selected.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  state.failSend = true;
  await selected.getByRole('textbox', { name: 'Message', exact: true }).fill('Your revised proposal is ready.');
  await expect(selected.getByLabel('SMS reply length')).toContainText('GSM-7 · 1 segment');
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(selected.getByRole('alert')).toContainText('MSG91 is temporarily unavailable');
  await expect(selected.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Your revised proposal is ready.');
  state.failSend = false;
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(selected.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(selected.getByText('Your revised proposal is ready.', { exact: true })).toBeVisible();
  expect(state.mutations).toHaveLength(2);
  for (const { body } of state.mutations) expect(body).toMatchObject({ expectedProviderAccountId: 'ORCHID', expectedRecipient: '919876543210', inboxContext: true });
  expect(state.mutations[1].body.idempotencyKey).toBe(state.mutations[0].body.idempotencyKey);
  expect(state.unexpected).toEqual([]);
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'sms-inbox-reply');
});

test('SMS channel preserves its conversation in the inbox and opens the shared composer', async ({ page }, testInfo) => {
  const state = await mockSMSWorkflows(page);
  await page.goto('/dashboard/outreach/sms?conversationId=9');
  await expect(page).toHaveURL(/\/dashboard\/outreach\/inbox\?channel=sms&thread=conversation%3A9/);
  await expect(page.getByText('Please send the proposal update.', { exact: true }).last()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'sms-outreach-conversation');
  const back = page.getByRole('button', { name: 'Back to inbox', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('link', { name: 'New outreach', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/outreach\/create\?channel=sms/);
  await expect(page.getByRole('heading', { name: 'New outreach', exact: true })).toBeVisible();
  await expect(page.getByLabel('Send from', { exact: true })).toContainText('MSG91 - ORCHID');
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('disconnected SMS inbox and composer link directly to MSG91 setup', async ({ page }, testInfo) => {
  const state = await mockSMSWorkflows(page);
  state.connected = false;
  await page.goto('/dashboard/outreach/sms?conversationId=9');
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  await expect(selected.getByText('Reconnect your verified MSG91 sender to reply.')).toBeVisible();
  await expect(selected.getByRole('link', { name: 'Manage connections' })).toHaveAttribute('href', '/dashboard/integrations/msg91');
  await expect(selected.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'sms-outreach-setup-required');
  await selected.getByRole('link', { name: 'Manage connections' }).click();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/msg91$/);
  await page.goto('/dashboard/outreach/create?channel=sms');
  await expect(page.getByRole('link', { name: 'Manage connections', exact: true })).toHaveAttribute('href', '/dashboard/integrations/msg91');
  await captureMSG91Page(page, testInfo, 'sms-composer-setup-required');
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('CRM contact handoff selects SMS and the correct recipient in the composer', async ({ page }, testInfo) => {
  const state = await mockSMSWorkflows(page);
  await page.goto('/dashboard/crm/contacts/42');
  await expect(page.getByRole('heading', { name: 'Ada Lovelace', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'crm-sms-contact');
  await page.getByRole('button', { name: 'Send outreach', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /SMS Personalized texts/ })).toBeVisible();
  await captureMSG91Page(page, testInfo, 'crm-sms-channel-choice');
  await page.getByRole('dialog').getByRole('button', { name: /SMS Personalized texts/ }).click();
  await expect(page).toHaveURL(/channel=sms&contactId=42&leadId=1/);
  await expect(page.getByLabel('Select Ada Lovelace')).toBeChecked();
  await expect(page.getByLabel('Send from', { exact: true })).toContainText('MSG91 - ORCHID');
  await page.getByLabel('Message body').fill('Hello {{first_name}}, your proposal is ready.');
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'crm-sms-composer');
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('legacy SMS library drafts retain their text and source in the shared composer', async ({ page }, testInfo) => {
  const state = await mockSMSWorkflows(page);
  await page.goto('/dashboard/outreach/sms/create?leadId=1&sourceAssetId=17');
  await expect(page).toHaveURL(/\/dashboard\/outreach\/create\?.*channel=sms/);
  await expect(page).toHaveURL(/sourceAssetId=17/);
  await expect(page.getByLabel('Select Ada Lovelace')).toBeChecked();
  await expect(page.getByLabel('Message body')).toHaveValue('Hello {{first_name}}, your proposal is ready.');
  await expect(page.getByLabel('Subject', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureMSG91Page(page, testInfo, 'sms-library-composer');
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
