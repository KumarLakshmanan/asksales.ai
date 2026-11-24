import { afterAll,beforeAll,describe,expect,it,jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import { usersTable } from '../models/users/schema.js';
import { walletsTable } from '../models/wallets/schema.js';
let db:any,admin:Pool,pool:Pool,http:any;

jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get:(_t,k)=>{const v=db?.[k];return typeof v==='function'?v.bind(db):v;}})}));
jest.unstable_mockModule('../models/platformAccess/functions.js',()=>({getEffectiveModuleAccess:async()=>[{key:'performance_marketing',enabled:true,status:'available'}],getMaintenanceSettings:async()=>({enabled:false})}));
jest.unstable_mockModule('../middleware/subscriptionAccess.js',()=>({checkSubscriptionRequest:async()=>true}));
// Daemons outside Paid Ads are inert. The actual BullMQ registry, all queue
// consumers, business/billing capture, auth middleware and scoped DB are real.
jest.unstable_mockModule('../tools/outreachSender.js',()=>({outreachSenderWorker:{start:async()=>{},stop:async()=>{}}}));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js',()=>({notificationEventConsumer:{start:async()=>{},stop:async()=>{}}}));
const {default:campaignRoutes}=await import('../routes/campaigns.routes.js');
const {creativeIntelligenceService:creative}=await import('../services/ads/creative-intelligence/CreativeIntelligenceService.js');
const {queueRegistry,QUEUE_NAMES}=await import('../queues/index.js');
const {startAllWorkers,stopAllWorkers,workersAreReady}=await import('../workers/index.js');
const {closeRedisConnections}=await import('../infrastructure/redis.js');
const {generateToken}=await import('../utils/jwt.js');
const {SmartThrottlingService}=await import('../services/SmartThrottlingService.js');
const {getBalance}=await import('../models/wallets/functions.js');
const app=express(); app.use(express.json());
app.use((_req,res,next)=>{res.set('Access-Control-Allow-Origin','http://127.0.0.1:3299');res.set('Access-Control-Allow-Credentials','true');res.set('Access-Control-Allow-Headers','content-type,x-business-profile-id,authorization');next();});
app.options('*',(_req,res)=>res.sendStatus(204));
app.use('/api/campaigns',campaignRoutes);
app.use((err:any,_req:any,res:any,_next:any)=>res.status(500).json({error:err.message}));
const scope=(actor:number,work:()=>any,business=11)=>withBusinessScope({userId:1,businessProfileId:business,actorUserId:actor,role:actor===1?'owner':'member'},()=>withBillingScope({organizationId:business===11?21:22,actorUserId:actor,businessProfileId:business,businessOwnerUserId:1},work));
const research=()=>({requestId:crypto.randomUUID(),source:'manual',references:[{pageName:'Synthetic competitor',body:'Observed workflow demo, no measured claims.'}]});
const token=(id:number)=>generateToken({userId:id,email:`audit-${id}@example.test`,role:'user'});
const call=(method:'get'|'post'|'put',path:string,actor=1)=>request(app)[method](path).set('Authorization',`Bearer ${token(actor)}`).set('x-business-profile-id','11');

