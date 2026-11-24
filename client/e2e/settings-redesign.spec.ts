import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { AUTOMATION_ACTIONS, AUTOMATION_CONDITION_FIELDS, AUTOMATION_PLACEHOLDERS, AUTOMATION_TRIGGERS } from '../../shared/crmAutomations';
import path from 'node:path';

const evidence = path.resolve('../design-references/dashboard-settings-review-2026-10-19');
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
test.beforeEach(async ({ page }) => {
  // These captures show the actual local application with synthetic workspace
  // data. Every API request is intercepted, including writes and provider jobs.
  let leadSources = ['linkedin', 'google', 'justdial'];
  let policy = { requireReviewBeforeAiSend: true, enabled: true, discountThresholdPct: 10, amountThreshold: 10000, currency: 'USD', reviewManualPricing: true, reviewerMemberIds: [9, 10] };
  let ads = { defaultLifetimeBudget: 100, currency: 'USD', locations: [], autonomousOptimizationEnabled: false, liveProviderMutationsEnabled: false, analyticsSyncMinutes: 15 };
  let autonomy = { mode: 'advisory', enabled: true, policyVersion: 'v1', consentedAt: null, notificationEmail: 'owner@example.test', defaultThresholds: {} };
  const notifications = { email: { enabled: false, providerState: 'available', subject: '{{event_title}} · {{ticket_number}}', text: 'Ticket: {{ticket_number}}\n{{safe_summary}}\nOpen ticket: {{ticket_url}}', preview: { subject: '', text: '', html: '' } }, whatsapp: { enabled: false, providerState: 'connected', templateId: 71, templateName: 'support_assignment', language: 'en', templates: [{ id: 71, name: 'support_assignment', language: 'en', body: 'Ticket {{1}} · {{2}} · {{3}} · {{4}} · {{5}} · {{6}} · {{7}}', compatible: true, parameterCount: 7, reasons: [] }] }, recipients: [{ memberId: 9, memberName: 'Asha', teamName: 'Sales', active: true, emailReady: true, emailHint: 'as***@example.test', whatsappReady: false, whatsappHint: null, memberProfileUrl: '/dashboard/support/teams/1/members/9' }] };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname, method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (pathname === '/api/settings/leads') { if (method === 'PUT') leadSources = body.leadSources; return route.fulfill({ json: { leadSources } }); }
    if (pathname === '/api/settings/ads') { if (method === 'PUT') ads = { ...ads, ...body }; return route.fulfill({ json: { settings: ads, readiness: { meta: true, google: false, reasons: { google: 'Choose a Google Ads customer account.' } }, environmentMutationGate: false } }); }
    if (pathname === '/api/settings/ads/autonomy') { if (method === 'PUT') autonomy = { ...autonomy, ...body }; return route.fulfill({ json: { settings: autonomy } }); }
    if (pathname === '/api/proposals/review-policy') { if (method === 'PUT') { policy = body; return route.fulfill({ json: policy }); } return route.fulfill({ json: { policy, reviewers: [{ id: 9, name: 'Asha', email: 'asha@example.test', role: 'reviewer', teamName: 'Sales' }, { id: 10, name: 'Ravi', email: 'ravi@example.test', role: 'reviewer', teamName: 'Finance' }] } }); }
    if (pathname.startsWith('/api/support/notification-settings')) { if (method === 'PUT') { if (pathname.endsWith('/email')) notifications.email = { ...notifications.email, ...body }; else notifications.whatsapp = { ...notifications.whatsapp, enabled: body.enabled, templateId: body.whatsappTemplateId }; } return route.fulfill({ json: notifications }); }
    if (pathname === '/api/support/notification-health') return route.fulfill({ json: { recentFailures: [], recentDeliveries: [] } });
    if (pathname === '/api/crm/automations/catalog') return route.fulfill({ json: { triggers: AUTOMATION_TRIGGERS, actions: AUTOMATION_ACTIONS, fields: AUTOMATION_CONDITION_FIELDS, placeholders: AUTOMATION_PLACEHOLDERS, runtimeEnabled: true, accounts: [], campaigns: [], members: [{ id: 9, name: 'Asha' }], whatsappTemplates: [] } });
    if (pathname === '/api/crm/automations/test') return route.fulfill({ json: { matches: true, triggerMatches: true, conditions: [], actions: [], warnings: ['Preview only.'] } });
    if (pathname === '/api/crm/automations') return route.fulfill({ json: method === 'GET' ? [] : { id: 901, isActive: false } });
    if (method !== 'GET' && method !== 'HEAD') return route.fulfill({ status: 409, json: { error: 'Unexpected writes are blocked in this local fixture.' } });
    if (/^\/api\/settings\/business-profiles\/\d+$/.test(pathname)) return route.fulfill({ json: { id: 4102, companyName: 'Regression Company', isDefault: true, role: 'owner', canManageTeam: true } });
    const shell = ['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/outreach/assistants/catalog', '/api/organizations', '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count'];
    if (shell.includes(pathname)) return route.fallback();
    return route.fulfill({ json: [] });
  });
});

async function capture(page: import('@playwright/test').Page, key: string, project: string) {
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, `${key}-implemented-${project.startsWith('mobile') ? 'mobile' : 'desktop'}.png`), fullPage: true, animations: 'disabled' });
}

