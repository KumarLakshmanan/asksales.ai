import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { SQL } from 'drizzle-orm';

const connectionString = process.env.AD_PUBLISH_QA_DATABASE_URL;
const redisUrl = process.env.AD_WORKFLOW_QA_REDIS_URL;
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
const integration = connectionString && redisUrl ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
let redis: Redis;
let queue: Queue;
let events: QueueEvents;
let queueFailure = false;
let balance = 10;
let moduleState: 'enabled' | 'disabled' | 'outage' = 'enabled';
const queueName = `ads-workflow-audit-${process.pid}`;
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (query: SQL) => database.execute(query),
  transaction: (callback: Parameters<typeof database.transaction>[0]) => database.transaction(callback),
} }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getMaintenanceSettings: async () => ({ enabled: false }),
  getEffectiveModuleAccess: async () => {
    if (moduleState === 'outage') throw new Error('Synthetic module lookup failure');
    return [{ key: 'performance_marketing', enabled: moduleState === 'enabled', status: moduleState === 'enabled' ? 'available' : 'disabled' }];
  },
}));
jest.unstable_mockModule('../models/wallets/functions.js', () => ({ getBalance: async () => balance }));
// Actual BullMQ transport and processor; shared registry/business/billing capture
// are outside this scope. No production queues or general workers are started.
jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: { CONTENT_GENERATION: queueName },
  queueRegistry: { addJob: async (_name: string, name: string, data: object, options: object) => {
    if (queueFailure) { queueFailure = false; throw new Error('Synthetic Redis producer failure'); }
    return (await queue.add(name, data, options)).id;
  } },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { creativeIntelligenceService } = await import('../services/ads/creative-intelligence/CreativeIntelligenceService.js');
const { AdPerformanceService } = await import('../services/ads/AdPerformanceService.js');
const { requireModuleAccess } = await import('../middleware/platformAccess.js');
const { default: creativeRoutes } = await import('../routes/creativeIntelligence.routes.js');
const creativeMigrationPath = '../migrations/287_ad_creative_intelligence.js';
const { up } = await import(creativeMigrationPath) as { up(client: Client): Promise<void> };
const app = express();
app.use(express.json());
// Synthetic authenticated identity, not an authentication or business-RLS test.
app.use((req, _res, next) => { const id = Number(req.header('x-audit-user')); if (id) (req as any).user = { id }; next(); });
app.use('/api/campaigns/creative-intelligence', requireModuleAccess('performance_marketing'), creativeRoutes);
const base = '/api/campaigns/creative-intelligence';
const body = () => ({ requestId: crypto.randomUUID(), source: 'manual', references: [{ pageName: 'Synthetic competitor', body: 'Observed demonstration, no performance claim.' }] });
const priorFlag = process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;

