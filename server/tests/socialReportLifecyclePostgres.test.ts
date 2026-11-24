import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns, type SQL } from 'drizzle-orm';
import { readFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

// Explicit opt-in, disposable database only. Never loads application .env files.
const connectionString = process.env.SOCIAL_INSIGHTS_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let pool: Pool;
const schema=`social_insights_${randomBytes(8).toString('hex')}`;
let database: NodePgDatabase;
let afterReportScan: (() => Promise<void>) | undefined;
const execute = async (query: SQL) => {
  const result = await database.execute(query);
  if (afterReportScan && result.rows.some(row => row.schedule_cron !== undefined)) {
    const callback = afterReportScan; afterReportScan = undefined; await callback();
  }
  return result;
};
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute,
  select: (...args: Parameters<NodePgDatabase['select']>) => database.select(...args),
  transaction: (callback: Parameters<NodePgDatabase['transaction']>[0]) => database.transaction(callback),
} }));
const notify = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const sendEmail = jest.fn<(...args: unknown[]) => Promise<{ success: boolean; error?: string }>>();
let moduleEnabled = true;
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getEffectiveModuleAccess: async () => [{ key: 'content', enabled: moduleEnabled, status: 'available' }],
  getMaintenanceSettings: async () => ({ enabled: false }),
}));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { notify } }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendEmailWithUserCredentials: sendEmail } }));
const controller = await import('../controllers/socialAnalyticsController.js');
const { requireModuleAccess } = await import('../middleware/platformAccess.js');

const app = express();
app.use(express.json());
// Identity/scope are fixture-only; production authentication is not bypassed or changed.
app.use((req, _res, next) => {
  if (req.get('x-qa-user') === '0') return next();
  req.user = { id: Number(req.get('x-qa-user') || 17) } as typeof req.user;
  withBusinessScope({ userId: req.user!.id, businessProfileId: Number(req.get('x-qa-business') || 1701) }, next);
});
app.use(requireModuleAccess('content'));
app.get('/reports', controller.listSavedSocialReports);
app.post('/reports', controller.createSavedSocialReport);
app.patch('/reports/:id', controller.updateSavedSocialReport);
app.delete('/reports/:id', controller.deleteSavedSocialReport);
app.post('/reports/:id/export', controller.exportSavedSocialReport);
app.get('/reports/:id/exports/:exportId', controller.getSavedSocialReportExport);
app.get('/reports/:id/deliveries', controller.listSocialReportDeliveries);
app.get('/listening', controller.listListeningEvents);
app.patch('/listening/:id', controller.updateListeningEvent);
app.get('/competitors', controller.listSocialCompetitors);
app.get('/competitors/:id/benchmark',controller.getCompetitorBenchmark);
app.post('/competitors', controller.createSocialCompetitor);
app.patch('/competitors/:id', controller.updateSocialCompetitor);
app.delete('/competitors/:id', (req,res,next)=>{void controller.deleteSocialCompetitor(req,res).catch(next);});
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message });
});
const http = supertest(app);
const now = new Date('2026-10-23T09:00:15Z');
const scope = <T>(work: () => T, businessProfileId = 1701) => withBusinessScope({ userId: 17, businessProfileId }, work);
async function report(overrides: Record<string, unknown> = {}) {
  const response = await http.post('/reports').send({ name: 'Weekly', filters: { relativeDays: 7, timezone: 'UTC' },
    scheduleCron: '0 9 * * *', deliveryChannel: 'in_app', ...overrides });
  expect(response.status).toBe(201);
  return response.body as { id: string; schedule_cron: string; schedule_definition: unknown };
}
async function competitor(withEvidence=true) {
  const row=(await pool.query(`INSERT INTO social_competitors(user_id,business_profile_id,platform,public_handle,public_url)
    VALUES(17,1701,'instagram','peer_a','https://instagram.com/peer_a') RETURNING *`)).rows[0];
  if(withEvidence) await pool.query(`INSERT INTO social_competitor_snapshots(competitor_id,user_id,business_profile_id,source,source_snapshot_id,metrics,source_url)
    VALUES($1,17,1701,'official_api','fixture-peer-a','{"followers":42}','https://instagram.com/peer_a')`,[row.id]);
  return row;
}

