// Opt-in acceptance: real configured SMS outbox -> QueueRegistry/capture -> Redis ->
// production-registered SMS processor. Real SQL identity/subscription checks;
// Actual SMS adapter, migration351 and durable history/claim ledger run. Only synthetic
// credentials, external fetch, wallet arithmetic and unrelated daemons are mocked.
import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Client} from 'pg';
import {drizzle,type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {PgDialect} from 'drizzle-orm/pg-core';
import {getTableColumns,sql,type SQL} from 'drizzle-orm';
import {sentMessagesTable} from '../models/sentMessages/schema.js';
import {leadsTable} from '../models/leads/schema.js';
import {Queue,QueueEvents,Worker as RealWorker,DelayedError,UnrecoverableError,type Processor,type WorkerOptions,type Job} from 'bullmq';
import {currentBusinessScope,withBusinessScope} from '../tenancy/businessContext.js';
import {currentBillingScope,withBillingScope} from '../tenancy/billingContext.js';

let client:Client,database:NodePgDatabase,queue:Queue,events:QueueEvents,worker:RealWorker|undefined;
let origin=40,failOutboxAck=false,disableDuringPreparation=false;
const connection={host:'127.0.0.1',port:32769,maxRetriesPerRequest:null};
const schema=`followup_origin_${randomUUID().replaceAll('-','')}`;
const queueName=`followup-origin-acceptance-${randomUUID()}`;
const dialect=new PgDialect();
const queryTrace:string[]=[];
const workerEntries:Array<Record<string,unknown>>=[];
const effects:Array<Record<string,unknown>>=[];
const creditRequests:Array<Record<string,unknown>>=[];
const failures:Array<Record<string,unknown>>=[];
const noop=async()=>{};
const context=()=>({business:currentBusinessScope(),billing:currentBillingScope()});

jest.unstable_mockModule('bullmq',()=>({Queue,QueueEvents,DelayedError,UnrecoverableError,Worker:class {
  private inner?:RealWorker;
  constructor(name:string,processor:Processor,options:WorkerOptions){
    if(name==='sms-sending'){
      worker=new RealWorker(queueName,async job=>{
        workerEntries.push({id:job.id,data:JSON.parse(JSON.stringify(job.data))});
        return processor(job);
      },{...options,connection,concurrency:1});
      this.inner=worker;
    }
  }
  on(...args:Parameters<RealWorker['on']>){if(this.inner)Reflect.apply(this.inner.on,this.inner,args);return this;}
  waitUntilReady=async()=>{await this.inner?.waitUntilReady();};
  close=async()=>{await this.inner?.close();};
  isRunning=()=>this.inner?.isRunning()??true;
  isPaused=()=>this.inner?.isPaused()??false;
}}));
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get:(_t,key)=>{
  if(key==='execute')return async(query:SQL)=>{
    const text=dialect.sqlToQuery(query).sql;queryTrace.push(text);
    if(failOutboxAck&&text.includes('SET follow_up_dispatches=jsonb_set')){
      failOutboxAck=false;throw new Error('Synthetic lost outbox dispatched-state write');
    }
    return database.execute(query);
  };
  const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
}})}));
const log={info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()};
jest.unstable_mockModule('../utils/logger.js',()=>({logger:log,createWorkerLogger:()=>log}));
jest.unstable_mockModule('../infrastructure/redis.js',()=>({getRedisConnection:()=>connection}));
jest.unstable_mockModule('../events/EventBus.js',()=>({eventBus:{initialize:noop,close:noop,publish:noop,emitToolEvent:noop},EVENT_CHANNELS:{}}));
jest.unstable_mockModule('../tools/outreachSender.js',()=>({outreachSenderWorker:{start:noop,stop:noop}}));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js',()=>({notificationEventConsumer:{start:noop,stop:noop}}));
jest.unstable_mockModule('../models/failedJobs/functions.js',()=>({insertFailedJob:async(data:Record<string,unknown>)=>{failures.push(data);}}));
// Preserve the consumer's transaction-enlisted reservation reference. Wallet pricing
// is deliberately mocked, but deduction identity/reference and SMS ledger are real SQL.
jest.unstable_mockModule('../services/CreditService.js',()=>({creditService:{
  reserveForResource:async(input:{createResource:(tx:NodePgDatabase)=>Promise<{resource:unknown;referenceId:string}>})=>{
    const snapshot=context();
    const result=await database.transaction(async tx=>{
      const created=await input.createResource(tx);
      const saved=await tx.execute(sql`INSERT INTO wallet_transactions(user_id,organization_id,actor_user_id,billing_business_profile_id,type,reference_type,reference_id)
        VALUES(${snapshot.business!.userId},${snapshot.billing!.organizationId},${snapshot.billing!.actorUserId},${snapshot.business!.businessProfileId},'deduction','sms_queue_claim',${created.referenceId}) RETURNING id`);
      return {success:true,transactionId:Number(saved.rows[0].id),resource:created.resource};
    });
    creditRequests.push({input,...snapshot});return result;
  },refundDeduction:async(input:{userId:number;transactionId:number})=>{
    const snapshot=context();
    const refund=await database.execute(sql`INSERT INTO fixture_refunds(transaction_id,user_id,organization_id,actor_user_id)
      SELECT id,user_id,organization_id,actor_user_id FROM wallet_transactions WHERE id=${input.transactionId} AND user_id=${input.userId}
      AND organization_id=${snapshot.billing!.organizationId} AND actor_user_id=${snapshot.billing!.actorUserId}
      ON CONFLICT(transaction_id) DO NOTHING RETURNING transaction_id`);
    return {success:refund.rows.length===1};
  },
}}));
jest.unstable_mockModule('../models/channelCredentials/functions',()=>({ChannelCredentialModel:{
  findActiveAccountByIdentifier:async()=>prepareCredential(),findByUserAndPlatform:async()=>prepareCredential(),updateAccount:noop,
}}));
async function prepareCredential(){
  if(disableDuringPreparation)await client.query("UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms,enabled}','false')");
  return syntheticCredential();
}
const syntheticCredential=()=>({id:77,isActive:true,credentialType:'api_key',accountIdentifier:'AUDITS',apiSecret:'synthetic-only',
  sessionData:{senderId:'AUDITS',flowId:'synthetic-approved-flow',messageVariable:'message'},providerVerifiedAt:new Date(),
  encryptionVersion:'synthetic',encryptionKeyId:'synthetic',encryptedAt:new Date()});
