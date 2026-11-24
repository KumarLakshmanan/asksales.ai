import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {SQL} from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import {withBusinessScope} from '../tenancy/businessContext.js';
import {withBillingScope} from '../tenancy/billingContext.js';
import {createBusinessScopedPool} from '../tenancy/scopedPool.js';
import {localBusinessFunctions,localBusinessIsolation} from './helpers/localBusinessPostgres.js';
const suite=process.env.CONTENT_PUBLISH_LOCAL_QA==='1'?describe:describe.skip;
let fixtureDb:any,pool:Pool,runtime:Pool,admin:Pool;
const schema=`youtube_reply_${randomBytes(8).toString('hex')}`;
const scoped=<T>(work:()=>T,profile=99,actor=991)=>withBusinessScope({userId:991,businessProfileId:profile,actorUserId:actor},()=>withBillingScope({organizationId:999,actorUserId:actor,businessOwnerUserId:991,businessProfileId:profile},work));
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get:(_t,k)=>(...args:any[])=>fixtureDb[k](...args)})}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{warn:jest.fn(),error:jest.fn(),info:jest.fn()}}));
const insert=jest.fn<any>();
jest.unstable_mockModule('googleapis',()=>({google:{auth:{OAuth2:class{setCredentials(){}}},youtube:()=>({comments:{insert},commentThreads:{list:async()=>({data:{items:[{id:'synthetic-parent',snippet:{topLevelComment:{id:'synthetic-parent',snippet:{textDisplay:'Synthetic comment',authorDisplayName:'Synthetic author'}}}}]}})}})}}));
const {channelCredentialsTable}=await import('../models/channelCredentials/schema.js');
const {default:router}=await import('../controllers/youtubeManagementController.js');
const {responseWrapper}=await import('../middleware/responseWrapper.js');
const app=express();app.use(express.json());app.use('/api',responseWrapper);app.use((req,_res,next)=>{const actor=req.get('x-fixture-actor')==='993'?993:991;req.user={id:actor} as any;scoped(next,req.get('x-fixture-business')==='100'?100:99,actor);});app.use('/api/youtube/manage',router);
const send=(key='reviewed-comment-intent',text='Synthetic reviewed reply',business=99,actor=991)=>request(app).post('/api/youtube/manage/comments/synthetic-parent/replies').set('Idempotency-Key',key).set('x-fixture-business',String(business)).set('x-fixture-actor',String(actor)).send({credentialId:11,text});
let providerMode='success';
let writes=0,fetchSpy:ReturnType<typeof jest.spyOn>;
suite('YouTube comment HTTP intent with real SQL/RLS and simulated Google',()=>{
 beforeAll(async()=>{
  if(process.env.DB_HOST!=='127.0.0.1')throw Error('Disposable loopback fixture required');
  const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),database:process.env.DB_NAME,user:process.env.DB_USER,password:''};
  admin=new Pool({...config,max:1,options:'-c search_path=pg_catalog'});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({...config,max:3,options:`-c search_path=${schema},pg_catalog -c app.business_profile_id=99 -c app.current_user_id=991`});
  await localBusinessFunctions(pool);
  await pool.query(`CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamp,is_approved boolean DEFAULT true);
   INSERT INTO users(id) VALUES(991),(993);
   CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,name text,company_name text,business_name text,is_default boolean DEFAULT true,archived_at timestamp,billing_organization_id integer);
   INSERT INTO company_settings VALUES(99,991,'Synthetic',NULL,NULL,true,NULL,999),(100,991,'Other synthetic',NULL,NULL,false,NULL,999);
   CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,role text,status text);
   INSERT INTO business_profile_memberships(business_profile_id,user_id,role,status) VALUES(99,993,'member','active');
   CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer);
   CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer,name text,default_for_user_id integer,billing_eligibility_at timestamp DEFAULT now());INSERT INTO billing_organizations VALUES(999,991,'Synthetic',991,now());
   CREATE TABLE billing_organization_memberships(id serial PRIMARY KEY,organization_id integer,user_id integer,status text,role text);
   CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);`);
  const definition=getTableConfig(channelCredentialsTable);const columns=definition.columns.map(c=>{if(c.name==='id')return 'id SERIAL PRIMARY KEY';const v=c.default;const d=v instanceof SQL?new PgDialect().sqlToQuery(v).sql:v===undefined?undefined:typeof v==='boolean'||typeof v==='number'?String(v):`'${(typeof v==='string'?v:JSON.stringify(v)).replaceAll("'","''")}'`;return `"${c.name}" ${c.getSQLType()}${d===undefined?'':` DEFAULT ${d}`}`;});await pool.query(`CREATE TABLE channel_credentials(${columns.join(',')})`);
  await localBusinessIsolation(pool,schema,['channel_credentials']);
  // Install the actual shared ownership/access functions in the disposable namespace.
  const ownership=readFileSync(resolve(process.cwd(),'migrations/299_business_profile_isolation.js'),'utf8').match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?END \$\$/)?.[0];
  const membership=readFileSync(resolve(process.cwd(),'migrations/304_business_profile_memberships.js'),'utf8');
  const actor=membership.match(/CREATE FUNCTION app_business_actor_user_id\(\)[\s\S]*?\$\$;/)?.[0];
  const access=membership.match(/CREATE FUNCTION app_business_access\(p_profile INTEGER\)[\s\S]*?\$\$;/)?.[0];
  if(!ownership||!actor||!access)throw Error('Shared ownership source unavailable');
  await pool.query(ownership+';'+actor+access.replace('search_path=public,pg_catalog',`search_path=${schema},pg_catalog`));
  // @ts-expect-error JavaScript migration executed unchanged.
  const migration=await import('../migrations/471_youtube_comment_intents.js');await migration.up(pool);await migration.down(pool);await migration.up(pool);
  runtime=createBusinessScopedPool(new Pool({...config,max:5,options:`-c search_path=${schema},pg_catalog`}));fixtureDb=drizzle(runtime);
 },30000);
 beforeEach(async()=>{
  await pool.query("UPDATE business_profile_memberships SET status='active'");
  writes=0;providerMode='success';insert.mockReset();insert.mockImplementation(async()=>{writes++;if(providerMode==='timeout')throw Error('Synthetic accepted then network timeout');return {data:providerMode==='missing_receipt'?{}:{id:'synthetic-reply-1'}};});
  await pool.query('TRUNCATE channel_credentials,youtube_comment_intents RESTART IDENTITY');
  await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,access_token,token_expiry,granted_scopes,provider_approval_status,is_active) VALUES(11,991,'youtube','synthetic-channel','synthetic-token',now()+interval '1 day',$1::jsonb,'approved',true)",[JSON.stringify(['https://www.googleapis.com/auth/youtube.force-ssl'])]);
  fetchSpy=jest.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('External requests forbidden');});
 });
 afterEach(()=>fetchSpy?.mockRestore());afterAll(async()=>{await runtime?.end();await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
 it('does not repeat an accepted-but-timeout reply on unchanged HTTP replay',async()=>{
  insert.mockImplementation(async()=>{writes++;if(writes===1)throw Error('Synthetic accepted then network timeout');return {data:{id:'synthetic-duplicate'}};});
  expect((await send()).status).toBe(502);const replay=await send();expect(writes).toBe(1);expect([409,502]).toContain(replay.status);
 });
 it('quarantines an accepted empty receipt and never inserts again',async()=>{
  insert.mockImplementation(async()=>{writes++;return {data:{}};});const first=await send();expect(first.status).toBe(502);expect(first.body.ambiguous).toBe(true);await send();expect(writes).toBe(1);
 });
 it('returns a saved success receipt for replay and rejects changed reviewed text',async()=>{
  expect((await send()).body.data.id).toBe('synthetic-reply-1');expect((await send()).body.data.id).toBe('synthetic-reply-1');expect(writes).toBe(1);expect((await send('reviewed-comment-intent','Changed text')).status).toBe(409);expect(writes).toBe(1);
 });
 it('allows only one concurrent provider insert for one intent',async()=>{
  let unblock!:()=>void;const held=new Promise<void>(r=>{unblock=r;});insert.mockImplementation(async()=>{writes++;await held;return {data:{id:'synthetic-reply-1'}};});
  const first=send().then(r=>r);for(let n=0;n<100&&writes===0;n++)await new Promise(r=>setTimeout(r,5));const second=send().then(r=>r);await new Promise(r=>setTimeout(r,50));unblock();await first;const result=await second;expect(writes).toBe(1);expect(result.status).toBe(409);
 });
 it('does not borrow another business credential or receipt',async()=>{await send();expect((await send('reviewed-comment-intent','Synthetic reviewed reply',100)).status).toBe(404);expect(writes).toBe(1);});
 it('requires a stable intent before any provider write',async()=>{const result=await request(app).post('/api/youtube/manage/comments/synthetic-parent/replies').send({credentialId:11,text:'Synthetic'});expect(result.status).toBe(400);expect(writes).toBe(0);});
 it('preserves a known receipt through local completion failure and finalizes without another insert',async()=>{
  await pool.query(`CREATE FUNCTION fail_reply_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='succeeded' THEN RAISE EXCEPTION 'Synthetic receipt write outage';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_reply_receipt BEFORE UPDATE ON youtube_comment_intents FOR EACH ROW EXECUTE FUNCTION fail_reply_receipt();`);
  try{expect((await send()).status).toBe(502);const row=(await pool.query('SELECT state,receipt FROM youtube_comment_intents')).rows[0];expect(row).toMatchObject({state:'ambiguous',receipt:{id:'synthetic-reply-1'}});}finally{await pool.query('DROP TRIGGER fail_reply_receipt ON youtube_comment_intents;DROP FUNCTION fail_reply_receipt()');}
  expect((await send()).body.data.id).toBe('synthetic-reply-1');expect(writes).toBe(1);expect((await pool.query('SELECT state FROM youtube_comment_intents')).rows[0].state).toBe('succeeded');
 });
 it('persists original actor and payer and rejects replay under changed authority',async()=>{
  expect((await send('staff-reviewed-intent','Reviewed by staff',99,993)).status).toBe(200);
  const row=(await pool.query('SELECT originating_authority FROM youtube_comment_intents')).rows[0];expect(row.originating_authority).toEqual({userId:991,businessProfileId:99,businessActorUserId:993,billingActorUserId:993,billingOrganizationId:999});
  expect((await send('staff-reviewed-intent','Reviewed by staff')).status).toBe(409);expect(writes).toBe(1);
 });
 it('rejects a revoked original actor before another effect',async()=>{
  expect((await send('staff-reviewed-intent','Reviewed by staff',99,993)).status).toBe(200);await pool.query("UPDATE business_profile_memberships SET status='inactive'");expect((await send('staff-reviewed-intent','Reviewed by staff',99,993)).status).toBe(403);expect(writes).toBe(1);
 });
 it('enforces immutable review and credential ownership through actual migration triggers',async()=>{
  await send();await expect(scoped(()=>runtime.query("UPDATE youtube_comment_intents SET reviewed_text='Changed review'"))).rejects.toMatchObject({code:'23514'});
  await expect(scoped(()=>runtime.query("UPDATE youtube_comment_intents SET business_profile_id=100"))).rejects.toMatchObject({code:'23514'});
  expect((await scoped(()=>runtime.query('SELECT id FROM youtube_comment_intents'),100)).rows).toHaveLength(0);
 });
 it('refuses rollback while reply history exists',async()=>{
  await send();
  // @ts-expect-error JavaScript migration executed unchanged.
  const migration=await import('../migrations/471_youtube_comment_intents.js');await expect(migration.down(pool)).rejects.toThrow(/history exists/);expect(writes).toBe(1);
 });

 it('retains the dispatch fence and receipt after credential retirement',async()=>{
  await send();await scoped(()=>runtime.query('DELETE FROM channel_credentials WHERE id=11'));
  const row=(await pool.query('SELECT credential_id,state,receipt FROM youtube_comment_intents')).rows[0];expect(row).toMatchObject({credential_id:null,state:'succeeded',receipt:{id:'synthetic-reply-1'}});expect(writes).toBe(1);
 });

 (process.env.COMMENT_BROWSER==='1'?it:it.skip)('interactive YouTube UI uses mounted router and durable SQL intent',async()=>{
  const path=process.env.COMMENT_EVIDENCE!;
  app.post('/__audit/reset',async(_req,res)=>{await pool.query('TRUNCATE youtube_comment_intents');writes=0;providerMode='success';res.json({ok:true});});
  app.post('/__audit/provider',(req,res)=>{providerMode=req.body.mode;res.json({ok:true});});
  app.get('/__audit/state',async(_req,res)=>res.json({writes,intents:(await pool.query('SELECT intent_key,state,receipt,originating_authority FROM youtube_comment_intents')).rows}));
  const server=app.listen(30474,'127.0.0.1');await new Promise<void>((done,fail)=>{server.once('listening',done);server.once('error',fail);});
  writeFileSync(path+'/ready.json',JSON.stringify({port:30474,schema}));
  try{const end=Date.now()+480000;while(!existsSync(path+'/done')&&Date.now()<end)await new Promise(r=>setTimeout(r,200));expect(existsSync(path+'/done')).toBe(true);}finally{await new Promise<void>(done=>server.close(()=>done()));}
 },500000);

 it('keeps definite provider rejection distinct from uncertainty and permits an explicitly new reviewed intent',async()=>{
  insert.mockRejectedValue({code:403,response:{status:403},message:'Synthetic provider rejected reply'});const denied=await send();expect(denied.status).toBe(403);expect(denied.body.code).toBe('YOUTUBE_REPLY_REJECTED');expect(denied.body.ambiguous).not.toBe(true);expect((await send()).status).toBe(403);expect(insert).toHaveBeenCalledTimes(1);
  insert.mockImplementation(async()=>{writes++;return {data:{id:'synthetic-reply-1'}};});expect((await send('explicit-reviewed-retry')).status).toBe(200);expect(writes).toBe(1);
 });

});
