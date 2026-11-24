// Opt-in local production-frontend acceptance. Never points at customer data or providers.
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { responseWrapper } from '../middleware/responseWrapper.js';

let database: NodePgDatabase;
let client: Client;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let mode = 'normal'; let held: Array<() => void> = [];
const requests: Array<Record<string, unknown>> = [];
const logs: Array<Record<string, unknown>> = [];
const evidenceDirectory = process.env.FOLLOW_UP_BROWSER_EVIDENCE_DIR;
const scope = (work: () => unknown) => withBusinessScope({ userId: 4101, businessProfileId: 4102, actorUserId: 4101, role: 'owner' }, work);
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_t,key) => {
  const value = (database as unknown as Record<PropertyKey, unknown>)[key]; return typeof value === 'function' ? value.bind(database) : value;
} }) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error {}, resolveContentBrandContext: async () => ({
    businessProfile: { id: 4102, version: 1, isApproved: true }, brandToolkit: { id: 4202, version: 1, isApproved: true },
  }), brandContextSnapshot: () => ({ provenance: { businessProfile: { version: 1 }, brandToolkit: { version: 1 } } }),
}));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: (req: express.Request,_res: express.Response,next: () => void) => {
  req.user = { id: 4101, email: 'synthetic@example.test', name: 'Synthetic auditor' }; scope(next);
} }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => (_req: unknown,_res: unknown,next: () => void) => next() }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ requireCredits: () => (_req: unknown,_res: unknown,next: () => void) => next() }));
jest.unstable_mockModule('../routes/outreachAssistants.routes.js', () => ({ default: express.Router() }));
// Unrelated controller exports are inert, but the actual mounted settings/template routers,
// validators, response wrapper, controllers and Drizzle persistence remain real.
const controllerMocks = new Map<string, Set<string>>();
for (const name of ['settings', 'content']) {
  const text = readFileSync(new URL(`../routes/${name}.routes.ts`, import.meta.url), 'utf8');
  for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const path = match[2];
    if (!path.startsWith('../controllers/') || /(?:settingsController|contentTemplatesController)\.js$/.test(path)) continue;
    const exports = controllerMocks.get(path) || new Set<string>();
    for (const part of match[1].split(',')) if (part.trim()) exports.add(part.trim());
    controllerMocks.set(path, exports);
  }
}
for (const [path,names] of controllerMocks) jest.unstable_mockModule(path, () => Object.fromEntries([...names].map(name => {
  const noop = (_req: unknown,_res: unknown,next?: () => void) => next?.();
  return [name, Object.assign(noop,{ single: () => noop,array: () => noop,fields: () => noop })];
})));
const settingsRouter = (await import('../routes/settings.routes.js')).default;
const contentRouter = (await import('../routes/content.routes.js')).default;
const app = express(); app.use(express.json());
app.use((req,res,next) => {
  res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:32800'); res.setHeader('Access-Control-Allow-Credentials','true');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Business-Profile-Id,X-Billing-Organization-Id,X-XSRF-TOKEN,Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods','GET,PUT,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers','Content-Request-Confirmed,Idempotency-Replayed');
  if(req.method === 'OPTIONS') { res.sendStatus(204); return; }
  requests.push({ method:req.method,path:req.path,headers:req.headers,body:req.body });
  if(mode === 'get-error' && /\/integrations\/.*\/follow-ups$/.test(req.path) && req.method === 'GET') { res.status(503).json({error:'Synthetic settings read unavailable'}); return; }
  if(mode === 'history-stall' && req.path === '/api/sent-messages') return;
  if(mode === 'template-lost-ack' && req.path === '/api/content/templates' && req.method === 'POST') {
    mode = 'normal'; const end = res.end.bind(res); res.end = ((...args: unknown[]) => { held.push(() => Reflect.apply(end, res, args)); return res; }) as typeof res.end;
  }
  next();
});
app.use('/api' ,responseWrapper);
app.get('/api/auth/me',(_req,res) => res.json({user:{id:4101,email:'synthetic@example.test',name:'Synthetic auditor',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}}));
app.get('/api/auth/csrf-token',(_req,res) => res.json({csrfToken:'synthetic'}));
app.get('/api/settings/business-profiles',(_req,res) => res.json([{id:4102,name:'Synthetic workspace',companyName:'Synthetic',isDefault:true,role:'owner'}]));
app.get('/api/platform/access',(_req,res) => res.json({maintenance:{enabled:false,message:''},modules:['campaigns','lead_generation','content','performance_marketing','ai_visibility','outreach','crm','support','support_ai','proposals','knowledge_base','integrations','billing','storage'].map(key=>({key,name:key,enabled:true,status:'available'}))}));
app.get('/api/settings/preferences',(_req,res) => res.json({theme:'light',language:'en',timezone:'UTC'}));
app.get('/api/organizations',(_req,res) => res.json({organizations:[]}));
app.get('/api/wallet',(_req,res) => res.json({balance:10000}));
app.get('/api/chat/threads',(_req,res) => res.json({threads:[],total:0}));
app.get('/api/notifications/unread/count',(_req,res) => res.json({count:0}));
app.get('/api/sent-messages',(_req,res) => res.json([]));
app.use('/api/settings',settingsRouter); app.use('/api/content',contentRouter);
app.use((_req,res) => res.status(404).json({error:'Outside synthetic audit scope'}));
const seed = async () => {
  const config = {enabled:true,maxFollowUps:2,followUps:[{id:'1',enabled:false,delayHours:1,templateId:-1},{id:'2',enabled:true,delayDays:1,templateId:-1}]};
  await client.query('TRUNCATE outreach_settings,content_templates,content_template_versions,content_request_receipts RESTART IDENTITY');
  const res=await request(app).put('/api/settings/outreach').send({enableAutoFollowUp:true,followUps:{email:config}});
  expect(res.status).toBe(200);
};

