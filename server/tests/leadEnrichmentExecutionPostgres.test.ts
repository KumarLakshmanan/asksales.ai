import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import type { RemovedLeadEnrichmentJob } from '../services/enrichment/removedJobReservation.js';

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
const { authenticateToken } = await import('../middleware/auth.js');
const { default: leadsRouter } = await import('../routes/leads.routes.js');
const { startAllWorkers, stopAllWorkers } = await import('../workers/index.js');
const { queueRegistry, QUEUE_NAMES } = await import('../queues/index.js');
const { removeJob, retryJob } = await import('../controllers/adminQueueController.js');
const { prepareLeadEnrichmentJobRemoval, releaseRemovedLeadEnrichmentReservation, recordFailedLeadEnrichmentJobRemoval,
  retryConfirmedLeadEnrichmentRemovalRelease } = await import('../services/enrichment/removedJobReservation.js');
const { creditService } = await import('../services/CreditService.js');
const { claimDeepEnrichment } = await import('../services/enrichment/deepExecution.js');
const { withBillingScope } = await import('../tenancy/billingContext.js');
suite('lead enrichment durable execution acceptance', () => {
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
    app.use('/api/enrichments', enrichmentRouter);
    app.use('/api/leads', leadsRouter);
    // Controller boundary probes below intentionally exclude admin auth; user auth remains real above.
    app.delete('/probe/admin/queues/:queueName/jobs/:jobId', removeJob);
    app.post('/probe/admin/queues/:queueName/jobs/:jobId/retry', retryJob);
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
    await admin?.end();
  });


  const queuedPost = (leadId: number) => request(app).post(`/api/leads/${leadId}/deep-enrich`).set('Authorization',`Bearer ${token}`).set('X-Business-Profile-Id',String(north)).send({async:true});
  const newLead = async (name: string) => (await business(north, () => scoped.query("INSERT INTO leads(uuid,user_id,name,source,status,lead_status,twitter_handle) VALUES(gen_random_uuid(),$1,$2::text,'synthetic','new','new',$2::text) RETURNING id",[owner,name]))).rows[0].id;
  const waitState = async (id: string, states: string[] = ['completed','failed']) => {
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);
    for(let i=0;i<800;i++) { const j=await queue.getJob(id); if(j && states.includes(await j.getState())) return j; await new Promise(r=>setTimeout(r,25)); }
    throw new Error(`Job ${id} did not reach ${states}`);
  };

  it('denies a priced queued start before creating a run, dispatching, or debiting', async () => {
    await admin.query('UPDATE wallets SET balance=1 WHERE organization_id=$1',[organization]);
    const leadId=await newLead('synthetic_no_funds');const response=await queuedPost(leadId);
    expect(response.status).toBe(402);expect(actor).not.toHaveBeenCalled();
    expect((await admin.query('SELECT id FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows).toHaveLength(0);
    expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(1);
    expect(Number((await admin.query('SELECT count(*) FROM wallet_transactions WHERE organization_id=$1',[organization])).rows[0].count)).toBe(0);
  });
  it('reserves before dispatch and reopens the exhausted-wallet queue receipt without another charge', async () => {
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();
    await admin.query('UPDATE wallets SET balance=5 WHERE organization_id=$1',[organization]);
    const leadId=await newLead('synthetic_funded');
    const response=await queuedPost(leadId);expect(response.status).toBe(200);
    const row=(await admin.query('SELECT * FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows[0];
    expect(row.status).toBe('pending');expect(row.billing_status).toBe('reserved');expect(actor).not.toHaveBeenCalled();
    expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(0);
    await queue.resume();const job=await waitState(response.body.jobId);expect(await job.getState()).toBe('completed');
    expect(actor).toHaveBeenCalledTimes(1);
    const replay=await queuedPost(leadId);expect(replay.status).toBe(200);expect(replay.body.jobId).toBe(response.body.jobId);
    const saved=(await admin.query('SELECT * FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows;
    expect(saved).toHaveLength(1);expect(saved[0].billing_status).toBe('settled');expect(saved[0].execution_result.success).toBe(true);
    expect(Number((await admin.query("SELECT count(*) FROM wallet_transactions WHERE organization_id=$1 AND type='deduction'",[organization])).rows[0].count)).toBe(1);
    expect((await get(`/api/enrichments/${row.id}`)).body.data).not.toHaveProperty('executionResult');
    expect((await get(`/api/enrichments/${row.id}`,south)).status).toBe(404);
  },30000);
  it('keeps a failed saved run failed in BullMQ and safely replays an explicit failed-job retry', async () => {
    const leadId=await newLead('synthetic_failed_attempt');factory.mockRejectedValue(new Error('Synthetic provider initialization unavailable'));
    const response=await queuedPost(leadId);expect(response.status).toBe(200);const job=await waitState(response.body.jobId);
    expect(await job.getState()).toBe('failed');
    const saved=(await admin.query('SELECT * FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows;
    expect(saved).toHaveLength(1);expect(saved[0].status).toBe('failed');expect(saved[0].billing_status).toBe('released');expect(actor).not.toHaveBeenCalled();
    const retry=await request(app).post(`/probe/admin/queues/lead-enrichment/jobs/${job.id}/retry`);expect(retry.status).toBe(200);
    await waitState(job.id!,['failed']);expect(factory).toHaveBeenCalledTimes(1);
    expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(1000);
  },30000);
  it('retries completion publication without repeating provider work or creating another run', async () => {
    const beforeDebits=Number((await admin.query("SELECT count(*) FROM wallet_transactions WHERE organization_id=$1 AND type='deduction'",[organization])).rows[0].count);
    const leadId=await newLead('synthetic_publish_retry');let injected=false;const original=eventBus.emitToolEvent.bind(eventBus);
    const emit=jest.spyOn(eventBus,'emitToolEvent').mockImplementation(async(status,data)=>{
      if(status==='completed'&&data.toolName==='lead_enrichment'&&!injected){injected=true;throw new Error('Synthetic post-provider event outage');}
      return original(status,data);
    });
    try {
      const response=await queuedPost(leadId);expect(response.status).toBe(200);const job=await waitState(response.body.jobId);
      expect(await job.getState()).toBe('completed');expect(job.attemptsMade).toBe(2);expect(actor).toHaveBeenCalledTimes(1);
      expect((await admin.query('SELECT id FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows).toHaveLength(1);
      expect(Number((await admin.query("SELECT count(*) FROM wallet_transactions WHERE organization_id=$1 AND type='deduction'",[organization])).rows[0].count)).toBe(beforeDebits+1);
    } finally {emit.mockRestore();}
  },30000);
  it.each(['authoritative','ambiguous'])('preserves the %s failure receipt without redispatch on retry',async mode=>{
    const leadId=await newLead(`synthetic_${mode}`);
    actor.mockResolvedValue(mode==='authoritative'?{success:false,status:'FAILED',runId:'synthetic-failed-run',items:[],error:'Synthetic terminal failure'}:{success:false,items:[],error:'Synthetic lost outcome'});
    const response=await queuedPost(leadId);const job=await waitState(response.body.jobId);expect(await job.getState()).toBe('failed');
    const saved=(await admin.query('SELECT * FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows[0];
    expect(saved.billing_status).toBe(mode==='authoritative'?'released':'held');expect(actor).toHaveBeenCalledTimes(1);
    await request(app).post(`/probe/admin/queues/lead-enrichment/jobs/${job.id}/retry`);await waitState(job.id!,['failed']);expect(actor).toHaveBeenCalledTimes(1);
  },30000);

  it('preserves the member snapshot and releases only its original unstarted fee after revocation',async()=>{
    const suffix=randomUUID(),email=`durable-member-${suffix}@example.invalid`;
    const member=(await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete) VALUES($1,'synthetic','Durable member',true,true) RETURNING id",[email])).rows[0].id;
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[north,member,email]);
    await admin.query("INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[organization,member,email]);
    const memberToken=generateToken({userId:member,email});const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();
    const leadId=await newLead('synthetic_revoked_origin');
    const response=await request(app).post(`/api/leads/${leadId}/deep-enrich`).set('Authorization',`Bearer ${memberToken}`).set('X-Business-Profile-Id',String(north)).send({async:true});
    expect(response.status).toBe(200);const queued=(await queue.getJob(response.body.jobId))!;
    expect(queued.data).toMatchObject({userId:owner,businessProfileId:north,businessActorUserId:member,billingActorUserId:member,billingOrganizationId:organization});
    await admin.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2",[north,member]);
    await queue.resume();const job=await waitState(response.body.jobId);expect(await job.getState()).toBe('failed');expect(actor).not.toHaveBeenCalled();
    const saved=(await admin.query('SELECT * FROM enrichment_runs WHERE id=$1',[response.body.runId])).rows[0];
    expect(saved.billing_status).toBe('released');expect(saved.provider_dispatch_started_at).toBeNull();
    expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(1000);
    const original=(await admin.query('SELECT * FROM wallet_transactions WHERE id=$1',[saved.billing_transaction_id])).rows[0];
    expect(original.actor_user_id).toBe(member);expect(original.organization_id).toBe(organization);
  },30000);
  it('refuses changed lead inputs after enqueue without provider IO and releases the unused fee',async()=>{
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();const leadId=await newLead('synthetic_changed_input');
    const response=await queuedPost(leadId);expect(response.status).toBe(200);
    await business(north,()=>scoped.query("UPDATE leads SET twitter_handle='changed_after_start' WHERE id=$1",[leadId]));
    await queue.resume();const job=await waitState(response.body.jobId);expect(await job.getState()).toBe('failed');expect(actor).not.toHaveBeenCalled();
    const saved=(await admin.query('SELECT * FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows[0];expect(saved.billing_status).toBe('released');
  },30000);
  it('applies migration532 repeatedly and refuses to discard saved execution outcomes',async()=>{
    // @ts-expect-error -- JS migration module follows the repository runner contract.
    const migration=await import('../migrations/532_enrichment_execution_results.js');
    const client=await admin.connect();const schema=`execution_${randomUUID().replaceAll('-','')}`;
    try {
      await client.query('BEGIN');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path="${schema}",pg_catalog`);
      await client.query('CREATE TABLE enrichment_runs(id serial PRIMARY KEY)');await migration.up(client);await migration.up(client);
      await client.query(`INSERT INTO enrichment_runs(execution_result) VALUES('{"success":true}')`);await client.query('SAVEPOINT guarded_down');
      await expect(migration.down(client)).rejects.toThrow('Review durable enrichment outcomes');await client.query('ROLLBACK TO SAVEPOINT guarded_down');
      await client.query('DELETE FROM enrichment_runs');await client.query(`INSERT INTO enrichment_runs(removal_intents) VALUES('{"synthetic":{"phase":"prepared"}}')`);
      await client.query('SAVEPOINT guarded_intent_down');await expect(migration.down(client)).rejects.toThrow('Review durable enrichment outcomes');await client.query('ROLLBACK TO SAVEPOINT guarded_intent_down');
      await client.query('DELETE FROM enrichment_runs');await migration.down(client);await migration.up(client);
    } finally {await client.query('ROLLBACK');client.release();}
  });

  it('enforces the same insufficient fixed fee at synchronous legacy lead entry points',async()=>{
    await admin.query('UPDATE wallets SET balance=1 WHERE organization_id=$1',[organization]);const leadId=await newLead('synthetic_sync_denial');
    for(const suffix of ['enrich','deep-enrich']){
      const response=await request(app).post(`/api/leads/${leadId}/${suffix}`).set('Authorization',`Bearer ${token}`).set('X-Business-Profile-Id',String(north)).send({});
      expect(response.status).toBe(402);
    }
    expect(actor).not.toHaveBeenCalled();expect((await admin.query('SELECT id FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows).toHaveLength(0);
  });
  it('creates one durable receipt for a legacy queued payload before provider IO',async()=>{
    const leadId=await newLead('synthetic_legacy_job');
    const jobId=await business(north,()=>queueRegistry.addJob(QUEUE_NAMES.LEAD_ENRICHMENT,'deep_enrich_lead',{userId:owner,leadId,enrichmentType:'deep_enrichment',createdAt:new Date().toISOString()}));
    const job=await waitState(jobId);expect(await job.getState()).toBe('completed');expect(actor).toHaveBeenCalledTimes(1);expect(job.data.enrichmentRunId).toBeGreaterThan(0);
    expect((await admin.query('SELECT id FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows).toHaveLength(1);
  },30000);
  it('does not enqueue or reserve again when Redis accepted a job but its response was lost',async()=>{
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();const leadId=await newLead('synthetic_uncertain_queue');
    const original=queueRegistry.addJob.bind(queueRegistry);let calls=0;
    const add=jest.spyOn(queueRegistry,'addJob').mockImplementation(async(...args:Parameters<typeof queueRegistry.addJob>)=>{const id=await original(...args);if(args[0]===QUEUE_NAMES.LEAD_ENRICHMENT){calls++;throw new Error('Synthetic lost dispatch response');}return id;});
    try {
      const response=await queuedPost(leadId);expect(response.status).toBe(503);expect((await queuedPost(leadId)).status).toBe(503);expect(calls).toBe(1);
      expect((await admin.query('SELECT id FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows).toHaveLength(1);
      const queued=(await queue.getJobs(['waiting','paused'])).find(job=>job.data.leadId===leadId)!;expect(queued).toBeDefined();
      await queue.resume();expect(await (await waitState(queued.id!)).getState()).toBe('completed');expect(actor).toHaveBeenCalledTimes(1);
    } finally {add.mockRestore();await queue.resume();}
  },30000);
  it('holds the fee and replays failure if saving a completed result fails in SQL',async()=>{
    const leadId=await newLead('synthetic_result_write_error');const name=`execution_result_fail_${randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lead_id=${leadId} AND NEW.execution_result->>'success'='true' THEN RAISE EXCEPTION 'Synthetic execution result write failed'; END IF; RETURN NEW; END $$;CREATE TRIGGER ${name} BEFORE UPDATE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      const response=await queuedPost(leadId);const job=await waitState(response.body.jobId);expect(await job.getState()).toBe('failed');expect(actor).toHaveBeenCalledTimes(1);
      const row=(await admin.query('SELECT * FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows[0];expect(row.billing_status).toBe('held');expect(row.execution_result.success).toBe(false);
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(995);
      await request(app).post(`/probe/admin/queues/lead-enrichment/jobs/${job.id}/retry`);await waitState(job.id!,['failed']);expect(actor).toHaveBeenCalledTimes(1);
    } finally {await admin.query(`DROP TRIGGER ${name} ON enrichment_runs;DROP FUNCTION ${name}()`);}
  },30000);

  it('accepts a supported Twitter handle through the legacy single-lead route and charges once',async()=>{
    const leadId=await newLead('synthetic_legacy_supported_handle');
    const response=await request(app).post(`/api/leads/${leadId}/enrich`).set('Authorization',`Bearer ${token}`).set('X-Business-Profile-Id',String(north)).send({});
    expect(response.status).toBe(200);expect(actor).toHaveBeenCalledTimes(1);
    expect((await admin.query('SELECT id FROM enrichment_runs WHERE lead_id=$1',[leadId])).rows).toHaveLength(1);
    expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(995);
  });

  (process.env.LEAD_BROWSER_LOCAL_QA==='1'?it:it.skip)('drives the production browser through the mounted API, registered worker and saved result',async()=>{
    const desktop=await newLead('synthetic_browser_desktop');const mobile=await newLead('synthetic_browser_mobile');
    expect(desktop).not.toBe(mobile);
    await business(north,()=>scoped.query("INSERT INTO enrichment_runs(user_id,lead_name,status,completed_at,summary) VALUES($1,'Synthetic saved discovery','completed',now(),'{}')",[owner]));
    const {getBalance}=await import('../models/wallets/functions.js');
    const {getEffectiveModuleAccess,getMaintenanceSettings}=await import('../models/platformAccess/functions.js');
    app.get('/api/auth/me',authenticateToken,(_req,res)=>res.json({user:{id:owner,name:'Synthetic browser owner',email:'synthetic-browser@example.invalid',isApproved:true,isSetupComplete:true,hasBusinessProfile:true,hasBrandToolkit:true}}));
    app.get('/api/platform/access',authenticateToken,async(_req,res)=>res.json({maintenance:await getMaintenanceSettings(),modules:await getEffectiveModuleAccess(owner)}));
    app.get('/api/settings/business-profiles',authenticateToken,(_req,res)=>res.json([{id:north,name:'Synthetic browser workspace',companyName:'Synthetic company',isDefault:true,role:'owner'}]));
    app.get('/api/wallet',authenticateToken,async(_req,res)=>res.json({balance:await getBalance(owner)}));
    await writeFile('/tmp/lead-discovery-browser-fixture.json',JSON.stringify({userId:owner,businessProfileId:north,token,browserLeadNames:{desktop:'synthetic_browser_desktop',mobile:'synthetic_browser_mobile'}}));
    const server=app.listen(58080,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const browserLog=process.env.LEAD_DISCOVERY_BROWSER_LOG||'/tmp/lead-production-browser.log';
    try {
      const {stdout,stderr}=await promisify(execFile)(process.execPath,[new URL('../../node_modules/@playwright/test/cli.js',import.meta.url).pathname,'test','--config','playwright.lead-discovery-audit.config.ts','lead-enrichment-execution.spec.ts'],{cwd:new URL('../../client/',import.meta.url).pathname,env:{...process.env,JEST_WORKER_ID:undefined},timeout:150000,maxBuffer:2e6});
      await writeFile(browserLog,stdout+stderr);
      expect(actor).toHaveBeenCalledTimes(2);
    } catch(error) {
      const output=error as {stdout?:string;stderr?:string};await writeFile(browserLog,(output.stdout||'')+(output.stderr||''));throw error;
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  },180000);

  it('releases the original unstarted fixed fee when an admin removes a pending lead job',async()=>{
    const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();const leadId=await newLead('synthetic_pending_cancel_fee');
    try {
      const response=await queuedPost(leadId);expect(response.status).toBe(200);
      const removed=await request(app).delete(`/probe/admin/queues/lead-enrichment/jobs/${response.body.jobId}`);expect(removed.status).toBe(200);
      expect(actor).not.toHaveBeenCalled();
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance)).toBe(1000);
    } finally {await queue.resume();}
  });

  // These call the Lead-owned helper around real BullMQ deletion. The Admin
  // controller composition above remains a separate, intentionally failing gate
  // until its original owner applies the pre/remove/post hook.
  describe('durable removed-job reservation helper',()=>{
    const snapshotJob=(job: InstanceType<typeof bull.Job>):RemovedLeadEnrichmentJob=>({queueName: 'lead-enrichment',jobId:job.id!,data:job.data as RemovedLeadEnrichmentJob['data']});
    const pausedJob=async(name:string)=>{
      const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();
      const leadId=await newLead(name),response=await queuedPost(leadId);expect(response.status).toBe(200);
      const job=(await queue.getJob(response.body.jobId))!;expect(job).toBeDefined();
      return {queue,job,leadId,runId:response.body.runId as number};
    };
    const balance=async()=>Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1',[organization])).rows[0].balance);
    const run=async(id:number)=>(await admin.query('SELECT * FROM enrichment_runs WHERE id=$1',[id])).rows[0];
    const refunds=async(id:number)=>(await admin.query("SELECT * FROM wallet_transactions WHERE type='refund' AND reference_id=$1 AND reference_type IN('credit_reservation','wallet_transaction')",[String(id)])).rows;

    it('releases a removed unclaimed attempt once across concurrent cleanup and hides private intents',async()=>{
      const {queue,job,runId}=await pausedJob('synthetic_removal_concurrent');
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        expect((await run(runId)).status).toBe('pending');expect(await balance()).toBe(995);
        expect((await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!.intentId).not.toBe(ticket.intentId);
        expect((await get(`/api/enrichments/${runId}`)).body.data).not.toHaveProperty('removalIntents');
        await job.remove();
        const results=await Promise.all(Array.from({length:6},()=>releaseRemovedLeadEnrichmentReservation(ticket)));
        expect(results.filter(r=>r.status==='released')).toHaveLength(1);
        expect(results.reduce((total,r)=>total+r.creditsRefunded,0)).toBe(5);
        expect(await balance()).toBe(1000);expect(actor).not.toHaveBeenCalled();
        expect(await refunds(ticket.reservationTransactionId!)).toHaveLength(1);
        const saved=await run(runId);expect(saved.status).toBe('failed');expect(saved.billing_status).toBe('released');
        expect(saved.provider_dispatch_started_at).toBeNull();expect(saved.removal_intents[ticket.intentId].phase).toBe('released');
        expect(await retryConfirmedLeadEnrichmentRemovalRelease(ticket)).toMatchObject({status:'already_released',creditsRefunded:0});
      } finally {await queue.resume();}
    });
    it('rejects caller payload and ticket identity changes before issuing credits',async()=>{
      const {queue,job}=await pausedJob('synthetic_removal_identity');
      try {
        const original=snapshotJob(job);
        await expect(prepareLeadEnrichmentJobRemoval({...original,data:{...original.data,billingOrganizationId:organization+1000000}})).rejects.toMatchObject({status:409});
        const ticket=(await prepareLeadEnrichmentJobRemoval(original))!;await job.remove();
        await expect(releaseRemovedLeadEnrichmentReservation({...ticket,reservationTransactionId:ticket.reservationTransactionId!+1})).rejects.toMatchObject({status:409});
        expect(await balance()).toBe(995);expect(actor).not.toHaveBeenCalled();
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'released',creditsRefunded:5});
      } finally {await queue.resume();}
    });
    it('keeps a successful deletion eligible when a concurrent removal handle fails',async()=>{
      const {queue,job}=await pausedJob('synthetic_removal_concurrent_handles');
      try {
        const successful=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        const unsuccessful=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        await job.remove();
        // A second real removal can report absence rather than a locked error;
        // this uncertain handler must not invalidate the first known success.
        await recordFailedLeadEnrichmentJobRemoval(unsuccessful,'uncertain');
        expect(await releaseRemovedLeadEnrichmentReservation(successful)).toMatchObject({status:'released',creditsRefunded:5});
        expect(await retryConfirmedLeadEnrichmentRemovalRelease(unsuccessful)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect(await balance()).toBe(1000);expect(await refunds(successful.reservationTransactionId!)).toHaveLength(1);expect(actor).not.toHaveBeenCalled();
      } finally {await queue.resume();}
    });
    it('never treats failed or uncertain deletion or absent Redis history as confirmation',async()=>{
      const {queue,job}=await pausedJob('synthetic_removal_uncertain');
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'not_removed',creditsRefunded:0});
        await recordFailedLeadEnrichmentJobRemoval(ticket,'uncertain');await job.remove();
        expect(await retryConfirmedLeadEnrichmentRemovalRelease(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect(await balance()).toBe(995);expect(actor).not.toHaveBeenCalled();
      } finally {await queue.resume();}
    });
    it('retains prepared identity when confirmation SQL fails after deletion without inferring success',async()=>{
      const {queue,job,runId}=await pausedJob('synthetic_removal_confirm_sql');
      const name=`remove_confirm_fail_${randomUUID().replaceAll('-','')}`;
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;await job.remove();
        await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${runId} AND NEW.removal_intents->'${ticket.intentId}'->>'phase'='release_pending' THEN RAISE EXCEPTION 'Synthetic confirmation unavailable'; END IF; RETURN NEW; END $$;CREATE TRIGGER ${name} BEFORE UPDATE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        await expect(releaseRemovedLeadEnrichmentReservation(ticket)).rejects.toMatchObject({cause:{message:'Synthetic confirmation unavailable'}});
        expect(await balance()).toBe(995);expect((await run(runId)).removal_intents[ticket.intentId].phase).toBe('prepared');
        expect(await retryConfirmedLeadEnrichmentRemovalRelease(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        await admin.query(`DROP TRIGGER ${name} ON enrichment_runs;DROP FUNCTION ${name}()`);
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'released',creditsRefunded:5});
      } finally {await admin.query(`DROP TRIGGER IF EXISTS ${name} ON enrichment_runs;DROP FUNCTION IF EXISTS ${name}()`);await queue.resume();}
    });
    it.each(['unavailable','response-lost','final-write'])('recovers a %s settlement failure from durable intent without a second refund',async(mode)=>{
      const {queue,job,runId}=await pausedJob(`synthetic_removal_${mode.replaceAll('-','_')}`);
      const name=`remove_final_fail_${randomUUID().replaceAll('-','')}`;
      let settle: ReturnType<typeof jest.spyOn> | undefined;
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;await job.remove();
        if(mode==='final-write') await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${runId} AND NEW.removal_intents->'${ticket.intentId}'->>'phase'='released' THEN RAISE EXCEPTION 'Synthetic final cleanup write unavailable'; END IF; RETURN NEW; END $$;CREATE TRIGGER ${name} BEFORE UPDATE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        else {
          const original=creditService.settleReservation.bind(creditService);
          settle=jest.spyOn(creditService,'settleReservation').mockImplementationOnce(async(options)=>{
            if(mode==='response-lost') await original(options);
            throw new Error('Synthetic settlement transport failure');
          });
        }
        await expect(releaseRemovedLeadEnrichmentReservation(ticket)).rejects.toThrow();
        const saved=await run(runId);expect(saved.removal_intents[ticket.intentId].phase).toBe('release_pending');expect(saved.billing_status).toBe('held');
        expect(await queue.getJob(job.id!)).toBeUndefined();expect(actor).not.toHaveBeenCalled();
        expect(await balance()).toBe(mode==='unavailable'?995:1000);
        settle?.mockRestore();settle=undefined;
        if(mode==='final-write') await admin.query(`DROP TRIGGER ${name} ON enrichment_runs;DROP FUNCTION ${name}()`);
        const recovered=await retryConfirmedLeadEnrichmentRemovalRelease(ticket);
        expect(recovered.status).toBe(mode==='unavailable'?'released':'already_released');expect(recovered.creditsRefunded).toBe(mode==='unavailable'?5:0);
        expect(await balance()).toBe(1000);expect(await refunds(ticket.reservationTransactionId!)).toHaveLength(1);
        expect((await run(runId)).removal_intents[ticket.intentId].phase).toBe('released');
      } finally {settle?.mockRestore();await admin.query(`DROP TRIGGER IF EXISTS ${name} ON enrichment_runs;DROP FUNCTION IF EXISTS ${name}()`);await queue.resume();}
    });
    it('does not release a claimed attempt even before its first provider marker',async()=>{
      const {queue,job,runId}=await pausedJob('synthetic_removal_claimed');
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        const saved=await run(runId);
        const claimed=await business(north,()=>claimDeepEnrichment({run:{...saved,id:runId} as never,created:false,credits:5,transactionId:saved.billing_transaction_id}));
        expect(claimed).toBeDefined();
        await job.remove();expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect(await balance()).toBe(995);expect(actor).not.toHaveBeenCalled();expect((await run(runId)).status).toBe('running');
      } finally {await queue.resume();}
    });
    it('does not release when the worker finishes between preparation and successful removal',async()=>{
      const {queue,job,runId}=await pausedJob('synthetic_removal_finished_race');
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;await queue.resume();
        const finished=await waitState(job.id!);expect(await finished.getState()).toBe('completed');await finished.remove();
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect(await balance()).toBe(995);expect(actor).toHaveBeenCalledTimes(1);expect((await run(runId)).billing_status).toBe('settled');
        const [settlement]=await refunds(ticket.reservationTransactionId!);expect(Number(settlement.amount)).toBe(0);
      } finally {await queue.resume();}
    },30000);
    it('retains credits when real active removal fails and provider work later completes',async()=>{
      const {queue,job}=await pausedJob('synthetic_removal_active_race');
      let finish!: (value:Record<string,unknown>)=>void;
      let entered!: ()=>void;const called=new Promise<void>(resolve=>{entered=resolve;});
      actor.mockImplementationOnce(()=>new Promise<Record<string,unknown>>(resolve=>{finish=resolve;entered();}));
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;await queue.resume();await called;
        expect(await job.getState()).toBe('active');await expect(job.remove()).rejects.toThrow();
        await recordFailedLeadEnrichmentJobRemoval(ticket,'failed');
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'not_removed',creditsRefunded:0});
        finish({success:true,items:[],runId:'synthetic-active-finished'});const done=await waitState(job.id!);await done.remove();
        expect(await retryConfirmedLeadEnrichmentRemovalRelease(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect(await balance()).toBe(995);const [settlement]=await refunds(ticket.reservationTransactionId!);expect(Number(settlement.amount)).toBe(0);expect(actor).toHaveBeenCalledTimes(1);
      } finally {finish?.({success:true,items:[]});await queue.resume();}
    },30000);
    it('does not release a removed failed job with an uncertain external outcome',async()=>{
      const {queue,job,runId}=await pausedJob('synthetic_removal_unknown_provider');
      try {
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        actor.mockResolvedValue({success:false,items:[],error:'Synthetic lost provider outcome'});await queue.resume();
        const failed=await waitState(job.id!);expect(await failed.getState()).toBe('failed');await failed.remove();
        expect(await releaseRemovedLeadEnrichmentReservation(ticket)).toMatchObject({status:'not_releasable',creditsRefunded:0});
        expect((await run(runId)).billing_status).toBe('held');expect(await balance()).toBe(995);expect(actor).toHaveBeenCalledTimes(1);
      } finally {await queue.resume();}
    },30000);
    it('uses the original staff and payer identity after revocation despite an ambient different scope',async()=>{
      const suffix=randomUUID(),email=`remove-member-${suffix}@example.invalid`;
      const member=(await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete) VALUES($1,'synthetic','Removal member',true,true) RETURNING id",[email])).rows[0].id;
      await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[north,member,email]);
      await admin.query("INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",[organization,member,email]);
      const memberToken=generateToken({userId:member,email});const queue=queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT);await queue.pause();
      try {
        const leadId=await newLead('synthetic_removal_original_staff');
        const response=await request(app).post(`/api/leads/${leadId}/deep-enrich`).set('Authorization',`Bearer ${memberToken}`).set('X-Business-Profile-Id',String(north)).send({async:true});
        expect(response.status).toBe(200);const job=(await queue.getJob(response.body.jobId))!;
        const ticket=(await prepareLeadEnrichmentJobRemoval(snapshotJob(job)))!;
        await admin.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2",[north,member]);
        await admin.query("UPDATE billing_organization_memberships SET status='revoked' WHERE organization_id=$1 AND user_id=$2",[organization,member]);
        await job.remove();
        const released=await withBusinessScope({userId:outsider,businessProfileId:south,actorUserId:outsider},()=>withBillingScope({organizationId:organization+100000,actorUserId:outsider,businessProfileId:south,businessOwnerUserId:outsider},()=>releaseRemovedLeadEnrichmentReservation(ticket)));
        expect(released.status).toBe('released');expect(await balance()).toBe(1000);expect(actor).not.toHaveBeenCalled();
        const [refund]=await refunds(ticket.reservationTransactionId!);
        expect(refund).toMatchObject({user_id:owner,organization_id:organization,actor_user_id:member,billing_business_profile_id:north});
      } finally {await queue.resume();}
    });
    it('does not reconstruct a reservation for a legacy job without a saved run',async()=>{
      expect(await prepareLeadEnrichmentJobRemoval({queueName:'lead-enrichment',jobId:'legacy-without-receipt',data:{userId:owner,businessProfileId:north,businessActorUserId:owner,billingOrganizationId:organization,billingActorUserId:owner,leadId:1}})).toBeNull();
      expect(await balance()).toBe(1000);expect(actor).not.toHaveBeenCalled();
    });
  });

});