(process.env.PAID_ADS_BOUNDARY_TEST==='true'?describe:describe.skip)('Paid Ads mounted migration/queue acceptance',()=>{
 beforeAll(async()=>{
  if(process.env.DB_HOST!=='127.0.0.1'||process.env.DB_NAME!=='ads_fix')throw new Error('Dedicated disposable DB required');
  const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME};
  admin=new Pool({...config,max:2}); pool=new Pool({...config,max:8});
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const table=(name:string,t:any)=>`CREATE TABLE ${name} (`+getTableConfig(t).columns.map(c=>`"${c.name}" ${c.name==='id'?'integer PRIMARY KEY':c.getSQLType()}`).join(',')+')';
  await admin.query(table('users',usersTable));await admin.query(table('wallets',walletsTable));
  await admin.query(`CREATE UNIQUE INDEX wallet_org ON wallets(organization_id);
   CREATE TABLE company_settings(id serial PRIMARY KEY,user_id integer,name text,company_name text,business_name text,is_default boolean DEFAULT false,is_approved boolean DEFAULT true,archived_at timestamp,billing_organization_id integer);
   INSERT INTO users(id,email,name,role,is_verified,is_approved,is_setup_complete,created_at,updated_at) VALUES(1,'owner@example.test','Audit owner','user',true,true,true,NOW(),NOW()),(2,'member@example.test','Audit member','user',true,true,true,NOW(),NOW()),(3,'stranger@example.test','Audit stranger','user',true,true,true,NOW(),NOW());
   INSERT INTO company_settings(id,user_id,name,company_name,business_name,is_default,billing_organization_id) VALUES(11,1,'North','North','North',true,21),(12,1,'South','South','South',false,22),(13,2,'Staff own','Staff own','Staff own',true,23),(14,3,'Stranger','Stranger','Stranger',true,24);
   CREATE TABLE brand_toolkits(id serial PRIMARY KEY,user_id integer,name text,voice_type text,custom_tone_guidelines text,voice_dos text,voice_donts text,visual_instructions text,content_instructions text,is_default boolean,is_active boolean,is_approved boolean);
   ALTER TABLE company_settings ADD COLUMN description text,ADD COLUMN value_proposition text,ADD COLUMN target_market text,ADD COLUMN restrictions text;
   CREATE TABLE content_assets(id serial PRIMARY KEY,user_id integer REFERENCES users(id));
   CREATE TABLE performance_ad_campaigns(id integer PRIMARY KEY,user_id integer,name text); INSERT INTO performance_ad_campaigns VALUES(19,1,'Synthetic campaign');
   CREATE TABLE ad_campaign_autonomy_policies(id serial PRIMARY KEY,campaign_id integer,user_id integer,enabled boolean,thresholds jsonb,consent_policy_version text,consented_at timestamp,consented_by_user_id integer,revoked_at timestamp,updated_at timestamp,UNIQUE(campaign_id,user_id));
   CREATE TABLE ad_settings(id serial PRIMARY KEY,user_id integer UNIQUE,live_provider_mutations_enabled boolean DEFAULT false); INSERT INTO ad_settings(user_id) VALUES(1);
   CREATE TABLE ad_action_queue(id serial PRIMARY KEY,user_id integer,campaign_id integer,status text,action_type text,evaluation_id integer,last_error text,completed_at timestamp,updated_at timestamp);
   CREATE TABLE ad_action_audit(id serial PRIMARY KEY,user_id integer,campaign_id integer,actor_type text,action_type text,rationale text,metrics_snapshot jsonb,provider_outcome jsonb);
  `);
  const m287='../migrations/287_ad_creative_intelligence.js'; const m299='../migrations/299_business_profile_isolation.js';const m325='../migrations/325_ad_creative_business_isolation.js';
  await (await import(m287)).up(admin);
  await admin.query('BEGIN');try{await (await import(m299)).up(admin);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  await admin.query(`CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,role text,status text);
   INSERT INTO business_profile_memberships(business_profile_id,user_id,role,status) VALUES(11,2,'member','active');
   CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer);
   CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer,name text,default_for_user_id integer,billing_eligibility_at timestamp);
   INSERT INTO billing_organizations VALUES(21,1,'North payer',1,NOW()),(22,1,'South payer',NULL,NOW()),(23,2,'Staff payer',2,NOW()),(24,3,'Stranger payer',3,NOW());
   CREATE TABLE billing_organization_memberships(organization_id integer,user_id integer,role text,status text);
   INSERT INTO billing_organization_memberships VALUES(21,1,'owner','active'),(22,1,'owner','active'),(23,2,'owner','active'),(24,3,'owner','active');
   INSERT INTO wallets(id,organization_id,user_id,balance,total_credits_added,total_credits_used) VALUES(1,21,1,100,100,0),(2,22,1,200,200,0),(3,23,2,300,300,0);
  `);
  const m304=readFileSync('migrations/304_business_profile_memberships.js','utf8');const funcs=m304.slice(m304.indexOf('CREATE FUNCTION app_business_actor_user_id()'),m304.indexOf('DO $$ DECLARE t record;',m304.indexOf('CREATE FUNCTION app_business_actor_user_id()')));
  await admin.query(funcs);
  for(const t of ['ad_creative_research_runs','ad_creative_briefs','ad_creative_brief_assets','ad_campaign_autonomy_policies','performance_ad_campaigns','ad_action_queue','ad_action_audit','ad_settings'])await admin.query(`ALTER POLICY business_isolation ON ${t} USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id))`);
  await admin.query('BEGIN');try{await (await import(m325)).up(admin);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO salesmarketing_business_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO salesmarketing_business_runtime');
  db=drizzle(createBusinessScopedPool(pool));
  await queueRegistry.initialize();
  for(const q of queueRegistry.getAllQueues())await q.obliterate({force:true});
  for(const q of queueRegistry.getAllQueues())if(q.name!==QUEUE_NAMES.CONTENT_GENERATION)await q.pause();else await q.resume();
  if(process.env.PAID_ADS_BROWSER_HOLD==='true')http=app.listen(3298,'127.0.0.1');
 },30000);
 afterAll(async()=>{if(http)await new Promise<void>(r=>http.close(()=>r()));await stopAllWorkers();await closeRedisConnections();SmartThrottlingService.getInstance().destroy();await pool?.end();await admin?.end();},30000);
 it('authenticates the mounted research API and completes its real queued request without a seed',async()=>{
  expect((await request(app).get('/api/campaigns/creative-intelligence/briefs')).status).toBe(401);
  expect((await call('get','/api/campaigns/creative-intelligence/briefs',3)).status).toBe(403);
  const body=research();
  const response=await call('post','/api/campaigns/creative-intelligence/research',2).send(body);
  expect(response.status).toBe(202);
  const retry=await call('post','/api/campaigns/creative-intelligence/research',2).send(body);
  expect(retry.status).toBe(202);expect(retry.body.id).toBe(response.body.id);
  expect((await call('post','/api/campaigns/creative-intelligence/research',2).send({...body,country:'GB'})).status).toBe(409);
  const q=queueRegistry.getQueue(QUEUE_NAMES.CONTENT_GENERATION);const jobs=await q.getWaiting();expect(jobs.length).toBe(1);
  expect(jobs[0].data).toMatchObject({userId:1,businessProfileId:11,businessActorUserId:2,billingOrganizationId:21,billingActorUserId:2});
  expect(await scope(2,()=>getBalance(2))).toBe(100);
  await startAllWorkers();expect(workersAreReady()).toBe(true);
  const deadline=Date.now()+15000;let row:any;
  do{row=(await admin.query('SELECT status,business_profile_id FROM ad_creative_research_runs WHERE id=$1',[response.body.id])).rows[0];if(['succeeded','failed'].includes(row.status))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  expect(row).toMatchObject({status:'succeeded',business_profile_id:11});
  expect((await call('get',`/api/campaigns/creative-intelligence/research/${response.body.id}`,2)).body.status).toBe('succeeded');
  await q.pause();
 },30000);
 it('isolates concurrent same-owner retries by business and retains a queued record on transport failure',async()=>{
  const body=research();
  const [north,northRetry,south]=await Promise.all([scope(2,()=>creative.createResearch(1,body)),scope(2,()=>creative.createResearch(1,body)),scope(1,()=>creative.createResearch(1,body),12)]);
  expect(north.id).toBe(northRetry.id);expect(south.id).not.toBe(north.id);
  await expect(scope(2,()=>creative.research(1,south.id))).rejects.toThrow('not found');
  const fail=jest.spyOn(queueRegistry,'addJob').mockRejectedValueOnce(new Error('Synthetic queue unavailable'));
  const another=research();await expect(scope(2,()=>creative.createResearch(1,another))).rejects.toThrow('Retry this request');fail.mockRestore();
  const saved=await scope(2,()=>creative.createResearch(1,another));expect(saved.status).toBe('queued');
  expect((await admin.query('SELECT count(*)::int n FROM ad_creative_research_runs WHERE request_id=$1',[another.requestId])).rows[0].n).toBe(1);
 });
 it('creates/retries brief persistence for two businesses without invoking paid generation',async()=>{
  const requestId=crypto.randomUUID();
  const create=async(business:number)=>{
   const run=await scope(1,()=>db.execute(sql`INSERT INTO ad_creative_research_runs(user_id,request_id,input_hash,input,status,"references") VALUES(1,${crypto.randomUUID()},'brief-fixture','{}','succeeded','[{"id":"ref-a","body":"Observed demo"}]'::jsonb) RETURNING id`),business);
   const input={requestId,researchRunIds:[Number(run.rows[0].id)],businessFacts:'Synthetic product facts',audience:'Synthetic audience'};
   const submit=(body:any)=>call('post','/api/campaigns/creative-intelligence/briefs',business===11?2:1).set('x-business-profile-id',String(business)).send(body);
   const created=await submit(input);expect(created.status).toBe(202);
   const retry=await submit(input);expect(retry.status).toBe(202);expect(retry.body.id).toBe(created.body.id);
   expect((await submit({...input,audience:'Changed audience'})).status).toBe(409);return created.body;
  };
  const [north,south]=await Promise.all([create(11),create(12)]);expect(north.id).not.toBe(south.id);
  const contexts=(await admin.query('SELECT business_profile_id,context FROM ad_creative_briefs WHERE request_id=$1 ORDER BY business_profile_id',[requestId])).rows;
  expect(contexts.map(row=>[row.business_profile_id,row.context.business.company_name])).toEqual([[11,'North'],[12,'South']]);
  await expect(scope(2,()=>creative.brief(1,south.id))).rejects.toThrow('not found');
 });
 it('honors the actual scoped tenant gate through the mounted manual-control route',async()=>{
  const previous=process.env.AD_PROVIDER_MUTATIONS_ENABLED;
  process.env.AD_PROVIDER_MUTATIONS_ENABLED='true';
  try {
   const response=await call('post','/api/campaigns/meta/campaigns/123/resume',2).send({});
   expect(response.status).toBe(403);expect(response.body.code).toBe('AD_MUTATIONS_GATED');
  } finally {process.env.AD_PROVIDER_MUTATIONS_ENABLED=previous;}
 });
 it('attributes mounted policy consent to the authenticated actor while retaining resource ownership',async()=>{
  for(const actor of [2,1]){
   const response=await call('put','/api/campaigns/autonomous/19/policy',actor).send({enabled:true,thresholds:{targetCpl:10}});
   expect(response.status).toBe(200);expect(response.body.policy.consentedByUserId).toBe(actor);
   expect((await admin.query('SELECT user_id,business_profile_id,consented_by_user_id FROM ad_campaign_autonomy_policies')).rows).toEqual([{user_id:1,business_profile_id:11,consented_by_user_id:actor}]);
  }
 });
 it('can hold the real API for an opt-in browser journey',async()=>{
  if(process.env.PAID_ADS_BROWSER_HOLD==='true') {
   await admin.query('DELETE FROM ad_creative_brief_assets; DELETE FROM ad_creative_briefs');
   writeFileSync('/tmp/asksales-ads-audit-corrections-api-ready','ready');
   const deadline=Date.now()+180000;
   while(!existsSync('/tmp/asksales-ads-audit-corrections-browser-done')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
  }
 },190000);
});
