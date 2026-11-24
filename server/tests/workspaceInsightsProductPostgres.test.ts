import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';

// Opt-in fixtures only. Authentication/module resolution are controlled boundaries;
// the router, SQL, runtime flags, Redis cache and readiness queries are real.
const databaseUrl = process.env.INSIGHTS_QA_DATABASE_URL;
const redisUrl = process.env.INSIGHTS_QA_REDIS_URL;
const suite = databaseUrl && redisUrl ? describe : describe.skip;
const schema = `insights_workflow_qa_${process.pid}`;
let pool: Pool;
let database: NodePgDatabase;
let redis: Redis;
let redisUnavailable = false;
let billingAllowed = true;
let modules = ['billing', 'outreach', 'support', 'crm'];
let pricing: Record<string,unknown>[] = [];
const active = new AsyncLocalStorage<{ userId: number; actorUserId: number; businessProfileId: number }>();
const scope = () => active.getStore() ?? { userId: 7, actorUserId: 7, businessProfileId: 11 };
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (...args: Parameters<NodePgDatabase['execute']>) => database.execute(...args),
  transaction: (...args: Parameters<NodePgDatabase['transaction']>) => database.transaction(...args),
} }));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.headers.authorization !== 'Bearer disposable-fixture') return res.sendStatus(401);
  active.run({ userId: 7, actorUserId: 7, businessProfileId: Number(req.headers['x-business-profile-id'] || 11) }, next);
} }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireAnyModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next() }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ requireBusinessScope: scope, currentBusinessScope: scope, withSystemScope: async (_reason: string, work: () => Promise<unknown>) => work() }));
jest.unstable_mockModule('../tenancy/billingContext.js', () => ({ currentBillingScope: () => ({ organizationId: 23 }) }));
jest.unstable_mockModule('../services/billing/organizations.js', () => ({ requireBillingRole: async () => {
  if (!billingAllowed) throw Object.assign(new Error('Billing permission required.'),{status:403});
  return {};
} }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => modules.map(key => ({ key, enabled: true })) }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => {
  if (redisUnavailable) throw new Error('Fixture Redis unavailable');
  return redis;
} }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({ getAllApiPricing: async () => pricing, getApiPricingByKey: async () => undefined }));
jest.unstable_mockModule('../services/GenAIPricingService.js', () => ({ getModelPrice: () => null }));
const { insightsRoutes } = await import('../routes/insights.routes.js');
const { clearInsightsRuntimeCache } = await import('../services/insights/RuntimeService.js');
const { getInsightsReadiness } = await import('../services/insights/ReadinessService.js');
const app = express().use('/api/insights', insightsRoutes);
const get = (suffix = '') => request(app).get(`/api/insights${suffix}`).set('Authorization', 'Bearer disposable-fixture');

