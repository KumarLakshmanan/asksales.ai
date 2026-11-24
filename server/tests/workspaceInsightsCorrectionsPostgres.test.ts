import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import { responseWrapper } from '../middleware/responseWrapper.js';

// Explicit disposable fixtures only. Authentication/catalog/role lookup are
// synthetic; mounted middleware, scopes, router, Drizzle SQL and Redis are real.
const local = process.env.WORKSPACE_INSIGHTS_CORRECTIONS_LOCAL_QA === '1' ? describe : describe.skip;
const databaseUrl = 'postgresql://postgres:insights_reconcile_disposable@127.0.0.1:55468/insights_reconcile_qa';
const schema = `insights_corrections_${process.pid}`;
let pool: Pool;
let database: NodePgDatabase;
let redis: Redis;
let redisUnavailable=false;
let billingAllowed=true;
let modules=['billing','outreach','support','crm'];

jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (...args: Parameters<NodePgDatabase['execute']>) => database.execute(...args),
} }));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.headers.authorization !== 'Bearer synthetic-corrections') return res.status(401).json({ success: false, error: 'Synthetic authentication required' });
  const businessProfileId = Number(req.headers['x-business-profile-id'] || 11);
  (req as unknown as { user: { id: number } }).user = { id: 7 };
  return withBusinessScope({ userId: 7, actorUserId: 7, businessProfileId, role: 'owner' }, () =>
    withBillingScope({ organizationId: 23, actorUserId: 7, businessProfileId, businessOwnerUserId: 7 }, next));
} }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getEffectiveModuleAccess: async () => modules.map(key => ({ key, name: key, enabled: true, status: 'available' })),
  getMaintenanceSettings: async () => ({ enabled: false, message: '' }),
}));
jest.unstable_mockModule('../services/billing/organizations.js', () => ({ requireBillingRole: async () => {
  if(!billingAllowed)throw Object.assign(new Error('Synthetic billing restriction'),{status:403});return {};
} }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => {
  if(redisUnavailable)throw new Error('Synthetic cache acquisition failure');return redis;
} }));
const { insightsRoutes } = await import('../routes/insights.routes.js');
const { clearInsightsRuntimeCache, getInsightsRuntime } = await import('../services/insights/RuntimeService.js');
const app = express().use('/api', responseWrapper).use('/api/insights', insightsRoutes);
const get = (suffix = '') => request(app).get('/api/insights' + suffix).set('Authorization', 'Bearer synthetic-corrections');

