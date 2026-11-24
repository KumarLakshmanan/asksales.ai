import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AssistantConversationContext } from '../../shared/assistantOperations';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { makeDemoInsights } from '../src/app/dashboard/(main)/insights/demo';
import { emailDisplayText } from '../../server/utils/emailDisplay';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
const html = '<style>body, table, td, a { color:red }</style><div hidden>Hidden preheader</div><p>Hello &amp; welcome</p><p>&amp;#847;&amp;#8199;&amp;#65279;Synthetic email second paragraph.</p><p>Contact &lt;sales@example.com&gt;; literal &amp;lt;script&amp;gt; and &lt;img src=x onerror=alert(1)&gt;</p><script>window.qaInjection=true</script>';
const sources = ['linkedin', 'google', 'justdial', 'yelp', 'instagram', 'facebook', 'twitter'];
const lead = { id: 901, name: 'Fixture lead', company: 'Synthetic Studio', email: 'fixture@example.test', role: 'Owner', source: 'manual', score: 65, leadStatus: 'new', createdAt: '2026-10-01T00:00:00Z' };
const inboxItem = { key: 'conversation:901', kind: 'conversation', id: 901, channel: 'email', leadId: 901, leadName: 'Fixture sender', leadEmail: lead.email, leadPhone: null, leadCompany: lead.company, leadAvatar: null, recipient: lead.email, subject: 'Synthetic email', preview: emailDisplayText(html, 'html'), activityAt: lead.createdAt, unreadCount: 0, totalMessages: 1, status: 'active', integrationProvider: 'gmail', reply: { canReply: false, reason: 'Read-only QA fixture', accountLabel: 'qa@example.test', providerAccountId: 'fixture-account' } };
const counts = { all: 0, email: 0, whatsapp: 0, instagram: 0, facebook: 0, sms: 0 };
const reportData = {
  sessions: [], leads: [], stats: { totalSessions: 0, widgetSessions: 0, totalMessages: 0, leadsGenerated: 0 },
  pagination: { sessions: { page: 1, limit: 25, total: 0, totalPages: 0 }, leads: { page: 1, limit: 25, total: 0, totalPages: 0 } },
  filters: { teams: [], assistants: [] }, metrics: { averageResponseSeconds: null, feedbackCount: 0, helpfulRate: null, csatCount: 0, satisfactionRate: null, handoffCount: 0, handoffRate: null, convertedLeads: 0, leadConversionRate: null },
};

async function fixtures(page: Page) {
  const state = { leadSettings: [...sources], settingsWrites: 0, reportFails: false, reportQueries: [] as URLSearchParams[], insightsFails: false, deletes: 0 };
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/business-profiles', '/api/settings/outreach/assistants/catalog', '/api/wallet', '/api/notifications/unread/count'].includes(url.pathname)) return route.fallback();
    if (url.pathname === '/api/organizations') return json({ organizations: [{ id: 4103, businessProfileId: 4102, name: 'Regression Business', ownerUserId: 4101, role: 'owner', canManageBilling: true }], invitations: [], selectedOrganizationId: 4103 });
    if (url.pathname === '/api/leads') return json({ data: url.searchParams.get('scoreRange') || url.searchParams.get('search') ? [] : [lead], total: 1, totalPages: 1, page: 1, pageSize: 15 });
    if (url.pathname === '/api/leads/stats') return json({ success: false });
    if (url.pathname === '/api/leads/bulk-delete') { state.deletes++; return json({ deletedCount: 1 }); }
    if (url.pathname === '/api/settings/leads') {
      if (request.method() === 'PUT') {
        state.settingsWrites++;
        if (state.settingsWrites === 1) return json({ error: 'Synthetic save failure. Retry your changes.' }, 409);
        state.leadSettings = request.postDataJSON().leadSources;
      }
      return json({ leadSources: state.leadSettings });
    }
    if (/\/api\/settings\/integrations\/\w+\/follow-ups$/.test(url.pathname)) return json({ enableAutoFollowUp: false, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: null, templateName: '' }] });
    if (url.pathname === '/api/outreach-conversations/inbox') return json({ items: [inboxItem], unreadThreads: counts, nextCursor: null });
    if (url.pathname === '/api/outreach-conversations/inbox/conversation/901') return json({ item: inboxItem });
    if (url.pathname === '/api/outreach-conversations/email/901/messages') return json({ conversation: { id: 901, leadName: inboxItem.leadName, leadEmail: lead.email }, messages: [{ id: 901, conversationId: 901, direction: 'inbound', content: emailDisplayText(html, 'html'), htmlContent: html, subject: inboxItem.subject, createdAt: lead.createdAt, status: 'received' }] });
    if (url.pathname === '/api/settings/outreach/assistants/conversations/901/activity') return json({ items: [], nextCursor: null, context: { name: 'Synthetic conversation', mode: 'manual', sessionStatus: 'active', channel: 'email', assistantId: null, revision: null, accountId: null, playbook: null, followUp: null } satisfies AssistantConversationContext });
    if (url.pathname === '/api/support/ai/report') {
      state.reportQueries.push(url.searchParams);
      for (const key of ['from', 'to', 'teamId']) if (url.searchParams.has(key) && !url.searchParams.get(key)) return json({ error: `Invalid ${key}` }, 400);
      if (state.reportFails) return json({ error: 'Synthetic reporting outage.' }, 503);
      return json(reportData);
    }
    if (url.pathname === '/api/insights') return state.insightsFails ? json({ error: 'Synthetic Insights outage.' }, 500) : json(makeDemoInsights());
    if (url.pathname === '/api/support/ai/quality') return json({ items: [], summary: { open: 0, reviewed: 0, helpful: 0 }, pagination: reportData.pagination.sessions, filters: reportData.filters });
    if (url.pathname === '/api/content/templates') return json({ templates: [], total: 0 });
    if (url.pathname === '/api/chat/threads') return json({ threads: [], total: 0 });
    return json([]); // All remaining API traffic is isolated, including writes.
  });
  return state;
}

