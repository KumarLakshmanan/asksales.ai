/**
 * Running-page audit against the real Instagram router and isolated PostgreSQL.
 * Start the opt-in browser harness documented in INSTAGRAM_AUTOMATIONS_ROLLOUT.md.
 * Feature requests reach the real API and PostgreSQL. App authentication,
 * account selection, shell services and Meta responses use explicit fixtures.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { newInstagramRule, type InstagramRuleDefinition } from '../../shared/instagramAutomations';

const fixtureApi = process.env.INSTAGRAM_AUTOMATIONS_QA_API || 'http://127.0.0.1:8087';
const appPath = '/dashboard/integrations/instagram/automations';
const ownerHeaders = { Authorization: 'Bearer fixture-owner', 'x-business-profile-id': '101' };
test.skip(process.env.INSTAGRAM_AUTOMATIONS_HTTP_QA !== '1', 'Requires the isolated local HTTP/Postgres harness.');
test.use({ trace: 'off', video: 'off' });

async function control(request: APIRequestContext, action: string, data: unknown = {}) {
  const response = await request.post(`${fixtureApi}/__audit/${action}`, { data });
  expect(response.ok(), `${action}: ${await response.text()}`).toBe(true);
}
async function api(request: APIRequestContext, path: string, method = 'GET', data?: unknown) {
  const response = await request.fetch(`${fixtureApi}/api/instagram/automations/${path}`, { method, headers: ownerHeaders, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return (await response.json()).data;
}
async function seedRule(request: APIRequestContext, name: string, kind: 'comment_dm' | 'comment_reply' = 'comment_dm', account = '1001', patch: Partial<InstagramRuleDefinition> = {}) {
  const definition = newInstagramRule(kind);
  definition.name = name;
  definition.trigger.keywords = ['guide'];
  if (kind === 'comment_dm') definition.message.text = 'Here is your requested guide.';
  else definition.publicReplies = ['Thanks for asking! Our hours are in our bio.'];
  return api(request, `${account}/rules`, 'POST', { definition: { ...definition, ...patch } });
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await expectNoHorizontalOverflow(page);
  const directory = resolve(dirname(info.config.configFile || resolve(info.config.rootDir, 'playwright.config.ts')), '../output/instagram-automation-audit/screenshots', info.project.name);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  // The dashboard scrolls inside main. Expand its wrappers only for capture so
  // fullPage includes the editor's lower fields; restore the tested layout.
  const originalLayout = await page.evaluate(() => {
    const records: { id: string; style: string | null; scrollTop: number }[] = [];
    const main = document.getElementById('main-content');
    let element = main;
    while (element && element !== document.body) {
      const id = `instagram-audit-capture-${records.length}`;
      records.push({ id, style: element.getAttribute('style'), scrollTop: element.scrollTop });
      element.setAttribute('data-audit-capture', id);
      element.style.height = 'auto';
      element.style.maxHeight = 'none';
      element.style.overflowX = 'clip';
      element.style.overflowY = 'visible';
      element.scrollTop = 0;
      element = element.parentElement;
    }
    // Put sticky save controls at their natural footer position in the expanded
    // image rather than over the middle of the form at viewport height.
    for (const footer of main?.querySelectorAll<HTMLElement>('.sticky.bottom-0') || []) {
      const id = `instagram-audit-capture-${records.length}`;
      records.push({ id, style: footer.getAttribute('style'), scrollTop: footer.scrollTop });
      footer.setAttribute('data-audit-capture', id);
      footer.style.position = 'static';
    }
    return records;
  });
  try {
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', scale: 'css' });
  } finally {
    await page.evaluate(records => {
      for (const record of records) {
        const element = document.querySelector<HTMLElement>(`[data-audit-capture="${record.id}"]`);
        if (!element) continue;
        if (record.style === null) element.removeAttribute('style');
        else element.setAttribute('style', record.style);
        element.removeAttribute('data-audit-capture');
        element.scrollTop = record.scrollTop;
      }
    }, originalLayout);
  }
  await info.attach(name, { path, contentType: 'image/png' });
}
async function view(page: Page, name = 'hub', extra = '') {
  await page.goto(`${appPath}?accountId=1001&view=${name}${extra}`, { timeout: 120_000 });
}

test.beforeEach(async ({ page, request }) => {
  page.setDefaultTimeout(30_000);
  await control(request, 'reset');
  let selected = 1;
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 9, name: 'Instagram Audit', email: 'owner@example.test' }));
    sessionStorage.setItem('active-business-profile:9', '101');
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const reply = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path.startsWith('/api/instagram/automations/')) {
      // Keep the local fixture proxy off idle pooled sockets; mutations are never retried.
      const response = await route.fetch({ url: `${fixtureApi}${path}${url.search}`, headers: { ...request.headers(), ...ownerHeaders, connection: 'close' }, maxRetries: request.method() === 'GET' ? 2 : 0 });
      return route.fulfill({ response });
    }
    if (path.includes('csrf')) return reply({ csrfToken: 'local-fixture' });
    if (path === '/api/auth/me') return reply({ user: { id: 9, name: 'Instagram Audit', email: 'owner@example.test', isSetupComplete: true, isApproved: true, hasBusinessProfile: true, hasBrandToolkit: true } });
    if (path === '/api/settings/business-profiles') return reply([{ id: 101, name: 'Audit studio', companyName: 'Audit studio', isDefault: true, role: 'owner' }]);
    if (path === '/api/instagram/oauth/status') return reply({ officialApi: { connected: true, authorized: true, instagramAccountId: selected === 1 ? '1001' : '1002', username: `test_100${selected}`, credentialId: selected, tokenExpired: false, expiresAt: null, connectionMethod: 'oauth', loginMethod: 'instagram', webhookSubscribed: true, grantedScopes: ['instagram_business_manage_messages', 'instagram_business_manage_comments'], capabilities: [] } });
    if (path === '/api/channel-accounts/instagram_api') return reply([1, 2].map(id => ({ id, accountIdentifier: `100${id}`, accountName: `test_100${id}`, isSelected: id === selected })));
    if (path === '/api/channel-accounts/instagram_api/select') { selected = request.postDataJSON().credentialId; return reply({ success: true }); }
    return route.fallback();
  });
});

test('connection entry, hub and empty history are understandable', async ({ page, audit }, info) => {
  await page.goto('/dashboard/integrations/instagram', { timeout: 120_000 });
  await expect(page.getByRole('heading', { name: 'Instagram', exact: true }).first()).toBeVisible();
  await screenshot(page, info, '01-instagram-connection');
  await page.getByRole('link', { name: 'Automations', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Instagram automations', exact: true })).toBeVisible();
  await expect(page.getByText('Conversation starters', { exact: true }).first()).toBeVisible();
  await screenshot(page, info, '02-automation-hub');
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment rules', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Available automations' }).locator('article')).toHaveCount(5);
  await view(page, 'history');
  await expect(page.getByText('No executions yet', { exact: true })).toBeVisible();
  await screenshot(page, info, '03-history-empty');
  expect(audit.blockedMutations).toEqual([]);
});

test('conversation starters validate, save languages, publish, survive rejection and remove', async ({ page, request }, info) => {
  await view(page, 'icebreakers');
  await expect(page.getByLabel('Question 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByLabel('Question 1', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await screenshot(page, info, '04-starters-validation');
  await page.getByLabel('Question 1', { exact: true }).fill('What are your opening hours?');
  await page.getByRole('button', { name: 'Add language', exact: true }).click();
  await page.getByLabel('Question 1 (en_US)', { exact: true }).fill('When can I visit your studio?');
  await screenshot(page, info, '05-starters-languages');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publish when you are ready.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Question 1 (en_US)', { exact: true })).toHaveValue('When can I visit your studio?');
  await page.getByRole('button', { name: 'Publish to Instagram', exact: true }).click();
  await expect(page.getByText('Published and confirmed by Instagram.', { exact: true })).toBeVisible();
  await screenshot(page, info, '06-starters-published');
  await control(request, 'provider', { failure: 'reject' });
  await page.getByLabel('Question 1', { exact: true }).fill('How do I book an appointment?');
  await page.getByRole('button', { name: 'Publish to Instagram', exact: true }).click();
  await expect(page.getByText('Meta has not authorized this operation for the account.', { exact: true })).toBeVisible();
  const saved = await api(request, '1001/profiles/icebreakers');
  expect(saved.config.locales[0].questions[0].question).toBe('How do I book an appointment?');
  expect(saved.publishedConfig.locales[0].questions[0].question).toBe('What are your opening hours?');
  await screenshot(page, info, '07-starters-publication-error');
  await control(request, 'provider', { failure: null });
  await page.getByRole('button', { name: 'Publish to Instagram', exact: true }).click();
  await expect(page.getByText('Published and confirmed by Instagram.', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove from Instagram', exact: true }).click();
  await expect(page.getByText('Removed from Instagram.', { exact: true })).toBeVisible();
  expect((await api(request, '1001/profiles/icebreakers')).publishedConfig).toBeNull();
});

test('main menu links and generated response actions persist and preview correctly', async ({ page, request }, info) => {
  await view(page, 'menu');
  await page.getByLabel('Menu item 1 label', { exact: true }).fill('View pricing');
  await page.getByLabel('Menu item 1 response', { exact: true }).fill('Studio packages start at ₹2,000.');
  await page.getByRole('button', { name: 'Add menu item', exact: true }).click();
  await page.getByLabel('Menu item 2 label', { exact: true }).fill('Visit our website');
  await page.getByRole('combobox', { name: 'Menu item 2 type', exact: true }).selectOption('link');
  await page.getByLabel('Menu item 2 link', { exact: true }).fill('http://example.test/pricing');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByLabel('Menu item 2 link', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Menu item 2 link', { exact: true }).fill('https://example.test/pricing');
  await screenshot(page, info, '08-menu-response-and-link');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publish when you are ready.', { exact: true })).toBeVisible();
  const saved = await api(request, '1001/profiles/menu');
  expect(saved.config.locales[0].items[0].payload).toMatch(/^MENU_/);
  await page.reload();
  await expect(page.getByLabel('Menu item 1 response', { exact: true })).toHaveValue('Studio packages start at ₹2,000.');
  await page.getByRole('button', { name: 'Preview menu item View pricing', exact: true }).click();
  await expect(page.getByText('Studio packages start at ₹2,000.', { exact: true }).last()).toBeVisible();
  await screenshot(page, info, '09-menu-preview-response');
  await page.getByRole('button', { name: 'Publish to Instagram', exact: true }).click();
  await expect(page.getByText('Published and confirmed by Instagram.', { exact: true })).toBeVisible();
});

test('wizard validates selected media, commits keywords and tags, saves paused and reloads', async ({ page, request }, info) => {
  await view(page, 'new', '&kind=comment_dm&guided=1');
  await expect(page.getByRole('heading', { name: 'New comment to DM', exact: true })).toBeVisible();
  await page.getByLabel('Specific posts or reels', { exact: false }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Select at least one post or reel.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Select post media-1/ }).click();
  await page.getByRole('button', { name: 'Load more posts', exact: true }).click();
  await page.getByRole('button', { name: /Select post media-2/ }).click();
  await screenshot(page, info, '10-wizard-choose-posts');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Trigger keywords', { exact: true }).fill('guide');
  await page.getByLabel('Negative keywords', { exact: true }).fill('spam');
  await page.getByLabel('Reply publicly to the comment', { exact: false }).check();
  await page.getByLabel('Public reply 1', { exact: true }).fill('Your guide is in your DMs.');
  await screenshot(page, info, '11-wizard-trigger');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('DM message', { exact: true }).fill('Hello {{name}}, here is your {{keyword}}: https://example.test/guide');
  await expect(page.getByRole('button', { name: 'Carousel', exact: true })).toBeDisabled();
  await screenshot(page, info, '12-wizard-compose');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Automation name', { exact: true }).fill('Guide delivery');
  await page.getByLabel('Contact tags', { exact: true }).fill('guide_requested');
  await screenshot(page, info, '13-wizard-review');
  await page.getByRole('button', { name: 'Create paused automation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guide delivery', exact: true })).toBeVisible();
  const rules = await api(request, '1001/rules');
  expect(rules[0]).toMatchObject({ status: 'paused', definition: { trigger: { keywords: ['guide'], negativeKeywords: ['spam'], mediaIds: ['media-1', 'media-2'] }, tags: ['guide_requested'] } });
  await page.reload();
  await page.getByRole('button', { name: 'Guide delivery', exact: true }).click();
  await expect(page.getByLabel('DM message', { exact: true })).toHaveValue('Hello {{name}}, here is your {{keyword}}: https://example.test/guide');
  await screenshot(page, info, '14-edit-comment-dm');
});

test('public comment editor validates, saves variations and enforces scoped precedence', async ({ page, request }, info) => {
  await view(page, 'new', '&kind=comment_reply');
  await expect(page.getByLabel('Public reply 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create paused automation', exact: true }).click();
  await expect(page.getByLabel('Automation name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Automation name', { exact: true }).fill('Public studio hours');
  await page.getByLabel('Only reels', { exact: false }).check();
  await page.getByLabel('Trigger keywords', { exact: true }).fill('hours');
  await page.getByLabel('Public reply 1', { exact: true }).fill('Hi {{username}}, we open at 9 am.');
  await page.getByRole('button', { name: 'Add reply variation', exact: true }).click();
  await page.getByLabel('Public reply 2', { exact: true }).fill('We are open every weekday from 9 am.');
  await page.getByLabel('Maximum sends per person per day', { exact: true }).fill('2');
  await page.getByLabel('Cooldown per person (minutes)', { exact: true }).fill('30');
  await screenshot(page, info, '15-public-comment-editor');
  await page.getByRole('button', { name: 'Create paused automation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Public studio hours', exact: true })).toBeVisible();
  const rules = await api(request, '1001/rules');
  expect(rules[0].definition).toMatchObject({ kind: 'comment_reply', trigger: { keywords: ['hours'], scope: 'reels' }, publicReplies: ['Hi {{username}}, we open at 9 am.', 'We are open every weekday from 9 am.'], filters: { maxPerDay: 2, cooldownMinutes: 30 } });
});

for (const format of ['quick_replies', 'buttons', 'carousel'] as const) {
  test(`menu rich format ${format} validates and survives save/reload`, async ({ page, request }, info) => {
    await view(page, 'menu');
    await page.getByLabel('Menu item 1 label', { exact: true }).fill('Our services');
    await page.getByRole('button', { name: format === 'quick_replies' ? 'Quick replies' : format === 'buttons' ? 'Button card' : 'Carousel', exact: true }).click();
    if (format !== 'carousel') await page.getByLabel('Menu item 1 response', { exact: true }).fill('Choose how we can help.');
    if (format === 'quick_replies') {
      await page.getByLabel('Quick reply 1 label', { exact: true }).fill('Pricing');
      await page.getByLabel('Quick reply 1 payload', { exact: true }).fill('PRICING');
    } else if (format === 'buttons') {
      await page.getByLabel('Button 1 label', { exact: true }).fill('View services');
      await page.getByLabel('Button 1 link', { exact: true }).fill('https://example.test/services');
    } else {
      await page.getByLabel('Card 1 title', { exact: true }).fill('Studio services');
      await page.getByLabel('Card 1 subtitle', { exact: true }).fill('Portraits and product photography');
    }
    await screenshot(page, info, `16-menu-${format}`);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Draft saved. Publish when you are ready.', { exact: true })).toBeVisible();
    expect((await api(request, '1001/profiles/menu')).config.locales[0].items[0].response.format).toBe(format);
    await page.reload();
    await expect(page.getByRole('button', { name: format === 'quick_replies' ? 'Quick replies' : format === 'buttons' ? 'Button card' : 'Carousel', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
}

test('follow gate shows the real flow, blocks oversized Unicode and supports rich content', async ({ page, request }, info) => {
  await view(page, 'new', '&kind=comment_dm&guided=1');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Trigger keywords', { exact: true }).fill('access');
  await page.getByLabel('Require a verified follow', { exact: false }).check();
  await page.getByLabel('Follow prompt', { exact: true }).fill('😀'.repeat(251));
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Follow prompt', { exact: true })).toBeVisible();
  await expect(page.getByText('Shorten the follow prompt to fit within 1,000 bytes.', { exact: true })).toBeVisible();
  await page.getByLabel('Follow prompt', { exact: true }).fill('Follow our account, then reply DONE for your download.');
  await screenshot(page, info, '17-follow-gate');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Button card', exact: true }).click();
  await page.getByLabel('DM message', { exact: true }).fill('Thanks for following. Your download is ready.');
  await page.getByLabel('Button 1 label', { exact: true }).fill('Download');
  await page.getByLabel('Button 1 link', { exact: true }).fill('https://example.test/download');
  await screenshot(page, info, '18-follow-gate-rich-content');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Automation name', { exact: true }).fill('Follower downloads');
  await expect(page.getByRole('combobox', { name: 'Audience', exact: true }).locator('option[value="non_followers"]')).toBeDisabled();
  await page.getByRole('button', { name: 'Create paused automation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Follower downloads', exact: true })).toBeVisible();
  expect((await api(request, '1001/rules'))[0].definition).toMatchObject({ followGate: { enabled: true }, message: { format: 'buttons' } });
});

test('rule management activates, pauses, orders, filters and deletes with real revisions', async ({ page, request }, info) => {
  await seedRule(request, 'First guide');
  await seedRule(request, 'Second guide');
  await seedRule(request, 'Public reply', 'comment_reply');
  await view(page, 'rules');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Activate First guide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause First guide', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause First guide', exact: true }).click();
  await page.getByRole('button', { name: 'Move Second guide up', exact: true }).click();
  await expect(page.getByText('Rule order saved. The first matching rule within each scope wins.', { exact: true })).toBeVisible();
  expect((await api(request, '1001/rules'))[0].definition.name).toBe('Second guide');
  await page.getByLabel('Search automations', { exact: true }).fill('First');
  await expect(page.getByRole('button', { name: 'Second guide', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move First guide up', exact: true })).toBeDisabled();
  await page.getByLabel('Search automations', { exact: true }).clear();
  await screenshot(page, info, '19-comment-rules');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete Public reply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Public reply', exact: true })).toHaveCount(0);
  expect(await api(request, '1001/rules')).toHaveLength(2);
});

test('history shows each outcome, pages older runs and recovers from errors', async ({ page, request }, info) => {
  await control(request, 'runs', { count: 56 });
  await view(page, 'history');
  await expect(page.getByRole('heading', { name: 'Execution history', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(page.getByText('Delivery unconfirmed', { exact: true }).first()).toBeVisible();
  await screenshot(page, info, '20-execution-history');
  await page.getByRole('button', { name: 'Load older executions', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(56);
  await page.route('**/api/instagram/automations/1001/runs', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'History is temporarily unavailable.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Refresh execution history', exact: true }).click();
  await expect(page.getByText('History is temporarily unavailable.', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(56);
  await screenshot(page, info, '21-history-retry');
  await page.getByRole('button', { name: 'Retry history', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(page.getByText('Loading history…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('History is temporarily unavailable.', { exact: true })).toHaveCount(0);
});

test('account switching isolates stored automations and refresh errors retain loaded content', async ({ page, request }, info) => {
  await seedRule(request, 'Account one guide');
  await seedRule(request, 'Account two guide', 'comment_dm', '1002');
  await view(page, 'rules');
  await expect(page.getByRole('button', { name: 'Account one guide', exact: true })).toBeVisible();
  await page.route('**/api/instagram/automations/1001', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Account data is temporarily unavailable.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Refresh automations', exact: true }).click();
  await expect(page.getByText(/Account data is temporarily unavailable\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account one guide', exact: true })).toBeVisible();
  await screenshot(page, info, '22-hub-refresh-error');
  await page.getByRole('button', { name: 'Change Instagram account', exact: true }).click();
  await screenshot(page, info, '23-account-picker');
  await page.getByRole('radio', { name: /test_1002/ }).click();
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click();
  await expect(page).toHaveURL(/accountId=1002/);
  await page.getByRole('button', { name: 'Manage 1 saved automation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Account two guide', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account one guide', exact: true })).toHaveCount(0);
  await screenshot(page, info, '24-second-account');
});

test('rollout and permissions keep draft editing available with clear disabled controls', async ({ page, request }, info) => {
  await control(request, 'provider', { enabled: false });
  await view(page, 'hub');
  await expect(page.getByText(/await administrator rollout approval/)).toBeVisible();
  await screenshot(page, info, '25-rollout-readiness');
  await page.getByRole('button', { name: 'Set up questions', exact: true }).click();
  await page.getByLabel('Question 1', { exact: true }).fill('Can I book a visit?');
  await expect(page.getByRole('button', { name: 'Publish to Instagram', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publish when you are ready.', { exact: true })).toBeVisible();
  await screenshot(page, info, '26-disabled-publish-saved-draft');
});

test('unsaved changes stay on screen when leaving is cancelled', async ({ page }, info) => {
  await view(page, 'icebreakers');
  await page.getByLabel('Question 1', { exact: true }).fill('Unsaved question');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Automation hub', exact: true }).click();
  await expect(page.getByLabel('Question 1', { exact: true })).toHaveValue('Unsaved question');
  await screenshot(page, info, '27-unsaved-edit-retained');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Automation hub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instagram automations', exact: true })).toBeVisible();
});

test('the follow verification card opens an account-bound setup with follow checks enabled', async ({ page }, info) => {
  await view(page);
  await page.getByRole('button', { name: 'Set up follow verification', exact: true }).click();
  await expect(page).toHaveURL(/accountId=1001.*preset=follow/);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Require a verified follow', { exact: false })).toBeChecked();
  await screenshot(page, info, '28-follow-card-setup');
  await page.reload();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Require a verified follow', { exact: false })).toBeChecked();
});

test('templates create paused automations and duplicate preserves the saved setup', async ({ page, request }, info) => {
  await view(page, 'new', '&kind=comment_dm');
  await page.getByLabel('Your content link', { exact: true }).fill('https://shop.example.test/guide');
  await page.getByRole('button', { name: 'Use template', exact: true }).click();
  await expect(page.getByLabel('DM message', { exact: true })).toHaveValue('Here is the guide you asked for: https://shop.example.test/guide');
  await screenshot(page, info, '29-customized-template');
  await page.getByRole('button', { name: 'Create paused automation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved automations', exact: true })).toBeVisible();
  const original = (await api(request, '1001/rules'))[0];
  expect(original.status).toBe('paused');
  await page.getByRole('button', { name: 'Duplicate Send a guide', exact: true }).click();
  await expect(page.getByLabel('Automation name', { exact: true })).toHaveValue('Send a guide (copy)');
  await screenshot(page, info, '30-duplicated-automation');
  const rules = await api(request, '1001/rules');
  expect(rules).toHaveLength(2); expect(rules[1].status).toBe('paused');
  expect(rules[1].definition.message).toEqual(original.definition.message);
});

test('unfinished edits recover after reload without replacing the saved revision', async ({ page }, info) => {
  await view(page, 'new', '&kind=comment_dm');
  await page.getByLabel('DM message', { exact: true }).fill('Recover this unfinished message');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore unfinished draft', exact: true })).toBeVisible();
  await screenshot(page, info, '31-draft-recovery');
  await page.getByRole('button', { name: 'Restore unfinished draft', exact: true }).click();
  await expect(page.getByLabel('DM message', { exact: true })).toHaveValue('Recover this unfinished message');
});

test('saved automation simulation explains priority and loads only its delivery details', async ({ page, request }, info) => {
  const rule = await seedRule(request, 'Test guide');
  await view(page, 'details', `&ruleId=${rule.id}`);
  await page.getByRole('button', { name: 'Check sample comment', exact: true }).click();
  await expect(page.getByText('This automation would win the trigger match.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Simulation uses the saved setup/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh delivery details', exact: true }).click();
  await expect(page.getByText('No recorded deliveries for this automation yet.', { exact: true })).toBeVisible();
  await screenshot(page, info, '32-test-and-delivery');
  expect((await api(request, '1001/runs')).runs).toHaveLength(0);
});

test('question presets and keyboard menu ordering preserve the intended responses', async ({ page }, info) => {
  await view(page, 'icebreakers');
  await page.getByLabel('Question preset for default', { exact: true }).selectOption('Services');
  await page.getByRole('button', { name: 'Use question preset', exact: true }).click();
  await expect(page.getByLabel('Question 1', { exact: true })).toHaveValue('What services do you offer?');
  await screenshot(page, info, '33-industry-questions');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publish when you are ready.', { exact: true })).toBeVisible();
  await view(page, 'menu');
  await page.getByLabel('Menu item 1 label', { exact: true }).fill('First');
  await page.getByLabel('Menu item 1 response', { exact: true }).fill('First answer');
  await page.getByRole('button', { name: 'Add menu item', exact: true }).click();
  await page.getByLabel('Menu item 2 label', { exact: true }).fill('Second');
  await page.getByLabel('Menu item 2 response', { exact: true }).fill('Second answer');
  await page.getByRole('button', { name: 'Move menu item 2 up in default', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Menu item 1 label', { exact: true })).toHaveValue('Second');
  await expect(page.getByLabel('Menu item 1 response', { exact: true })).toHaveValue('Second answer');
  await screenshot(page, info, '34-menu-order');
});

test('activation reviews overlaps and connection health exposes actionable readiness', async ({ page, request }, info) => {
  const first = await seedRule(request, 'Priority guide');
  await request.put(`${fixtureApi}/api/instagram/automations/1001/rules/${first.id}`, { headers: ownerHeaders, data: { definition: first.definition, status: 'active', revision: first.revision } });
  await seedRule(request, 'Other guide');
  await view(page, 'rules');
  await expect(page.getByText('Review 1 potential overlap(s)', { exact: true }).first()).toBeVisible();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Potential overlap'); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Activate Other guide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Activate Other guide', exact: true })).toBeVisible();
  await screenshot(page, info, '35-activation-overlap');
  await page.goto('/dashboard/integrations/instagram');
  await expect(page.getByRole('region', { name: 'Instagram connection health', exact: true })).toBeVisible();
  await expect(page.getByText('Account authorization: Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check connection health', exact: true }).click();
  await expect(page.getByText('Includes the current Instagram event subscriptions.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check connection health', exact: true })).toBeEnabled();
  await screenshot(page, info, '36-connection-health');
});


for (const action of ['activate', 'pause', 'delete', 'reorder', 'duplicate'] as const) {
  test(`a focus refresh preserves the completed ${action} action`, async ({ page, request }) => {
    let source = await seedRule(request, 'Focus guide');
    await seedRule(request, 'Second guide');
    if (action === 'pause') source = await api(request, `1001/rules/${source.id}`, 'PUT', { definition: source.definition, revision: source.revision, status: 'active' });
    await view(page, 'rules');
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
    await expectNoHorizontalOverflow(page);
    const label = action === 'activate' ? 'Activate Focus guide' : action === 'pause' ? 'Pause Focus guide' : action === 'delete' ? 'Delete Focus guide' : action === 'reorder' ? 'Move Focus guide down' : 'Duplicate Focus guide';
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
    const path = `/api/instagram/automations/1001/rules/${action === 'reorder' ? 'order' : source.id + (action === 'duplicate' ? '/duplicate' : '')}`;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { started = resolve; });
    await page.route(`**${path}`, async route => {
      started(); await gate;
      const response = await route.fetch({ url: `${fixtureApi}${path}`, headers: { ...route.request().headers(), ...ownerHeaders, connection: 'close' }, maxRetries: 0 });
      await route.fulfill({ response });
    }, { times: 1 });
    if (['activate', 'delete'].includes(action)) page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: label, exact: true }).click(); await pending;
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); release();
    if (action === 'duplicate') {
      await expect(page.getByLabel('Automation name', { exact: true })).toHaveValue('Focus guide (copy)', { timeout: 5000 });
      await page.getByRole('button', { name: 'Back to automations', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: 'Refresh automations', exact: true })).toBeEnabled({ timeout: 5000 });
    const saved = await api(request, '1001/rules');
    if (action === 'activate' || action === 'pause') {
      expect(saved.find((rule: { id: number }) => rule.id === source.id).status).toBe(action === 'activate' ? 'active' : 'paused');
      await expect(page.getByRole('button', { name: `${action === 'activate' ? 'Pause' : 'Activate'} Focus guide`, exact: true })).toBeEnabled();
    } else if (action === 'delete') {
      expect(saved.some((rule: { id: number }) => rule.id === source.id)).toBe(false);
      await expect(page.getByRole('button', { name: 'Focus guide', exact: true })).toHaveCount(0);
    } else if (action === 'reorder') expect(saved[0].definition.name).toBe('Second guide');
    else expect(saved.filter((rule: { definition: { name: string } }) => rule.definition.name.startsWith('Focus guide'))).toHaveLength(2);
  });
}


for (const field of ['text', 'media', 'type'] as const) {
  test(`a changed sample ${field} discards its pending match result`, async ({ page, request }) => {
    const saved = await seedRule(request, 'Sample guide');
    await view(page, 'details', `&ruleId=${saved.id}`);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { started = resolve; });
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
    const path = `/api/instagram/automations/1001/rules/${saved.id}/test`;
    await page.route(`**${path}`, async route => {
      const response = await route.fetch({ url: `${fixtureApi}${path}`, headers: { ...route.request().headers(), ...ownerHeaders, connection: 'close' }, maxRetries: 0 });
      started(); await gate; await route.fulfill({ response });
    }, { times: 1 });
    await page.getByRole('button', { name: 'Check sample comment', exact: true }).click(); await pending;
    if (field === 'text') await page.getByLabel('Sample comment', { exact: true }).fill('unrelated pineapple');
    else if (field === 'media') await page.getByLabel('Sample post or reel ID', { exact: true }).fill('changed-media');
    else await page.getByLabel('Sample content type', { exact: true }).selectOption('reel');
    release();
    await expect(page.getByRole('button', { name: 'Check sample comment', exact: true })).toBeEnabled({ timeout: 5000 });
    await expect(page.getByText('This automation would win the trigger match.', { exact: true })).toHaveCount(0, { timeout: 2000 });
    await page.getByRole('button', { name: 'Check sample comment', exact: true }).click();
    await expect(page.getByText(field === 'text' ? 'This comment does not match this automation.' : 'This automation would win the trigger match.', { exact: true })).toBeVisible();
  });
}
