import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {Queue,QueueEvents,Worker as RedisWorker,DelayedError,UnrecoverableError,type Job,type Processor,type WorkerOptions} from 'bullmq';
import {createBusinessScopedPool} from '../tenancy/scopedPool.js';
import {currentBusinessScope,withBusinessScope} from '../tenancy/businessContext.js';
import {currentBillingScope,withBillingScope} from '../tenancy/billingContext.js';

const suite=process.env.JOB_ORIGIN_LOCAL_QA==='1'?describe:describe.skip;
const suffix=randomBytes(6).toString('hex');
const databaseName=`asksales_job_origin_qa_${suffix}`;
const queueName=`tenant-origin-${suffix}`;
const socket=process.env.THROTTLE_QA_SOCKET;
const connection={path:socket,maxRetriesPerRequest:null};
const noop=async()=>{};
let appDb:ReturnType<typeof drizzle>,admin:Pool,pool:Pool,fixture:Pool;
let queue:Queue,events:QueueEvents,worker:RedisWorker|undefined;
let owner:number,actor:number,profile:number,payer:number;
const providerEffect=jest.fn<()=>Promise<void>>();
const failedReview=jest.fn<(...args:unknown[])=>Promise<void>>().mockResolvedValue(undefined);

// Use one real BullMQ consumer running the production registered OUTREACH
// callback. Other unrelated worker processes/timers are inert in this fixture.
jest.unstable_mockModule('bullmq',()=>({Queue,QueueEvents,DelayedError,UnrecoverableError,Worker:class {
  private inner?:RedisWorker;
  constructor(name:string,processor:Processor,options:WorkerOptions) {
    if(name==='outreach') {
      worker=new RedisWorker(queueName,processor,{...options,connection,concurrency:1});
      this.inner=worker;
    }
  }
  on(...args:Parameters<RedisWorker['on']>){if(this.inner)Reflect.apply(this.inner.on,this.inner,args);return this;}
  waitUntilReady=async()=>{await this.inner?.waitUntilReady();};
  close=async()=>{await this.inner?.close();};
}}));
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({}, {get(_target,key){
  const value=Reflect.get(appDb,key);return typeof value==='function'?value.bind(appDb):value;
}})}));
jest.unstable_mockModule('../infrastructure/redis.js',()=>({getRedisConnection:()=>connection}));
const log={info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()};
jest.unstable_mockModule('../utils/logger.js',()=>({logger:log,createWorkerLogger:()=>log}));
jest.unstable_mockModule('../events/EventBus.js',()=>({eventBus:{initialize:noop,close:noop,publish:noop},EVENT_CHANNELS:{}}));
jest.unstable_mockModule('../tools/outreachSender.js',()=>({outreachSenderWorker:{start:noop,stop:noop}}));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js',()=>({notificationEventConsumer:{start:noop,stop:noop}}));
jest.unstable_mockModule('../models/failedJobs/functions.js',()=>({insertFailedJob:failedReview}));
// The terminal Instagram runtime is a mocked effect boundary here. Its actual
// recovery orchestration is owned/tested separately by the Instagram audit.
jest.unstable_mockModule('../services/instagramAutomations/InstagramAutomationRuntime.js',()=>({processInstagramAutomationRun:providerEffect}));
const {queueRegistry,QUEUE_NAMES}=await import('../queues/index.js');
const {captureJobBusiness}=await import('../tenancy/jobBusinessScope.js');
const {subscriptions}=await import('../services/subscriptions/service.js');
const {startAllWorkers,stopAllWorkers}=await import('../workers/index.js');
const {jobDispatcher}=await import('../queues/JobDispatcher.js');
const {dispatchAndWait}=await import('../mastra/tools/queueBridge.js');
type Snapshot={userId:number;businessProfileId:number;businessActorUserId:number;billingActorUserId:number;billingOrganizationId:number;runId:number;createdAt:string};
const asActor=<T>(who:number,work:()=>T)=>withBusinessScope({userId:owner,businessProfileId:profile,actorUserId:who},()=>withBillingScope({organizationId:payer,actorUserId:who},work));
const snapshot=():Snapshot=>({userId:owner,businessProfileId:profile,businessActorUserId:actor,billingActorUserId:actor,billingOrganizationId:payer,runId:1,createdAt:new Date().toISOString()});
async function enqueue(data:Snapshot,raw=false):Promise<Job>{
  if(raw)return queue.add('process_instagram_automation',data,{attempts:1});
  const id=await queueRegistry.addJob(QUEUE_NAMES.OUTREACH,'process_instagram_automation',data,{attempts:1});
  const job=await queue.getJob(id);if(!job)throw new Error('Synthetic job was not persisted');return job;
}
async function rejected(job:Job,reason:RegExp){
  const outcome=await job.waitUntilFinished(events,10000).then(()=>({error:undefined}),error=>({error}));
  expect(providerEffect).not.toHaveBeenCalled();
  expect(outcome.error).toBeInstanceOf(Error);
  expect((outcome.error as Error).message).toMatch(reason);
  expect(await job.getState()).toBe('failed');
}