test('CRM uses guided steps and previews a draft without sending', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/crm/automations/new'); await expect(page.getByRole('heading', { name: 'New automation' })).toBeVisible();
  await page.getByLabel('Automation name', { exact: true }).fill('Notify sales about a new lead');
  await capture(page, '02-automation', testInfo.project.name);
  await page.getByRole('button', { name: /Contact created A new CRM contact/ }).click();
  await expect(page.getByRole('complementary', { name: 'Rule preview' })).toContainText('Contact created');
  await page.getByRole('button', { name: 'Continue to conditions' }).click(); await page.getByRole('button', { name: 'Continue to actions' }).click();
  await page.getByLabel('Add action', { exact: true }).selectOption('update_tags'); await page.getByLabel('Tags', { exact: true }).fill('qualified');
  await page.getByRole('button', { name: 'Test', exact: true }).click(); await page.getByRole('button', { name: 'Run preview' }).click(); await expect(page.getByText('This event qualifies')).toBeVisible();
  await expectNoHorizontalOverflow(page); expect(audit.consoleErrors).toEqual([]);
});
test('Ad Settings keeps drafts across tabs and shows actionable readiness', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/settings/ads'); await expect(page.getByRole('heading', { name: 'Ad Settings', exact: true })).toBeVisible();
  await capture(page, '03-ads', testInfo.project.name);
  await page.getByLabel('Amount', { exact: true }).fill('125'); await page.getByRole('tab', { name: 'AI permissions', exact: true }).click();
  await expect(page.getByLabel('Pause notification email')).toHaveValue('owner@example.test'); await page.getByRole('tab', { name: 'Connection readiness', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Before you activate a campaign' })).toBeVisible();
  await page.getByRole('tab', { name: 'Campaign defaults', exact: true }).click(); await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('125');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(audit.consoleErrors).toEqual([]);
});
test('Proposal policy summarizes reviewer rules and saves the existing contract', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/proposals/settings'); await expect(page.getByRole('heading', { name: 'Sending policy' })).toBeVisible();
  await capture(page, '04-proposals', testInfo.project.name);
  await page.getByRole('radio', { name: /Allow eligible AI proposals/ }).check(); await expect(page.getByText('Eligible new AI offers can send automatically.')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click(); await expect(page.getByRole('radio', { name: /Save AI proposals/ })).toBeChecked();
  await page.getByLabel('Discount above (%)', { exact: true }).fill('15'); await page.getByRole('button', { name: 'Save policy' }).click(); await expect(page.getByText('Proposal settings saved.', { exact: true })).toBeVisible();
  expect(audit.consoleErrors).toEqual([]);
});
test('Notification switches stage changes and the tabs preserve templates', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/support/notifications'); await expect(page.getByRole('heading', { name: 'Notification channels' })).toBeVisible();
  await capture(page, '05-notifications', testInfo.project.name);
  const writes: string[] = []; page.on('request', request => { if (request.method() === 'PUT') writes.push(new URL(request.url()).pathname); });
  await page.getByRole('switch', { name: 'Enable Email notifications' }).click(); await page.getByRole('switch', { name: 'Enable WhatsApp notifications' }).click(); expect(writes).toEqual([]);
  await page.getByRole('tab', { name: 'Message templates' }).click(); await page.getByLabel('Subject', { exact: true }).fill('Assignment {{ticket_number}}');
  await page.getByRole('tab', { name: 'Recipients', exact: true }).click(); await expect(page.getByText('Missing WhatsApp', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(writes).toEqual(['/api/support/notification-settings/email', '/api/support/notification-settings/whatsapp']);
  await page.getByRole('tab', { name: 'Delivery activity', exact: true }).click(); await expect(page.getByText('No failed deliveries.', { exact: true })).toBeVisible(); await expectNoHorizontalOverflow(page); expect(audit.consoleErrors).toEqual([]);
});
test('Workspace directory searches and filters all permitted settings', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/settings/workspace'); const region = page.getByRole('region', { name: 'Workspace configuration links' }); await expect(region.getByRole('link', { name: /^Ad Settings/ })).toBeVisible();
  await capture(page, '06-workspace', testInfo.project.name);
  await page.getByLabel('Search workspace settings', { exact: true }).fill('follow-up'); await expect(region.getByRole('link')).toHaveCount(1); await expect(region.getByRole('link')).toHaveAttribute('href', '/dashboard/outreach/follow-ups');
  await page.getByLabel('Search workspace settings', { exact: true }).fill('no such setting'); await expect(page.getByText('No settings match your search.')).toBeVisible(); await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click(); await expect(region.getByRole('link')).toHaveCount(1); await expect(region.getByRole('link')).toHaveAttribute('href', '/dashboard/integrations'); expect(audit.consoleErrors).toEqual([]);
});
test('Lead source selection disables Yelp and persists supported fallbacks', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/settings/leads'); await expect(page.getByRole('heading', { name: 'Lead discovery defaults' })).toBeVisible();
  await capture(page, '07-leads', testInfo.project.name);
  await expect(page.getByRole('checkbox', { name: 'Yelp is not supported' })).toBeDisabled(); await page.getByRole('checkbox', { name: 'Select LinkedIn as a fallback source' }).uncheck(); await page.getByRole('button', { name: 'Save defaults', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save defaults', exact: true })).toBeDisabled(); await page.reload(); await expect(page.getByRole('checkbox', { name: 'Select LinkedIn as a fallback source' })).not.toBeChecked(); expect(audit.consoleErrors).toEqual([]);
});