suite('Social report/listening lifecycle with disposable PostgreSQL and real handlers/SQL', () => {
  beforeAll(async () => {
    const target = new URL(connectionString!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/social_insights_audit')
      throw new Error('Only the disposable local social_insights_audit database is allowed');
    pool = new Pool({ connectionString, max: 8, options:`-c search_path=${schema},pg_catalog` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(17),(18)');
    await pool.query('CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer); INSERT INTO company_settings VALUES(1701,17),(1702,17),(1801,18)');
    await localBusinessFunctions(pool);
    const columns = Object.values(getTableColumns(channelCredentialsTable)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',');
    await pool.query(`CREATE TABLE channel_credentials(${columns}); ALTER TABLE channel_credentials ADD PRIMARY KEY(id)`);
    // Use the shipped report/listening DDL, plus only the supporting fixture tables.
    for (const migration of ['180_create_social_listening_and_competitors', '181_create_social_reports',
      '183_harden_social_report_delivery_idempotency', '185_harden_social_competitor_snapshot_integrity',
      '228_add_social_report_timezone_schedule', '246_create_social_content_insights', '272_social_reporting_periods',
      '282_social_insights_management','570_social_report_preparation_fence']) {
      const { up } = await import(`../migrations/${migration}.js`);
      await up({ query: (text: string, values?: unknown[]) => pool.query(text, values) });
    }
    await pool.query(`CREATE TABLE social_metric_snapshots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id integer,
      platform text,account_identifier text,metric_window_start timestamptz,metric_window_end timestamptz,source text,
      source_snapshot_id text,metrics jsonb,captured_at timestamptz DEFAULT NOW(),timezone text);
      CREATE TABLE social_comment_workflows(user_id integer,credential_id integer,post_id text,comment_id text,status text);
      ALTER TABLE social_saved_reports DROP CONSTRAINT social_saved_reports_user_id_name_key;
      ALTER TABLE social_listening_events DROP CONSTRAINT social_listening_events_user_id_platform_provider_event_id_key;
      ALTER TABLE social_competitors DROP CONSTRAINT social_competitors_user_id_platform_public_handle_key`);
    // Exercise the production scoped pool against real RLS; this is a bounded
    // fixture, not a claim to have applied the full application's migration chain.
    const scopedTables=['social_saved_reports', 'social_report_exports', 'social_report_deliveries',
      'social_listening_events', 'social_competitors', 'social_competitor_snapshots', 'social_metric_snapshots',
      'social_content_items', 'social_comment_workflows', 'channel_credentials'];
    await localBusinessIsolation(pool,schema,scopedTables);
    await pool.query(`CREATE UNIQUE INDEX report_scope_name ON social_saved_reports(business_profile_id,user_id,name);
      CREATE UNIQUE INDEX listening_scope_event ON social_listening_events(business_profile_id,user_id,platform,provider_event_id);
      CREATE UNIQUE INDEX competitor_scope_handle ON social_competitors(business_profile_id,user_id,platform,public_handle)`);
    database = drizzle(createBusinessScopedPool(pool));
  });
  beforeEach(async () => {
    jest.clearAllMocks(); notify.mockResolvedValue({ id: 'fixture-notification' }); sendEmail.mockResolvedValue({ success: true });
    afterReportScan = undefined; moduleEnabled = true;
    await pool.query('TRUNCATE social_saved_reports,social_listening_events,social_metric_snapshots,social_competitors,channel_credentials,social_comment_workflows RESTART IDENTITY CASCADE');
  });
  afterAll(async () => { if(pool) {try {await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);} finally {await pool.end();}} });

  it('updates a legacy UTC cron from the exact editor PATCH body and preserves it on pause/resume', async () => {
    const saved = await report();
    const updated = await http.patch(`/reports/${saved.id}`).send({ name: 'Weekly', filters: { relativeDays: 7, timezone: 'UTC' },
      schedule: null, scheduleCron: '30 10 * * 1', deliveryChannel: 'in_app', deliveryTarget: null });
    expect(updated.status).toBe(200); expect(updated.body.schedule_cron).toBe('30 10 * * 1');
    const paused = await http.patch(`/reports/${saved.id}`).send({ paused: true });
    expect(paused.body.schedule_cron).toBe('30 10 * * 1'); expect(paused.body.paused).toBe(true);
    const resumed = await http.patch(`/reports/${saved.id}`).send({ paused: false });
    expect(resumed.body.schedule_cron).toBe('30 10 * * 1'); expect(resumed.body.paused).toBe(false);
  });
  it('accepts switching between friendly, cron, and on-demand schedules; rejects invalid or conflicting schedules', async () => {
    const saved = await report();
    const friendly = { frequency: 'weekly', dayOfWeek: 1, localTime: '09:30', timezone: 'America/New_York' };
    expect((await http.patch(`/reports/${saved.id}`).send({ schedule: friendly, scheduleCron: null })).body.schedule_definition).toEqual(friendly);
    expect((await http.patch(`/reports/${saved.id}`).send({ schedule: null, scheduleCron: '30 9 * * 1' })).body.schedule_cron).toBe('30 9 * * 1');
    expect((await http.patch(`/reports/${saved.id}`).send({ scheduleCron: 'bad' })).status).toBe(400);
    expect((await http.patch(`/reports/${saved.id}`).send({ schedule: friendly, scheduleCron: '30 9 * * 1' })).status).toBe(400);
    const cleared = await http.patch(`/reports/${saved.id}`).send({ schedule: null, scheduleCron: null, filters: {} });
    expect(cleared.status).toBe(200); expect(cleared.body.schedule_cron).toBeNull(); expect(cleared.body.schedule_definition).toBeNull();
    for (const scheduleCron of [0, false, [], 'bad']) {
      expect((await http.patch(`/reports/${saved.id}`).send({ scheduleCron })).status).toBe(400);
      expect((await http.post('/reports').send({name:'Invalid',filters:{relativeDays:7},scheduleCron,deliveryChannel:'in_app'})).status).toBe(400);
    }
  });
  it('enforces the actual content module middleware and authenticated owner requirement', async () => {
    expect((await http.get('/reports').set('x-qa-user','0')).status).toBe(401);
    moduleEnabled = false;
    expect((await http.get('/reports')).status).toBe(403);
    expect((await http.post('/reports').send({name:'Forbidden'})).status).toBe(403);
  });
  it('isolates the same report name and immutable exports across two businesses and another owner', async () => {
    const saved = await report();
    expect((await http.post('/reports').set('x-qa-business','1702').send({ name: 'Weekly', filters: {} })).status).toBe(201);
    const exported = await http.post(`/reports/${saved.id}/export`).send({ format: 'json' });
    expect(exported.status).toBe(201);
    expect((await http.get(`/reports/${saved.id}/exports/${exported.body.id}`).set('x-qa-business','1702')).status).toBe(404);
    expect((await http.get(`/reports/${saved.id}/deliveries`).set('x-qa-user','18')).status).toBe(404);
    expect((await http.patch(`/reports/${saved.id}`).set('x-qa-business','1702').send({ paused: true })).status).toBe(404);
    expect((await http.delete(`/reports/${saved.id}`).set('x-qa-business','1702')).status).toBe(404);
  });
  it('reserves only one export/notification under concurrent replicas and duplicate execution', async () => {
    await report();
    const results = await Promise.all([scope(() => controller.processDueSocialReports(now)), scope(() => controller.processDueSocialReports(now))]);
    expect(results.reduce((sum, row) => sum + row.sent, 0)).toBe(1); expect(notify).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT * FROM social_report_exports')).rows).toHaveLength(1);
    expect(await scope(() => controller.processDueSocialReports(now))).toEqual({ processed: 0, sent: 0, failed: 0, skipped: 1 });
  });
  const redisTest = process.env.SOCIAL_INSIGHTS_QA_REDIS_URL ? it : it.skip;
  redisTest('survives a real Redis/BullMQ worker retry and duplicate job IDs without a second delivery', async () => {
    const target = new URL(process.env.SOCIAL_INSIGHTS_QA_REDIS_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) || target.port !== '6393') throw new Error('Disposable audit Redis on port 6393 required');
    const { Queue, Worker, QueueEvents } = await import('bullmq');
    const connection = {host:target.hostname,port:Number(target.port),maxRetriesPerRequest:null};
    const name=`social-insights-audit-${process.pid}`, options={connection};
    const queue=new Queue(name,options), events=new QueueEvents(name,options);
    let executions=0;
    await report();
    const worker=new Worker(name,async()=>{
      executions++; const result=await scope(()=>controller.processDueSocialReports(now));
      if(executions===1) throw new Error('Fixture worker restart after persisted delivery');
      return result;
    },{...options,concurrency:2});
    try {
      await events.waitUntilReady();
      const job=await queue.add('cron-scheduled-social-reports',{}, {jobId:'fixture-occurrence',attempts:2,backoff:{type:'fixed',delay:50}});
      await queue.add('cron-scheduled-social-reports',{}, {jobId:'fixture-occurrence'});
      await job.waitUntilFinished(events,10000);
      expect(executions).toBe(2); expect(notify).toHaveBeenCalledTimes(1);
      expect((await pool.query('SELECT * FROM social_report_exports')).rows).toHaveLength(1);
    } finally { await worker.close(); await events.close(); await queue.obliterate({force:true}); await queue.close(); }
  });
  redisTest('uses existing BullMQ retry behavior for a failed preparation, then sends once after SQL recovery',async()=>{
    const target=new URL(process.env.SOCIAL_INSIGHTS_QA_REDIS_URL!);
    if(!['localhost','127.0.0.1'].includes(target.hostname)||target.port!=='6393') throw new Error('Disposable audit Redis required');
    const {Queue,Worker,QueueEvents}=await import('bullmq');
    const options={connection:{host:target.hostname,port:Number(target.port),maxRetriesPerRequest:null}}, name=`social-report-preparation-${process.pid}`;
    const queue=new Queue(name,options),events=new QueueEvents(name,options); let executions=0;
    await report();await pool.query('ALTER TABLE social_metric_snapshots RENAME TO offline_metric_snapshots');
    const worker=new Worker(name,async()=>{
      executions++;
      try {return await scope(()=>controller.processDueSocialReports(now));}
      catch(error){if(executions===1) await pool.query('ALTER TABLE offline_metric_snapshots RENAME TO social_metric_snapshots');throw error;}
    },options);
    try {
      await events.waitUntilReady();
      const job=await queue.add('cron-scheduled-social-reports',{}, {attempts:3,backoff:{type:'exponential',delay:3000}});
      expect((await job.waitUntilFinished(events,15000)).sent).toBe(1);
      expect(executions).toBe(2);expect(notify).toHaveBeenCalledTimes(1);
      expect((await pool.query('SELECT * FROM social_report_exports')).rows).toHaveLength(1);
    } finally {
      await worker.close();await events.close();await queue.obliterate({force:true});await queue.close();
      await pool.query(`DO $$ BEGIN IF to_regclass('offline_metric_snapshots') IS NOT NULL THEN ALTER TABLE offline_metric_snapshots RENAME TO social_metric_snapshots; END IF; END $$`);
    }
  },20000);
  it('retains the generated export citation in delivery history when notification delivery fails', async () => {
    const saved = await report(); notify.mockResolvedValue(false);
    expect(await scope(() => controller.processDueSocialReports(now))).toEqual({ processed: 1, sent: 0, failed: 1, skipped: 0 });
    const history = await http.get(`/reports/${saved.id}/deliveries`);
    expect(history.status).toBe(200); expect(history.body[0].status).toBe('failed');
    expect(history.body[0].export_id).toEqual(expect.any(String)); expect(history.body[0].exported_at).toBeTruthy();
    expect((await http.get(`/reports/${saved.id}/exports/${history.body[0].export_id}`)).status).toBe(200);
    await scope(() => controller.processDueSocialReports(now)); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('does not rerun an ambiguous email send when the same occurrence is retried', async () => {
    await report({ deliveryChannel: 'email', deliveryTarget: 'audit@example.test' });
    sendEmail.mockRejectedValue(new Error('fixture provider timed out after acceptance'));
    expect((await scope(() => controller.processDueSocialReports(now))).failed).toBe(1);
    expect((await scope(() => controller.processDueSocialReports(now))).processed).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
  it('recovers a generation SQL failure after database recovery in the same occurrence',async()=>{
    await report(); await pool.query('ALTER TABLE social_metric_snapshots RENAME TO offline_metric_snapshots');
    let failure:unknown;
    try {await scope(()=>controller.processDueSocialReports(now));} catch(error){failure=error;}
    finally {await pool.query('ALTER TABLE offline_metric_snapshots RENAME TO social_metric_snapshots');}
    expect((await scope(()=>controller.processDueSocialReports(now))).sent).toBe(1);
    expect(failure).toEqual(expect.objectContaining({code:'SOCIAL_REPORT_PREPARATION_FAILED'}));
    const ledger=(await pool.query('SELECT * FROM social_report_deliveries')).rows;
    expect(ledger).toHaveLength(1); expect(ledger[0].status).toBe('sent'); expect(ledger[0].generation_attempts).toBe(2);
    expect((await pool.query('SELECT * FROM social_report_exports')).rows).toHaveLength(1); expect(notify).toHaveBeenCalledTimes(1);
  });
  it.each([false,true])('rolls back an actually killed preparation process (after export=%s) and recovers without a lease or duplicate export',async(afterExport)=>{
    await report();
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./helpers/socialReportCrashFixture.ts',import.meta.url))],{
      cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',SOCIAL_INSIGHTS_QA_DATABASE_URL:connectionString!,SOCIAL_INSIGHTS_QA_SCHEMA:schema,SOCIAL_INSIGHTS_QA_CRASH_AFTER_EXPORT:afterExport?'1':'0'},stdio:['ignore','pipe','pipe'],
    });
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    let output='',errors=''; child.stderr.on('data',chunk=>{errors+=String(chunk);});
    let marker:{atomic:boolean;backendPid:number};
    try {
      marker=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`Crash fixture did not reach preparation: ${errors}`)),10000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error(`Crash fixture exited before its barrier: ${errors}`));});
      });
      expect((await scope(()=>controller.processDueSocialReports(now))).processed).toBe(0);
    } finally {child.kill('SIGKILL');await exited;}
    for(let attempt=0;attempt<100;attempt++) {
      if(!(await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[marker.backendPid])).rows.length) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect((await pool.query('SELECT * FROM social_report_deliveries')).rows).toHaveLength(0);
    expect((await pool.query('SELECT * FROM social_report_exports')).rows).toHaveLength(0);
    expect(marker.atomic).toBe(true);
    expect((await scope(()=>controller.processDueSocialReports(now))).sent).toBe(1); expect(notify).toHaveBeenCalledTimes(1);
  },20000);
  it.each(['pending','failed'])('keeps legacy %s occurrences unreplayed and migration up/down/up preserves their evidence',async(status)=>{
    const saved=await report();
    await pool.query(`INSERT INTO social_report_deliveries(report_id,user_id,business_profile_id,delivery_key,status)
      VALUES($1,17,1701,'cron:2026-10-23T09:00:00.000Z',$2)`,[saved.id,status]);
    const migrationName='570_social_report_preparation_fence';
    const migration=await import(`../migrations/${migrationName}.js`) as {
      up:(client:{query:(statement:string)=>Promise<unknown>})=>Promise<void>;
      down:(client:{query:(statement:string)=>Promise<unknown>})=>Promise<void>;
    };
    const client={query:(statement:string)=>pool.query(statement)};
    await migration.up(client);await migration.up(client);
    expect((await scope(()=>controller.processDueSocialReports(now))).processed).toBe(0);expect(notify).not.toHaveBeenCalled();
    try {
      await migration.down(client);
      expect((await pool.query('SELECT * FROM social_report_deliveries')).rows).toHaveLength(1);
      expect((await pool.query('SELECT * FROM social_saved_reports')).rows).toHaveLength(1);
    } finally {await migration.up(client);}
    expect((await pool.query('SELECT preparation_version FROM social_report_deliveries')).rows[0].preparation_version).toBe(0);
  });
  it('does not execute a paused schedule or another business report', async () => {
    await report({ paused: true });
    await http.post('/reports').set('x-qa-business','1702').send({ name: 'Foreign', filters:{relativeDays:7},scheduleCron:'0 9 * * *',deliveryChannel:'in_app' });
    expect((await scope(() => controller.processDueSocialReports(now))).processed).toBe(0); expect(notify).not.toHaveBeenCalled();
  });
  it('does not claim a report paused after the worker scan but before reservation', async () => {
    const saved = await report();
    afterReportScan = async () => { await pool.query('UPDATE social_saved_reports SET paused=true WHERE id=$1',[saved.id]); };
    expect((await scope(() => controller.processDueSocialReports(now))).processed).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect((await pool.query('SELECT * FROM social_report_exports')).rows).toHaveLength(0);
  });
  it('does not claim a deleted or edited recipient/filter definition from an earlier scan', async () => {
    for (const edit of ["delivery_target='changed@example.test'", "filters='{}'::jsonb", "schedule_cron='30 9 * * *'"]) {
      const saved = await report({name:edit,deliveryChannel:'email',deliveryTarget:'audit@example.test'});
      afterReportScan = async () => { await pool.query(`UPDATE social_saved_reports SET ${edit} WHERE id=$1`,[saved.id]); };
      expect((await scope(() => controller.processDueSocialReports(now))).processed).toBe(0);
      await pool.query('TRUNCATE social_saved_reports CASCADE');
    }
    const saved = await report(); afterReportScan = async () => { await pool.query('DELETE FROM social_saved_reports WHERE id=$1',[saved.id]); };
    expect((await scope(() => controller.processDueSocialReports(now))).processed).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('runs once across both repeated local times on the autumn DST transition', async () => {
    await report({ scheduleCron: null, schedule: { frequency: 'daily', localTime: '01:30', timezone: 'America/New_York' } });
    expect((await scope(() => controller.processDueSocialReports(new Date('2026-11-01T05:30:00Z')))).sent).toBe(1);
    expect((await scope(() => controller.processDueSocialReports(new Date('2026-11-01T06:30:00Z')))).sent).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('uses local friendly times across DST and restricts monthly schedules to days 1–28', async () => {
    const schedule = { frequency: 'daily', localTime: '09:00', timezone: 'America/New_York' };
    expect(controller.scheduledReportDefinitionIsDue(schedule,new Date('2026-03-07T14:00:00Z'))).toBe(true);
    expect(controller.scheduledReportDefinitionIsDue(schedule,new Date('2026-03-08T13:00:00Z'))).toBe(true);
    expect(controller.scheduledReportDefinitionIsDue({...schedule,localTime:'02:30'},new Date('2026-03-08T07:30:00Z'))).toBe(false);
    expect((await http.post('/reports').send({name:'Invalid',filters:{relativeDays:7},schedule:{frequency:'monthly',dayOfMonth:29,localTime:'09:00',timezone:'UTC'},deliveryChannel:'in_app'})).status).toBe(400);
  });
  it('preserves captured public competitor evidence across a provider failure and scopes it to its business', async () => {
    const row = (await pool.query(`INSERT INTO social_competitors(user_id,business_profile_id,platform,public_handle,public_url) VALUES(17,1701,'instagram','peer','https://instagram.com/peer') RETURNING *`)).rows[0];
    const client = { platform: 'instagram' as const, credential: { accountIdentifier: 'fixture-account' }, request: jest.fn(async () => ({business_discovery:{id:'123',followers_count:42}})) };
    await scope(() => controller.refreshPublicCompetitorSnapshot(17,row,client));
    const before = await http.get('/competitors?platform=instagram'); expect(before.body[0].latest_public_snapshot.metrics).toEqual({followers:42});
    client.request.mockRejectedValueOnce(new Error('fixture provider down') as never);
    await expect(scope(() => controller.refreshPublicCompetitorSnapshot(17,row,client))).rejects.toThrow('fixture provider down');
    const after = await http.get('/competitors?platform=instagram'); expect(after.body[0].last_refresh_status).toBe('error');
    expect(after.body[0].latest_public_snapshot).toEqual(before.body[0].latest_public_snapshot);
    expect((await http.get('/competitors').set('x-qa-business','1702')).body).toEqual([]);
  });
  it('returns a useful conflict instead of delete500 for captured competitor evidence and preserves every row',async()=>{
    const saved=await competitor();
    const response=await http.delete(`/competitors/${saved.id}`);
    expect(response.status).toBe(409); expect(response.body.code).toBe('SOCIAL_COMPETITOR_EVIDENCE_IMMUTABLE');
    expect(response.body.error).toContain('Archive');
    expect((await pool.query('SELECT * FROM social_competitors')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM social_competitor_snapshots')).rows).toHaveLength(1);
    expect((await http.delete(`/competitors/${saved.id}`).set('x-qa-business','1702')).status).toBe(404);
    expect((await http.patch(`/competitors/${saved.id}`).send({isActive:false})).status).toBe(200);
  });
  it('deletes an uncaptured competitor and rejects deletion while its public refresh is pending',async()=>{
    const saved=await competitor(false);
    await pool.query("UPDATE social_competitors SET last_refresh_status='pending' WHERE id=$1",[saved.id]);
    expect((await http.delete(`/competitors/${saved.id}`)).status).toBe(409);
    await pool.query("UPDATE social_competitors SET last_refresh_status='error' WHERE id=$1",[saved.id]);
    expect((await http.delete(`/competitors/${saved.id}`)).body).toEqual({deleted:true});
    expect((await http.delete(`/competitors/${saved.id}`)).status).toBe(404);
  });
  it('serializes competitor deletion with a concurrent snapshot capture without losing evidence',async()=>{
    const saved=await competitor(false), writer=await pool.connect();
    await writer.query('BEGIN');
    try {
      await writer.query(`INSERT INTO social_competitor_snapshots(competitor_id,user_id,business_profile_id,source,source_snapshot_id,metrics,source_url)
        VALUES($1,17,1701,'official_api','concurrent-capture','{"followers":42}','https://instagram.com/peer_a')`,[saved.id]);
      const removing=http.delete(`/competitors/${saved.id}`).then(response=>response);
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++) {
        waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM social_competitors%FOR UPDATE%' LIMIT 1")).rows.length>0;
        if(!waiting) await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting).toBe(true); await writer.query('COMMIT');
      expect((await removing).status).toBe(409);
      expect((await pool.query('SELECT * FROM social_competitor_snapshots')).rows).toHaveLength(1);
    } finally {await writer.query('ROLLBACK');writer.release();}
  });
  it('does not relabel peer_a evidence as peer_b through PATCH or same-handle POST',async()=>{
    const saved=await competitor();
    const patched=await http.patch(`/competitors/${saved.id}`).send({publicHandle:'peer_b',publicUrl:'https://instagram.com/peer_b'});
    expect(patched.status).toBe(409); expect(patched.body.code).toBe('SOCIAL_COMPETITOR_IDENTITY_HAS_EVIDENCE');
    expect((await http.post('/competitors').send({platform:'instagram',publicHandle:'peer_a',publicUrl:'https://instagram.com/peer_b'})).status).toBe(409);
    const list=await http.get('/competitors');
    expect(list.body[0].public_handle).toBe('peer_a'); expect(list.body[0].latest_public_snapshot.metrics).toEqual({followers:42});
    expect(list.body[0].latest_public_snapshot.sourceUrl).toBe('https://instagram.com/peer_a');
    expect((await http.patch(`/competitors/${saved.id}`).send({displayName:'Readable name',isActive:false})).status).toBe(200);
  });
  it('allows an uncaptured identity correction, resets old refresh state, and blocks it during refresh',async()=>{
    const saved=await competitor(false);
    await pool.query("UPDATE social_competitors SET last_refresh_status='pending' WHERE id=$1",[saved.id]);
    expect((await http.patch(`/competitors/${saved.id}`).send({publicHandle:'peer_b',publicUrl:'https://instagram.com/peer_b'})).status).toBe(409);
    await pool.query("UPDATE social_competitors SET last_refresh_status='error',last_refresh_error='Old profile error',last_refresh_attempt_at=NOW() WHERE id=$1",[saved.id]);
    const updated=await http.patch(`/competitors/${saved.id}`).send({publicHandle:'peer_b',publicUrl:'https://instagram.com/peer_b'});
    expect(updated.status).toBe(200); expect(updated.body.last_refresh_status).toBeNull();
    expect(updated.body.last_refresh_attempt_at).toBeNull(); expect(updated.body.last_refresh_error).toBeNull();
  });
  it('discards an old provider response when the uncaptured identity changed during the request',async()=>{
    const saved=await competitor(false); let release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
    const client={platform:'instagram' as const,credential:{accountIdentifier:'fixture-account'},request:async()=>{entered();await gate;return{business_discovery:{id:'old-profile',followers_count:42}};}};
    const refreshing=scope(()=>controller.refreshPublicCompetitorSnapshot(17,saved,client));
    const outcome=refreshing.then(()=>({ok:true}),error=>({ok:false,error}));
    await started;
    expect((await http.patch(`/competitors/${saved.id}`).send({publicHandle:'peer_b',publicUrl:'https://instagram.com/peer_b'})).status).toBe(200);
    release(); expect(await outcome).toEqual({ok:false,error:expect.objectContaining({code:'SOCIAL_COMPETITOR_CHANGED'})});
    const listed=(await http.get('/competitors')).body[0];
    expect(listed.public_handle).toBe('peer_b'); expect(listed.latest_public_snapshot).toBeNull(); expect(listed.last_refresh_status).toBeNull();
  });
  it('returns only listening evidence in the selected credential and business with correct source totals', async () => {
    await pool.query(`INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,credential_type,account_identifier,is_active) VALUES(22,17,1701,'instagram_api','oauth','fixture-account',true);
      INSERT INTO social_listening_events(user_id,business_profile_id,platform,provider_event_id,body,occurred_at,source,metadata) VALUES
      (17,1701,'instagram','11','Great',NOW(),'official_api','{"credentialId":22,"contentId":"99","collection":"owned_post_comments"}'),
      (17,1701,'instagram','12','Tagged',NOW(),'official_api','{"credentialId":22,"collection":"account_tagged_content"}'),
      (17,1701,'instagram','13','Other account',NOW(),'public_export','{"credentialId":23,"collection":"manual"}'),
      (17,1702,'instagram','14','Other business',NOW(),'official_api','{"credentialId":22,"collection":"owned_post_comments"}')`);
    const result = await http.get('/listening?platform=instagram&credentialId=22&paginated=1&kind=all');
    expect(result.status).toBe(200); expect(result.body.total).toBe(2); expect(result.body.sourceSummary).toEqual({comments:1,tags:1,manual:0});
    expect(result.body.items.map((row: {body: string}) => row.body)).toEqual(expect.arrayContaining(['Great','Tagged']));
    expect((await http.get('/listening?platform=instagram&credentialId=22&paginated=1&kind=all').set('x-qa-business','1702')).status).toBe(404);
  });

  for (const viewport of [{width:1440,height:900},{width:390,height:844},{width:320,height:757}]) {
    const browserTest = process.env.SOCIAL_INSIGHTS_QA_BROWSER_URL ? it : it.skip;
    browserTest(`browser → real HTTP handlers → scoped PostgreSQL at ${viewport.width}px, normal zoom and keyboard`, async () => {
      const browserUrl = new URL(process.env.SOCIAL_INSIGHTS_QA_BROWSER_URL!);
      if (!['localhost','127.0.0.1'].includes(browserUrl.hostname)) throw new Error('Local browser fixture only');
      await pool.query(`INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,credential_type,account_identifier,is_active) VALUES(22,17,1701,'instagram_api','oauth','fixture-account',true);
        INSERT INTO social_metric_snapshots(user_id,business_profile_id,platform,account_identifier,metric_window_start,metric_window_end,source,source_snapshot_id,metrics)
        VALUES(17,1701,'instagram','fixture-account','2026-10-21T00:00:00Z','2026-10-21T23:59:59.999Z','official_api','fixture-day','{"views":42}');
        INSERT INTO social_listening_events(user_id,business_profile_id,platform,provider_event_id,body,occurred_at,source,metadata)
        VALUES(17,1701,'instagram','11','Great fixture comment','2026-10-21T12:00:00Z','official_api','{"credentialId":22,"contentId":"99","collection":"owned_post_comments"}')`);
      const saved = await report(); notify.mockResolvedValue(false);
      await scope(() => controller.processDueSocialReports(now));
      const peer=await competitor();
      const { chromium, expect: browserExpect } = await import('@playwright/test');
      const browser = await chromium.launch({ executablePath: process.env.SOCIAL_INSIGHTS_QA_CHROMIUM || '/usr/bin/chromium', headless: true });
      const server = app.listen(0,'127.0.0.1');
      await new Promise<void>(resolve=>server.once('listening',resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const page = await browser.newPage({viewport,deviceScaleFactor:1,acceptDownloads:true,serviceWorkers:'block'});
      const errors: string[] = [], blocked: string[] = [], traffic: string[] = [];
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',entry=>{if(entry.type()==='error') traffic.push(`console: ${entry.text()}`);});
      page.on('request',request=>traffic.push(`${request.method()} ${request.url()}`));
      page.on('requestfailed',request=>traffic.push(`failed ${request.url()} ${request.failure()?.errorText}`));
      let failRead = true, failSave = true;
      const directory = process.env.SOCIAL_INSIGHTS_QA_EVIDENCE_DIR || '/tmp/social-insights-browser-evidence';
      await mkdir(directory,{recursive:true});
      try {
        await page.routeWebSocket('**',socket=>new URL(socket.url()).pathname==='/_next/webpack-hmr'?socket.connectToServer():socket.close());
        await page.route('**/*',async route=>{
          const request = route.request(), url = new URL(request.url());
          if (url.pathname.startsWith('/api/')) {
            const cors={'access-control-allow-origin':browserUrl.origin,'access-control-allow-credentials':'true',
              'access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS',
              'access-control-allow-headers':request.headers()['access-control-request-headers'] || '*'};
            if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:cors});
            const path = url.pathname.replace('/api/social-analytics','');
            if (/^\/(reports|listening|competitors)(\/|$)/.test(path)) {
              if (path === '/reports' && request.method()==='GET' && failRead) { failRead=false; return route.fulfill({status:503,headers:cors,json:{error:'Fixture restart'}}); }
              if (path === `/reports/${saved.id}` && request.method()==='PATCH' && failSave) { failSave=false; return route.fulfill({status:503,headers:cors,json:{error:'Fixture save failed; draft retained'}}); }
              const response = await route.fetch({url:`${origin}${path}${url.search}`}); return route.fulfill({response,headers:{...response.headers(),...cors}});
            }
            let json: unknown = [];
            if(url.pathname==='/api/auth/me') json={user:{id:17,name:'Audit owner',email:'audit@example.test',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}};
            else if(url.pathname==='/api/platform/access') json={maintenance:{enabled:false},modules:['content','integrations','performance_marketing','crm'].map(key=>({key,name:key,enabled:true,status:'available',mode:'enabled'}))};
            else if(url.pathname==='/api/settings/business-profiles') json=[{id:1701,name:'Audit business',companyName:'Audit business',isDefault:true,role:'owner'}];
            else if(url.pathname==='/api/settings/preferences') json={theme:'light',language:'en',timezone:'UTC'};
            else if(url.pathname==='/api/organizations') json={organizations:[]};
            else if(url.pathname==='/api/wallet') json={balance:1000};
            else if(url.pathname==='/api/notifications/unread/count') json={count:0};
            else if(url.pathname==='/api/channel-accounts/instagram_api') json=[{id:22,accountIdentifier:'fixture-account',accountName:'Fixture account',isSelected:true,analyticsReady:true}];
            else if(url.pathname==='/api/social-analytics/dashboard') json={summary:{},trends:[],recommendation:{recommendation:null,citations:[]},freshness:{latestSnapshotAt:'2026-10-22T00:00:00Z',snapshotCount:1,evidenceSourceCount:1},sync:null};
            else if(url.pathname==='/api/social-analytics/content') json={items:[],totalPosts:0,metricTotals:{},metricCoverage:{},formats:[],timeline:[],topContent:[],sync:null};
            else if(!['GET','HEAD'].includes(request.method())) { blocked.push(`${request.method()} ${url.pathname}`); return route.fulfill({status:403,json:{error:'Fixture blocks unrelated effects'}}); }
            return route.fulfill({json,headers:cors});
          }
          if(url.origin!==browserUrl.origin){blocked.push(`external ${url.origin}`);return route.abort();}
          return route.continue();
        });
        const target = `${browserUrl.origin}/dashboard/marketing/analytics?tab=reports&platform=instagram&account=22&start=2026-10-01&end=2026-10-22`;
        await page.goto(target);
        await browserExpect(page.getByRole('button',{name:'Edit',exact:true})).toBeVisible({timeout:15000});
        expect(await page.evaluate('({zoom:visualViewport?.scale,overflow:document.documentElement.scrollWidth>innerWidth+1})')).toEqual({zoom:1,overflow:false});
        await page.getByRole('button',{name:'Edit',exact:true}).focus(); await page.keyboard.press('Enter');
        const editor=page.getByRole('dialog',{name:'Edit report'});
        await editor.getByLabel('Five-field UTC cron').fill('30 10 * * 1');
        await editor.getByRole('button',{name:'Save report',exact:true}).focus(); await page.keyboard.press('Enter');
        await browserExpect(editor.getByRole('alert')).toContainText('Fixture save failed');
        await browserExpect(editor.getByLabel('Five-field UTC cron')).toHaveValue('30 10 * * 1');
        await editor.getByRole('button',{name:'Save report',exact:true}).press('Enter');
        await browserExpect(editor).toHaveCount(0);
        expect((await pool.query('SELECT schedule_cron FROM social_saved_reports WHERE id=$1',[saved.id])).rows[0].schedule_cron).toBe('30 10 * * 1');
        await page.getByRole('button',{name:'Edit',exact:true}).press('Enter');
        await editor.getByLabel('Five-field UTC cron').fill('0 7 * * *'); await page.keyboard.press('Escape');
        await browserExpect(editor).toHaveCount(0); await page.reload();
        await browserExpect(page.getByText(/UTC schedule: 30 10 \* \* 1/)).toBeVisible();
        await page.getByRole('button',{name:'Pause',exact:true}).press('Enter');
        await browserExpect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
        await page.getByRole('button',{name:'Resume',exact:true}).press('Enter');
        await browserExpect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
        for(const format of ['CSV','JSON','PDF']) {
          const downloaded=page.waitForEvent('download'); await page.getByRole('button',{name:format,exact:true}).click();
          const file=await downloaded; await file.saveAs(`${directory}/${viewport.width}-${file.suggestedFilename()}`);
          const bytes=await readFile((await file.path())!); expect(bytes.length).toBeGreaterThan(10);
          if(format==='PDF') {
            expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
            const {stdout}=await promisify(execFile)(process.env.SOCIAL_INSIGHTS_QA_PDFTOTEXT || 'pdftotext',[(await file.path())!,'-']);
            expect(stdout).toContain('fixture-day');
          } else if(format==='JSON') expect(JSON.parse(bytes.toString()).snapshots[0].source_snapshot_id).toBe('fixture-day');
          else expect(bytes.toString()).toContain('fixture-day');
        }
        await page.getByRole('button',{name:'Preview',exact:true}).click();
        const preview=page.getByRole('dialog',{name:'Weekly',exact:true});
        await browserExpect(preview.getByText('failed', {exact:false})).toBeVisible();
        await browserExpect(preview.getByText(/Delivery is unconfirmed/)).toBeVisible();
        await browserExpect(preview.getByRole('button',{name:/View this .* export/})).toBeVisible();
        await page.screenshot({path:`${directory}/reports-${viewport.width}.png`}); await page.keyboard.press('Escape');
        await page.goto(target.replace('tab=reports','tab=listening'));
        await browserExpect(page.getByText('Great fixture comment',{exact:true})).toBeVisible();
        expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')).toBe(true);
        await page.screenshot({path:`${directory}/listening-${viewport.width}.png`});
        await page.goto(target.replace('tab=reports','tab=competitors'));
        await browserExpect(page.getByText('@peer_a',{exact:true})).toBeVisible();
        await browserExpect(page.getByText('Current public followers: 42',{exact:true})).toBeVisible();
        await page.getByRole('button',{name:'Delete',exact:true}).press('Enter');
        const deleting=page.getByRole('dialog',{name:/Delete peer_a/});
        await deleting.getByRole('button',{name:'Delete competitor',exact:true}).press('Enter');
        await browserExpect(deleting.getByRole('alert')).toContainText('Archive');
        await page.screenshot({path:`${directory}/competitor-delete-${viewport.width}.png`});
        await page.keyboard.press('Escape');
        await page.getByRole('button',{name:'Edit',exact:true}).press('Enter');
        const editingPeer=page.getByRole('dialog',{name:'Edit competitor',exact:true});
        await editingPeer.getByLabel('Public handle').fill('peer_b');
        await editingPeer.getByLabel('Public profile URL').fill('https://instagram.com/peer_b');
        await editingPeer.getByRole('button',{name:'Save changes',exact:true}).press('Enter');
        await browserExpect(editingPeer.getByRole('alert')).toContainText('Create a new competitor');
        await page.keyboard.press('Escape');await page.reload();
        await browserExpect(page.getByText('@peer_a',{exact:true})).toBeVisible();
        expect((await pool.query('SELECT public_handle FROM social_competitors WHERE id=$1',[peer.id])).rows[0].public_handle).toBe('peer_a');
        await page.getByRole('button',{name:'Archive',exact:true}).press('Enter');
        await browserExpect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();
        expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')).toBe(true);
        expect(errors).toEqual([]); expect(blocked).toEqual([]);
      } catch(error) {
        await page.screenshot({path:`${directory}/failure-${viewport.width}.png`});
        console.error('Browser fixture failure',page.url(),errors,traffic,await page.locator('body').innerText());
        throw error;
      } finally { await browser.close(); await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
    },180000);
  }
});
