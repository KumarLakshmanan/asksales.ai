/** Opt-in synthetic PostgreSQL: mounted outreach routes, real auth/profile/billing scope and history SQL. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

const url = process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL;
const uiOrigin = 'http://127.0.0.1:32802';
const suite = url ? describe : describe.skip;
let client: Client, database: NodePgDatabase, server: ReturnType<express.Express['listen']>;
let moduleEnabled = true;
const trace: string[] = [];
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_t, key) => {
  if (key === 'execute') return async (query: SQL) => { trace.push(new PgDialect().sqlToQuery(query).sql); return database.execute(query); };
  const value = Reflect.get(database, key); return typeof value === 'function' ? value.bind(database) : value;
} }) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Only synthetic login/session, rate-limit infrastructure, subscription availability and module catalog are replaced.
// Actual authenticateToken, businessProfileScope/resolver, businessPermissions, billing scope and route/controller/model execute.
jest.unstable_mockModule('../utils/jwt', () => ({ verifyToken: (token: string) => /^fixture-(9|17|19)$/.test(token) ? { userId: Number(token.slice(8)) } : null, isTokenRevoked: async () => false }));
jest.unstable_mockModule('../models/users/functions', () => ({ getUserById: async (id: number) => ({ id, email: `fixture-${id}@example.test`, name: `Fixture ${id}` }) }));
jest.unstable_mockModule('../services/SmartThrottlingService', () => ({ SmartThrottlingService: { getInstance: () => ({ isAllowed: async () => ({ allowed: true }), recordRequest: async () => {} }) } }));
jest.unstable_mockModule('../middleware/subscriptionAccess.js', () => ({ checkSubscriptionRequest: async () => true }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => [{ key: 'outreach', enabled: moduleEnabled }], getMaintenanceSettings: async () => ({ enabled: false }) }));
const routeSource = readFileSync(new URL('../routes/outreach.routes.ts', import.meta.url), 'utf8');
for (const match of routeSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
  const path = match[2]; if (!path.startsWith('../controllers/') || path.includes('sentMessageController')) continue;
  const names = match[1].split(',').map(value => value.trim().split(/\s+as\s+/)[0]).filter(Boolean);
  jest.unstable_mockModule(path, () => Object.fromEntries(names.map(name => [name, Object.assign((_req: unknown, _res: unknown, next?: () => void) => next?.(), { single: () => (_req: unknown, _res: unknown, next: () => void) => next() })])));
}
const { authenticateToken } = await import('../middleware/auth.js');
const { responseWrapper } = await import('../middleware/responseWrapper.js');
const { SentMessageModel } = await import('../models/sentMessages/functions.js');
const { getSentMessages } = await import('../controllers/sentMessageController.js');
const router = (await import('../routes/outreach.routes.js')).default;
const { sentMessagesTable } = await import('../models/sentMessages/schema.js');
const { outreachMessagesTable, outreachConversationsTable } = await import('../models/outreachConversations/schema.js');
const { companySettings } = await import('../models/companySettings/schema.js');
const app = express(); app.use(express.json()); app.use('/api', responseWrapper);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', uiOrigin); res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Business-Profile-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204); next();
});
app.get('/api/auth/me', authenticateToken, (_req,res) => res.json({user:{id:9,email:'fixture-9@example.test',name:'Fixture owner',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}}));
app.get('/api/auth/csrf-token', (_req,res) => res.json({csrfToken:'synthetic'}));
app.get('/api/settings/business-profiles', (_req,res) => res.json([{id:91,name:'First',companyName:'First',isDefault:true,role:'owner'},{id:92,name:'Second',companyName:'Second',isDefault:false,role:'owner'}]));
app.get('/api/platform/access', (_req,res) => res.json({maintenance:{enabled:false},modules:['campaigns','lead_generation','content','performance_marketing','ai_visibility','outreach','crm','support','support_ai','proposals','knowledge_base','integrations','billing','storage'].map(key=>({key,name:key,enabled:true,status:'available'}))}));
app.get('/api/settings/preferences', (_req,res) => res.json({theme:'light',language:'en',timezone:'UTC'}));
app.get('/api/organizations', (_req,res) => res.json({organizations:[]}));
app.get('/api/wallet', (_req,res) => res.json({balance:10000}));
app.get('/api/chat/threads', (_req,res) => res.json({threads:[],total:0}));
app.get('/api/notifications/unread/count', (_req,res) => res.json({count:0}));
app.use('/api/outreach', router);
// Exact production legacy registration from routes.ts; the monolithic unrelated routes are not booted.
app.get('/api/sent-messages', authenticateToken, getSentMessages);
const get = (channel: string, actor = 9, business = 91, path = '/api/outreach/sent') => request(app).get(path).set('Authorization', `Bearer fixture-${actor}`).set('X-Business-Profile-Id', String(business)).query({ followUps: 'true', channel });
const envelope = (channel: string, originId: number, step = 1) => ({ version: 1, state: 'review_required', reviewReason: 'JOB_ORIGIN_REQUIRED', jobId: `configured-follow-up-91-9-${channel}-${originId}-${step}`, payload: { userId: 9, businessProfileId: 91, businessActorUserId: 17, billingActorUserId: 17, billingOrganizationId: 901, followUpOriginMessageId: originId, followUpStep: step, message: 'Reserved synthetic wording', secretFixtureField: 'must-not-leak' } });

suite('authority-review history against real local PostgreSQL', () => {
  beforeAll(async () => {
    if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/followup_qa') throw new Error('Disposable loopback followup_qa required');
    client = new Client({ connectionString: url }); await client.connect(); await client.query('CREATE TEMP TABLE anchor(id int);SET search_path TO pg_temp,pg_catalog'); database = drizzle(client);
    for (const [name, table] of [['sent_messages', sentMessagesTable], ['outreach_messages', outreachMessagesTable], ['outreach_conversations', outreachConversationsTable], ['company_settings', companySettings]] as const) {
      const columns = Object.values(getTableColumns(table as PgTable)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',');
      await client.query(`CREATE TEMP TABLE ${name} (${columns})`);
    }
    await client.query(`CREATE TEMP TABLE users(id int,deleted_at timestamp);
      CREATE TEMP TABLE business_profile_memberships(id int,business_profile_id int,user_id int,role text,status text);
      CREATE TEMP TABLE business_profile_preferences(user_id int,default_business_profile_id int);
      CREATE TEMP TABLE billing_organizations(id int,name text,owner_user_id int,default_for_user_id int,billing_eligibility_at timestamp);
      CREATE TEMP TABLE billing_organization_memberships(organization_id int,user_id int,status text,role text);`);
    if (process.env.FOLLOW_UP_REVIEW_BROWSER === '1') { server = app.listen(32801, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); }
  });
  beforeEach(async () => {
    moduleEnabled = true; trace.length = 0;
    await client.query(`TRUNCATE users,company_settings,business_profile_memberships,billing_organizations,billing_organization_memberships,sent_messages,outreach_messages,outreach_conversations RESTART IDENTITY;
      INSERT INTO users VALUES(9,NULL),(17,NULL),(19,NULL);
      INSERT INTO company_settings(id,user_id,name,company_name,business_name,is_default,billing_organization_id) VALUES(91,9,'First','First','First',true,901),(92,9,'Second','Second','Second',false,902),(93,19,'Foreign','Foreign','Foreign',true,903);
      INSERT INTO business_profile_memberships VALUES(1,91,17,'member','active');
      INSERT INTO billing_organizations VALUES(901,'First payer',9,9,NOW()),(902,'Second payer',9,NULL,NOW()),(903,'Foreign payer',19,19,NOW());
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,channel,lead_name) VALUES(21,9,91,'email','Email customer'),(22,9,91,'whatsapp','Social customer'),(24,9,91,'instagram','Instagram customer'),(25,9,91,'facebook','Facebook customer');`);
    await client.query(`INSERT INTO sent_messages(id,user_id,business_profile_id,lead_id,lead_name,channel,is_reply,follow_up_step,message,status,delivery_status,sent_at,created_at,updated_at,message_id,follow_up_dispatches)
      VALUES(41,9,91,71,'SMS customer','sms',false,2,'Original SMS','sent','sent','2026-01-01','2026-01-01','2026-01-02','original-provider-receipt',$1),
      (42,9,92,71,'Other business','sms',false,1,'Other business','sent','sent','2026-01-01','2026-01-01','2026-01-02','other-receipt',$2),
      (43,19,93,71,'Foreign account','sms',false,1,'Foreign account','sent','sent','2026-01-01','2026-01-01','2026-01-02','foreign-receipt',$3),
      (51,9,91,71,'Confirmed SMS customer','sms',true,1,'Actual receipt wording','sent','delivered','2026-01-03','2026-01-03','2026-01-03','actual-follow-up-receipt','{}'),
      (52,9,91,71,'Uncertain SMS customer','sms',true,1,'Uncertain attempt','failed','uncertain','2026-01-03','2026-01-03','2026-01-03',NULL,'{}')`, [JSON.stringify({ '1': envelope('sms',41), '2': envelope('sms',41,2) }), JSON.stringify({ '1': envelope('sms',42) }), JSON.stringify({ '1': envelope('sms',43) })]);
    for (const [id, conversation, channel, status, state, receipt] of [[61,21,'email','queued','not_started',null],[62,22,'whatsapp','sent','confirmed','actual-social-receipt'],[63,21,'email','manual_review','unknown',null],[66,24,'instagram','pending','not_started',null],[67,25,'facebook','failed','unknown',null]] as const) {
      await client.query(`INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,follow_up_origin_message_id,follow_up_step,content,metadata,status,provider_call_state,provider_message_id,manual_review_required,created_at,sent_at)
        VALUES($1,9,91,$2,'outbound','follow_up',11,1,'Reserved envelope wording',$3,$4::text,$5,$6,$7,'2026-01-03',CASE WHEN $4::text='sent' THEN '2026-01-03'::timestamp ELSE NULL END)`, [id,conversation,JSON.stringify({ configuredFollowUpDispatch: envelope(channel,11) }),status,state,receipt,state==='unknown']);
    }
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await client?.end(); });
  it('fails closed without a selected business scope and performs no history query', async () => {
    await expect(SentMessageModel.findRecentFollowUpsByUser(9,'sms')).rejects.toThrow('A business profile is required');
    expect(trace).toHaveLength(0);
  });
  it('projects nonempty SMS original outbox holds without presenting the original receipt as follow-up delivery', async () => {
    const result = await get('sms'); expect(result.status).toBe(200);
    const rows = result.body.data; const held = rows.filter((row: { authorityReview?: unknown }) => row.authorityReview);
    expect(held).toHaveLength(2);
    expect(held.map((row: { followUpStep: number }) => row.followUpStep).sort()).toEqual([1,2]);
    expect(held[0]).toMatchObject({ kind: 'configured_outbox', status: 'review_required', deliveryStatus: 'unconfirmed', sentAt: null, recordedMessageId: null,
      authorityReview: { reason: 'JOB_ORIGIN_REQUIRED', origin: { table: 'sent_messages', messageId: 41, userId: 9, businessProfileId: 91 }, identity: { businessActorUserId: 17, billingActorUserId: 17, billingOrganizationId: 901 } } });
    expect(JSON.stringify(rows)).not.toContain('must-not-leak'); expect(JSON.stringify(rows)).not.toContain('original-provider-receipt');
  });
  it.each(['email','whatsapp','instagram','facebook'])('preserves %s message status and receipt while projecting authority review separately', async channel => {
    const result = await get(channel); expect(result.status).toBe(200); const rows = result.body.data;
    const row = rows.find((value: { id: number }) => value.id === ({email:61,whatsapp:62,instagram:66,facebook:67}[channel]));
    expect(row).toMatchObject({ status: {email:'queued',whatsapp:'sent',instagram:'pending',facebook:'failed'}[channel], recordedMessageId: channel === 'whatsapp' ? 'actual-social-receipt' : null,
      authorityReview: { reason: 'JOB_ORIGIN_REQUIRED', origin: { table: 'outreach_messages', messageId: 11, step: 1, userId: 9, businessProfileId: 91 } } });
    if (channel === 'email') expect(rows.find((value: { id: number }) => value.id === 63)).toMatchObject({ status: 'manual_review', deliveryStatus: 'uncertain', sentAt: null });
  });
  it('retains missing legacy identity as unknown, never the current reader', async () => {
    await client.query("UPDATE sent_messages SET follow_up_dispatches=follow_up_dispatches #- '{1,payload,businessActorUserId}' WHERE id=41");
    const result = await get('sms'); expect(result.status).toBe(200);
    expect(result.body.data.find((row: { authorityReview?: { origin: { step: number } } }) => row.authorityReview?.origin.step===1).authorityReview.identity.businessActorUserId).toBeNull();
  });
  it('enforces actual selected-business membership and explicit owner/profile SQL filters', async () => {
    const staff = await get('sms',17,91); expect(staff.status).toBe(200); expect(JSON.stringify(staff.body)).not.toMatch(/Other business|Foreign account/);
    expect((await get('sms',17,92)).status).toBe(403);
    expect((await request(app).get('/api/outreach/sent').set('Authorization','Bearer fixture-9').set('X-Business-Profile-Id','91').query({followUps:'true',channel:'sms',businessProfileId:92})).status).toBe(400); expect((await get('sms',9,93)).status).toBe(403);
    const second = await get('sms',9,92); expect(second.status).toBe(200); expect(JSON.stringify(second.body)).not.toContain('SMS customer');
    await client.query("UPDATE business_profile_memberships SET status='revoked' WHERE user_id=17"); expect((await get('sms',17,91)).status).toBe(403);
    expect((await request(app).get('/api/outreach/sent?followUps=true&channel=sms')).status).toBe(401);
    moduleEnabled=false; expect((await get('sms')).status).toBe(403);
  });
  it('matches the existing mounted legacy history endpoint and preserves receipt/uncertain records', async () => {
    const canonical = await get('sms'); const legacy = await get('sms',9,91,'/api/sent-messages');
    expect(legacy.body).toEqual(canonical.body); expect(legacy.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({id:51,status:'sent',deliveryStatus:'delivered',recordedMessageId:'actual-follow-up-receipt'}),
      expect.objectContaining({id:52,status:'failed',deliveryStatus:'uncertain',recordedMessageId:null}),
    ]));
  });
  it('pages separate held steps deterministically and leaves all original persistence unchanged', async () => {
    const before = (await client.query('SELECT id,status,delivery_status,follow_up_dispatches FROM sent_messages ORDER BY id')).rows;
    const keys:string[]=[];
    for(let offset=0;offset<4;offset++) {
      const result=await request(app).get('/api/outreach/sent').set('Authorization','Bearer fixture-9').set('X-Business-Profile-Id','91').query({followUps:'true',channel:'sms',limit:1,offset});
      expect(result.status).toBe(200);expect(result.body.data).toHaveLength(1);keys.push(result.body.data[0].activityKey);
    }
    expect(new Set(keys).size).toBe(4);expect(keys).toContain('configured_outbox:41:1');expect(keys).toContain('configured_outbox:41:2');
    expect((await client.query('SELECT id,status,delivery_status,follow_up_dispatches FROM sent_messages ORDER BY id')).rows).toEqual(before);
    expect(trace.every(query=>/^\s*SELECT\b/i.test(query))).toBe(true);
  });
  it('never joins a conversation from another profile or deduplicates against a foreign profile receipt', async () => {
    await client.query("INSERT INTO outreach_conversations(id,user_id,business_profile_id,channel,lead_name) VALUES(23,9,92,'email','Other profile thread');INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,content,status,created_at,rfc_message_id) VALUES(64,9,91,23,'outbound','follow_up','Mismatched scope','sent',NOW(),'foreign-rfc')");
    await client.query("INSERT INTO sent_messages(id,user_id,business_profile_id,channel,is_reply,follow_up_step,message,status,delivery_status,sent_at,created_at,message_id) VALUES(53,9,91,'email',true,1,'Selected legacy receipt','sent','sent',NOW(),NOW(),'foreign-rfc')");
    await client.query("INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,content,status,created_at,rfc_message_id) VALUES(65,9,92,23,'outbound','follow_up','Other scope receipt','sent',NOW(),'foreign-rfc')");
    const result=await get('email');expect(result.status).toBe(200);expect(result.body.data.some((row:{id:number})=>row.id===64||row.id===65)).toBe(false);
    // A malformed cross-profile row must not hide an actually selected-profile receipt either.
    expect((await get('email')).body.data).toEqual(expect.arrayContaining([expect.objectContaining({id:53,message:'Selected legacy receipt'})]));
  });
  (process.env.FOLLOW_UP_REVIEW_BROWSER==='1'?it:it.skip)('renders nonempty real authorized API data in the production history UI', async () => {
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-networking','--disable-dev-shm-usage']});
    const evidence:Array<Record<string,unknown>>=[];
    try {
      const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());await context.routeWebSocket('**/*',socket=>socket.close());
      await context.addInitScript("localStorage.setItem('token','fixture-9');localStorage.setItem('user',JSON.stringify({id:9}));sessionStorage.setItem('active-business-profile:9','91');");
      const page=await context.newPage();const failures:string[]=[];page.on('pageerror',error=>failures.push(error.message));page.on('requestfailed',request=>failures.push(request.url()+': '+request.failure()?.errorText));page.on('response',response=>{if(response.url().includes('/api/'))failures.push(String(response.status())+' '+response.url());});await page.goto(`${uiOrigin}/dashboard/outreach/follow-ups?channel=sms&tab=history`);
      await page.getByText('Reserved synthetic wording',{exact:true}).first().waitFor({timeout:12000}).catch(async error=>{evidence.push({url:page.url(),body:(await page.locator('body').textContent())?.slice(0,5000),failures});throw error;});
      expect((await context.cookies()).some(cookie=>cookie.name==='asksales_session')).toBe(true);
      expect(await page.getByText('Review required',{exact:true}).count()).toBe(2);
      expect(await page.getByText('Delivery not confirmed',{exact:true}).count()).toBe(2);
      await page.getByText('Recorded message ID: actual-follow-up-receipt',{exact:true}).waitFor();
      await page.getByText('Delivery uncertain',{exact:true}).waitFor();
      expect(await page.getByText('Original SMS',{exact:true}).count()).toBe(0);
      expect(await page.getByRole('button',{name:/replay|rebind|reauthorize/i}).count()).toBe(0);
      const body=await page.locator('body').textContent();expect(body).not.toMatch(/must-not-leak|Foreign account|Other business|original-provider-receipt/);
      evidence.push({channel:'sms',reviewRows:2,confirmedReceiptVisible:true,uncertainVisible:true});
      for(const channel of ['email','whatsapp','instagram','facebook']) {
        await page.goto(`${uiOrigin}/dashboard/outreach/follow-ups?channel=${channel}&tab=history`);
        await page.getByText('Review required',{exact:true}).first().waitFor();
        if(channel==='email') {await page.getByText('Recorded: queued',{exact:true}).waitFor();await page.getByText('Delivery uncertain',{exact:true}).waitFor();}
        else if(channel==='whatsapp') {await page.getByText('Recorded: sent',{exact:true}).waitFor();await page.getByText('Recorded message ID: actual-social-receipt',{exact:true}).waitFor();}
        if(channel==='instagram')await page.getByText('Recorded: pending',{exact:true}).waitFor();
        if(channel==='facebook')await page.getByText('Delivery uncertain',{exact:true}).waitFor();
        evidence.push({channel,storedStatusPreserved:true});
      }
      await page.setViewportSize({width:390,height:844});const image=await page.screenshot({fullPage:true,path:process.env.FOLLOW_UP_REVIEW_EVIDENCE_DIR?`${process.env.FOLLOW_UP_REVIEW_EVIDENCE_DIR}/history-mobile.png`:undefined});expect(image.readUInt32BE(16)).toBeLessThanOrEqual(391);
    } finally {await browser.close();if(process.env.FOLLOW_UP_REVIEW_EVIDENCE_DIR)writeFileSync(`${process.env.FOLLOW_UP_REVIEW_EVIDENCE_DIR}/browser.json`,JSON.stringify(evidence,null,2));}
  },90000);
});
