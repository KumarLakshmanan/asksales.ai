import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { responseWrapper } from '../middleware/responseWrapper.js';
import type { PreparedLeadEnrichmentRemoval } from '../services/enrichment/removedJobReservation.js';

// Opt-in only. Requires the existing migrations in a dedicated disposable DB.
// Never load application .env files or infer a DSN from the environment.
const suite = process.env.LEAD_DISCOVERY_LOCAL_QA === '1' ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
const databaseProxy = new Proxy({}, {
  get: (_target, key) => (...args: unknown[]) => Reflect.get(fixtureDb, key).apply(fixtureDb, args),
});
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
const factory = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const actor = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const crawler = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../services/agents/ApifyService.js', () => ({
  ApifyService: { createWithAdminCredentials: factory },
}));
jest.unstable_mockModule('../services/WebsiteCrawlerService.js', () => ({
  WebsiteCrawlerService: class { crawl = crawler; },
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { createProviderForUser: async () => { throw new Error('No synthetic LLM configured'); } },
}));
const { default: enrichmentRouter } = await import('../routes/enrichments.routes.js');
const { generateToken } = await import('../utils/jwt.js');
const { closeRedisConnections, getRedisConnection } = await import('../infrastructure/redis.js');
const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');
const { eventBus } = await import('../events/EventBus.js');
// All workers except Lead Enrichment are inert: no other queue can execute effects.
// The lead worker processor/wrapper, Queue/QueueEvents and Redis remain real.
const bull = await import('bullmq');
let liveLeadWorker: InstanceType<typeof bull.Worker>;
jest.unstable_mockModule('bullmq', () => ({ ...bull,
  Worker: class {
    constructor(name: string, processor: unknown, options: Record<string, unknown>) {
      if (name === 'lead-enrichment') {
        liveLeadWorker = new bull.Worker(name, processor as never, options as never);
        return liveLeadWorker as never;
      }
    }
    on() { return this; } async waitUntilReady() {} async close() {}
    isRunning() { return true; } isPaused() { return false; }
  },
}));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js', () => ({ notificationEventConsumer: { start: async () => {}, stop: async () => {} } }));
jest.unstable_mockModule('../tools/outreachSender.js', () => ({ outreachSenderWorker: { start: async () => {}, stop: async () => {} } }));
const { authenticateAdminToken, requireSuperAdmin } = await import('../middleware/auth.js');
const { default: leadsRouter } = await import('../routes/leads.routes.js');
const { startAllWorkers, stopAllWorkers } = await import('../workers/index.js');
const { queueRegistry, QUEUE_NAMES } = await import('../queues/index.js');
const { removeJob } = await import('../controllers/adminQueueController.js');
const { retryConfirmedLeadEnrichmentRemovalRelease } = await import('../services/enrichment/removedJobReservation.js');
const { creditService } = await import('../services/CreditService.js');
const { claimDeepEnrichment } = await import('../services/enrichment/deepExecution.js');
suite('administrator pending removal with real auth, SQL and Redis', () => {
  let admin: Pool;
  let scoped: Pool;
  let owner: number;
  let outsider: number;
  let north: number;
  let south: number;
  let token: string;
  let organization: number;
  let app: express.Express;
  let priceId: number;
  let superToken: string;
  let ordinaryAdminToken: string;
  const business = <T>(profile: number, work: () => T) => withBusinessScope({ userId: owner, businessProfileId: profile }, work);
  const get = (path: string, profile = north) => request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(profile));
  beforeAll(async () => {
    if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'lead_audit'
      || process.env.DB_PORT !== '55432' || process.env.REDIS_HOST !== '127.0.0.1'
      || process.env.REDIS_PORT !== '56379') throw new Error('Use only the disposable lead-audit containers');
    admin = new Pool({ host: '127.0.0.1', port: 55432, database: 'lead_audit', user: 'lead_audit', password: 'disposable_fixture', max: 2 });
    await assertBusinessScopeSchema(admin);
    scoped = createBusinessScopedPool(new Pool({ host: '127.0.0.1', port: 55432, database: 'lead_audit', user: 'lead_audit', password: 'disposable_fixture', max: 6 }));
    fixtureDb = drizzle(scoped);
    const suffix = randomUUID();
    const users = await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete) VALUES($1,'synthetic','Discovery owner',true,true),($2,'synthetic','Discovery outsider',true,true) RETURNING id", [`discovery-${suffix}@example.invalid`, `outsider-${suffix}@example.invalid`]);
    [owner, outsider] = users.rows.map(row => row.id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,name,is_default) VALUES($1,'Discovery North',true),($1,'Discovery South',false) RETURNING id", [owner]);
    [north, south] = profiles.rows.map(row => row.id);
    await admin.query("INSERT INTO company_settings(user_id,name,is_default) VALUES($1,'Discovery Other',true)", [outsider]);
    organization = (await admin.query('SELECT billing_organization_id FROM company_settings WHERE id=$1', [north])).rows[0].billing_organization_id;
    await admin.query('INSERT INTO wallets(user_id,organization_id,balance) VALUES($1,$2,1000) ON CONFLICT(organization_id) DO UPDATE SET balance=1000', [owner, organization]);
    token = generateToken({ userId: owner, email: `discovery-${suffix}@example.invalid` });
    expect(await getRedisConnection().ping()).toBe('PONG');
    app = express();
    app.use(express.json());
    app.use('/api', responseWrapper);
    app.use('/api/enrichments', enrichmentRouter);
    app.use('/api/leads', leadsRouter);
    // Same route and real guards as admin.routes.ts; no authentication substitute.
    app.delete('/api/admin/queues/:queueName/jobs/:jobId', authenticateAdminToken, requireSuperAdmin, removeJob);
    await admin.query("INSERT INTO admins(id,email,password,name,role) VALUES(1900000000,$1,'synthetic','Synthetic super','super_admin'),(1900000001,$2,'synthetic','Synthetic admin','admin')", ['super-'+suffix+'@example.invalid','admin-'+suffix+'@example.invalid']);
    superToken=generateToken({adminId:1900000000,email:'super-'+suffix+'@example.invalid',role:'super_admin'});
    ordinaryAdminToken=generateToken({adminId:1900000001,email:'admin-'+suffix+'@example.invalid',role:'admin'});
    priceId=(await admin.query("INSERT INTO credit_pricing(event_key,name,category,credits_per_unit,is_active) VALUES('lead_enrichment','Synthetic durable enrichment fee','lead',5,true) RETURNING id")).rows[0].id;
    await startAllWorkers();
  }, 30000);
  beforeEach(async () => {
    factory.mockReset().mockImplementation(async () => ({runActor:actor}));
    actor.mockReset().mockResolvedValue({ success: true, items: [], runId: 'synthetic-provider-run', datasetId: 'synthetic-dataset' });
    crawler.mockReset().mockResolvedValue({ pages: [], combinedContent: '' });
    await admin.query('UPDATE wallets SET balance=1000 WHERE organization_id=$1', [organization]);
    await admin.query("DELETE FROM user_module_access WHERE user_id=$1 AND module_key='lead_generation'", [owner]);
  });
  afterAll(async () => {
    await liveLeadWorker?.close();
    await stopAllWorkers();
    await queueRegistry.close();
    await eventBus.close();
    SmartThrottlingService.getInstance().destroy();
    await closeRedisConnections();
    await scoped?.end();
    if(priceId) await admin.query('DELETE FROM credit_pricing WHERE id=$1',[priceId]);
    await admin.query('DELETE FROM admins WHERE id IN(1900000000,1900000001)');
    await admin?.end();
  });


  const queuedPost = (leadId: number) => request(app).post(`/api/leads/${leadId}/deep-enrich`).set('Authorization',`Bearer ${token}`).set('X-Business-Profile-Id',String(north)).send({async:true});
  const newLead = async (name: string) => (await business(north, () => scoped.query("INSERT INTO leads(uuid,user_id,name,source,status,lead_status,twitter_handle) VALUES(gen_random_uuid(),$1,$2::text,'synthetic','new','new',$2::text) RETURNING id",[owner,name]))).rows[0].id;
  const waitState = async (id: string, states: string[] = ['completed','failed']) => {
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);
    for(let i=0;i<800;i++) { const j=await queue.getJob(id); if(j && states.includes(await j.getState())) return j; await new Promise(r=>setTimeout(r,25)); }
    throw new Error(`Job ${id} did not reach ${states}`);
  };

  afterEach(async () => {
    jest.restoreAllMocks();
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);
    await queue.pause();
    // Only synthetic, non-active fixture jobs. Never force-remove a locked job.
    for(const job of await queue.getJobs(['waiting','paused','delayed','failed','completed'])) await job.remove();
    await queue.resume();
  });
  const remove=(id:string,bearer=superToken)=>request(app).delete('/api/admin/queues/lead-enrichment/jobs/'+id).set('Authorization','Bearer '+bearer);
  const balance=async()=>Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance);
  const saved=async(id:number)=>(await admin.query('SELECT * FROM enrichment_runs WHERE id=$1',[id])).rows[0];
  const refunds=async(id:number)=>(await admin.query("SELECT * FROM wallet_transactions WHERE type='refund' AND reference_id=$1 AND reference_type IN('credit_reservation','wallet_transaction')",[String(id)])).rows;
  const pausedJob=async(name:string)=>{
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();
    const leadId=await newLead(name);const response=await queuedPost(leadId);expect(response.status).toBe(200);
    const job=(await queue.getJob(response.body.jobId))!;
    return {queue,job,leadId,runId:Number(response.body.runId)};
  };

  it('permits only a current database super-admin and leaves denied jobs and reservations untouched',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_auth');
    expect((await request(app).delete('/api/admin/queues/lead-enrichment/jobs/'+job.id)).status).toBe(401);
    expect((await remove(job.id!,token)).status).toBe(403);
    expect((await remove(job.id!,ordinaryAdminToken)).status).toBe(403);
    const forgedRole=generateToken({adminId:1900000001,email:'synthetic@example.invalid',role:'super_admin'});
    expect((await remove(job.id!,forgedRole)).status).toBe(403);
    expect(await queue.getJob(job.id!)).toBeDefined();expect(await balance()).toBe(995);
    expect((await saved(runId)).removal_intents).toEqual({});expect(actor).not.toHaveBeenCalled();
  });
  it('removes a pending job and releases exactly its original reservation through the mounted super-admin route',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_refund');
    const before=await saved(runId);expect(await balance()).toBe(995);
    const response=await remove(job.id!);expect(response.status).toBe(200);
    expect(await queue.getJob(job.id!)).toBeUndefined();expect(actor).not.toHaveBeenCalled();
    expect(await balance()).toBe(1000);expect(await refunds(before.billing_transaction_id)).toHaveLength(1);
    expect(response.body).toMatchObject({success:true,removed:true,cleanupPending:false});
    const row=await saved(runId);expect(row.billing_status).toBe('released');expect(row.provider_dispatch_started_at).toBeNull();
    expect((await remove(job.id!)).status).toBe(404);expect(await balance()).toBe(1000);
    expect((await get('/api/enrichments/'+runId)).body.data).not.toHaveProperty('removalIntents');
  });

  it('ignores body/header payer substitutions and refunds the original staff reservation after revocation',async()=>{
    const email='admin-removal-member-'+randomUUID()+'@example.invalid';
    const member=(await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete) VALUES($1,'synthetic','Synthetic member',true,true) RETURNING id",[email])).rows[0].id;
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[north,member,email]);
    await admin.query("INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[organization,member,email]);
    const otherOrg=Number((await admin.query('SELECT billing_organization_id FROM company_settings WHERE user_id=$1 LIMIT 1',[outsider])).rows[0].billing_organization_id);
    await admin.query('INSERT INTO wallets(user_id,organization_id,balance) VALUES($1,$2,77) ON CONFLICT(organization_id) DO UPDATE SET balance=77',[outsider,otherOrg]);
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();
    const leadId=await newLead('synthetic_admin_original_staff');
    const memberToken=generateToken({userId:member,email});
    const queued=await request(app).post('/api/leads/'+leadId+'/deep-enrich').set('Authorization','Bearer '+memberToken).set('X-Business-Profile-Id',String(north)).send({async:true});
    expect(queued.status).toBe(200);
    await admin.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2",[north,member]);
    const response=await remove(queued.body.jobId).set('X-Business-Profile-Id',String(south)).send({userId:outsider,billingOrganizationId:otherOrg,billingActorUserId:1900000000});
    expect(response.status).toBe(200);expect(await balance()).toBe(1000);expect(actor).not.toHaveBeenCalled();
    const original=await saved(queued.body.runId);const [refund]=await refunds(original.billing_transaction_id);
    expect(refund.organization_id).toBe(organization);expect(refund.user_id).toBe(owner);expect(refund.actor_user_id).toBe(member);
    expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[otherOrg])).rows[0].balance)).toBe(77);
  });

  it('keeps the original reservation when stored queue identity mismatches its ledger',async()=>{
    const {job,runId}=await pausedJob('synthetic_admin_mismatched_origin');
    await job.updateData({...job.data,billingOrganizationId:organization+1000000});
    const response=await remove(job.id!);expect(response.status).toBe(500);
    expect(await job.getState()).toBe('waiting');expect(await balance()).toBe(995);
    expect((await saved(runId)).removal_intents).toEqual({});expect(actor).not.toHaveBeenCalled();
  });

  it('blocks a previously issued admin session after its password cutoff before touching the job',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_stale_session');
    try {
      await admin.query("UPDATE admins SET password_changed_at=clock_timestamp()+interval '1 second' WHERE id=1900000000");
      expect((await remove(job.id!)).status).toBe(401);
      expect(await queue.getJob(job.id!)).toBeDefined();expect(await balance()).toBe(995);
      expect((await saved(runId)).removal_intents).toEqual({});expect(actor).not.toHaveBeenCalled();
    } finally {await admin.query('UPDATE admins SET password_changed_at=NULL WHERE id=1900000000');}
  });

  it('does not remove or release an observed active job',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_active');
    let finish!: (value:Record<string,unknown>)=>void;
    let entered!: ()=>void;const called=new Promise<void>(resolve=>{entered=resolve;});
    actor.mockImplementationOnce(()=>new Promise<Record<string,unknown>>(resolve=>{finish=resolve;entered();}));
    try {
      await queue.resume();await called;
      const response=await remove(job.id!);expect(response.status).toBe(409);
      expect(await job.getState()).toBe('active');expect(await balance()).toBe(995);
      expect((await saved(runId)).removal_intents).toEqual({});
      finish({success:true,items:[]});await waitState(job.id!);
    } finally {finish?.({success:true,items:[]});}
  },30000);

  it('records an uncertain removal and never releases if the pending job becomes locked',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_lock_race');
    let finish!: (value:Record<string,unknown>)=>void;
    let entered!: ()=>void;const called=new Promise<void>(resolve=>{entered=resolve;});
    actor.mockImplementationOnce(()=>new Promise<Record<string,unknown>>(resolve=>{finish=resolve;entered();}));
    const original=bull.Job.prototype.remove;
    const removal=jest.spyOn(bull.Job.prototype,'remove').mockImplementation(async function(this: InstanceType<typeof bull.Job>,options){
      if(this.id===job.id){await queue.resume();await called;}
      return original.call(this,options);
    });
    try {
      expect((await remove(job.id!)).status).toBe(500);
      const row=await saved(runId);const intent=Object.values(row.removal_intents)[0] as PreparedLeadEnrichmentRemoval;
      expect(intent).toMatchObject({phase:'uncertain'});expect(await balance()).toBe(995);
      expect(await job.getState()).toBe('active');
      finish({success:true,items:[]});await waitState(job.id!);removal.mockRestore();await job.remove();
      expect(await retryConfirmedLeadEnrichmentRemovalRelease(intent)).toMatchObject({status:'not_releasable',creditsRefunded:0});
      expect(await balance()).toBe(995);expect(actor).toHaveBeenCalledTimes(1);
    } finally {finish?.({success:true,items:[]});removal.mockRestore();}
  },30000);

  it('retains a completed worker charge when completion races the pending state read',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_completed_race');
    const original=bull.Job.prototype.remove;
    jest.spyOn(bull.Job.prototype,'remove').mockImplementation(async function(this: InstanceType<typeof bull.Job>,options){
      if(this.id===job.id){await queue.resume();await waitState(job.id!,['completed']);}
      return original.call(this,options);
    });
    const response=await remove(job.id!);expect(response.status).toBe(200);
    expect(response.body.reservationCleanup).toBe('not_releasable');expect(response.body.message).not.toBe('Pending job cancelled');
    expect(await balance()).toBe(995);expect(actor).toHaveBeenCalledTimes(1);
    expect((await saved(runId)).billing_status).toBe('settled');
  },30000);

  it('does not release an attempt claimed before its provider marker',async()=>{
    const {job,runId}=await pausedJob('synthetic_admin_claimed_race');const row=await saved(runId);
    const original=bull.Job.prototype.remove;
    jest.spyOn(bull.Job.prototype,'remove').mockImplementation(async function(this: InstanceType<typeof bull.Job>,options){
      if(this.id===job.id)await business(north,()=>claimDeepEnrichment({run:{id:runId} as never,created:false,credits:5,transactionId:row.billing_transaction_id}));
      return original.call(this,options);
    });
    const response=await remove(job.id!);expect(response.status).toBe(200);expect(response.body.reservationCleanup).toBe('not_releasable');
    expect(await balance()).toBe(995);expect(actor).not.toHaveBeenCalled();expect((await saved(runId)).status).toBe('running');
  });

  it('does not release failed job history with an unknown provider outcome',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_unknown_effect');
    actor.mockResolvedValue({success:false,items:[],error:'Synthetic unknown provider outcome'});
    await queue.resume();await waitState(job.id!,['failed']);
    const response=await remove(job.id!);expect(response.status).toBe(200);expect(response.body.reservationCleanup).toBe('not_releasable');
    expect(await balance()).toBe(995);expect((await saved(runId)).billing_status).toBe('held');expect(actor).toHaveBeenCalledTimes(1);
  },30000);

  it.each([false,true])('settles once across concurrent loaded handles; second removal uncertain=%s',async secondFails=>{
    const {job,runId}=await pausedJob('synthetic_admin_concurrent_'+String(secondFails));
    const original=bull.Job.prototype.remove;let arrived=0;let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    jest.spyOn(bull.Job.prototype,'remove').mockImplementation(async function(this: InstanceType<typeof bull.Job>,options){
      if(this.id===job.id){const call=++arrived;if(call===2)release();await barrier;if(secondFails&&call===2)throw new Error('Synthetic uncertain second removal');}
      return original.call(this,options);
    });
    const responses=await Promise.all([remove(job.id!),remove(job.id!)]);
    expect(responses.map(r=>r.status).sort()).toEqual(secondFails?[200,500]:[200,200]);
    const row=await saved(runId);expect(Object.keys(row.removal_intents)).toHaveLength(2);
    expect(await balance()).toBe(1000);expect(await refunds(row.billing_transaction_id)).toHaveLength(1);expect(actor).not.toHaveBeenCalled();
  });

  it.each(['unavailable','response-lost','final-write','confirmation-write'])('reports durable cleanup-pending truthfully for %s after successful deletion',async mode=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_cleanup_'+mode.replaceAll('-','_'));
    const name='admin_remove_fault_'+randomUUID().replaceAll('-','');
    let settlement:ReturnType<typeof jest.spyOn>|undefined;
    if(mode==='confirmation-write'||mode==='final-write'){
      const phase=mode==='confirmation-write'?'release_pending':'released';
      await admin.query('CREATE FUNCTION '+name+"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id="+runId+" AND EXISTS(SELECT 1 FROM jsonb_each(NEW.removal_intents) AS e WHERE e.value->>'phase'='"+phase+"') THEN RAISE EXCEPTION 'Synthetic removal SQL unavailable'; END IF; RETURN NEW; END $$;CREATE TRIGGER "+name+' BEFORE UPDATE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION '+name+'()');
    }else{
      const original=creditService.settleReservation.bind(creditService);
      settlement=jest.spyOn(creditService,'settleReservation').mockImplementationOnce(async options=>{
        if(mode==='response-lost')await original(options);throw new Error('Synthetic settlement unavailable');
      });
    }
    try {
      const response=await remove(job.id!);expect(response.status).toBe(202);
      expect(response.body).toMatchObject({success:true,removed:true,cleanupPending:true,intentId:expect.any(String)});
      expect(await queue.getJob(job.id!)).toBeUndefined();expect(actor).not.toHaveBeenCalled();
      const row=await saved(runId);const intent=row.removal_intents[response.body.intentId] as PreparedLeadEnrichmentRemoval;
      expect(intent).toMatchObject({phase:mode==='confirmation-write'?'prepared':'release_pending'});
      expect(await balance()).toBe(mode==='unavailable'||mode==='confirmation-write'?995:1000);
      expect((await remove(job.id!)).status).toBe(404);
      settlement?.mockRestore();settlement=undefined;
      await admin.query('DROP TRIGGER IF EXISTS '+name+' ON enrichment_runs;DROP FUNCTION IF EXISTS '+name+'()');
      const recovered=await retryConfirmedLeadEnrichmentRemovalRelease(intent);
      if(mode==='confirmation-write'){
        expect(recovered).toMatchObject({status:'not_releasable',creditsRefunded:0});expect(await balance()).toBe(995);
      }else{
        expect(recovered.status).toBe(mode==='unavailable'?'released':'already_released');
        expect(await balance()).toBe(1000);expect(await refunds(row.billing_transaction_id)).toHaveLength(1);
      }
    } finally {settlement?.mockRestore();await admin.query('DROP TRIGGER IF EXISTS '+name+' ON enrichment_runs;DROP FUNCTION IF EXISTS '+name+'()');}
  });

  it('retains identity without releasing when a deletion acknowledgement and uncertain-outcome SQL write both fail',async()=>{
    const {queue,job,runId}=await pausedJob('synthetic_admin_lost_removal_ack');
    const name='admin_remove_uncertain_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE FUNCTION '+name+"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id="+runId+" AND EXISTS(SELECT 1 FROM jsonb_each(NEW.removal_intents) AS e WHERE e.value->>'phase'='uncertain') THEN RAISE EXCEPTION 'Synthetic uncertain receipt unavailable'; END IF; RETURN NEW; END $$;CREATE TRIGGER "+name+' BEFORE UPDATE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION '+name+'()');
    const original=bull.Job.prototype.remove;
    jest.spyOn(bull.Job.prototype,'remove').mockImplementation(async function(this: InstanceType<typeof bull.Job>,options){
      await original.call(this,options);if(this.id===job.id)throw new Error('Synthetic lost deletion acknowledgement');
    });
    try {
      expect((await remove(job.id!)).status).toBe(500);expect(await queue.getJob(job.id!)).toBeUndefined();
      const row=await saved(runId);const intent=Object.values(row.removal_intents)[0] as PreparedLeadEnrichmentRemoval;
      expect(intent).toMatchObject({phase:'prepared'});expect(await balance()).toBe(995);expect(actor).not.toHaveBeenCalled();
      expect(await retryConfirmedLeadEnrichmentRemovalRelease(intent)).toMatchObject({status:'not_releasable',creditsRefunded:0});
    } finally {await admin.query('DROP TRIGGER '+name+' ON enrichment_runs;DROP FUNCTION '+name+'()');}
  });

  it('preserves legacy unreserved removal and unrelated queue history without issuing credits',async()=>{
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();const leadId=await newLead('synthetic_admin_legacy');
    const id=await business(north,()=>queueRegistry.addJob(QUEUE_NAMES.LEAD_ENRICHMENT,'deep_enrich_lead',{userId:owner,leadId,enrichmentType:'deep_enrichment',createdAt:new Date().toISOString()}));
    expect((await remove(id)).status).toBe(200);expect(await balance()).toBe(1000);expect(actor).not.toHaveBeenCalled();
    const otherId=await business(north,()=>queueRegistry.addJob(QUEUE_NAMES.OUTREACH,'synthetic_inert',{userId:owner,createdAt:new Date().toISOString()}));
    const other=await request(app).delete('/api/admin/queues/outreach/jobs/'+otherId).set('Authorization','Bearer '+superToken);
    expect(other.status).toBe(200);expect(await balance()).toBe(1000);
  });
});