jest.unstable_mockModule('../utils/channelCredentialSecrets.js',()=>({decryptChannelCredentialSecret:()=> 'synthetic-not-real',decryptChannelCredentialSession:(value:unknown)=>value}));
jest.unstable_mockModule('../services/integrations/MSG91ProviderService.js',()=>({getMSG91Balance:async()=>{throw new Error('External balance forbidden');},verifyMSG91Configuration:async()=>{throw new Error('External verification forbidden');}}));
jest.unstable_mockModule('../services/CRMService',()=>({crmService:{autoCreateContactOnOutreachSend:noop}}));
jest.unstable_mockModule('../services/InboundContactResolver.js',()=>({inboundContactResolver:{}}));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js',()=>({privacyVaultService:{},redactPiiWithStableTokens:(value:unknown)=>value}));

const {configuredFollowUpDispatch,reserveSmsFollowUpDispatch,recoverConfiguredFollowUpDispatches}=await import('../services/outreach/ConfiguredFollowUpDispatchService.js');
const {followUpSettingsRevision}=await import('../utils/followUpSettingsRevision.js');
const {captureJobBusiness}=await import('../tenancy/jobBusinessScope.js');
const {queueRegistry,QUEUE_NAMES}=await import('../queues/index.js');
const {startAllWorkers,stopAllWorkers}=await import('../workers/index.js');
const asActor=<T>(actor:number,payer:number|undefined,work:()=>T)=>withBusinessScope({userId:9,businessProfileId:91,actorUserId:actor},()=>
  payer===undefined?work():withBillingScope({organizationId:payer,actorUserId:actor,businessProfileId:91,businessOwnerUserId:9},work));
const config={enabled:true,maxFollowUps:1,revision:'synthetic-current',followUps:[{enabled:true,delayMinutes:5,templateId:-1}]};