suite('origin identity through real PostgreSQL, BullMQ and registered worker gates',()=>{
  let access:ReturnType<typeof jest.spyOn>;
  beforeAll(async()=>{
    const template=process.env.BUSINESS_STAFF_TEST_DATABASE;
    if(!template?.startsWith('asksales_profile_identity_')||!['127.0.0.1','localhost','::1'].includes(process.env.DB_HOST||'')
      ||!socket?.startsWith('/workspace/tenant-billing-fixes-'))throw new Error('Explicit disposable local PostgreSQL/Redis fixtures required');
    const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
    admin=new Pool({...config,database:'postgres',max:1});
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${template}"`);
    fixture=new Pool({...config,database:databaseName,max:2});
    pool=createBusinessScopedPool(new Pool({...config,database:databaseName,max:5}));appDb=drizzle(pool);
    const users=await fixture.query("INSERT INTO users(email,password,name,is_verified,is_approved,is_setup_complete,created_at) VALUES($1,'synthetic','Owner',true,true,true,now()-interval '90 days'),($2,'synthetic','Staff',true,false,true,now()-interval '90 days') RETURNING id",[`owner-${suffix}@example.invalid`,`actor-${suffix}@example.invalid`]);
    [owner,actor]=users.rows.map(row=>Number(row.id));
    const profiles=await fixture.query("INSERT INTO company_settings(user_id,name,company_name,is_default,is_approved) VALUES($1,'Origin QA','Origin QA',true,true) RETURNING id,billing_organization_id",[owner]);
    profile=Number(profiles.rows[0].id);payer=Number(profiles.rows[0].billing_organization_id);
    await fixture.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[profile,actor,`actor-${suffix}@example.invalid`]);
    await fixture.query("UPDATE billing_organizations SET billing_eligibility_at=now()-interval '90 days' WHERE id=$1",[payer]);
    queue=new Queue(queueName,{connection});events=new QueueEvents(queueName,{connection});await events.waitUntilReady();
    jest.spyOn(queueRegistry,'initialize').mockImplementation(noop);
    jest.spyOn(queueRegistry,'addRepeatableJob').mockImplementation(async()=>undefined);
    jest.spyOn(queueRegistry,'getQueue').mockReturnValue(queue);
    access=jest.spyOn(subscriptions,'access');
    await startAllWorkers();if(!worker)throw new Error('Actual OUTREACH worker was not registered');await worker.waitUntilReady();
  },30000);
  beforeEach(async()=>{
    await worker!.resume();await fixture.query("UPDATE business_profile_memberships SET status='active' WHERE business_profile_id=$1 AND user_id=$2",[profile,actor]);
    await fixture.query('UPDATE subscription_settings SET enforced=false WHERE id=1');
    providerEffect.mockReset();providerEffect.mockResolvedValue(undefined);access.mockClear();failedReview.mockClear();
  });
  afterAll(async()=>{
    await stopAllWorkers();await events?.close();
    if(queue){await queue.obliterate({force:true});await queue.close();}
    jest.restoreAllMocks();await pool?.end();await fixture?.end();
    if(admin){await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);await admin.end();}
  },30000);
  it('does not bypass real origin rejection through the queued media bridge',async()=>{
    const enabled=jest.spyOn(jobDispatcher,'isQueueEnabled').mockReturnValue(true);
    try {
      const origin=snapshot();
      await fixture.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2",[profile,actor]);
      const count=await queue.count();
      const direct=jest.fn(async()=>({success:true,toolName:'generate_image'}));
      await expect(asActor(owner,()=>dispatchAndWait('generate_image',{...origin,prompt:'Synthetic image; no provider'}, {userId:owner,threadId:1} as import('../mastra/tools/toolRegistry.js').ToolContext,direct))).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
      expect(await queue.count()).toBe(count);expect(direct).not.toHaveBeenCalled();expect(providerEffect).not.toHaveBeenCalled();
    } finally { enabled.mockRestore(); }
  });
  it('keeps active staff authority through owner-ambient recapture and the real outer subscription gate',async()=>{
    providerEffect.mockImplementation(async()=>{
      expect(currentBusinessScope()?.actorUserId).toBe(actor);expect(currentBillingScope()?.actorUserId).toBe(actor);
    });
    const job=await asActor(owner,()=>enqueue(snapshot()));
    expect(job.data).toMatchObject({businessActorUserId:actor,billingActorUserId:actor});
    await job.waitUntilFinished(events,10000);expect(providerEffect).toHaveBeenCalledTimes(1);expect(access).toHaveBeenCalledTimes(1);
  });
  it.each(['original','recovered'] as const)('rejects a persisted %s job after original staff revocation before a mocked effect',async kind=>{
    await worker!.pause();
    const captured=await asActor(actor,()=>captureJobBusiness(snapshot(),{requireOriginatingIdentity:true}));
    const job=await asActor(kind==='recovered'?owner:actor,()=>enqueue(captured));
    await fixture.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2",[profile,actor]);
    await worker!.resume();await rejected(job,/removed|available/);expect(access).not.toHaveBeenCalled();
    expect(job.data).toMatchObject({businessActorUserId:actor,billingActorUserId:actor});
  });
  it('rejects recovery recapture after revocation instead of replacing it with ambient owner authority',async()=>{
    await fixture.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2",[profile,actor]);
    await expect(asActor(owner,()=>enqueue(snapshot()))).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(providerEffect).not.toHaveBeenCalled();
  });
  it('rejects a conflicting persisted payer instead of replacing it with the ambient valid payer',async()=>{
    const different=Number((await fixture.query('SELECT billing_default_organization($1) AS id',[actor])).rows[0].id);
    await expect(asActor(owner,()=>enqueue({...snapshot(),billingOrganizationId:different}))).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(providerEffect).not.toHaveBeenCalled();
  });
  it.each(['businessActorUserId','billingActorUserId'] as const)('independently rejects conflicting %s in persisted worker input',async field=>{
    const job=await enqueue({...snapshot(),[field]:owner},true);await rejected(job,/actors conflict/);expect(access).not.toHaveBeenCalled();
  });
  it.each(['userId','businessProfileId','businessActorUserId','billingActorUserId','billingOrganizationId'] as const)('keeps legacy worker input without %s failed and reviewable',async field=>{
    const data={...snapshot(),[field]:undefined} as unknown as Snapshot;
    const job=await enqueue(data,true);await rejected(job,/originating authority/);expect(access).not.toHaveBeenCalled();
  });
  it('allows legitimate owner-originated jobs through the actual worker and subscription gate',async()=>{
    const job=await asActor(owner,()=>enqueue({...snapshot(),businessActorUserId:owner,billingActorUserId:owner}));
    await job.waitUntilFinished(events,10000);expect(providerEffect).toHaveBeenCalledTimes(1);expect(access).toHaveBeenCalledTimes(1);
  });
  it('executes the real outer subscription denial for an authorized owner before the mocked effect',async()=>{
    await fixture.query("UPDATE subscription_settings SET enforced=true,launched_at=now()-interval '90 days' WHERE id=1");
    const job=await asActor(owner,()=>enqueue({...snapshot(),businessActorUserId:owner,billingActorUserId:owner}));
    await rejected(job,/subscription/);expect(access).toHaveBeenCalledTimes(1);
  });
});