async function capture(page: Page, label: string, name: string) {
  const folder = path.join(process.env.ASKSALES_QA_EVIDENCE_DIR || '/private/tmp/asksales-qa-20261005', label);
  await mkdir(folder, { recursive: true });
  await expectNoHorizontalOverflow(page);
  const main = page.locator('#main-content');
  const originalTop = await main.evaluate(element => element.scrollTop);
  const offsets = await main.evaluate(element => {
    const result = [0];
    for (let offset = element.clientHeight * .8; offset < element.scrollHeight - element.clientHeight; offset += element.clientHeight * .8) result.push(offset);
    if (element.scrollHeight > element.clientHeight) result.push(element.scrollHeight - element.clientHeight);
    return result;
  });
  for (const [index, offset] of offsets.entries()) {
    await main.evaluate((element, top) => { element.scrollTop = top; }, offset);
    await page.screenshot({ path: path.join(folder, `${name}${index ? `-scroll-${index}` : ''}.png`), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display:none!important }' });
  }
  await main.evaluate((element, top) => { element.scrollTop = top; }, originalTop);
}

for (const width of [320, 375, 768, 1440]) {
  test(`confirmed QA journeys at ${width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixtures(page);
    const label = `width-${width}`;
    await page.goto('/dashboard/leads');
    await expect(page.getByRole('heading', { name: /All Leads/ })).toBeVisible();
    const headerControls = await page.locator('[data-testid="header"] button, [data-testid="header"] a').evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })));
    for (const [index, rect] of headerControls.entries()) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      for (const other of headerControls.slice(index + 1)) expect(Math.min(rect.right, other.right) - Math.max(rect.left, other.left)).toBeLessThanOrEqual(1);
    }
    const trigger = page.getByRole('button', { name: /Find a page in/ });
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'Search AskSales.AI' })).toBeVisible();
    await capture(page, label, 'page-search');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.getByRole('button', { name: 'Filter leads' }).click();
    for (const name of ['Status', 'Source', 'Score range', 'Sort by']) await expect(page.getByRole('combobox', { name, exact: true })).toBeVisible();
    await expect(page.getByLabel('Search leads', { exact: true })).toBeVisible();
    await capture(page, label, 'leads-filters');
    await page.getByLabel('Score range').selectOption('80-100');
    await expect(page.getByText('No leads match your filters')).toBeVisible();
    await page.getByRole('button', { name: 'Clear Filters' }).click();
    await page.getByRole('checkbox', { name: /^Select (lead )?Fixture lead$/ }).check();
    await page.getByRole('button', { name: 'Delete Selected' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await capture(page, label, 'delete-review');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.deletes).toBe(0);

    await page.goto('/dashboard/settings/leads');
    await expect(page.getByText('7 sources selected')).toBeVisible();
    await page.getByRole('button', { name: 'Disable Yelp lead source' }).click();
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Enable Yelp lead source' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByText('All source changes saved')).toBeVisible();
    await capture(page, label, 'lead-sources');
    await page.reload();
    await expect(page.getByText('6 sources selected')).toBeVisible();

    await page.goto('/dashboard/outreach/follow-ups');
    await expect(page).toHaveURL(/\/dashboard\/outreach\/follow-ups$/);
    await expect(page.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await page.getByRole('button', { name: 'Add Follow-Up Step' }).click();
    await page.getByLabel('Step 2 delay', { exact: true }).fill('1');
    await expect(page.getByRole('tabpanel', { name: 'Settings', exact: true }).getByRole('alert')).toContainText('choose a delay later than step 1');
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
    await page.getByLabel('Step 2 delay', { exact: true }).fill('3');
    await capture(page, label, 'follow-up-sequence');
    await page.getByRole('tab', { name: 'WhatsApp', exact: true }).click();
    await expect(page.getByLabel('Step 1 delay', { exact: true })).toHaveValue('1');
    await page.getByRole('tab', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: 'Create template', exact: true }).click();
    await expect(page.getByLabel('Template name')).toBeVisible();
    await capture(page, label, 'template-form');
    await page.keyboard.press('Escape');

    await page.goto('/dashboard/outreach/inbox');
    const row = page.getByRole('button', { name: 'Open Fixture sender on Email' });
    await expect(row).toContainText('Hello & welcome');
    await expect(row).not.toContainText('body, table');
    await row.click();
    await expect(page.getByRole('listitem', { name: 'Received email' })).toContainText('Synthetic email second paragraph.');
    await expect(page.getByRole('listitem', { name: 'Received email' })).not.toContainText('&#847;');
    await expect(page.getByRole('listitem', { name: 'Received email' })).toContainText('Contact <sales@example.com>; literal <script> and <img src=x onerror=alert(1)>');
    await expect(page.getByRole('listitem', { name: 'Received email' }).locator('script, img, iframe')).toHaveCount(0);
    expect(await page.evaluate(() => 'qaInjection' in window)).toBe(false);
    await capture(page, label, 'inbox-readable-email');

    await page.goto('/dashboard/support-ai/reports');
    await expect(page.getByLabel('From date')).not.toHaveValue('');
    await page.getByLabel('From date').fill('2026-09-01');
    await page.getByLabel('To date').fill('2026-10-05');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    state.reportFails = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Refresh failed — showing the last loaded results')).toBeVisible();
    await expect(page.getByLabel('From date')).toHaveValue('2026-09-01');
    state.reportFails = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('Refresh failed — showing the last loaded results')).toHaveCount(0);
    await capture(page, label, 'support-report-range');
    await page.reload();
    await expect(page.getByLabel('From date')).toHaveValue('2026-09-01');
    await expect(page.getByLabel('To date')).toHaveValue('2026-10-05');
    expect(state.reportQueries.some(query => query.get('from') === '2026-09-01' && query.get('to') === '2026-10-05')).toBe(true);

    state.insightsFails = true;
    await page.goto('/dashboard/insights');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Synthetic Insights outage.');
    state.insightsFails = false;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('2,415', { exact: true })).toBeVisible();
    await capture(page, label, 'insights-recovery');

    if (width === 1440) {
      // Model browser zoom's CSS viewport and physical-pixel scale together.
      // CSS zoom alone keeps desktop media queries and misrepresents reflow.
      await page.setViewportSize({ width: 720, height: 500 });
      const session = await page.context().newCDPSession(page);
      await session.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 500, deviceScaleFactor: 2, mobile: false });
      await page.goto('/dashboard/outreach/follow-ups');
      await expect(page.getByLabel('Step 1 delay', { exact: true })).toBeVisible();
      await capture(page, 'zoom-200-percent', 'follow-ups');
      for (const [route, name] of [['leads', 'leads'], ['settings/leads', 'sources'], ['support-ai/reports', 'reports']]) {
        await page.goto(`/dashboard/${route}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await capture(page, 'reflow-200-percent', name);
      }
    }
  });
}