(process.env.FOLLOW_UP_BROWSER_QA === '1' ? describe : describe.skip)('Followup corrections production frontend to mounted router PostgreSQL acceptance',() => {
  beforeAll(async () => {
    const url=process.env.OUTREACH_QA_DATABASE_URL!;
    if(new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/followup_qa') throw new Error('Disposable local fixture only');
    client = new Client({connectionString:url}); await client.connect();
    await client.query('CREATE TEMP TABLE audit_anchor(id integer); SET search_path TO pg_temp,pg_catalog');
    database=drizzle(client);
    await client.query(`CREATE TABLE outreach_settings (
      id serial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT 4102, user_id integer NOT NULL,
      email_provider text DEFAULT 'gmail', sender_name text, sender_email text, reply_to_email text, email_signature text,
      enable_auto_follow_up boolean DEFAULT false, follow_up_delay integer DEFAULT 3, follow_up_delay_hours integer DEFAULT 72,
      max_follow_ups integer DEFAULT 3, follow_up_steps jsonb DEFAULT '[]', channel_follow_ups jsonb DEFAULT '{}',
      enable_tracking boolean DEFAULT true, personalize_messages boolean DEFAULT true, send_time_optimization boolean DEFAULT true,
      daily_email_limit integer DEFAULT 200, auto_ticket_dedup_window_minutes integer DEFAULT 30,
      block_on_zero_credit boolean DEFAULT false, slack_webhook_url text, created_at timestamp DEFAULT NOW(), updated_at timestamp DEFAULT NOW(),
      UNIQUE(business_profile_id,user_id)
    );
    CREATE TABLE content_templates (
      id serial PRIMARY KEY, user_id integer, brand_toolkit_id integer, business_profile_id integer,
      name varchar(255) NOT NULL, type varchar(50) NOT NULL, subject text, content text NOT NULL, html_content text,
      variables jsonb DEFAULT '[]', category varchar(100), tags jsonb DEFAULT '[]', description text, thumbnail_url text,
      is_predefined boolean DEFAULT false, usage_count integer DEFAULT 0, last_used_at timestamp,
      is_approved boolean DEFAULT false, approved_by integer, approved_at timestamp, version integer DEFAULT 1 NOT NULL,
      brand_context_snapshot jsonb DEFAULT '{}' NOT NULL, created_at timestamp DEFAULT NOW() NOT NULL, updated_at timestamp DEFAULT NOW() NOT NULL
    );
    CREATE TABLE content_template_versions (
      id serial PRIMARY KEY, business_profile_id integer DEFAULT 4102, template_id integer NOT NULL REFERENCES content_templates(id) ON DELETE CASCADE, user_id integer, version integer NOT NULL,
      snapshot jsonb NOT NULL, created_by integer, created_at timestamp DEFAULT NOW(), UNIQUE(template_id, version)
    );
    CREATE TABLE content_request_receipts (
      business_profile_id integer NOT NULL, user_id integer NOT NULL, request_key varchar(200) NOT NULL,
      request_hash varchar(64) NOT NULL, state varchar(20) DEFAULT 'pending', status_code integer,
      response_body jsonb, created_at timestamptz DEFAULT NOW(), completed_at timestamptz,
      PRIMARY KEY(business_profile_id,user_id,request_key)
    )`);
    server=app.listen(32801,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
  });
  beforeEach(async()=>{mode='normal';held=[];requests.length=0;await seed();});
  afterAll(async()=>{await new Promise<void>(resolve=>server?.close(()=>resolve()));await client?.end();if(evidenceDirectory)writeFileSync(join(evidenceDirectory,'browser-evidence.json'),JSON.stringify(logs,null,2));});

  async function browserSession() {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox','--disable-background-networking','--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:32800/dashboard/outreach/follow-ups?channel=email');
    await page.getByRole('button',{name:'Save Settings',exact:true}).waitFor({timeout:60000});
    return { browser, page };
  }
  it('preserves disabled steps and opaque IDs through the production UI and mounted API',async()=>{
    const {browser,page}=await browserSession();try {
      const before=(await client.query('SELECT channel_follow_ups FROM outreach_settings')).rows[0].channel_follow_ups.email;
      expect(await page.getByLabel('Enable step 1',{exact:true}).isChecked()).toBe(false);
      await page.getByRole('button',{name:'Save Settings',exact:true}).click();
      await page.getByText('Follow-up settings updated successfully.',{exact:true}).first().waitFor();
      const after=(await client.query('SELECT channel_follow_ups FROM outreach_settings')).rows[0].channel_follow_ups.email;
      expect(after.followUps).toEqual(before.followUps);expect(after.followUps[0].id).toBe('1');expect(after.followUps[0].enabled).toBe(false);
      expect(after.revision).not.toBe(before.revision); logs.push({case:'production-step-dto',before,after});
    }finally{await browser.close();}
  },90000);
  it('keeps keyboard focus at both template openers and exposes all channel navigation at normal zoom',async()=>{
    const {browser,page}=await browserSession();try {
      for(const label of ['Email','WhatsApp','Instagram','Facebook','SMS']) {await page.getByRole('tab',{name:label,exact:true}).click();await page.getByRole('button',{name:'Save Settings',exact:true}).waitFor();}
      await page.waitForURL(/channel=sms/);
      const inline=page.getByRole('button',{name:'Create template for step 1',exact:true});await inline.click();await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});await inline.and(page.locator(':focus')).waitFor({timeout:2500});
      await page.getByRole('tab',{name:'Templates',exact:true}).click();const create=page.getByRole('button',{name:'Create template',exact:true});await create.click();
      await page.getByRole('dialog').waitFor();await page.getByLabel('Template name',{exact:true}).fill('Cancelled private draft');await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({state:'hidden'});
      await create.and(page.locator(':focus')).waitFor({timeout:2500});
      expect(await create.and(page.locator(':focus')).count()).toBe(1);
      await create.click();expect(await page.getByLabel('Template name',{exact:true}).inputValue()).toBe('');await page.keyboard.press('Escape');
      await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Settings',exact:true}).click();
      const screenshot=await page.screenshot({...(evidenceDirectory?{path:join(evidenceDirectory,'mobile-final.png')}:{}),fullPage:true});
      const dimensions={viewportWidth:page.viewportSize()!.width,fullPageImageWidth:screenshot.readUInt32BE(16),deviceScaleFactor:1};
      expect(dimensions.fullPageImageWidth).toBeLessThanOrEqual(dimensions.viewportWidth+1);
      logs.push({case:'focus-channels-default-zoom',dimensions});
    }finally{await browser.close();}
  },90000);
  it('recovers a settings read failure and shows an empty history without replacing saved settings',async()=>{
    const {browser,page}=await browserSession();try {
      mode='get-error';await page.reload();await page.getByText('Follow-up settings could not be loaded',{exact:true}).waitFor();
      expect(await page.getByRole('button',{name:'Save Settings',exact:true}).count()).toBe(0);
      mode='normal';await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('button',{name:'Save Settings',exact:true}).waitFor();
      await page.getByRole('tab',{name:'History',exact:true}).click();await page.getByText('No follow-ups yet',{exact:true}).waitFor();
      logs.push({case:'settings-error-retry-empty-history'});
    }finally{await browser.close();}
  },90000);
  it('bounds a stalled real history endpoint and enables retry',async()=>{
    const {browser,page}=await browserSession();try {
      await page.clock.install();mode='history-stall';await page.getByRole('tab',{name:'History',exact:true}).click();
      await page.getByText('Loading history…',{exact:true}).waitFor();await page.clock.runFor(15_100);
      await page.getByRole('alert').filter({hasText:'timed out'}).waitFor();expect(await page.getByRole('button',{name:'Refresh',exact:true}).isEnabled()).toBe(true);
      mode='normal';await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByText('No follow-ups yet',{exact:true}).waitFor();
      logs.push({case:'production-history-deadline-retry'});
    }finally{await browser.close();}
  },90000);
  it('replays one actual persisted template after a lost HTTP acknowledgement with the same intent key',async()=>{
    const {browser,page}=await browserSession();try {
      await page.getByRole('tab',{name:'Templates',exact:true}).click();await page.getByRole('button',{name:'Create template',exact:true}).click();
      await page.getByLabel('Template name',{exact:true}).fill('Synthetic recovered template');await page.getByLabel('Message',{exact:true}).fill('Hello {{first_name}}');
      await page.clock.install();mode='template-lost-ack';await page.getByRole('button',{name:'Create template',exact:true}).click();
      await new Promise<void>((resolve,reject)=>{const started=Date.now();const check=()=>{if(held.length)resolve();else if(Date.now()-started>8000)reject(new Error('Template response never reached held acknowledgement'));else setTimeout(check,20);};check();});
      expect((await client.query('SELECT count(*)::int AS n FROM content_templates')).rows[0].n).toBe(1);
      await page.clock.runFor(15_100);await page.getByRole('alert').filter({hasText:'unconfirmed'}).waitFor();
      await page.getByRole('button',{name:'Close draft',exact:true}).click();await page.clock.runFor(300);
      await page.getByRole('button',{name:'Create template',exact:true}).click();expect(await page.getByLabel('Message',{exact:true}).inputValue()).toBe('Hello {{first_name}}');
      await page.getByRole('button',{name:'Retry same create',exact:true}).click();await page.getByText('Follow-up template created',{exact:true}).first().waitFor();
      expect((await client.query('SELECT count(*)::int AS n FROM content_templates')).rows[0].n).toBe(1);
      const posts=requests.filter(item=>item.method==='POST'&&item.path==='/api/content/templates');expect(posts).toHaveLength(2);
      const keys=posts.map(item=>(item.headers as Record<string,string>)['idempotency-key']);expect(keys[1]).toBe(keys[0]);expect(keys[0]).toBeTruthy();
      logs.push({case:'production-template-lost-ack',keys,rows:1});
    }finally{for(const end of held)end();await browser.close();}
  },90000);
});