async function reserve(actor=9,identity:Record<string,unknown>={}){
  const payload={userId:9,leadId:77,to:'919000000000',message:'Synthetic approved fixture',isFollowUp:true,useSavedFollowUpSettings:true,
    createdAt:new Date().toISOString(),...identity,
    followUpProvenance:{version:1,userId:9,businessProfileId:91,channel:'sms',originTable:'sent_messages',originMessageId:origin,step:1,settingsRevision:followUpSettingsRevision(config)}};
  const envelope=await asActor(actor,901,()=>configuredFollowUpDispatch('sms',origin,1,payload));
  expect(await asActor(actor,901,()=>reserveSmsFollowUpDispatch(origin,null,1,envelope))).toBe(true);
  return envelope;
}
async function persisted(){return (await client.query('SELECT follow_up_dispatches FROM sent_messages WHERE id=$1',[origin])).rows[0].follow_up_dispatches['1'];}
async function recoveredJob(id:string){const job=await queue.getJob(id);if(!job)throw new Error('Expected local Redis job missing');return job;}
async function complete(job:Job){await worker!.resume();return job.waitUntilFinished(events,10000);}
const suite=process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL?describe:describe.skip;
suite('configured follow-up immutable origin through outbox and registered SMS worker',()=>{
  beforeAll(async()=>{
    const url=process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL!;
    if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/followup_qa')throw new Error('Disposable local fixture required');
    client=new Client({connectionString:url});await client.connect();await client.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema},pg_catalog`);database=drizzle(client);
    for(const [name,table] of [['sent_messages',sentMessagesTable],['leads',leadsTable]] as const){
      const columns=Object.values(getTableColumns(table)).map(column=>`"${column.name}" ${column.getSQLType()}`);
      await client.query(`CREATE TABLE ${name}(${columns.join(',')})`);
    }
    await client.query(`
      CREATE TABLE users(id int PRIMARY KEY,deleted_at timestamp,is_approved boolean,is_setup_complete boolean,is_verified boolean,created_at timestamp);
      CREATE TABLE company_settings(id int PRIMARY KEY,user_id int,archived_at timestamp,is_default boolean,name text,company_name text,business_name text,billing_organization_id int);
      CREATE TABLE business_profile_memberships(id int,business_profile_id int,user_id int,role text,status text);
      CREATE TABLE business_profile_preferences(user_id int,default_business_profile_id int);
      CREATE TABLE billing_organizations(id int,name text,owner_user_id int,default_for_user_id int,billing_eligibility_at timestamp);
      CREATE TABLE billing_organization_memberships(organization_id int,user_id int,status text,role text);
      CREATE TABLE billing_admin_plan_terms(organization_id int,cancelled_at timestamp,starts_at timestamp,ends_at timestamp);
      CREATE TABLE subscription_settings(id int,enforced boolean,launched_at timestamp,credential_id int,published_catalog_version int,capacity_enforced boolean);
      CREATE TABLE billing_subscriptions(id uuid,organization_id int,mode text,failure_at timestamp,cancel_at_period_end boolean,status text,replaces_id uuid,authorized boolean,starts_at timestamp);
      CREATE TABLE subscription_charges(subscription_id uuid,organization_id int,period_start timestamp,period_end timestamp,refund_amount_paise int);
      CREATE TABLE outreach_settings(user_id int,business_profile_id int,enable_auto_follow_up boolean,channel_follow_ups jsonb);
      CREATE TABLE outreach_messages(id int,user_id int,business_profile_id int,metadata jsonb,status text,updated_at timestamp,conversation_id int,provider_account_id text,provider_message_id text,external_message_id text,follow_up_cancelled_at timestamp,sent_at timestamp,created_at timestamp,direction text,message_kind text);
      CREATE TABLE outreach_conversations(id int,user_id int,lead_id int,channel text,automation_mode text,session_ended_at timestamp);
      CREATE TABLE social_follow_up_schedules(id int,delivery_message_id int,user_id int,business_profile_id int,status text,version int,cancelled_at timestamp,cancellation_reason text,updated_at timestamp);
      CREATE TABLE fixture_refunds(transaction_id integer PRIMARY KEY,user_id int,organization_id int,actor_user_id int);
      CREATE TABLE wallet_transactions(id serial PRIMARY KEY,user_id int,organization_id int,actor_user_id int,billing_business_profile_id int,type text,reference_type text,reference_id text UNIQUE);
      ALTER TABLE sent_messages ALTER business_profile_id SET DEFAULT 91;
      ALTER TABLE sent_messages ALTER is_reply SET DEFAULT false;
      ALTER TABLE sent_messages ALTER created_at SET DEFAULT NOW();
      ALTER TABLE sent_messages ALTER follow_up_dispatches SET DEFAULT '{}';
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read bool,parent_links jsonb,legacy_business_column text);
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE SQL STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION app_business_actor_user_id() RETURNS integer LANGUAGE SQL STABLE AS $$ SELECT NULLIF(current_setting('app.business_actor_user_id',true),'')::integer $$;
      CREATE FUNCTION app_business_system() RETURNS bool LANGUAGE SQL STABLE AS $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN CREATE ROLE salesmarketing_business_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF; END $$;
      SELECT set_config('app.business_profile_id','91',false),set_config('app.current_user_id','9',false),set_config('app.business_actor_user_id','9',false);
    `);
    const guard=(await readFile('migrations/299_business_profile_isolation.js','utf8')).match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\)[\s\S]*?END \$\$/)?.[0];
    const access=(await readFile('migrations/304_business_profile_memberships.js','utf8')).match(/CREATE FUNCTION app_business_access\(p_profile INTEGER\)[\s\S]*?\$\$;/)?.[0];
    if(!guard||!access)throw new Error('Actual migration299/304 ownership helpers required');
    await client.query(guard);await client.query(access.replace('search_path=public,pg_catalog',`search_path=${schema},pg_catalog`));
    const migrationPath='../migrations/351_sms_queue_delivery_claims.js';
    const migration=await import(migrationPath) as {up:(target:Client)=>Promise<void>};
    await migration.up(client);await migration.up(client);
    jest.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      expect(String(input)).toBe('https://control.msg91.com/api/v5/flow');
      const started=(await client.query('SELECT state,reservation_reference,reservation_id FROM sms_queue_deliveries WHERE job_id=$1',[workerEntries.at(-1)!.id])).rows[0];
      expect(started).toMatchObject({state:'started',reservation_reference:expect.stringMatching(/^sms-queue:/),reservation_id:expect.any(Number)});
      effects.push({args:[input,init],...context()});
      return new Response(JSON.stringify({type:'success',request_id:`synthetic-provider-receipt-${origin}`}),{status:200,headers:{'Content-Type':'application/json'}});
    });
    queue=new Queue(queueName,{connection});events=new QueueEvents(queueName,{connection});await events.waitUntilReady();
    jest.spyOn(queueRegistry,'initialize').mockImplementation(noop);
    jest.spyOn(queueRegistry,'addRepeatableJob').mockImplementation(async()=>undefined);
    jest.spyOn(queueRegistry,'getQueue').mockImplementation(name=>{expect(name).toBe(QUEUE_NAMES.SMS_SENDING);return queue;});
    await startAllWorkers();if(!worker)throw new Error('Production SMS worker was not registered');await worker.waitUntilReady();await worker.pause();
  },30000);
  beforeEach(async()=>{
    await worker!.pause();origin++;failOutboxAck=false;disableDuringPreparation=false;effects.length=0;creditRequests.length=0;workerEntries.length=0;failures.length=0;queryTrace.length=0;
    for(const fn of Object.values(log))fn.mockClear();
    await client.query(`TRUNCATE users,company_settings,business_profile_memberships,business_profile_preferences,billing_organizations,billing_organization_memberships,billing_admin_plan_terms,subscription_settings,billing_subscriptions,subscription_charges,outreach_settings,sent_messages,outreach_messages,outreach_conversations,social_follow_up_schedules,sms_queue_deliveries,wallet_transactions,fixture_refunds,leads;
      INSERT INTO users VALUES(9,NULL,true,true,true,NOW()-INTERVAL '90 days'),(17,NULL,false,true,true,NOW()-INTERVAL '90 days');
      INSERT INTO company_settings VALUES(91,9,NULL,true,'Fixture business','Fixture business','Fixture business',901);
      INSERT INTO business_profile_memberships VALUES(1,91,17,'member','active');
      INSERT INTO billing_organizations VALUES(901,'Original payer',9,9,NOW()-INTERVAL '90 days'),(902,'Other payer',9,NULL,NOW()-INTERVAL '90 days');
      INSERT INTO billing_organization_memberships VALUES(901,9,'active','owner'),(902,9,'active','owner');
      INSERT INTO subscription_settings VALUES(1,false,NOW()-INTERVAL '90 days',NULL,1,false);
      INSERT INTO outreach_conversations VALUES(31,9,77,'sms','ai_active',NULL);
      INSERT INTO leads(id,user_id,business_profile_id,name,phone,blacklisted,do_not_contact,email_unsubscribed,sms_sent) VALUES(77,9,91,'Synthetic lead','919000000000',false,false,false,0);`);
    await client.query('INSERT INTO outreach_settings VALUES(9,91,true,$1)',[{sms:config}]);
    await client.query("INSERT INTO sent_messages(id,user_id,business_profile_id,channel,follow_up_step,follow_up_dispatches,updated_at,lead_id,message_id) VALUES($1,9,91,'sms',NULL,'{}',NOW(),77,$2)",[origin,`original-${origin}`]);
    await client.query("INSERT INTO outreach_messages(id,user_id,business_profile_id,metadata,status,updated_at,conversation_id,provider_account_id,external_message_id,sent_at,created_at,direction,message_kind) VALUES($1,9,91,$2,'sent',NOW(),31,'AUDITS',$3,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour','outbound','outreach')",[origin,{outreachCreation:{version:1,followUpSource:'channel_settings',delivery:{channel:'sms',leadId:77,phone:'919000000000'}}},`original-${origin}`]);
  });
  afterAll(async()=>{
    await stopAllWorkers();await events?.close();await queue?.close();jest.restoreAllMocks();if(client){await client.query(`DROP SCHEMA ${schema} CASCADE`);await client.end();}
  },30000);

  it('persists the complete server-resolved owner identity before reservation and executes once',async()=>{
    const envelope=await reserve();const before=await persisted();
    expect(before.payload).toMatchObject({userId:9,businessProfileId:91,businessActorUserId:9,billingActorUserId:9,billingOrganizationId:901});
    await expect(asActor(9,undefined,()=>captureJobBusiness(before.payload,{requireOriginatingIdentity:true}))).resolves.toMatchObject(before.payload);
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(1);
    const job=await recoveredJob(envelope.jobId);await complete(job);
    expect(effects).toHaveLength(1);expect(creditRequests[0].billing).toMatchObject({organizationId:901,actorUserId:9});
    expect((await persisted()).payload).toEqual(before.payload);
    const ledger=(await client.query('SELECT * FROM sms_queue_deliveries WHERE job_id=$1',[envelope.jobId])).rows[0];
    expect(ledger).toMatchObject({state:'confirmed',business_actor_user_id:9,billing_actor_user_id:9,billing_organization_id:901,activity_message_id:expect.any(Number)});
    expect((await client.query('SELECT status,message_id,is_reply,follow_up_step FROM sent_messages WHERE id=$1',[ledger.activity_message_id])).rows[0]).toMatchObject({status:'sent',is_reply:true,follow_up_step:1,message_id:`synthetic-provider-receipt-${origin}`});
  });
  it('executes under the persisted active originating staff with its original payer',async()=>{
    const envelope=await reserve(17);
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(1);
    await complete(await recoveredJob(envelope.jobId));
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({business:{userId:9,businessProfileId:91,actorUserId:17},billing:{organizationId:901,actorUserId:17}});
    expect((await client.query('SELECT business_actor_user_id,billing_actor_user_id,billing_organization_id,state FROM sms_queue_deliveries WHERE job_id=$1',[envelope.jobId])).rows[0])
      .toMatchObject({business_actor_user_id:17,billing_actor_user_id:17,billing_organization_id:901,state:'confirmed'});
  });
  it('runs the real adapter final callback after preparation and stops a newly disabled channel',async()=>{
    const envelope=await reserve();
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(1);
    disableDuringPreparation=true;
    expect(await complete(await recoveredJob(envelope.jobId))).toMatchObject({success:false,suppressed:true});
    expect(effects).toHaveLength(0);
    expect(creditRequests).toHaveLength(1);
    expect((await client.query('SELECT state,provider_message_id FROM sms_queue_deliveries WHERE job_id=$1',[envelope.jobId])).rows[0])
      .toMatchObject({state:'stopped',provider_message_id:null});
    expect((await client.query('SELECT user_id,organization_id,actor_user_id FROM fixture_refunds')).rows).toEqual([{user_id:9,organization_id:901,actor_user_id:9}]);
  });
  it('freezes originating staff at persistence and never substitutes the recovery owner after revocation',async()=>{
    const envelope=await reserve(17);expect((await persisted()).payload).toMatchObject({businessActorUserId:17,billingActorUserId:17,billingOrganizationId:901});
    await client.query("UPDATE business_profile_memberships SET status='revoked' WHERE user_id=17");
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
    expect(await queue.getJob(envelope.jobId)).toBeUndefined();expect(effects).toHaveLength(0);expect(creditRequests).toHaveLength(0);
    expect(await persisted()).toMatchObject({state:'review_required',reviewReason:'ORGANIZATION_FORBIDDEN',payload:{businessActorUserId:17,billingActorUserId:17,billingOrganizationId:901}});
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
  });
  it('retains the original payer and requires review if the fixture business mapping changes',async()=>{
    const envelope=await reserve();await client.query('UPDATE company_settings SET billing_organization_id=902 WHERE id=91');
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
    expect(await queue.getJob(envelope.jobId)).toBeUndefined();expect(effects).toHaveLength(0);expect(creditRequests).toHaveLength(0);
    expect(await persisted()).toMatchObject({state:'review_required',reviewReason:'ORGANIZATION_FORBIDDEN',payload:{billingOrganizationId:901}});
  });
  it('uses the frozen approved payer rather than an unrelated ambient recovery payer',async()=>{
    const envelope=await reserve();expect(await asActor(9,902,()=>recoverConfiguredFollowUpDispatches())).toBe(1);
    const job=await recoveredJob(envelope.jobId);expect(job.data.billingOrganizationId).toBe(901);await complete(job);
    expect(effects).toHaveLength(1);expect(effects[0].billing).toMatchObject({organizationId:901,actorUserId:9});
  });
  it.each(['userId','businessProfileId','businessActorUserId','billingActorUserId','billingOrganizationId'])('leaves legacy work missing %s durably reviewable without promoting authority',async field=>{
    const envelope=await reserve();
    await client.query("UPDATE sent_messages SET follow_up_dispatches=follow_up_dispatches #- ARRAY['1','payload',$2]::text[] WHERE id=$1",[origin,field]);
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
    expect(await queue.getJob(envelope.jobId)).toBeUndefined();expect(effects).toHaveLength(0);expect(creditRequests).toHaveLength(0);
    expect(await persisted()).toMatchObject({state:'review_required',reviewReason:'JOB_ORIGIN_REQUIRED'});
    const durable=await persisted();expect(durable.payload[field]).toBeUndefined();
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
  });
  it('registered worker still rejects originating staff revoked after enqueue',async()=>{
    const envelope=await reserve(17);expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(1);
    const job=await recoveredJob(envelope.jobId);await client.query("UPDATE business_profile_memberships SET status='revoked' WHERE user_id=17");
    await expect(complete(job)).rejects.toThrow(/removed|available/);expect(effects).toHaveLength(0);expect(creditRequests).toHaveLength(0);
    expect(job.data.businessActorUserId).toBe(17);
  });
  it('retains one effect and the identical frozen payload across a lost outbox acknowledgement',async()=>{
    const envelope=await reserve();failOutboxAck=true;expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
    const job=await recoveredJob(envelope.jobId);expect((await persisted()).state).toBe('pending');await complete(job);expect(effects).toHaveLength(1);
    await worker!.pause();expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(1);await worker!.resume();
    expect((await persisted()).state).toBe('dispatched');expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(0);
    expect(effects).toHaveLength(1);expect(creditRequests).toHaveLength(1);expect((await recoveredJob(envelope.jobId)).data).toEqual(job.data);
    expect((await client.query('SELECT count(*)::int AS count FROM wallet_transactions')).rows[0].count).toBe(1);
    expect((await client.query('SELECT count(*)::int AS count FROM sent_messages WHERE is_reply')).rows[0].count).toBe(1);
    expect((await client.query('SELECT sms_sent FROM leads WHERE id=77')).rows[0].sms_sent).toBe(1);
    expect((await client.query('SELECT count(*)::int AS count FROM fixture_refunds')).rows[0].count).toBe(0);
  });
  it('real subscription unavailability still rejects before mocked credit and provider effects',async()=>{
    const envelope=await reserve();await client.query('UPDATE subscription_settings SET enforced=true WHERE id=1');
    expect(await asActor(9,undefined,()=>recoverConfiguredFollowUpDispatches())).toBe(1);const job=await recoveredJob(envelope.jobId);
    await expect(complete(job)).rejects.toThrow(/subscription/);expect(effects).toHaveLength(0);expect(creditRequests).toHaveLength(0);
  });
});