local('Workspace Insights correction acceptance through mounted HTTP and PostgreSQL', () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    try { await admin.query(`CREATE SCHEMA ${schema}`); } finally { await admin.end(); }
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    database = drizzle(pool);
    redis = new Redis('redis://127.0.0.1:56468/13');
    await pool.query(await readFile(new URL('./fixtures/workspaceInsightsCorrections.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    redisUnavailable=false;billingAllowed=true;modules=['billing','outreach','support','crm'];
    const keys = await redis.keys('workspace-insights:v1:*');
    if (keys.length) await redis.del(...keys);
    clearInsightsRuntimeCache();
    await pool.query('UPDATE workspace_insights_runtime SET enabled=true');
    await pool.query('TRUNCATE outreach_messages,outreach_conversations,support_chat_messages,support_chat_sessions');
    await pool.query('TRUNCATE wallet_transactions; DELETE FROM ai_usage_events WHERE id>3');
  });
  afterAll(async () => {
    if (redis) await redis.quit();
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
  });

  it('recovers corrupt and unavailable cache entries through the mounted response wrapper',async()=>{
    expect((await get()).body.data.performance.totalTokens).toBe(12);
    const [key]=await redis.keys('workspace-insights:v1:11:*');await redis.set(key!,'{invalid-json');
    const fresh=await get();expect(fresh.status).toBe(200);expect(fresh.body.data.performance.totalTokens).toBe(12);
    expect(JSON.parse((await redis.get(key!))!).performance.totalTokens).toBe(12);
    redisUnavailable=true;
    for(const suffix of ['', '?refresh=1']){const response=await get(suffix);expect(response.status).toBe(200);expect(response.body.data.performance.totalTokens).toBe(12);}
  });

  it('rechecks module and billing permissions before reusing a privileged cached response',async()=>{
    expect((await get()).body.data.costs.status).toBe('complete');
    billingAllowed=false;expect((await get()).body.data.costs.status).toBe('restricted');
    expect((await get('/details?kind=charges')).status).toBe(403);
    modules=[];const denied=await get();expect(denied.status).toBe(403);expect(denied.body.code).toBe('MODULE_UNAVAILABLE');
  });

  it('retains the integrated rollout code and blocks both cached summary and details',async()=>{
    expect((await get()).status).toBe(200);await pool.query('UPDATE workspace_insights_runtime SET enabled=false');clearInsightsRuntimeCache();
    try{
      for(const suffix of ['', '/details?kind=usage']){const response=await get(suffix);expect(response.status).toBe(503);expect(response.body).toEqual({success:false,error:'Insights is awaiting pricing and ledger validation.',code:'INSIGHTS_ROLLOUT_PENDING'});}
    }finally{await pool.query('UPDATE workspace_insights_runtime SET enabled=true');clearInsightsRuntimeCache();}
  });

  it('preserves an exact @ model identity in both summary and usage details', async () => {
    const summary = await get('?model=fixture%2Fmodel%40v1');
    const details = await get('/details?kind=usage&model=fixture%2Fmodel%40v1');
    expect(summary.status).toBe(200);
    expect(summary.body.data.performance.totalTokens).toBe(7);
    expect(summary.body.data.query.model).toBe('fixture/model@v1');
    expect(details.status).toBe(200);
    expect(details.body.data.items.map((row: { model: string }) => row.model)).toEqual(['fixture/model@v1']);
    const other = await get('?model=fixture%2Fmodel%40v1').set('X-Business-Profile-Id', '12');
    expect(other.body.data.performance.totalTokens).toBe(0);
  });

  it('continues to the next original conversation after an older thread is backfilled', async () => {
    for (const id of [1, 2, 3]) {
      await pool.query("INSERT INTO outreach_conversations(id,business_profile_id,channel) VALUES($1,11,'email')", [id]);
      await pool.query("INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,message_kind,message_type,created_at) VALUES($1,11,$1,'inbound','received','reply','text',CURRENT_DATE+$1::integer*interval '1 minute')", [id]);
    }
    const first = await get('/details?kind=conversations&limit=1');
    expect(first.status).toBe(200);
    expect(first.body.data.items[0].conversation.id).toBe(3);
    await pool.query("INSERT INTO outreach_conversations(id,business_profile_id,channel) VALUES(4,11,'email'); INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,message_kind,message_type,created_at) VALUES(4,11,4,'inbound','received','reply','text',CURRENT_DATE)");
    const second = await get(`/details?kind=conversations&limit=1&cursor=${first.body.data.nextCursor}`);
    expect(second.status).toBe(200);
    expect(second.body.data.items[0].conversation.id).toBe(2);
  });

  it('keeps mixed-source cursor identities stable across backfills and message-date updates', async () => {
    await pool.query(`
      INSERT INTO outreach_conversations(id,business_profile_id,channel) VALUES(1,11,'email'),(2,11,'email'),(3,11,'email'),(99,12,'email');
      INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,created_at) VALUES
        (1,11,1,'inbound','received',CURRENT_DATE+interval '1 minute'),
        (2,11,2,'inbound','received',CURRENT_DATE+interval '2 minutes'),
        (3,11,3,'inbound','received',CURRENT_DATE+interval '3 minutes'),
        (99,12,99,'inbound','received',CURRENT_DATE);
      INSERT INTO support_chat_sessions(id,business_profile_id) VALUES(1,11),(2,11);
      INSERT INTO support_chat_messages(id,business_profile_id,session_id,role,created_at) VALUES(1,11,1,'user',CURRENT_DATE),(2,11,2,'user',CURRENT_DATE);
    `);
    const first = await get('/details?kind=conversations&limit=2');
    expect(first.status).toBe(200);
    const seen = first.body.data.items.map((row: { conversation: { kind: string; id: number } }) => `${row.conversation.kind}:${row.conversation.id}`);
    await pool.query(`
      INSERT INTO outreach_conversations(id,business_profile_id,channel) VALUES(4,11,'email');
      INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,created_at) VALUES(4,11,4,'inbound','received',CURRENT_DATE),(5,11,3,'inbound','received',CURRENT_DATE);
      UPDATE outreach_messages SET created_at=CURRENT_DATE WHERE id=2;
    `);
    let cursor = first.body.data.nextCursor;
    while (cursor) {
      const page = await get(`/details?kind=conversations&limit=2&cursor=${cursor}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.data.items.map((row: { conversation: { kind: string; id: number } }) => `${row.conversation.kind}:${row.conversation.id}`));
      cursor = page.body.data.nextCursor;
      if (seen.length > 5) throw new Error('Pagination duplicated a conversation');
    }
    expect(seen).toEqual(['outreach:3', 'widget:2', 'outreach:2', 'widget:1', 'outreach:1']);
    expect(new Set(seen).size).toBe(5);
  });

  it('includes maximum serial IDs from both conversation sources and bounds their cursors', async () => {
    await pool.query(`
      INSERT INTO outreach_conversations(id,business_profile_id,channel) VALUES(2147483647,11,'email');
      INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,created_at) VALUES(1,11,2147483647,'inbound','received',CURRENT_DATE);
      INSERT INTO support_chat_sessions(id,business_profile_id) VALUES(2147483647,11);
      INSERT INTO support_chat_messages(id,business_profile_id,session_id,role,created_at) VALUES(1,11,2147483647,'user',CURRENT_DATE);
    `);
    const first = await get('/details?kind=conversations&limit=1');
    expect(first.status).toBe(200);
    expect(first.body.data.items[0].conversation).toEqual({ kind: 'widget', id: 2147483647 });
    expect(first.body.data.nextCursor).toBe('c1:4294967295');
    const second = await get(`/details?kind=conversations&limit=1&cursor=${first.body.data.nextCursor}`);
    expect(second.status).toBe(200);
    expect(second.body.data.items[0].conversation).toEqual({ kind: 'outreach', id: 2147483647 });
    expect(second.body.data.nextCursor).toBeNull();
    for (const cursor of ['3', 'c1:4294967297', 'c1:0', 'c1:-1', 'c1:2.5', 'c1:abc']) {
      expect((await get(`/details?kind=conversations&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    }
  });

  it('applies the selected process to summary usage/cost and their detail SQL', async () => {
    await pool.query(`
      INSERT INTO ai_usage_events(id,business_profile_id,kind,process,provider,model,channel,status,total_tokens,occurred_at) VALUES(4,11,'text','routing','fixture','fixture','email','success',11,now());
      INSERT INTO wallet_transactions(id,organization_id,billing_business_profile_id,type,amount,created_at,metadata,category) VALUES
        (1,23,11,'deduction',-2,now(),'{}','customer_chat'),(2,23,11,'deduction',-9,now(),'{}','routing');
    `);
    const summary = await get('?process=customer_chat');
    expect(summary.status).toBe(200);
    expect(summary.body.data.filters.processes).toEqual(expect.arrayContaining(['customer_chat', 'routing']));
    expect(summary.body.data.performance.totalTokens).toBe(12);
    expect(summary.body.data.costs.net.credits).toBe('2.00');
    const usage = await get('/details?kind=usage&process=customer_chat');
    expect(usage.status).toBe(200);
    expect(usage.body.data.items).toHaveLength(2);
    expect(usage.body.data.items.every((row: { process: string }) => row.process === 'customer_chat')).toBe(true);
    const charges = await get('/details?kind=charges&process=customer_chat');
    expect(charges.status).toBe(200);
    expect(charges.body.data.items.map((row: { credits: string }) => row.credits)).toEqual(['2.00']);
  });

  it('gates a cold missing runtime table and recovers once the table is restored', async () => {
    await pool.query('ALTER TABLE workspace_insights_runtime RENAME TO workspace_insights_runtime_missing');
    clearInsightsRuntimeCache();
    try {
      expect((await get()).status).toBe(503);
      expect((await get('/details?kind=usage')).status).toBe(503);
      await expect(getInsightsRuntime()).resolves.toEqual({ enabled: false, pricingGuardEnabled: false, instrumentationStartedAt: null });
    } finally {
      await pool.query('ALTER TABLE workspace_insights_runtime_missing RENAME TO workspace_insights_runtime');
    }
    expect((await get()).status).toBe(200);
  });

  it('propagates an unrelated wrapped PostgreSQL error instead of disguising it as disabled runtime', async () => {
    await pool.query('ALTER TABLE workspace_insights_runtime RENAME COLUMN enabled TO enabled_missing');
    clearInsightsRuntimeCache();
    try {
      await expect(getInsightsRuntime()).rejects.toMatchObject({ cause: { code: '42703' } });
      expect((await get()).status).toBe(500);
    } finally {
      await pool.query('ALTER TABLE workspace_insights_runtime RENAME COLUMN enabled_missing TO enabled');
      clearInsightsRuntimeCache();
    }
    expect((await get()).status).toBe(200);
  });

  (process.env.WORKSPACE_INSIGHTS_CORRECTIONS_BROWSER === '1' ? it : it.skip)('accepts filters, stable cursors and detail retry in the production shell at normal zoom', async () => {
    const { chromium } = await import('playwright-core');
    const output = fileURLToPath(new URL('../../evidence/browser/', import.meta.url));
    await mkdir(output, { recursive: true });
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const facts: unknown[] = [];
    try {
      for (const width of [320, 768, 1440]) {
        await pool.query(`
          TRUNCATE outreach_messages,outreach_conversations;
          INSERT INTO outreach_conversations(id,business_profile_id,channel) SELECT n,11,'email' FROM generate_series(1,35) n;
          INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,created_at)
            SELECT n,11,n,'inbound','received',CURRENT_DATE+n*interval '1 minute' FROM generate_series(1,35) n;
        `);
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage(); page.setDefaultTimeout(15_000);
        const errors: string[] = [], mutations: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
          localStorage.setItem('user', JSON.stringify({ id: 7 }));
          sessionStorage.setItem('active-business-profile:7', '11');
          class Socket extends EventTarget { static OPEN = 1; readyState = 1; send() {} close() {} }
          Object.defineProperty(globalThis, 'WebSocket', { value: Socket });
        });
        await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3113' ? route.continue() : route.abort());
        await page.route('**/api/**', async route => {
          const req = route.request(), url = new URL(req.url());
          const cors = { 'access-control-allow-origin': 'http://127.0.0.1:3113', 'access-control-allow-credentials': 'true' };
          const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: cors });
          if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,HEAD,OPTIONS', 'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*' } });
          if (req.method() !== 'GET') { mutations.push(req.method() + ' ' + url.pathname); return json({ error: 'Synthetic audit rejects mutations' }, 405); }
          if (url.pathname.startsWith('/api/insights')) {
            const response = await get(url.pathname.slice('/api/insights'.length) + url.search);
            return json(response.body, response.status);
          }
          if (url.pathname === '/api/auth/me') return json({ user: { id: 7, name: 'Synthetic Owner', email: 'owner@example.test', isApproved: true, isSetupComplete: true, hasBusinessProfile: true, hasBrandToolkit: true } });
          if (url.pathname === '/api/platform/access') return json({ maintenance: { enabled: false }, modules: ['billing', 'outreach', 'support', 'crm', 'campaigns', 'lead_generation', 'content', 'performance_marketing', 'storage', 'integrations'].map(key => ({ key, name: key, enabled: true, status: 'available', mode: 'enabled' })) });
          if (url.pathname === '/api/settings/business-profiles') return json([{ id: 11, name: 'Synthetic Business', companyName: 'Synthetic Business', isDefault: true, role: 'owner' }]);
          if (url.pathname === '/api/organizations') return json({ organizations: [{ id: 23, businessProfileId: 11, name: 'Synthetic Business', ownerUserId: 7, role: 'owner', canManageBilling: true }], selectedOrganizationId: 23, invitations: [] });
          if (url.pathname === '/api/settings/preferences') return json({ theme: 'light', language: 'en', timezone: 'UTC' });
          if (url.pathname === '/api/wallet') return json({ balance: 100 });
          if (url.pathname === '/api/notifications/unread/count') return json({ count: 0 });
          if (url.pathname === '/api/chat/threads') return json({ threads: [], total: 0 });
          return json([]);
        });
        await page.goto('http://127.0.0.1:3113/dashboard/settings');
        if (width < 1024) { await page.getByRole('button', { name: 'Show sidebar', exact: true }).focus(); await page.keyboard.press('Enter'); }
        await page.getByRole('link', { name: 'Insights', exact: true }).focus(); await page.keyboard.press('Enter');
        await page.waitForURL('http://127.0.0.1:3113/dashboard/insights');
        if (width < 1024) await page.getByRole('dialog', { name: 'Dashboard navigation', exact: true }).waitFor({ state: 'hidden' });
        const process = page.getByLabel('Filter by process');
        await process.locator('option[value="customer_chat"]').waitFor({ state: 'attached' });
        const processResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/insights' && new URL(r.url()).searchParams.get('process') === 'customer_chat' && r.status() === 200);
        await process.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
        await processResponse; await process.locator('option[value="customer_chat"]').waitFor({ state: 'attached' });
        expect(await process.inputValue()).toBe('customer_chat');
        const modelResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/insights' && new URL(r.url()).searchParams.get('model') === 'fixture/model@v1' && r.status() === 200);
        await page.getByLabel('Filter by model').selectOption('fixture/model@v1');
        const filtered = (await (await modelResponse).json()).data;
        expect(filtered.query).toMatchObject({ model: 'fixture/model@v1', process: 'customer_chat' });
        expect(filtered.performance.totalTokens).toBe(7);
        await page.getByText('tokens', { exact: true }).locator('..').getByText('7', { exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Insights', exact: true }).click();
        const platforms = await page.evaluate(`(() => {
          const first=Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='All platforms');
          return Array.from(first.parentElement.querySelectorAll('button')).map(button=>({label:button.textContent,client:button.clientWidth,scroll:button.scrollWidth}));
        })()`) as Array<{label:string;client:number;scroll:number}>;
        expect(platforms.filter(button => button.scroll > button.client + 1)).toEqual([]);
        await page.screenshot({ path: `${output}/${width}-filters.png`, fullPage: true });

        await pool.query('ALTER TABLE ai_usage_events RENAME TO ai_usage_events_outage');
        try {
          await page.getByRole('button',{name:'Refresh',exact:true}).click();
          await page.getByText('Showing the last successful snapshot.',{exact:false}).waitFor();
          await page.getByText('tokens',{exact:true}).locator('..').getByText('7',{exact:true}).waitFor();
          await page.getByRole('status').filter({hasText:'Last updated'}).waitFor();
          await page.screenshot({path:`${output}/${width}-stale-refresh.png`,fullPage:true});
        }finally{await pool.query('ALTER TABLE ai_usage_events_outage RENAME TO ai_usage_events');}
        await page.getByRole('button',{name:'Refresh',exact:true}).click();
        await page.getByText('Showing the last successful snapshot.',{exact:false}).waitFor({state:'hidden'});

        await pool.query('ALTER TABLE wallet_transactions RENAME TO wallet_transactions_outage');
        try {
          await page.getByRole('button', { name: 'Details for Credits consumed', exact: true }).click();
          await page.getByRole('dialog').getByText('Could not load records.', { exact: true }).waitFor();
        } finally { await pool.query('ALTER TABLE wallet_transactions_outage RENAME TO wallet_transactions'); }
        await page.getByRole('button', { name: 'Retry records', exact: true }).focus(); await page.keyboard.press('Enter');
        await page.getByRole('dialog').getByText('No matching records.', { exact: true }).waitFor();
        await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });

        const firstResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/insights/details' && new URL(r.url()).searchParams.get('kind') === 'conversations' && r.status() === 200);
        await page.getByRole('button', { name: 'Details for Conversations trend', exact: true }).click();
        const first = (await (await firstResponse).json()).data;
        expect(first.items).toHaveLength(30); expect(first.nextCursor).toBe('c1:12');
        await pool.query("INSERT INTO outreach_conversations(id,business_profile_id,channel) VALUES(36,11,'email'); INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,created_at) VALUES(36,11,36,'inbound','received',CURRENT_DATE); UPDATE outreach_messages SET created_at=CURRENT_DATE WHERE id=1");
        const nextResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/insights/details' && new URL(r.url()).searchParams.get('cursor') === first.nextCursor && r.status() === 200);
        await page.getByRole('button', { name: 'Next page', exact: true }).focus(); await page.keyboard.press('Enter');
        const second = (await (await nextResponse).json()).data;
        expect(second.items.map((row: { conversation: { id: number } }) => row.conversation.id)).toEqual([5, 4, 3, 2, 1]);
        await page.getByRole('dialog').getByText('email conversation · 1 messages', { exact: true }).first().waitFor();
        expect(await page.getByRole('dialog').getByText('email conversation · 1 messages', { exact: true }).count()).toBe(5);
        await page.screenshot({ path: `${output}/${width}-continued-details.png`, fullPage: true });
        await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.reload(); await process.locator('option[value="customer_chat"]').waitFor({ state: 'attached' });
        await page.getByText('tokens', { exact: true }).locator('..').getByText('12', { exact: true }).waitFor();
        if(width===1440){
          modules=[];
          try{
            await page.getByRole('button',{name:'Refresh',exact:true}).click();
            await page.locator('[role="alert"].rounded-xl').waitFor();
            expect(await page.getByText('AI performance',{exact:true}).count()).toBe(0);
            expect(await page.getByText(/Showing the last successful snapshot/).count()).toBe(0);
          }finally{modules=['billing','outreach','support','crm'];}
          await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('AI performance',{exact:true}).waitFor();
          await pool.query('UPDATE workspace_insights_runtime SET enabled=false');clearInsightsRuntimeCache();
          try{
            await page.getByRole('button',{name:'Refresh',exact:true}).click();
            await page.getByText('Insights will open after model prices and wallet totals are verified.',{exact:true}).waitFor();
            expect(await page.getByText('AI performance',{exact:true}).count()).toBe(0);
          }finally{await pool.query('UPDATE workspace_insights_runtime SET enabled=true');clearInsightsRuntimeCache();}
          await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('AI performance',{exact:true}).waitFor();
        }
        const overflow = await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1');
        expect(overflow).toBe(false); expect(errors).toEqual([]); expect(mutations).toEqual([]);
        facts.push({ width, deviceScaleFactor: 1, process: filtered.query.process, model: filtered.query.model, tokens: filtered.performance.totalTokens, cursor: first.nextCursor, nextConversationIds: second.items.map((row: { conversation: { id: number } }) => row.conversation.id), platformWidths:platforms, keyboardNavigation: true, detailRetry: true, staleSnapshotRetained:true,deniedSnapshotHidden:width===1440,rolloutGateVerified:width===1440,reload: true, overflow, pageErrors: errors, applicationMutations: mutations });
        await context.close();
      }
    } finally {
      await writeFile(output + '/results.json', JSON.stringify(facts, null, 2) + '\n');
      await browser.close();
    }
  }, 180_000);
});
