import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const date = '2026-10-03T08:00:00Z';
const session = { id: 41, title: 'Delivery question', memberName: 'Visitor', messageCount: 2, leadId: 71, leadInfo: { id: 71, name: 'Asha', email: 'asha@example.test', phone: null }, metadata: { source: 'widget', visitorName: 'Asha' }, createdAt: date, updatedAt: date };
const messages = [
  { id: 81, role: 'user', content: 'When will my order arrive?', createdAt: date },
  { id: 82, role: 'assistant', content: '**Delivery** takes three days.', sources: [{ title: 'Shipping policy', excerpt: 'Three business days.', similarity: 0.88 }], confidence: 0.88, createdAt: date },
];

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/settings\/outreach\/assistants(?:\?.*)?$/, route => route.fulfill({ json: { runtimeEnabled: false, assistants: [], nextCursor: null } }));
  await page.route('**/api/support/ai/sessions?*', route => route.fulfill({ json: { data: [{ ...session, metadata: { source: 'internal' } }], total: 1 } }));
  await page.route('**/api/support/ai/sessions/41', route => route.fulfill({ json: { ...session, messages } }));
  await page.route('**/api/support/ai/sessions/41/turns**', route => route.fulfill({ json: { turns: [] } }));
  await page.route('**/api/support/ai/report**', route => {
    const url = new URL(route.request().url());
    const current = Number(url.searchParams.get('sessionPage') || 1);
    return route.fulfill({ json: { sessions: [session], leads: [{ id: 71, name: 'Asha', email: 'asha@example.test', phone: null, source: 'support_widget', status: 'new', createdAt: date }], stats: { totalSessions: 26, widgetSessions: 20, totalMessages: 90, leadsGenerated: 1 }, pagination: { sessions: { page: current, limit: 25, total: 26, totalPages: 2 }, leads: { page: 1, limit: 25, total: 1, totalPages: 1 } }, filters: { teams: [{ id: 5, name: 'Customer care' }], assistants: [] }, metrics: { averageResponseSeconds: 2.4, feedbackCount: 3, helpfulRate: 66.7, csatCount: 0, satisfactionRate: null, handoffCount: 2, handoffRate: 7.7, convertedLeads: 0, leadConversionRate: 0 } } });
  });
  await page.route('**/api/support/ai/quality**', route => route.fulfill({ json: { items: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 }, summary: { open: 0, reviewed: 0, helpful: 0 }, filters: { teams: [], assistants: [] } } }));
  await page.route('**/api/support-widget/token', route => route.fulfill({ json: [{ teamId: 5, teamName: 'Customer care', token: 'test-widget-token', allowedDomains: ['https://example.test'], settings: { displayName: 'Customer care', greeting: 'How can we help?', primaryColor: '#2563eb', logoUrl: '', position: 'right' }, installation: null }] }));
});

test('report filters, transcript feedback, contact links, and navigation survive returning to reports', async ({ page }) => {
  const flags: unknown[] = [];
  await page.route('**/api/support/ai/messages/82/feedback', route => { flags.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); });
  await page.goto('/dashboard/support-ai/reports');
  await expect(page.getByRole('heading', { name: 'Support reports' })).toBeVisible();
  await page.getByLabel('From date').fill('2026-10-01');
  await page.getByLabel('Conversation source').selectOption('widget');
  await page.getByRole('tab', { name: /^Conversations/ }).click();
  await page.getByLabel('Search conversations', { exact: true }).fill('Delivery');
  await page.getByRole('button', { name: 'Open conversation: Delivery question' }).click();
  await expect(page.getByText('Delivery takes three days.')).toBeVisible();
  await page.getByRole('button', { name: 'Flag answer', exact: true }).click();
  await page.getByLabel('Feedback reason').selectOption('incorrect');
  await page.getByLabel('Feedback notes').fill('Check the current delivery policy.');
  await page.getByRole('button', { name: 'Save flag' }).click();
  await expect.poll(() => flags.length).toBe(1);
  expect(flags[0]).toMatchObject({ rating: 'needs_review', reason: 'incorrect', status: 'open' });
  await expect(page.getByRole('link', { name: 'View contact', exact: true })).toHaveAttribute('href', '/dashboard/crm/contacts/-71');
  const nav = page.getByRole('navigation', { name: 'Support AI', exact: true });
  await nav.getByRole('link', { name: 'Answer quality', exact: true }).click();
  await nav.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/sessionId=41/);
  await expect(page.getByLabel('Search conversations', { exact: true })).toHaveValue('Delivery');
  await expect(page.getByLabel('From date')).toHaveValue('2026-10-01');
  await expectNoHorizontalOverflow(page);
});