suite('Insights workflow with disposable PostgreSQL and Redis', () => {
  beforeAll(async () => {
    for (const raw of [databaseUrl, redisUrl]) if (!raw || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname)) throw new Error('Explicit local fixtures required');
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    database = drizzle(pool);
    redis = new Redis(redisUrl!);
    await pool.query(`
      CREATE TABLE company_settings(id integer,user_id integer,timezone text);
      INSERT INTO company_settings VALUES(11,7,'UTC'),(12,7,'UTC');
      CREATE TABLE workspace_insights_runtime(id integer,enabled boolean,pricing_guard_enabled boolean,instrumentation_started_at timestamptz);
      INSERT INTO workspace_insights_runtime VALUES(1,true,true,'2026-01-01');
      CREATE TABLE ai_usage_events(id integer,business_profile_id integer,kind text,process text,provider text,model text,channel text,conversation_kind text,conversation_id integer,contact_id integer,status text,input_tokens integer,output_tokens integer,total_tokens integer,cached_tokens integer,reasoning_tokens integer,duration_ms integer,units numeric,occurred_at timestamptz);
      CREATE TABLE outreach_conversations(id integer,business_profile_id integer,crm_contact_id integer,channel text,user_id integer);
      CREATE TABLE outreach_messages(id integer,business_profile_id integer,conversation_id integer,direction text,status text,message_kind text,message_type text,sent_at timestamp,created_at timestamp,provider_message_id text,external_message_id text);
      CREATE TABLE support_chat_sessions(id integer,business_profile_id integer);
      CREATE TABLE support_chat_messages(id integer,business_profile_id integer,session_id integer,role text,processing_status text,metadata jsonb,created_at timestamp);
      CREATE TABLE sales_outcome_events(id serial,business_profile_id integer,user_id integer,actor_user_id integer,source_key text,kind text,contact_id integer,booking_id integer,conversation_kind text,conversation_id integer,channel text,amount numeric,currency text,evidence text,payment_id text,verified boolean,occurred_at timestamptz,UNIQUE(business_profile_id,source_key));
      CREATE TABLE crm_contacts(id integer,business_profile_id integer,merged_into_contact_id integer,first_name text,last_name text,company text,user_id integer,currency text,created_at timestamp);
      CREATE TABLE wallet_transactions(id integer,organization_id integer,billing_business_profile_id integer,type text,amount numeric,created_at timestamp,metadata jsonb,category text,reference_type text,reference_id text);
      CREATE TABLE tool_approvals(business_profile_id integer,status text,created_at timestamp);
      CREATE TABLE admin_api_credentials(platform text,config jsonb,is_active boolean);
      CREATE TABLE intent_classifier_credentials(platform text,config jsonb,is_active boolean);
      CREATE TABLE embedding_settings(default_provider text,default_model text,updated_at timestamptz);
      CREATE TABLE ai_settings(ai_provider text,ai_model text,image_provider text,image_model text,video_provider text,video_model text);
      INSERT INTO ai_usage_events(id,business_profile_id,kind,process,provider,model,channel,status,total_tokens,occurred_at) VALUES(1,11,'text','customer_chat','fixture','fixture','email','success',5,now()),(2,12,'text','customer_chat','fixture','fixture','email','success',99,now());
    `);
  });
  beforeEach(async () => {
    redisUnavailable = false;
    billingAllowed = true;
    modules = ['billing', 'outreach', 'support', 'crm'];
    pricing = [];
    clearInsightsRuntimeCache();
    const keys = await redis.keys('workspace-insights:v1:*');
    if (keys.length) await redis.del(...keys);
    await pool.query('TRUNCATE sales_outcome_events');
  });
  afterAll(async () => {
    if (redis) await redis.quit();
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
  });

  it('recovers from corrupt Redis JSON and replaces it with fresh scoped SQL results', async () => {
    expect((await get()).status).toBe(200);
    const [key] = await redis.keys('workspace-insights:v1:11:*');
    await redis.set(key!, '{invalid-json');
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body.performance.totalTokens).toBe(5);
    expect(JSON.parse((await redis.get(key!))!).performance.totalTokens).toBe(5);
  });
  it('serves computed results when Redis acquisition fails, including explicit refresh', async () => {
    redisUnavailable = true;
    for (const suffix of ['', '?refresh=1']) {
      const response = await get(suffix);
      expect(response.status).toBe(200);
      expect(response.body.performance.totalTokens).toBe(5);
    }
  });
  it('isolates businesses and refreshes cached facts over HTTP', async () => {
    expect((await get()).body.performance.totalTokens).toBe(5);
    expect((await get().set('x-business-profile-id', '12')).body.performance.totalTokens).toBe(99);
    await pool.query('UPDATE ai_usage_events SET total_tokens=6 WHERE id=1');
    expect((await get()).body.performance.totalTokens).toBe(5);
    expect((await get('?refresh=1')).body.performance.totalTokens).toBe(6);
    expect((await get()).body.performance.totalTokens).toBe(6);
    await pool.query('UPDATE ai_usage_events SET total_tokens=5 WHERE id=1');
    expect((await request(app).get('/api/insights')).status).toBe(401);
    expect((await get('?from=2026-02-30')).status).toBe(400);
    expect((await get('/details?kind=sales&limit=0')).status).toBe(400);
  });
  it('does not reuse a privileged cache after billing or module access changes', async () => {
    expect((await get()).body.costs.status).toBe('complete');
    billingAllowed = false;
    expect((await get()).body.costs.status).toBe('restricted');
    expect((await get('/details?kind=charges')).status).toBe(403);
    modules = ['crm'];
    const restricted = await get();
    expect(restricted.body.performance.status).toBe('restricted');
    expect((await get('/details?kind=usage')).status).toBe(403);
    expect((await get('/details?kind=sales')).status).toBe(200);
  });
  it('rejects detail cursors outside the PostgreSQL serial range before running the detail query', async () => {
    expect((await get('/details?kind=usage&cursor=2147483648')).status).toBe(400);
  });
  it('inventories unpriced active/recent models and reports missing historical conversion evidence', async () => {
    await pool.query(`INSERT INTO admin_api_credentials VALUES('openai','{"model":"fixture-unpriced","extractionModel":"fixture-unpriced"}',true);
      INSERT INTO wallet_transactions(id,organization_id,billing_business_profile_id,type,amount,created_at,metadata,category)
      VALUES(1,23,11,'deduction',-2,now(),'{}','fixture')`);
    try {
      const pending = await getInsightsReadiness();
      expect(pending.ready).toBe(false);
      expect(pending.unpriced).toEqual(expect.arrayContaining([expect.objectContaining({provider:'openai',model:'fixture-unpriced'})]));
      expect(pending.reconciliation.missingHistoricalRates).toBe(1);
      pricing = [['openai','fixture-unpriced'],['fixture','fixture']].map(([provider,model],index)=>({id:index+1,isActive:true,category:'llm',provider,pricingKey:`fixture:${index}`,updatedAt:new Date(),metadata:{model,verified:true,inputUsdPerMillion:1,outputUsdPerMillion:1}}));
      const ready = await getInsightsReadiness();
      expect(ready.ready).toBe(true);
      expect(ready.unpriced).toEqual([]);
      expect(ready.reconciliation.differenceCredits).toBe('0.00');
      expect(ready.reconciliation.missingHistoricalRates).toBe(1);
    } finally { await pool.query('TRUNCATE admin_api_credentials,wallet_transactions'); }
  });
  it('returns the rollout gate instead of cached data when runtime is disabled', async () => {
    expect((await get()).status).toBe(200);
    await pool.query('UPDATE workspace_insights_runtime SET enabled=false');
    clearInsightsRuntimeCache();
    try { expect((await get()).body.code).toBe('INSIGHTS_ROLLOUT_PENDING'); }
    finally { await pool.query('UPDATE workspace_insights_runtime SET enabled=true'); clearInsightsRuntimeCache(); }
  });

  (process.env.INSIGHTS_QA_BROWSER_URL ? it : it.skip)('mounts the real page with HTTP/SQL evidence in Chromium, reloads, refreshes, and supports keyboard at normal zoom', async () => {
    const browserUrl = new URL(process.env.INSIGHTS_QA_BROWSER_URL!);
    if (!['localhost','127.0.0.1','[::1]'].includes(browserUrl.hostname)) throw new Error('Local browser fixture required');
    const { chromium } = await import('playwright-core');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const folder = process.env.INSIGHTS_QA_EVIDENCE_DIR || '/tmp/insights-browser-evidence';
    await mkdir(folder,{recursive:true});
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    try {
      await pool.query('UPDATE workspace_insights_runtime SET instrumentation_started_at=now()');
      clearInsightsRuntimeCache();
      for (const width of [390,1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        const apiResponses: number[] = [];
        const apiPaths: string[] = [];
        const browserErrors: string[] = [];
        page.on('pageerror',error=>pageErrors.push(error.message));
        page.on('console',message=>{if(message.type()==='error') browserErrors.push(message.text());});
        page.on('requestfailed',request=>browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
        await page.addInitScript(() => {
          localStorage.setItem('user',JSON.stringify({id:7}));
          sessionStorage.setItem('active-business-profile:7','11');
          class FixtureSocket extends EventTarget { static OPEN=1; readyState=1; send() {} close() {} }
          Object.defineProperty(globalThis,'WebSocket',{value:FixtureSocket});
        });
        await page.route('**/*',route=>new URL(route.request().url()).origin===browserUrl.origin?route.continue():route.abort());
        await page.route('**/api/**',async route=>{
          const url = new URL(route.request().url());
          apiPaths.push(url.pathname);
          const cors = {'access-control-allow-origin':browserUrl.origin,'access-control-allow-credentials':'true'};
          const json = (body:unknown,status=200)=>route.fulfill({status,json:body,headers:cors});
          if (route.request().method()==='OPTIONS') return route.fulfill({status:204,headers:{...cors,'access-control-allow-methods':'GET,HEAD,OPTIONS','access-control-allow-headers':route.request().headers()['access-control-request-headers']||'Content-Type,Authorization,X-Business-Profile-Id,X-Billing-Organization-Id'}});
          if (route.request().method()!=='GET') return json({error:'Fixture rejects all mutations'},409);
          if (url.pathname.startsWith('/api/insights')) {
            const response = await get(url.pathname.slice('/api/insights'.length)+url.search);
            apiResponses.push(response.status);
            return json(response.body,response.status);
          }
          if (url.pathname==='/api/auth/me') return json({user:{id:7,name:'Synthetic Owner',email:'owner@example.test',isApproved:true,isSetupComplete:true,hasBusinessProfile:true,hasBrandToolkit:true}});
          if (url.pathname==='/api/platform/access') return json({maintenance:{enabled:false},modules:['billing','outreach','support','crm','campaigns','lead_generation','content','performance_marketing','storage','integrations'].map(key=>({key,name:key,enabled:true,status:'available',mode:'enabled'}))});
          if (url.pathname==='/api/settings/business-profiles') return json([{id:11,name:'Synthetic Business',companyName:'Synthetic Business',isDefault:true,role:'owner'}]);
          if (url.pathname==='/api/organizations') return json({organizations:[{id:23,businessProfileId:11,name:'Synthetic Business',ownerUserId:7,role:'owner',canManageBilling:true}],invitations:[],selectedOrganizationId:23});
          if (url.pathname==='/api/settings/preferences') return json({theme:'light',language:'en',timezone:'UTC'});
          if (url.pathname==='/api/wallet') return json({balance:100});
          if (url.pathname==='/api/notifications/unread/count') return json({count:0});
          if (url.pathname==='/api/chat/threads') return json({threads:[],total:0});
          return json([]);
        });
        await page.goto(`${browserUrl.origin}/dashboard/insights`);
        await page.waitForTimeout(1500);
        await writeFile(`${folder}/browser-${width}-initial.json`,JSON.stringify({url:page.url(),body:await page.locator('body').innerText(),apiPaths,pageErrors,browserErrors},null,2));
        await page.screenshot({path:`${folder}/insights-${width}-initial.png`,fullPage:true});
        await page.getByText('Last updated',{exact:false}).waitFor();
        await page.getByText(/Usage before Insights instrumentation/).waitFor();
        expect(await page.getByText('No activity in the selected period.',{exact:true}).count()).toBeGreaterThan(0);
        expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')).toBe(true);
        const refreshButton = page.getByRole('button',{name:'Refresh',exact:true});
        await refreshButton.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('status').filter({hasText:'Last updated'}).waitFor();
        await page.reload();
        await page.getByText('Last updated',{exact:false}).waitFor();
        await page.screenshot({path:`${folder}/insights-${width}-loaded.png`,fullPage:true});
        await pool.query('ALTER TABLE ai_usage_events RENAME TO ai_usage_events_unavailable');
        try {
          await page.getByRole('button',{name:'Refresh',exact:true}).click();
          await page.getByText('Showing the last successful snapshot.',{exact:false}).waitFor();
          await page.screenshot({path:`${folder}/insights-${width}-stale.png`,fullPage:true});
        } finally { await pool.query('ALTER TABLE ai_usage_events_unavailable RENAME TO ai_usage_events'); }
        await page.getByRole('button',{name:'Refresh',exact:true}).click();
        await page.getByText('Showing the last successful snapshot.',{exact:false}).waitFor({state:'hidden'});
        const details = page.getByRole('button',{name:/^Details for /}).first();
        await details.focus(); await page.keyboard.press('Enter');
        await page.getByRole('dialog').waitFor();
        await page.getByText('No matching records.',{exact:true}).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({state:'hidden'});
        expect(pageErrors).toEqual([]);
        expect(apiResponses).toContain(200); expect(apiResponses).toContain(500);
        await context.close();
      }
    } finally { await browser.close(); }
  },180_000);
});
