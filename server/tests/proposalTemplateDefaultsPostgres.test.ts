import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Page } from 'playwright-core';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Only an explicitly supplied disposable local database is accepted. No .env.
const connectionString = process.env.PROPOSAL_AUDIT_DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;
let admin: Pool, pool: Pool, database: NodePgDatabase;
let ownerId: number, businessId: number, otherBusinessId: number, ownerToken: string;
const forbiddenProvider = jest.fn(async () => { throw new Error('External effects are forbidden in proposal template tests'); });
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = database[key as keyof typeof database];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { notify: forbiddenProvider } }));
jest.unstable_mockModule('../services/emailService', () => ({ emailService: { sendEmailWithUserCredentials: forbiddenProvider } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: { createProviderForUser: forbiddenProvider } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { retrieveText: forbiddenProvider } }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { reserveOutreachCredit: forbiddenProvider, refundDeduction: forbiddenProvider } }));
jest.unstable_mockModule('../utils/emailTemplates', () => ({ getBrandInfo: async () => ({ companyName: 'Synthetic Business', primaryColor: '#14532d', logoUrl: null }), renderBrandedEmail: forbiddenProvider, renderAdminEmail: forbiddenProvider }));
jest.unstable_mockModule('../utils/email', () => ({ sendVerificationEmail: forbiddenProvider, sendResetPasswordEmail: forbiddenProvider, sendApprovalPendingEmail: forbiddenProvider, sendNewUserNotificationToAdmin: forbiddenProvider }));
jest.unstable_mockModule('../services/googleSignIn.js', () => ({ verifyGoogleCredential: forbiddenProvider }));
const { default: proposalsRouter } = await import('../routes/proposals.routes.js');
const { generateToken } = await import('../utils/jwt.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const { authenticateToken } = await import('../middleware/auth.js');
const { getCurrentUser } = await import('../controllers/authController.js');
const app = express(); app.use(express.json()); app.use('/api/proposals', proposalsRouter);
app.get('/api/auth/me', authenticateToken, getCurrentUser);
const ownerRequest = (method: 'get' | 'post' | 'put', url: string, business = businessId) => request(app)[method](url)
  .set('Authorization', `Bearer ${ownerToken}`).set('X-Business-Profile-Id', String(business));
const template = (name: string, isDefault = true) => ({ name, isDefault, termsAndConditions: 'Payment on completion.' });


async function browserJourney(width: number, work: (page: Page) => Promise<void>) {
    const base = process.env.PROPOSAL_AUDIT_BROWSER_URL!;
    const server = app.listen(58080, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: process.env.PROPOSAL_AUDIT_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await context.addCookies([{ name: 'asksales_session', value: ownerToken, url: base }]);
      await context.routeWebSocket('**/*', socket => {
        if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(socket.url()).hostname)) socket.connectToServer();
        else socket.close();
      });
      await context.addInitScript(({ ownerId, businessId }) => {
        const state = globalThis as unknown as { localStorage: { setItem(key: string, value: string): void }; sessionStorage: { setItem(key: string, value: string): void } };
        state.localStorage.setItem('user', JSON.stringify({ id: ownerId }));
        state.sessionStorage.setItem(`active-business-profile:${ownerId}`, String(businessId));
      }, { ownerId, businessId });
      // Only ancillary app-shell reads are mocked. Auth and proposal requests
      // traverse the real Next proxy, mounted router, services and database.
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.abort();
        const shell: Record<string, unknown> = {
          '/api/platform/access': { maintenance: { enabled: false }, modules: ['campaigns','lead_generation','content','performance_marketing','ai_visibility','outreach','crm','support','support_ai','proposals','knowledge_base','integrations','billing','storage'].map(key => ({ key, name: key, status: 'available', enabled: true, mode: 'enabled' })) },
          '/api/settings/preferences': { theme: 'light', currency: 'USD', timezone: 'UTC' },
          '/api/settings/business-profiles': [{ id: businessId, userId: ownerId, name: 'Synthetic Business', companyName: 'Synthetic Business', isDefault: true, role: 'owner' }],
          '/api/organizations': { organizations: [] }, '/api/wallet': { balance: 10000 }, '/api/notifications/unread/count': { count: 0 },
          '/api/settings/outreach/assistants/catalog': { runtimeEnabled: false, presets: [], accounts: [], models: [], permissions: { canManage: false } },
        };
        if (url.pathname in shell) return route.fulfill({ json: shell[url.pathname] });
        if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/proposals') && url.pathname !== '/api/auth/me') return route.fulfill({ json: [] });
        return route.continue();
      });
      const page = await context.newPage();
      const diagnostics = { pageErrors: [] as string[], consoleErrors: [] as string[], failedRequests: [] as string[] };
      page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
      page.on('requestfailed', req => diagnostics.failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
      try { await work(page); }
      catch (error) {
        if (process.env.PROPOSAL_AUDIT_EVIDENCE_DIR) {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(`${process.env.PROPOSAL_AUDIT_EVIDENCE_DIR}/browser-failure.json`, JSON.stringify({ url: page.url(), text: await page.locator('body').innerText(), ...diagnostics }, null, 2));
        }
        throw error;
      }
    } finally {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

databaseTests('proposal template defaults through the mounted router and PostgreSQL RLS', () => {
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/proposal_audit(?:_[a-z0-9_]+)?$/.test(url.pathname)) {
      throw new Error('Use a disposable local proposal_audit database');
    }
    admin = new Pool({ connectionString, options: '-c app.business_system=on' });
    const user = await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete,is_verified) VALUES($1,'unused','Synthetic Template Owner',true,true,true) RETURNING id", [`templates-${crypto.randomUUID()}@example.test`]);
    ownerId = Number(user.rows[0].id);
    const businesses = await admin.query("INSERT INTO company_settings(user_id,company_name,billing_organization_id) SELECT $1,n,id FROM billing_organizations CROSS JOIN (VALUES ('Synthetic Templates'),('Other Synthetic Business')) names(n) WHERE owner_user_id=$1 RETURNING id", [ownerId]);
    [businessId, otherBusinessId] = businesses.rows.map(row => Number(row.id));
    await admin.query("INSERT INTO brand_toolkits(user_id,business_profile_id,name) VALUES($1,$2,'Synthetic Brand')", [ownerId, businessId]);
    pool = new Pool({ connectionString, max: 12, options: '-c lock_timeout=5000 -c statement_timeout=15000' });
    database = drizzle(createBusinessScopedPool(pool));
    ownerToken = generateToken({ userId: ownerId, email: 'templates@example.test' });
  });
  afterAll(async () => {
    expect(forbiddenProvider).not.toHaveBeenCalled();
    await closeRedisConnections();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });
  beforeEach(async () => { await admin.query('DELETE FROM proposal_templates WHERE user_id=$1', [ownerId]); });

  it('persists every concurrent default create and exactly one default', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => ownerRequest('post', '/api/proposals/templates').send(template(`Concurrent ${i}`))));
    // Assert only scalar outcomes so failure logs cannot dump bearer headers.
    expect(results.map(result => result.status)).toEqual(Array(8).fill(201));
    const saved = await admin.query('SELECT id,is_default FROM proposal_templates WHERE user_id=$1 AND business_profile_id=$2', [ownerId, businessId]);
    expect(saved.rowCount).toBe(8);
    expect(saved.rows.filter(row => row.is_default)).toHaveLength(1);
    expect(new Set(results.map(result => result.body.data.id)).size).toBe(8);
  });

  it('serializes concurrent default updates and creates within only the selected business', async () => {
    const targets = await Promise.all(Array.from({ length: 4 }, (_, i) => ownerRequest('post', '/api/proposals/templates').send(template(`Target ${i}`, false))));
    const other = await ownerRequest('post', '/api/proposals/templates', otherBusinessId).send(template('Other default'));
    expect(other.status).toBe(201);
    const results = await Promise.all([
      ...targets.map(target => ownerRequest('put', `/api/proposals/templates/${target.body.data.id}`).send({ isDefault: true })),
      ...Array.from({ length: 4 }, (_, i) => ownerRequest('post', '/api/proposals/templates').send(template(`Mixed ${i}`))),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 200, 200, 200, 201, 201, 201, 201]);
    const defaults = await admin.query('SELECT id,business_profile_id FROM proposal_templates WHERE user_id=$1 AND is_default=true ORDER BY business_profile_id', [ownerId]);
    expect(defaults.rows.filter(row => row.business_profile_id === businessId)).toHaveLength(1);
    expect(defaults.rows.filter(row => row.business_profile_id === otherBusinessId).map(row => row.id)).toEqual([other.body.data.id]);
    const foreign = await ownerRequest('put', `/api/proposals/templates/${other.body.data.id}`).send({ isDefault: true });
    expect(foreign.status).toBe(404);
  });

  (process.env.PROPOSAL_AUDIT_BROWSER_URL ? it : it.skip)('saves and reloads approved default terms through the real template UI', async () => {
    await browserJourney(1440, async page => {
      const base = process.env.PROPOSAL_AUDIT_BROWSER_URL!;
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/dashboard/proposals/templates`);
      await page.getByRole('button', { name: 'Create template', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Browser default terms');
      await page.getByLabel('Customer copy', { exact: true }).fill('Deliver one agreed report.');
      await page.getByLabel('Terms and conditions', { exact: true }).fill('Payment on completion.');
      const choice = page.getByRole('checkbox', { name: 'Use as default template' });
      await choice.focus(); await page.keyboard.press('Space');
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/proposals/templates' && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Save template', exact: true }).click();
      expect((await saved).status()).toBe(201);
      await page.getByRole('heading', { name: 'Browser default terms', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('tab', { name: /My templates/ }).click();
      const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Browser default terms', exact: true }) });
      await card.getByText('Default terms', { exact: true }).waitFor();
      await card.getByRole('button', { name: 'Edit', exact: true }).click();
      expect(await choice.isChecked()).toBe(true);
      expect(await page.getByLabel('Terms and conditions', { exact: true }).inputValue()).toBe('Payment on completion.');
      const catalog = await admin.query("INSERT INTO proposal_catalog(user_id,business_profile_id,name,currency,unit_price,unit) VALUES($1,$2,'Approved report','USD',100,'report') RETURNING id", [ownerId, businessId]);
      const made = await ownerRequest('post', '/api/proposals').send({ title: 'Approved offer', recipientName: 'Synthetic Customer', recipientEmail: 'customer@example.test', currency: 'USD', termsAndConditions: 'Payment on completion.', lineItems: [{ catalogId: catalog.rows[0].id, name: 'Approved report', quantity: 1, unitPrice: 100, unit: 'report' }] });
      expect(made.status).toBe(201);
      const candidate = await ownerRequest('get', `/api/proposals/${made.body.data.id}`);
      expect(candidate.status).toBe(200);
      const { assertAutomaticProposalCommercials } = await import('../services/ProposalApprovalService.js');
      await expect(withBusinessScope({ userId: ownerId, businessProfileId: businessId }, () => assertAutomaticProposalCommercials(ownerId, candidate.body.data))).resolves.toBeUndefined();
      expect(errors).toEqual([]);
      if (process.env.PROPOSAL_AUDIT_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.PROPOSAL_AUDIT_EVIDENCE_DIR}/default-terms.png`, fullPage: true });
    });
  }, 180000);

  (process.env.PROPOSAL_AUDIT_BROWSER_URL ? it : it.skip).each([1440, 390])('keeps wizard labels readable and retires cancelled restore at %ipx', async width => {
    const made = await ownerRequest('post', '/api/proposals').send({ title: 'Synthetic editor offer', recipientName: 'Synthetic Customer', recipientEmail: 'customer@example.test', currency: 'USD', termsAndConditions: 'Payment on completion.', lineItems: [{ name: 'Report', quantity: 1, unitPrice: 100 }] });
    expect(made.status).toBe(201); const id = made.body.data.id;
    await browserJourney(width, async page => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${process.env.PROPOSAL_AUDIT_BROWSER_URL}/dashboard/proposals/${id}/edit`);
      const title = page.getByPlaceholder('Website launch for Acme');
      await title.waitFor({ timeout: 90000 });
      const savedA = page.waitForResponse(response => new URL(response.url()).pathname === `/api/proposals/${id}` && response.request().method() === 'PUT');
      await title.fill('Saved version A'); expect((await savedA).status()).toBe(200);
      const current = (await ownerRequest('get', `/api/proposals/${id}`)).body.data;
      expect((await ownerRequest('put', `/api/proposals/${id}`).send({ expectedRevision: current.revision, title: 'Other tab version' })).status).toBe(200);
      const stale = page.waitForResponse(response => new URL(response.url()).pathname === `/api/proposals/${id}` && response.request().method() === 'PUT');
      await title.fill('Unsaved stale B'); expect((await stale).status()).toBe(409);
      await page.reload(); await page.getByRole('button', { name: 'Restore draft', exact: true }).waitFor();
      let release!: () => void, held!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { held = resolve; });
      await page.route(`**/api/proposals/${id}`, async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch(); held(); await gate; await route.fulfill({ response });
      });
      await page.getByRole('button', { name: 'Restore draft', exact: true }).click(); await waiting;
      await page.getByRole('button', { name: 'Use current version', exact: true }).click();
      const savedC = page.waitForResponse(response => new URL(response.url()).pathname === `/api/proposals/${id}` && response.request().method() === 'PUT');
      await title.fill('Chosen current C'); release(); expect((await savedC).status()).toBe(200);
      expect(await title.inputValue()).toBe('Chosen current C');
      expect((await ownerRequest('get', `/api/proposals/${id}`)).body.data.title).toBe('Chosen current C');
      const labels = await page.locator('nav[aria-label="Proposal creation steps"] button span:last-child').evaluateAll(nodes => nodes.map(node => {
        const label = node as unknown as { textContent: string | null; getBoundingClientRect(): { height: number } };
        return { text: label.textContent, height: label.getBoundingClientRect().height };
      }));
      if (process.env.PROPOSAL_AUDIT_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.PROPOSAL_AUDIT_EVIDENCE_DIR}/editor-${width}.png`, fullPage: true });
      for (const label of labels) expect(label.height).toBeLessThanOrEqual(label.text === 'Scope and pricing' ? 44 : 24);
      const layout = await page.evaluate(() => {
        const viewport = globalThis as unknown as { innerWidth: number; visualViewport: { scale: number }; document: { documentElement: { scrollWidth: number } } };
        return { scale: viewport.visualViewport.scale, overflow: viewport.document.documentElement.scrollWidth > viewport.innerWidth };
      });
      expect(layout).toEqual({ scale: 1, overflow: false });
      const back = page.getByRole('button', { name: 'Back to proposals', exact: true }); await back.focus();
      expect(await back.evaluate(element => element === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement)).toBe(true);
      await back.click(); await page.waitForURL('**/dashboard/proposals'); expect(errors).toEqual([]);
    });
  }, 180000);

  (process.env.PROPOSAL_AUDIT_BROWSER_URL ? it : it.skip).each([false, true])('renders a persisted delivery failure (uncertain: %s) without implying success', async uncertain => {
    const team = await admin.query("INSERT INTO support_teams(user_id,business_profile_id,name,is_active) VALUES($1,$2,'Synthetic Team',true) RETURNING id", [ownerId, businessId]);
    const member = await admin.query("INSERT INTO team_members(user_id,business_profile_id,team_id,name,email,is_active) VALUES($1,$2,$3,'Synthetic Agent',$4,true) RETURNING id", [ownerId, businessId, team.rows[0].id, `agent-${crypto.randomUUID()}@example.test`]);
    const lead = await admin.query("INSERT INTO leads(user_id,business_profile_id,uuid,source,status,name,email) VALUES($1,$2,gen_random_uuid(),'manual','new','Synthetic Customer','customer@example.test') RETURNING id", [ownerId, businessId]);
    const session = await admin.query("INSERT INTO support_chat_sessions(member_id,business_profile_id,lead_id,title,session_expires_at,automation_mode) VALUES($1,$2,$3,'Synthetic Customer',NOW()+INTERVAL '1 day','ai_active') RETURNING id", [member.rows[0].id, businessId, lead.rows[0].id]);
    const conversation = await admin.query("INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,channel,external_thread_id,lead_name,lead_email,metadata) VALUES($1,$2,$3,'web',$4,'Synthetic Customer','customer@example.test',$5::jsonb) RETURNING id", [ownerId, businessId, lead.rows[0].id, `support-widget:${session.rows[0].id}`, JSON.stringify({ supportWidgetSessionId: session.rows[0].id })]);
    await admin.query('UPDATE support_chat_sessions SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify({ widgetProposalIdentity: { conversationId: conversation.rows[0].id, leadId: lead.rows[0].id } }), session.rows[0].id]);
    const made = await ownerRequest('post', '/api/proposals').send({ title: 'Synthetic delivery offer', coverNote: 'One agreed report.', recipientName: 'Synthetic Customer', recipientEmail: 'customer@example.test', currency: 'USD', termsAndConditions: 'Payment on completion.', showTermsAndConditions: true, autoOnboard: false, leadId: lead.rows[0].id, outreachConversationId: conversation.rows[0].id, lineItems: [{ name: 'Report', quantity: 1, unitPrice: 100, priceConfirmed: true }] });
    expect(made.status).toBe(201); const id = made.body.data.id;
    const { ProposalDeliveryService, proposalDeliveryService } = await import('../services/ProposalDeliveryService.js');
    const dispatch = jest.fn(async () => ({ success: false, outcomeUncertain: uncertain, error: 'Synthetic provider detail' }));
    // The mounted controller delegates to the real service with only its external
    // dispatch seam replaced. Readiness, approval, claim and receipts stay real.
    const delivery = new ProposalDeliveryService({ dispatch });
    const seam = jest.spyOn(proposalDeliveryService, 'send').mockImplementation(delivery.send.bind(delivery));
    try {
      await browserJourney(1440, async page => {
        await page.goto(`${process.env.PROPOSAL_AUDIT_BROWSER_URL}/dashboard/proposals/${id}?channel=web`);
        const prepared = page.waitForResponse(response => new URL(response.url()).pathname === `/api/proposals/${id}/prepare-delivery`);
        await page.getByRole('button', { name: 'Prepare delivery review', exact: true }).click();
        const preparation = await prepared;
        expect({ status: preparation.status(), request: preparation.request().postDataJSON(), body: await preparation.json() }).toMatchObject({ status: 200, body: { data: { ready: true } } });
        await page.getByRole('button', { name: 'Approve this exact version', exact: true }).click();
        const sent = page.waitForResponse(response => new URL(response.url()).pathname === `/api/proposals/${id}/send`);
        await page.getByRole('button', { name: 'Send approved proposal', exact: true }).click();
        const response = await sent; expect(response.status()).toBe(200);
        expect((await response.json()).data.delivery.state).toBe(uncertain ? 'uncertain' : 'failed');
        const alert = page.getByRole('alert').filter({ hasText: uncertain ? 'Delivery unconfirmed' : 'Delivery failed' });
        await alert.waitFor(); expect(await alert.textContent()).toContain('Synthetic provider detail');
        if (uncertain) {
          expect(await alert.textContent()).toContain('reconcile');
          expect(await page.getByRole('button', { name: 'Prepare another delivery' }).count()).toBe(0);
        } else await page.getByRole('button', { name: 'Review delivery again', exact: true }).waitFor();
        const persisted = await admin.query('SELECT status FROM proposals WHERE id=$1', [id]);
        expect(persisted.rows[0].status).toBe(uncertain ? 'delivery_unknown' : 'draft');
        expect(dispatch).toHaveBeenCalledTimes(1);
        if (process.env.PROPOSAL_AUDIT_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.PROPOSAL_AUDIT_EVIDENCE_DIR}/delivery-${uncertain ? 'uncertain' : 'failed'}.png`, fullPage: true });
      });
    } finally { seam.mockRestore(); }
  }, 180000);

  (process.env.PROPOSAL_AUDIT_BROWSER_URL ? it : it.skip)('honors the webchat delivery deep link from proposal authoring', async () => {
    const made = await ownerRequest('post', '/api/proposals').send({ title: 'Webchat deep link', recipientName: 'Synthetic Customer', currency: 'USD' });
    expect(made.status).toBe(201);
    await browserJourney(1440, async page => {
      await page.goto(`${process.env.PROPOSAL_AUDIT_BROWSER_URL}/dashboard/proposals/${made.body.data.id}?channel=web`);
      await page.getByRole('button', { name: 'Prepare delivery review', exact: true }).waitFor();
      expect(await page.locator('section[aria-labelledby="proposal-delivery-title"] select').first().inputValue()).toBe('web');
    });
  }, 180000);
});