test('widget preview is local until settings are saved and pages fit small and large viewports', async ({ page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/support-widget/settings/5', route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: route.request().postDataJSON() }); });
  await page.goto('/dashboard/support-ai/widget-settings');
  await page.getByLabel('Display name').fill('Acme care');
  await page.getByLabel('Greeting').fill('Welcome to Acme.');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ displayName: 'Acme care', greeting: 'Welcome to Acme.' });
  for (const width of [320, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
  }
  await page.screenshot({ path: '.test-results-support-ai-enhancements/widget-settings.png', fullPage: true });
});

test('chat restores failed input and offers rename and transcript export', async ({ page }) => {
  let preferences = { theme: 'light', language: 'en', timezone: 'UTC' };
  await page.route('**/api/settings/preferences', route => {
    if (route.request().method() === 'PUT') preferences = route.request().postDataJSON();
    return route.fulfill({ json: preferences });
  });
  await page.route('**/api/support/ai/chat', route => route.fulfill({ status: 503, json: { error: 'Please retry shortly.' } }));
  await page.goto('/dashboard/support-ai/chat');
  const composer = page.getByPlaceholder('Ask a question or paste a customer message…');
  await composer.fill('Where is my order?');
  await composer.press('Enter');
  await expect(composer).toHaveValue('Where is my order?');
  await expect(page.getByRole('button', { name: /Retry message/ })).toBeVisible();
  if (await page.getByRole('button', { name: 'Show support conversations' }).isVisible()) await page.getByRole('button', { name: 'Show support conversations' }).click();
  await page.getByRole('button', { name: 'Open chat Delivery question' }).click();
  await page.getByRole('button', { name: 'Conversation actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Rename/ })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download transcript', exact: true }).click();
  const transcript = await downloaded;
  expect(transcript.suggestedFilename()).toBe('Delivery question.txt');
  expect(await readFile((await transcript.path())!, 'utf8')).toContain('**Delivery** takes three days.');
  for (const width of [320, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
  }
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: '.test-results-support-ai-enhancements/chat.png', fullPage: true });
});

test('public widget can be embedded from another origin while dashboard framing stays protected', async ({ page, request, baseURL }) => {
  const publicResponse = await request.get('/support-widget/test-widget-token');
  expect(publicResponse.headers()['x-frame-options']).toBeUndefined();
  expect(publicResponse.headers()['content-security-policy']).toContain('frame-ancestors http: https:');
  const dashboardResponse = await request.get('/dashboard/support-ai/chat');
  expect(dashboardResponse.headers()['x-frame-options']).toBe('SAMEORIGIN');
  await page.route('**/api/support-widget/config?*', route => route.fulfill({ json: { success: true, data: { teamName: 'Acme care', displayName: 'Acme care', greeting: 'How can we help?', primaryColor: '#2563eb', logoUrl: '', position: 'right' } } }));
  // Use a real second origin so Chromium can classify its local address space.
  const host = createServer((_incoming, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<html><body><iframe title="Customer support" src="${baseURL}/support-widget/test-widget-token" style="width:320px;height:600px;border:0"></iframe></body></html>`);
  });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(host.address() as AddressInfo).port}/`);
    const widget = page.frameLocator('iframe');
    await expect(widget.getByPlaceholder('Type your message…')).toBeVisible();
    await expect(widget.getByText('How can we help?', { exact: true })).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
  }
});