integration('ad workflow HTTP, PostgreSQL consent and Redis transport (synthetic only)', () => {
  beforeAll(async () => {
    if (!connectionString || !redisUrl || !local(connectionString) || !local(redisUrl)) throw new Error('Explicit local PostgreSQL and Redis required.');
    client = new Client({ connectionString });
    await client.connect();
    await client.query('SET search_path TO pg_temp,pg_catalog');
    database = drizzle(client);
    await client.query('CREATE TEMP TABLE users(id integer PRIMARY KEY,email text); INSERT INTO users VALUES(7,\'owner@example.test\'),(8,\'other@example.test\'); CREATE TEMP TABLE content_assets(id integer PRIMARY KEY,user_id integer);');
    // Migration creates connection-local tables because pg_temp is first.
    await up(client);
    // Match the business-scoped retry keys installed by migration 299.
    for (const table of ['ad_creative_research_runs','ad_creative_briefs']) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN business_profile_id integer NOT NULL DEFAULT 71`);
      const constraints=await client.query("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='u' AND conname LIKE '%request_id%'",[table]);
      for (const row of constraints.rows) await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${row.conname}"`);
      await client.query(`CREATE UNIQUE INDEX ${table}_business_retry ON ${table}(business_profile_id,user_id,request_id)`);
    }
    await client.query(`
      CREATE TEMP TABLE performance_ad_campaigns(id integer PRIMARY KEY,user_id integer); INSERT INTO performance_ad_campaigns VALUES(19,7);
      CREATE TEMP TABLE ad_settings(user_id integer,autonomy_mode text,autonomous_optimization_enabled boolean,consent_policy_version text,consented_at timestamptz,consented_by_user_id integer,analytics_sync_minutes integer,live_provider_mutations_enabled boolean);
      CREATE TEMP TABLE ad_campaign_autonomy_policies(campaign_id integer,user_id integer,enabled boolean,consent_policy_version text,consented_at timestamptz,consented_by_user_id integer);
      CREATE TEMP TABLE ad_target_automation_holds(id serial PRIMARY KEY,user_id integer,campaign_id integer,platform text,target_type text,target_key text,hold_until timestamptz);
      CREATE TEMP TABLE ad_performance_evaluations(id integer,user_id integer,campaign_id integer,platform text,target_type text,target_key text,metrics_updated_at timestamptz,state text,hypothetical_action text,created_at timestamptz);
      CREATE TEMP TABLE ad_analytics_sync_runs(user_id integer,campaign_id integer,platform text,status text,completed_at timestamptz);
      CREATE TEMP TABLE ad_provider_resources(id serial PRIMARY KEY,user_id integer,campaign_id integer,platform text,resource_type text,local_key text,status text,provider_resource_name text,provider_resource_id text,cleanup_status text);
    `);
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection: redis as any });
    events = new QueueEvents(queueName, { connection: redis as any });
    await events.waitUntilReady();
  });
  beforeEach(async () => {
    moduleState = 'enabled'; balance = 10; queueFailure = false;
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = 'true';
    await queue.obliterate({ force: true });
    await client.query('TRUNCATE ad_creative_research_runs,ad_creative_briefs,ad_creative_brief_assets,ad_settings,ad_campaign_autonomy_policies,ad_target_automation_holds,ad_performance_evaluations,ad_analytics_sync_runs,ad_provider_resources RESTART IDENTITY');
    await client.query(`INSERT INTO ad_settings VALUES(7,'live_pause',true,'ads-pause-v1','2026-10-23T00:00:00Z',7,15,false);
      INSERT INTO ad_campaign_autonomy_policies VALUES(19,7,true,'ads-pause-v1','2026-10-23T00:00:00Z',7);
      INSERT INTO ad_performance_evaluations VALUES(101,7,19,'meta','ad','ad-1',NOW(),'recommendation','pause',NOW());
      INSERT INTO ad_analytics_sync_runs VALUES(7,19,'meta','succeeded',NOW());
      INSERT INTO ad_provider_resources(user_id,campaign_id,platform,resource_type,local_key,status,provider_resource_id) VALUES(7,19,'meta','ad','ad-1','active','synthetic-provider-ad');`);
  });
  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED; else process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = priorFlag;
    await events?.close(); await queue?.obliterate({ force: true }); await queue?.close(); await redis?.quit(); await client?.end();
  });

  it('enforces missing identity, disabled module and module-lookup outage over HTTP', async () => {
    expect((await request(app).get(`${base}/briefs`)).status).toBe(401);
    moduleState = 'disabled'; expect((await request(app).get(`${base}/briefs`).set('x-audit-user', '7')).status).toBe(403);
    moduleState = 'outage'; expect((await request(app).get(`${base}/briefs`).set('x-audit-user', '7')).status).toBe(503);
  });

  it('enforces feature, credits, input and owner boundaries without provider calls', async () => {
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = 'false';
    expect((await request(app).post(`${base}/research`).set('x-audit-user','7').send(body())).status).toBe(503);
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = 'true';
    expect((await request(app).post(`${base}/research`).set('x-audit-user','7').send({ ...body(), references: [] })).status).toBe(400);
    balance = 0;
    expect((await request(app).post(`${base}/briefs`).set('x-audit-user','7').send({})).status).toBe(402);
    const created = await request(app).post(`${base}/research`).set('x-audit-user','7').send(body());
    expect(created.status).toBe(202);
    expect((await request(app).get(`${base}/research/${created.body.id}`).set('x-audit-user','8')).status).toBe(404);
    expect((await request(app).get(`${base}/research/${created.body.id}`).set('x-audit-user','7')).status).toBe(200);
  });

  it('recovers a failed producer retry into one durable DB row and one Redis job, then runs manual research', async () => {
    const payload = body(); queueFailure = true;
    expect((await request(app).post(`${base}/research`).set('x-audit-user','7').send(payload)).status).toBe(503);
    const retry = await request(app).post(`${base}/research`).set('x-audit-user','7').send(payload);
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('queued');
    const replay = await request(app).post(`${base}/research`).set('x-audit-user','7').send(payload);
    expect(replay.body.id).toBe(retry.body.id);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM ad_creative_research_runs')).rows[0].count).toBe(1);
    const jobs = await queue.getJobs(['wait','delayed','active']); expect(jobs).toHaveLength(1);
    const worker = new Worker(queueName, async job => creativeIntelligenceService.process(job.data.userId,job.data.recordId,'research'), { connection: redis as any });
    try { await jobs[0].waitUntilFinished(events, 10_000); } finally { await worker.close(); }
    const result = await request(app).get(`${base}/research/${retry.body.id}`).set('x-audit-user','7');
    expect(result.body.status).toBe('succeeded');
    expect(result.body.references[0].bodies).toEqual(['Observed demonstration, no performance claim.']);
    expect(result.body.message).toContain('unknown');
  });

  it('round-trips and deletes synthetic creative bytes using the real disposable local object backend', async () => {
    if (!process.env.LOCAL_STORAGE_PATH?.startsWith('/tmp/asksales-ads-audit-')) throw new Error('A disposable audit object root is required.');
    const { objectStorage } = await import('../services/ObjectStorageService.js');
    const key = `synthetic-creative/${crypto.randomUUID()}.png`;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
    try {
      expect(await objectStorage.upload(key,bytes,'image/png')).toContain(key);
      expect(await objectStorage.exists(key)).toBe(true);
      expect(await objectStorage.download(key)).toEqual(bytes);
    } finally { await objectStorage.delete(key); }
    expect(await objectStorage.exists(key)).toBe(false);
  });

  const action = () => ({ action_type:'pause',evaluation_id:101,user_id:7,campaign_id:19,platform:'meta',target_type:'ad',target_key:'ad-1',target_resource:'synthetic-provider-ad',policy_version:'ads-pause-v1',consent_snapshot:{accountConsentedAt:'2026-10-23T00:00:00.000Z',campaignConsentedAt:'2026-10-23T00:00:00.000Z'} });
  it.each([
    ['account consent', "UPDATE ad_settings SET autonomy_mode='off'"],
    ['campaign consent', 'UPDATE ad_campaign_autonomy_policies SET enabled=false'],
    ['renewed consent', "UPDATE ad_campaign_autonomy_policies SET consented_at=consented_at+INTERVAL '1 second'"],
    ['stale metrics', "UPDATE ad_performance_evaluations SET metrics_updated_at=NOW()-INTERVAL '2 hours'"],
    ['new evaluation', "INSERT INTO ad_performance_evaluations VALUES(102,7,19,'meta','ad','ad-1',NOW(),'healthy',NULL,NOW()+INTERVAL '1 second')"],
    ['failed sync', "UPDATE ad_analytics_sync_runs SET status='failed'"],
    ['resource rebound', "UPDATE ad_provider_resources SET provider_resource_id='different-provider-ad'"],
    ['manual hold', "INSERT INTO ad_target_automation_holds(user_id,campaign_id,platform,target_type,target_key,hold_until) VALUES(7,19,'meta','ad','ad-1',NOW()+INTERVAL '72 hours')"],
  ])('revalidates dual consent and evidence against real SQL: %s', async (_name, mutation) => {
    const service = new AdPerformanceService();
    expect(await service.revalidateAutonomousPause(action())).toEqual({valid:true});
    await client.query(mutation);
    expect((await service.revalidateAutonomousPause(action())).valid).toBe(false);
  });
});
