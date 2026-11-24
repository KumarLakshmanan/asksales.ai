import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { installOrganicManagedStorageFixtures, installOrganicUploadCapacityFixtures } from './helpers/organicManagedStoragePostgres.js';
import { Pool, types as pgTypes } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import { Queue, QueueEvents, Worker as RedisWorker, DelayedError, UnrecoverableError, type Processor, type WorkerOptions } from 'bullmq';
import { withBusinessScope, currentBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

const suite = process.env.CONTENT_PUBLISH_LOCAL_QA === '1' ? describe : describe.skip;
const suffix = randomBytes(8).toString('hex');
const schema = `linkedin_publish_${suffix}`;
const queueName = `linkedin-publication-${suffix}`;
const connection = { host: '127.0.0.1', port: Number(process.env.REDIS_PORT), maxRetriesPerRequest: null };
const owner = 991, actor = 993, profile = 99, payer = 999;
const asActor = <T>(who: number, work: () => T) => withBusinessScope({ userId: owner, businessProfileId: profile, actorUserId: who },
  () => withBillingScope({ organizationId: payer, actorUserId: who, businessOwnerUserId: owner, businessProfileId: profile }, work));
const sqlTrace: Array<{query: string; params: unknown[]}> = [];
let frozenSnapshots: Record<string, unknown>[] = [];
const objectBytes = new Map<string, Buffer>();
let fixtureDb: any, pool: Pool, runtime: Pool, admin: Pool, queue: Queue, events: QueueEvents, worker: RedisWorker | undefined;
const noop = async () => {};
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
// Only the real registered organic callback gets a real Redis consumer. Other
// queues, timers, notifications and all non-LinkedIn providers are inert.
jest.unstable_mockModule('bullmq', () => ({ Queue, QueueEvents, DelayedError, UnrecoverableError, Worker: class {
  private inner?: RedisWorker;
  constructor(name: string, processor: Processor, options: WorkerOptions) {
    if (name === 'organic-publishing') this.inner = worker = new RedisWorker(queueName, processor, { ...options, connection });
  }
  on(...args: Parameters<RedisWorker['on']>) { this.inner?.on(...args); return this; }
  waitUntilReady = async () => { await this.inner?.waitUntilReady(); };
  close = async () => { await this.inner?.close(); };
} }));
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_target, key) => (...args: any[]) => fixtureDb[key](...args) }) }));
const { default: Redis } = await import('ioredis');
let fixtureRedis: InstanceType<typeof Redis> | undefined;
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => fixtureRedis || connection }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: log, createWorkerLogger: () => log }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { initialize: noop, close: noop, publish: noop }, EVENT_CHANNELS: {} }));
jest.unstable_mockModule('../tools/outreachSender.js', () => ({ outreachSenderWorker: { start: noop, stop: noop } }));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js', () => ({ notificationEventConsumer: { start: noop, stop: noop } }));
jest.unstable_mockModule('../models/failedJobs/functions.js', () => ({ insertFailedJob: noop }));
jest.unstable_mockModule('../services/social/OrganicPublishNotifications.js', () => ({ notifyOrganicPublishFailure: noop }));
jest.unstable_mockModule('../services/media/PublishingImagePreflight.js', () => ({ preflightPublishingImages: async (urls: string[]) => ({ urls, probes: [] }) }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error {}, brandContextSnapshot: () => frozenSnapshots.shift() || ({}), formatContentBrandContext: () => "Synthetic brand context", formatMediaBrandContext: () => "Synthetic media brand context",
  resolveContentBrandContext: async () => ({ businessProfile: { id: profile }, brandToolkit: { id: profile } }),
}));
jest.unstable_mockModule('../services/content/ContentComplianceService.js', () => ({ CANONICAL_CONTENT_VARIABLES: new Set(), findTemplateVariables: () => [], renderContentVariables: (value: unknown) => value, contentOutputSchemas: {}, ContentComplianceError: class extends Error {}, validateGeneratedContent: noop, extractJsonObject: (x: string) => x, parseStructuredContent: JSON.parse }));
jest.unstable_mockModule('../mastra/tools/queueBridge.js', () => ({ dispatchAndWait: noop, shouldUseQueue: () => false }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: noop }));
jest.unstable_mockModule('dotenv', () => ({ default: { config: () => ({ parsed: {} }) }, config: () => ({ parsed: {} }) }));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: (req: any, _res: any, next: any) => {
  const who = req.get('x-fixture-user') === '992' ? 992 : owner; req.user = { id: who };
  if (who === 992) return withBusinessScope({ userId: 992, businessProfileId: 199, actorUserId: 992 }, next);
  return asActor(owner, next);
} }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => (_req: any, _res: any, next: any) => next() }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ requireCredits: (_req: any, _res: any, next: any) => next() }));

const { metaPageConnectionsTable } = await import('../models/metaPageConnections/schema.js');
const { adminApiCredentialsTable } = await import('../models/adminApiCredentials/schema.js');
const { contentPlansTable } = await import('../models/contentPlans/schema.js');
const { contentTemplatesTable } = await import('../models/contentTemplates/schema.js');
const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
const { socialPublishAttemptsTable } = await import('../models/socialPublishAttempts/schema.js');
const { channelCredentialsTable } = await import('../models/channelCredentials/schema.js');
const { queueRegistry } = await import('../queues/index.js');
const { startAllWorkers, stopAllWorkers } = await import('../workers/index.js');
const { executePublishSocialPost } = await import('../mastra/tools/executors/contentExecutor.js');
const { getOrganicPublishingReview } = await import('../services/social/OrganicPublishingService.js');
const { enqueueOrganicPublishAttempt } = await import('../services/social/OrganicPublishQueue.js');
const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
const { prepareOrganicPublishBatch, updateEditableContentAsset, changeOrganicPublishSchedule, deleteEditableContentAsset, recoverOrganicPublishAttempt } = await import('../services/social/OrganicPublishLifecycleService.js');
const { publishContentAsset, unpublishContentAsset, getContentAssetPublishAttempts } = await import('../controllers/contentAssetController.js');
// @ts-expect-error migration modules are plain JavaScript and are executed unchanged
const migration = await import('../migrations/470_linkedin_organic_publish_attempts.js');

suite('LinkedIn executor → SQL attempt → actual registry → registered worker → simulated provider', () => {
  let fetchSpy: ReturnType<typeof jest.spyOn>, writes: number;
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '') || !process.env.REDIS_PORT) throw Error('Disposable loopback fixtures required');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD || '' };
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' }); await admin.query(`CREATE SCHEMA "${schema}"`);
    const options = `-c search_path=${schema},pg_catalog -c timezone=UTC`;
    const types = { getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === 1114 ? (value: string) => new Date(`${value}Z`) : pgTypes.getTypeParser(oid, format) };
    pool = new Pool({ ...config, max: 3, options: `${options} -c app.business_profile_id=99`, types });
    runtime = createBusinessScopedPool(new Pool({ ...config, max: 5, options, types })); fixtureDb = drizzle(runtime, { logger: { logQuery(query, params) { sqlTrace.push({ query, params }); } } });
    await localBusinessFunctions(pool);
    await pool.query(`CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamp,is_approved boolean DEFAULT true);
      INSERT INTO users(id) VALUES(991),(993);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,name text,company_name text,business_name text,is_default boolean DEFAULT true,archived_at timestamp,billing_organization_id integer);
      INSERT INTO company_settings(id,user_id,name,billing_organization_id) VALUES(99,991,'Synthetic LinkedIn',999);
      CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,role text,status text);
      INSERT INTO business_profile_memberships(business_profile_id,user_id,role,status) VALUES(99,993,'member','active');
      CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer,name text,default_for_user_id integer,billing_eligibility_at timestamp DEFAULT now());
      INSERT INTO billing_organizations(id,owner_user_id,name) VALUES(999,991,'Synthetic payer');
      CREATE TABLE billing_organization_memberships(id serial PRIMARY KEY,organization_id integer,user_id integer,status text,role text);`);
    for (const table of [contentAssetsTable, socialPublishAttemptsTable, channelCredentialsTable, contentPlansTable, contentTemplatesTable, metaPageConnectionsTable, adminApiCredentialsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        if (column.name === 'id') return 'id SERIAL PRIMARY KEY';
        const value = column.default;
        const defaultSql = value instanceof SQL ? new PgDialect().sqlToQuery(value).sql : value === undefined ? undefined : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('CREATE UNIQUE INDEX linkedin_attempt_key ON social_publish_attempts(business_profile_id,user_id,idempotency_key)');
    await pool.query("ALTER TABLE social_publish_attempts ADD CONSTRAINT social_publish_attempts_platform_check CHECK(platform IN ('instagram','facebook','youtube'))");
    await migration.up(pool);
    await localBusinessIsolation(pool, schema, ['content_assets', 'social_publish_attempts', 'channel_credentials', 'content_plans', 'content_templates', 'meta_page_connections']);
    await installOrganicManagedStorageFixtures(pool, schema);
    await installOrganicUploadCapacityFixtures(pool, schema);
    const { objectStorage } = await import('../services/ObjectStorageService.js');
    jest.spyOn(objectStorage, 'delete').mockImplementation(async key => { objectBytes.delete(key); });
    jest.spyOn(objectStorage, 'upload').mockImplementation(async (key,bytes) => { objectBytes.set(key,Buffer.from(bytes)); return `https://media.example.invalid/managed/${key}`; });
    fixtureRedis = new Redis(connection);
    queue = new Queue(queueName, { connection }); events = new QueueEvents(queueName, { connection }); await events.waitUntilReady();
    jest.spyOn(queueRegistry, 'initialize').mockImplementation(noop);
    jest.spyOn(queueRegistry, 'addRepeatableJob').mockImplementation(async () => undefined);
    jest.spyOn(queueRegistry, 'getQueue').mockReturnValue(queue);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Unmocked network denied'); });
    await startAllWorkers(); if (!worker) throw Error('Actual organic worker not registered'); await worker.waitUntilReady();
  }, 30000);
  beforeEach(async () => {
    await worker!.pause(); await queue.obliterate({ force: true });
    await pool.query('TRUNCATE billing_capacity_items,billing_capacity_totals,billing_storage_reservations,storage_managed_references,storage_files,storage_quotas,content_assets,social_publish_attempts,channel_credentials RESTART IDENTITY');
    frozenSnapshots = []; objectBytes.clear(); sqlTrace.length = 0;
    await pool.query("UPDATE business_profile_memberships SET status='active'; UPDATE users SET is_approved=true; INSERT INTO channel_credentials(id,user_id,platform,account_identifier,access_token,is_active,is_selected) VALUES(13,991,'linkedin','urn:li:person:fixture','synthetic-token',true,true); INSERT INTO content_assets(id,user_id,type,title,content,status,version) VALUES(1,991,'social_post','Reviewed','Reviewed copy','draft',1)");
    writes = 0; fetchSpy.mockReset();
  });
  afterAll(async () => {
    await stopAllWorkers(); await events?.close(); await fixtureRedis?.quit(); if (queue) { await queue.obliterate({ force: true }); await queue.close(); }
    jest.restoreAllMocks(); await runtime?.end(); await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  }, 30000);
  async function prepare() {
    return asActor(actor, async () => {
      const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
      const asset = (await ContentAssetModel.findByIdForUser(1, owner))!;
      const args = { content_asset_id: 1, platform: 'linkedin', post_type: 'text', credential_id: 13, caption: 'Reviewed LinkedIn copy', expected_version: asset.version,
        expected_review_token: (await getOrganicPublishingReview(asset)).token, idempotency_key: 'same-reviewed-request', scheduled_for: new Date(Date.now() + 3600000).toISOString() };
      expect((await executePublishSocialPost(args, { userId: owner, widgetId: 'reviewed-widget' } as any)).success).toBe(true);
      const rows = await pool.query('SELECT * FROM social_publish_attempts'); expect(rows.rows).toHaveLength(1);
      await pool.query("UPDATE social_publish_attempts SET next_attempt_at=now()-interval '1 minute'");
      return { args, attempt: (await SocialPublishAttemptModel.findByIdForUser(Number(rows.rows[0].id), owner))! };
    });
  }
  async function dispatch(attempt: Awaited<ReturnType<typeof prepare>>['attempt']) {
    const id = await asActor(owner, () => enqueueOrganicPublishAttempt(attempt)); const job = await queue.getJob(String(id)); if (!job) throw Error('Job not persisted'); return job;
  }
  async function immediate(scenario = 'success') {
    return asActor(actor, async () => {
      const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
      const asset = (await ContentAssetModel.findByIdForUser(1, owner))!;
      const args = { content_asset_id: 1, platform: 'linkedin', post_type: 'text', credential_id: 13, caption: 'Reviewed LinkedIn copy', expected_version: asset.version,
        expected_review_token: (await getOrganicPublishingReview(asset)).token, idempotency_key: 'immediate-request' };
      fetchSpy.mockImplementation(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        expect(init?.method).toBe('POST'); writes++;
        if (scenario === 'timeout') throw Error('Synthetic accepted then timeout');
        return new Response(null, { status: 201, headers: scenario === 'missing_receipt' ? {} : { 'x-restli-id': 'urn:li:share:123456' } });
      });
      const first = await executePublishSocialPost(args, { userId: owner, widgetId: 'immediate' } as any);
      const replay = await executePublishSocialPost(args, { userId: owner, widgetId: 'immediate' } as any);
      return { first, replay };
    });
  }
  const response = () => { const res: any = { statusCode: 200 }; res.status = (status: number) => { res.statusCode = status; return res; }; res.json = (body: unknown) => { res.body = body; return res; }; return res; };
  it.each(['success', 'timeout', 'missing_receipt'])('retains exactly one immediate provider write for %s and same-key executor replay', async scenario => {
    const { first, replay } = await immediate(scenario);
    expect(writes).toBe(1); expect((await pool.query('SELECT * FROM social_publish_attempts')).rows).toHaveLength(1);
    expect(first.success).toBe(scenario === 'success'); expect(replay.success).toBe(scenario === 'success');
  });
  it.each(['success', 'timeout', 'missing_receipt'] as const)('does not publish twice after %s, registry redelivery or executor replay', async scenario => {
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(url)).toBe('https://api.linkedin.com/rest/posts'); expect(init?.method).toBe('POST');
      expect(currentBusinessScope()?.actorUserId).toBe(actor);
      expect(new Headers(init?.headers).get('LinkedIn-Version')).toBe('202610'); writes++;
      if (scenario === 'timeout') throw Error('Synthetic accepted then timeout');
      return new Response(null, { status: 201, headers: scenario === 'missing_receipt' ? {} : { 'x-restli-id': 'urn:li:share:123456' } });
    });
    const { args, attempt } = await prepare(); const job = await dispatch(attempt);
    expect(job.data).toMatchObject({ businessActorUserId: actor, billingActorUserId: actor, businessProfileId: profile, billingOrganizationId: payer });
    await worker!.resume(); await job.waitUntilFinished(events, 10000);
    const replayJob = await queue.add('publish-attempt', job.data, { attempts: 1 }); await replayJob.waitUntilFinished(events, 10000);
    const replay = await asActor(actor, () => executePublishSocialPost(args, { userId: owner, widgetId: 'reviewed-widget' } as any));
    const saved = await asActor(owner, () => SocialPublishAttemptModel.findByIdForUser(attempt.id, owner));
    expect(writes).toBe(1); expect(saved?.status).toBe(scenario === 'success' ? 'succeeded' : 'ambiguous');
    if (scenario === 'success') expect(replay.output.results.linkedin.postId).toBe('urn:li:share:123456');
    else await expect(asActor(owner, () => recoverOrganicPublishAttempt(owner, 1, attempt.id, 'retry'))).rejects.toMatchObject({ code: 'PUBLISH_RECOVERY_UNAVAILABLE' });
  });
  it('rejects a queued and owner-ambient recovered delivery after the original staff actor is revoked', async () => {
    const { attempt } = await prepare(); const job = await dispatch(attempt);
    await pool.query("UPDATE business_profile_memberships SET status='revoked'");
    await expect(asActor(owner, () => enqueueOrganicPublishAttempt(attempt))).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
    await expect(asActor(owner, () => recoverOrganicPublishAttempt(owner, 1, attempt.id, 'publish_now'))).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
    await worker!.resume(); await expect(job.waitUntilFinished(events, 10000)).rejects.toThrow(/available|removed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('claims concurrent distinct Redis deliveries before only one LinkedIn provider write', async () => {
    const { attempt } = await prepare(); const job = await dispatch(attempt);
    const duplicate = await queue.add('publish-attempt', job.data, { attempts: 1 });
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    fetchSpy.mockImplementation(async () => { writes++; began(); await finish; return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123456' } }); });
    await worker!.resume(); await started; release();
    await Promise.all([job.waitUntilFinished(events, 10000), duplicate.waitUntilFinished(events, 10000)]);
    expect(writes).toBe(1);
  });
  it('retains staff approval origin for cron-dispatched Facebook work under an ambient owner', async () => {
    await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,access_token,is_active,is_selected) VALUES(14,991,'facebook_page','reviewed-page','synthetic-page-token',true,true)");
    await asActor(actor, async () => {
      const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
      const asset = (await ContentAssetModel.findByIdForUser(1, owner))!;
      const result = await executePublishSocialPost({ content_asset_id: 1, platform: 'facebook', credential_id: 14, post_type: 'text', caption: 'Reviewed Facebook copy',
        expected_version: asset.version, expected_review_token: (await getOrganicPublishingReview(asset)).token,
        idempotency_key: 'staff-fb', scheduled_for: new Date(Date.now() + 3600000).toISOString() }, { userId: owner } as any);
      expect(result.success).toBe(true);
    });
    const attempt = await asActor(owner, () => SocialPublishAttemptModel.findByIdForUser(1, owner));
    const job = await dispatch(attempt!);
    expect(job.data.businessActorUserId).toBe(actor); expect(job.data.billingActorUserId).toBe(actor);
    await pool.query("UPDATE business_profile_memberships SET status='revoked'");
    await expect(asActor(owner, () => enqueueOrganicPublishAttempt(attempt!))).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('honors the real outer business-approval gate before a queued provider effect', async () => {
    const { attempt } = await prepare(); const job = await dispatch(attempt);
    await pool.query('UPDATE users SET is_approved=false WHERE id=991');
    await worker!.resume(); await expect(job.waitUntilFinished(events, 10000)).rejects.toThrow(/approval/i); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('does not use a changed provider account after approval', async () => {
    const { attempt } = await prepare(); const job = await dispatch(attempt);
    await pool.query("UPDATE channel_credentials SET account_identifier='urn:li:person:other' WHERE id=13");
    await worker!.resume(); await job.waitUntilFinished(events, 10000); expect(fetchSpy).not.toHaveBeenCalled();
    expect((await pool.query('SELECT status FROM social_publish_attempts')).rows[0].status).toBe('failed');
  });
  it('rejects unreviewed legacy replay and unsupported native media without a provider write', async () => {
    const old = await asActor(actor, () => executePublishSocialPost({ content_asset_id: 1, platform: 'linkedin', caption: 'Old replay', idempotency_key: 'old-widget' }, { userId: owner } as any));
    expect(old.success).toBe(false);
    await pool.query("UPDATE content_assets SET image_url='https://media.example.test/image.jpg' WHERE id=1");
    const { first } = await immediate();
    expect(first.success).toBe(false); expect(first.error).toMatch(/native media uploads/);
    expect((await pool.query('SELECT * FROM social_publish_attempts')).rows).toHaveLength(0); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('publishes the HTTP reviewed destination through the same durable account contract', async () => asActor(actor, async () => {
    const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
    const { default: express } = await import('express');
    const { default: http } = await import('supertest');
    const asset = (await ContentAssetModel.findByIdForUser(1, owner))!;
    fetchSpy.mockResolvedValue(new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123456' } }));
    const body = {
      expectedVersion: asset.version, expectedReviewToken: (await getOrganicPublishingReview(asset)).token,
      targets: [{ platform: 'linkedin', credentialId: 13, caption: 'HTTP reviewed text', postType: 'text' }],
    };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: actor } as any; asActor(actor, next); });
    app.post('/api/content/assets/:assetId/publish', publishContentAsset);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    try {
      expect((await http(server).post('/api/content/assets/1/publish').set('Idempotency-Key', 'http-linkedin').send(body)).status).toBe(200);
      expect((await http(server).post('/api/content/assets/1/publish').set('Idempotency-Key', 'http-linkedin').send(body)).status).toBe(200);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT reviewed_payload FROM social_publish_attempts')).rows[0].reviewed_payload.publicationOrigin.businessActorUserId).toBe(actor);
  }));
  it.each(['delete', 'denied_status', 'delete_timeout'] as const)('retains the exact receipt/account while handling %s', async mode => {
    await immediate();
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(url)).toBe('https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A123456');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-token');
      if (mode === 'delete_timeout') throw Error('Synthetic deletion timeout');
      return new Response(null, { status: mode === 'denied_status' ? 403 : 204 });
    });
    await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,access_token,is_active) VALUES(14,991,'linkedin','urn:li:person:other','do-not-use',true)");
    const res = response(); await asActor(owner, () => unpublishContentAsset({ user: { id: owner }, params: { assetId: '1' }, body: { mode: mode === 'denied_status' ? 'reconcile' : 'delete' } } as any, res));
    const asset = (await pool.query('SELECT status,published_post_id,version FROM content_assets WHERE id=1')).rows[0];
    expect(res.statusCode).toBe(mode === 'delete' ? 200 : 502);
    expect(asset.status).toBe(mode === 'delete' ? 'draft' : 'published');
    expect(asset.version).toBe(mode === 'delete' ? 2 : 1);
    expect((await pool.query('SELECT provider_post_id FROM social_publish_attempts')).rows[0].provider_post_id).toBe('urn:li:share:123456');
    if (mode !== 'delete') expect(asset.published_post_id).toBe('urn:li:share:123456');
  });
  it('rejects an owner-substituted Redis actor that conflicts with the durable approval origin', async () => {
    const { attempt } = await prepare(); const job = await dispatch(attempt);
    const forged = await queue.add('publish-attempt', { ...job.data, businessActorUserId: owner, billingActorUserId: owner }, { attempts: 1 });
    await queue.remove(job.id!); await worker!.resume(); await expect(forged.waitUntilFinished(events, 10000)).rejects.toThrow(/origin|actor/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('leaves legacy attempts without originating authority unsent', async () => {
    const { attempt } = await prepare();
    const legacy = { ...attempt, reviewedPayload: { ...attempt.reviewedPayload, publicationOrigin: undefined } };
    await expect(asActor(owner, () => enqueueOrganicPublishAttempt(legacy))).rejects.toMatchObject({ code: 'JOB_ORIGIN_REQUIRED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('cancels and retires a scheduled asset before a stale registered delivery without posting', async () => {
    const { attempt } = await prepare(); const job = await dispatch(attempt);
    await asActor(owner, () => changeOrganicPublishSchedule(owner, [1])); await asActor(owner, () => deleteEditableContentAsset(owner, 1));
    await worker!.resume(); await job.waitUntilFinished(events, 10000); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rolls the new migration down/up without losing history, and refuses down after LinkedIn use', async () => {
    await migration.down(pool); await migration.up(pool);
    await prepare(); await expect(migration.down(pool)).rejects.toThrow(/history exists/);
    expect((await pool.query('SELECT count(*) AS total FROM social_publish_attempts')).rows[0].total).toBe('1');
  });
  it('looks up only the original request and includes its child destination receipt', async () => {
    const {default:express}=await import('express');const {default:request}=await import('supertest');
    await pool.query("SELECT setval(pg_get_serial_sequence('content_assets','id'),1); INSERT INTO channel_credentials(id,user_id,platform,account_identifier,access_token,is_active) VALUES(14,991,'facebook_page','synthetic-page','synthetic-token',true)");
    await asActor(actor,async()=>{
      const {ContentAssetModel}=await import('../models/contentAssets/functions.js');const asset=(await ContentAssetModel.findByIdForUser(1,owner))!;
      const result=await executePublishSocialPost({content_asset_id:1,expected_version:1,expected_review_token:(await getOrganicPublishingReview(asset)).token,idempotency_key:'original-multi-request',scheduled_for:new Date(Date.now()+3600000).toISOString(),targets:[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'},{platform:'facebook',credentialId:14,caption:'Reviewed Facebook',postType:'text'}]},{userId:owner} as any);expect(result.success).toBe(true);
    });
    const app=express();app.use((req,_res,next)=>{req.user={id:actor} as any;asActor(actor,next);});app.get('/api/content/assets/:assetId/publish-attempts',getContentAssetPublishAttempts);
    const original=await request(app).get('/api/content/assets/1/publish-attempts').query({requestKey:'original-multi-request'});
    expect(original.status).toBe(200);expect(original.body.attempts).toHaveLength(2);expect(new Set(original.body.attempts.map((a:any)=>a.platform))).toEqual(new Set(['facebook','linkedin']));
    const unrelated=await request(app).get('/api/content/assets/1/publish-attempts').query({requestKey:'different-request'});expect(unrelated.body.attempts).toHaveLength(0);expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('BC-S02 actual canonical references in publication writers', () => {
    const scope = { userId: owner, businessProfileId: profile };
    const privateUrl = (id: number) => `/api/settings/storage/files/${id}/download`;
    const frozen = (id: number) => ({ brandToolkit: { logoUrl: privateUrl(id), logoUrls: [privateUrl(id)] } });
    async function files() {
      await pool.query("SELECT setval(pg_get_serial_sequence('content_assets','id'),1)");
      for (const [id, name] of [[1, 'z-logo.png'], [2, 'a-logo.png']] as const) {
        const key = `${owner}/brand_asset/${name}`;
        objectBytes.set(key, Buffer.from(`bytes-${id}`));
        await pool.query("INSERT INTO storage_files(id,user_id,business_profile_id,file_name,storage_key,storage_backend,file_size_bytes,category,url) VALUES($1,$2,$3,$4,$5,'local',7,'brand_asset',$6)", [id,owner,profile,name,key,privateUrl(id)]);
      }
      await pool.query('INSERT INTO storage_quotas(user_id,storage_used_bytes,file_count) VALUES($1,14,2)', [owner]);
      await pool.query("SELECT setval(pg_get_serial_sequence('storage_files','id'),2)");
    }
    async function batch(key = 'canonical-reference-batch', targets = [
      {platform:'linkedin' as const,credentialId:13,caption:'Reviewed LinkedIn',postType:'text'},
      {platform:'facebook' as const,credentialId:14,caption:'Reviewed Facebook',postType:'text'},
    ]) {
      const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
      const asset = (await ContentAssetModel.findByIdForUser(1,owner))!;
      const review = { expectedVersion:asset.version,expectedReviewToken:(await getOrganicPublishingReview(asset)).token,required:true };
      const scheduled = targets.map(target=>({...target,scheduledFor:new Date(Date.now()+3_600_000).toISOString()}));
      const entries = await prepareOrganicPublishBatch(owner,1,scheduled,key,review);
      return {entries,scheduled,review};
    }
    beforeEach(async () => {
      await files();
      await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,access_token,is_active,is_selected) VALUES(14,991,'facebook_page','synthetic-page','synthetic-token',true,true)");
    });
    it('registers every frozen attempt and complete asset in one ordered multi-target batch, then replays stored snapshots', async () => asActor(actor, async () => {
      frozenSnapshots = [frozen(1),frozen(2)]; sqlTrace.length = 0;
      const {entries,scheduled,review} = await batch();
      const references = (await pool.query('SELECT reference_type,reference_id,storage_file_id FROM storage_managed_references ORDER BY reference_type,reference_id')).rows;
      expect(references).toHaveLength(4);
      expect(references.filter(row=>row.reference_type==='social_publish_attempt').map(row=>row.storage_file_id)).toEqual([1,2]);
      expect(references.filter(row=>row.reference_type==='content_asset').map(row=>row.storage_file_id)).toEqual([1,2]);
      const billingLock = sqlTrace.findIndex(row=>row.query.includes('FOR UPDATE OF o'));
      const domainLock = sqlTrace.findIndex(row=>row.query.includes('"content_assets"') && row.query.endsWith('for update'));
      const objectLock = sqlTrace.findIndex(row=>row.params.some(value=>String(value).startsWith('storage-object:')));
      const lastDomainWrite = sqlTrace.reduce((last,row,index)=>/^(insert into|update) "(content_assets|social_publish_attempts)"/.test(row.query)?index:last,-1);
      expect(billingLock).toBeGreaterThanOrEqual(0); expect(billingLock).toBeLessThan(domainLock); expect(objectLock).toBeGreaterThan(lastDomainWrite);
      const objects = sqlTrace.filter(row=>row.params.some(value=>String(value).startsWith('storage-object:'))).flatMap(row=>row.params.filter(value=>String(value).startsWith('storage-object:')));
      expect(objects).toEqual([`storage-object:${owner}:local:${owner}/brand_asset/a-logo.png`,`storage-object:${owner}:local:${owner}/brand_asset/z-logo.png`]);
      frozenSnapshots = [frozen(2)];
      const replay = await prepareOrganicPublishBatch(owner,1,scheduled,'canonical-reference-batch',review);
      expect(replay.map((entry:{attempt:{id:number}})=>entry.attempt.id)).toEqual(entries.map((entry:{attempt:{id:number}})=>entry.attempt.id));
      expect((await pool.query('SELECT reference_type,reference_id,storage_file_id FROM storage_managed_references ORDER BY reference_type,reference_id')).rows).toEqual(references);
      expect(frozenSnapshots).toHaveLength(1); expect(fetchSpy).not.toHaveBeenCalled();
      expect((await pool.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1',[owner])).rows[0]).toMatchObject({storage_used_bytes:'14',file_count:2});
    }));
    it('rolls back all destinations and references when the final frozen revision is unavailable', async () => asActor(actor, async () => {
      frozenSnapshots = [frozen(1),frozen(999999)];
      await expect(batch()).rejects.toThrow(/unavailable/);
      expect((await pool.query('SELECT status,content FROM content_assets ORDER BY id')).rows).toEqual([{status:'draft',content:'Reviewed copy'}]);
      expect((await pool.query('SELECT id FROM social_publish_attempts')).rows).toHaveLength(0);
      expect((await pool.query('SELECT storage_file_id FROM storage_managed_references')).rows).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    }));
    it('rolls back an editable asset update when canonical registration fails', async () => asActor(actor, async () => {
      const {syncManagedStorageOwners}=await import('../services/managedStorageReferences.js');
      await pool.query('UPDATE content_assets SET image_url=$1 WHERE id=1',[privateUrl(1)]);
      await fixtureDb.transaction((tx:any)=>syncManagedStorageOwners(tx,{entries:[{owner:{...scope,kind:'content_asset',id:'1'},urls:[privateUrl(1)]}]}));
      await pool.query("CREATE FUNCTION synthetic_reference_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic reference registration outage'; END $$; CREATE TRIGGER synthetic_reference_failure BEFORE INSERT ON storage_managed_references FOR EACH ROW EXECUTE FUNCTION synthetic_reference_failure()");
      try { await expect(updateEditableContentAsset(owner,1,{title:'Should roll back',imageUrl:privateUrl(2),version:2})).rejects.toMatchObject({cause:{message:'Synthetic reference registration outage'}}); }
      finally { await pool.query('DROP TRIGGER synthetic_reference_failure ON storage_managed_references; DROP FUNCTION synthetic_reference_failure()'); }
      expect((await pool.query('SELECT title,image_url,version FROM content_assets WHERE id=1')).rows[0]).toEqual({title:'Reviewed',image_url:privateUrl(1),version:1});
      expect((await pool.query('SELECT storage_file_id FROM storage_managed_references')).rows).toEqual([{storage_file_id:1}]);
    }));
    it('releases deleted asset owners but retains the frozen attempt through FK SET NULL and blocks unreferenced cleanup', async () => asActor(actor, async () => {
      frozenSnapshots=[frozen(1)]; const {entries}=await batch('delete-reference',[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'}]);
      const attempt=entries[0].attempt;
      // Existing enrolled references also test deletion independently of new registration.
      const {syncManagedStorageOwners}=await import('../services/managedStorageReferences.js');
      await fixtureDb.transaction((tx:any)=>syncManagedStorageOwners(tx,{entries:[{owner:{...scope,kind:'content_asset',id:'1'},urls:[privateUrl(1)]},{owner:{...scope,kind:'social_publish_attempt',id:String(attempt.id)},urls:[privateUrl(1)]}]}));
      await changeOrganicPublishSchedule(owner,[1]);
      expect((await pool.query("SELECT count(*)::integer AS count FROM storage_managed_references WHERE reference_type='social_publish_attempt'")).rows[0].count).toBe(1);
      expect(await deleteEditableContentAsset(owner,1)).toBe(true);
      expect((await pool.query('SELECT reference_type,reference_id FROM storage_managed_references')).rows).toEqual([{reference_type:'social_publish_attempt',reference_id:String(attempt.id)}]);
      expect((await pool.query('SELECT asset_id,reviewed_payload,status FROM social_publish_attempts')).rows[0]).toMatchObject({asset_id:null,status:'cancelled',reviewed_payload:{brandContextSnapshot:frozen(1),publicationOrigin:attempt.reviewedPayload.publicationOrigin}});
      const {storageService}=await import('../services/StorageService.js');
      expect(await storageService.deleteFile(1,owner)).toBe(false); expect(objectBytes.has(`${owner}/brand_asset/z-logo.png`)).toBe(true);
      expect((await pool.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1',[owner])).rows[0]).toMatchObject({storage_used_bytes:'14',file_count:2});
    }));
    it('persists the reviewed YouTube options and upload start time while keeping omitted privacy private in the real caller transaction', async () => asActor(actor,async()=>{
      const {ContentAssetModel}=await import('../models/contentAssets/functions.js');
      const {prepareOrganicPublishAttempt}=await import('../services/social/OrganicPublishingService.js');
      const youtubeOptions={madeForKids:true,containsSyntheticMedia:true,categoryId:'28',defaultLanguage:'en-US',license:'creativeCommon' as const};
      const videoUrl='https://cdn.example.invalid/synthetic-video.mp4';
      const metadata={mediaProbe:{durationSeconds:60,width:1080,height:1920,codec:'h264',container:'mp4'}};
      await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,account_name,access_token,is_active,is_selected) VALUES(7,991,'youtube','UC-reviewed-channel','Synthetic YouTube','synthetic-token',true,true)");
      await pool.query('UPDATE content_assets SET title=$1,video_url=$2,metadata=$3::jsonb WHERE id=1',['Video',videoUrl,JSON.stringify(metadata)]);
      frozenSnapshots=[frozen(1)]; const at=new Date(Date.now()+3_600_000).toISOString();
      const asset=(await ContentAssetModel.findByIdForUser(1,owner))!;
      const input={platform:'youtube' as const,credentialId:7,postType:'short',tags:['first','second'],youtubeOptions,scheduledFor:at,timezone:'Asia/Kolkata',idempotencyKey:'youtube-jsonb-reference-review'};
      const prepared=await fixtureDb.transaction((tx:any)=>prepareOrganicPublishAttempt(owner,asset,input,tx));
      expect(prepared.snapshot).toMatchObject({youtubeOptions,privacyStatus:'private',scheduledFor:at,providerAccountId:'UC-reviewed-channel'});
      const saved=(await pool.query('SELECT next_attempt_at,reviewed_payload FROM social_publish_attempts WHERE id=$1',[prepared.attempt.id])).rows[0];
      expect(saved.next_attempt_at.toISOString()).toBe(at); expect(saved.reviewed_payload.youtubeOptions).toEqual(youtubeOptions);
      const current=(await ContentAssetModel.findByIdForUser(1,owner))!;
      frozenSnapshots=[frozen(2)];
      const replay=await prepareOrganicPublishAttempt(owner,current,{...input,youtubeOptions:{license:'creativeCommon',defaultLanguage:'en-US',categoryId:'28',containsSyntheticMedia:true,madeForKids:true}});
      expect(replay.attempt.id).toBe(prepared.attempt.id); expect(replay.snapshot.brandContextSnapshot).toEqual(frozen(1));
      await expect(prepareOrganicPublishAttempt(owner,(await ContentAssetModel.findByIdForUser(1,owner))!,{...input,youtubeOptions:{...youtubeOptions,defaultLanguage:'fr'}})).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
      await expect(prepareOrganicPublishAttempt(owner,(await ContentAssetModel.findByIdForUser(1,owner))!,{...input,tags:['second','first']})).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
      expect((await pool.query('SELECT id FROM social_publish_attempts')).rows).toHaveLength(1);
      expect((await pool.query('SELECT reference_type,storage_file_id FROM storage_managed_references ORDER BY reference_type')).rows).toEqual([{reference_type:'content_asset',storage_file_id:1},{reference_type:'social_publish_attempt',storage_file_id:1}]);
      expect(fetchSpy).not.toHaveBeenCalled();
    }));
    it('registers the full asset through the mounted edit API and denies a foreign business', async () => {
      const {default:express}=await import('express'); const {default:request}=await import('supertest');
      const {default:contentRouter}=await import('../routes/content.routes.js');
      const app=express(); app.use(express.json()); app.use('/api/content',contentRouter);
      frozenSnapshots=[frozen(1)];
      const changed=await request(app).put('/api/content/assets/1').send({title:'HTTP frozen snapshot'});
      expect(changed.status).toBe(200); expect(changed.body.brandContextSnapshot).toEqual(frozen(1));
      expect((await pool.query('SELECT reference_type,reference_id,storage_file_id FROM storage_managed_references')).rows).toEqual([{reference_type:'content_asset',reference_id:'1',storage_file_id:1}]);
      expect((await request(app).put('/api/content/assets/1').set('x-fixture-user','992').send({title:'Foreign overwrite'})).status).toBe(404);
      expect((await pool.query('SELECT title FROM content_assets WHERE id=1')).rows[0].title).toBe('HTTP frozen snapshot');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
    async function until(check:()=>Promise<boolean>) {
      for(let attempt=0;attempt<100;attempt++) { if(await check())return; await new Promise(resolve=>setTimeout(resolve,10)); }
      throw Error('Synthetic concurrency barrier did not reach the expected PostgreSQL lock');
    }
    it('serializes writer-first compensation before object locks and preserves committed frozen bytes/accounting', async () => {
      const {storageService}=await import('../services/StorageService.js');
      const control=await pool.connect(); let writing:Promise<unknown>|undefined,compensating:Promise<boolean>|undefined;
      let settled=false, compensationResult:boolean|undefined, writerResult:unknown;
      await pool.query("CREATE FUNCTION synthetic_domain_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(92713,99); RETURN NEW; END $$; CREATE TRIGGER synthetic_domain_pause BEFORE UPDATE ON content_assets FOR EACH ROW EXECUTE FUNCTION synthetic_domain_pause()");
      await control.query('SELECT pg_advisory_lock(92713,99)');
      try {
        frozenSnapshots=[frozen(1)]; writing=asActor(actor,()=>batch('writer-first',[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'}]));
        await until(async()=>Boolean((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=92713 AND objid=99 AND NOT granted) AS waiting")).rows[0].waiting));
        compensating=asActor(actor,()=>storageService.compensateFailedUpload(scope,1)).then(result=>{settled=true;return result;});
        await until(async()=>settled||Boolean((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF o%') AS waiting")).rows[0].waiting));
        expect(settled).toBe(false);
      } finally {
        await control.query('SELECT pg_advisory_unlock(92713,99)'); control.release();
        const results=await Promise.allSettled([writing,compensating]);
        writerResult=results[0]; if(results[1].status==='fulfilled')compensationResult=results[1].value;
        await pool.query('DROP TRIGGER synthetic_domain_pause ON content_assets; DROP FUNCTION synthetic_domain_pause()');
      }
      expect(writerResult).toMatchObject({status:'fulfilled'}); expect(compensationResult).toBe(false);
      expect((await pool.query('SELECT storage_file_id FROM storage_managed_references')).rows).toHaveLength(2);
      expect(objectBytes.has(`${owner}/brand_asset/z-logo.png`)).toBe(true);
      expect((await pool.query('SELECT is_deleted FROM storage_files WHERE id=1')).rows[0].is_deleted).toBe(false);
      expect((await pool.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1',[owner])).rows[0]).toMatchObject({storage_used_bytes:'14',file_count:2});
    });
    it('rejects late publication after compensation-first without claiming new durable references', async () => asActor(actor,async()=>{
      const {storageService}=await import('../services/StorageService.js');
      expect(await storageService.compensateFailedUpload(scope,1)).toBe(true);
      expect(objectBytes.has(`${owner}/brand_asset/z-logo.png`)).toBe(false);
      frozenSnapshots=[frozen(1)];
      await expect(batch('compensation-first',[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'}])).rejects.toThrow(/unavailable/);
      expect((await pool.query('SELECT id FROM social_publish_attempts')).rows).toHaveLength(0);
      expect((await pool.query('SELECT storage_file_id FROM storage_managed_references')).rows).toHaveLength(0);
      expect((await pool.query('SELECT status FROM content_assets WHERE id=1')).rows[0].status).toBe('draft');
      expect((await pool.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1',[owner])).rows[0]).toMatchObject({storage_used_bytes:'7',file_count:1});
    }));
    it.each(['success','timeout'])('keeps frozen references through registered-worker %s and Redis replay without a second effect', async mode=>{
      frozenSnapshots=[frozen(1)]; const {attempt}=await prepare(); const job=await dispatch(attempt);
      fetchSpy.mockImplementation(async()=>{writes++; if(mode==='timeout')throw Error('Synthetic provider accepted then timeout');return new Response(null,{status:201,headers:{'x-restli-id':'urn:li:share:frozen-reference-worker'}});});
      await worker!.resume(); await job.waitUntilFinished(events,10000);
      const duplicate=await queue.add('publish-attempt',job.data,{attempts:1}); await duplicate.waitUntilFinished(events,10000);
      expect(writes).toBe(1); const saved=await asActor(actor,()=>SocialPublishAttemptModel.findByIdForUser(attempt.id,owner));
      expect(saved?.status).toBe(mode==='success'?'succeeded':'ambiguous'); expect(saved?.reviewedPayload.publicationOrigin).toEqual(attempt.reviewedPayload.publicationOrigin);
      expect((await pool.query('SELECT reference_type,storage_file_id FROM storage_managed_references ORDER BY reference_type')).rows).toEqual([{reference_type:'content_asset',storage_file_id:1},{reference_type:'social_publish_attempt',storage_file_id:1}]);
      const {storageService}=await import('../services/StorageService.js'); expect(await asActor(actor,()=>storageService.compensateFailedUpload(scope,1))).toBe(false);
      expect(objectBytes.has(`${owner}/brand_asset/z-logo.png`)).toBe(true);
    });
    it('preserves frozen reviewed media when an editable asset adopts a different brand snapshot', async () => asActor(actor,async()=>{
      frozenSnapshots=[frozen(1)]; const {entries}=await batch('changed-brand-reference',[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'}]);
      await changeOrganicPublishSchedule(owner,[1]);
      const existing=(await pool.query('SELECT metadata FROM content_assets WHERE id=1')).rows[0].metadata;
      await updateEditableContentAsset(owner,1,{brandContextSnapshot:frozen(2),metadata:existing,version:3});
      expect((await pool.query('SELECT reference_type,storage_file_id FROM storage_managed_references ORDER BY reference_type,storage_file_id')).rows).toEqual([{reference_type:'content_asset',storage_file_id:1},{reference_type:'content_asset',storage_file_id:2},{reference_type:'social_publish_attempt',storage_file_id:1}]);
      expect((await pool.query('SELECT reviewed_payload FROM social_publish_attempts WHERE id=$1',[entries[0].attempt.id])).rows[0].reviewed_payload.brandContextSnapshot).toEqual(frozen(1));
      expect((await pool.query('SELECT is_deleted FROM storage_files ORDER BY id')).rows).toEqual([{is_deleted:false},{is_deleted:false}]);
    }));
    it('rejects a known private foreign revision without granting ownership or persisting a destination', async () => asActor(actor,async()=>{
      await pool.query("INSERT INTO users(id) VALUES(992); INSERT INTO billing_organizations(id,owner_user_id,name) VALUES(1999,992,'Synthetic foreign payer'); INSERT INTO company_settings(id,user_id,name,billing_organization_id) VALUES(199,992,'Synthetic foreign business',1999); INSERT INTO storage_files(id,user_id,business_profile_id,file_name,storage_key,url) VALUES(9,992,199,'foreign.png','992/brand_asset/foreign.png','https://public.example.invalid/foreign.png')");
      frozenSnapshots=[frozen(9)]; await expect(batch('private-foreign-reference',[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'}])).rejects.toThrow(/unavailable/);
      expect((await pool.query('SELECT id FROM social_publish_attempts')).rows).toHaveLength(0); expect((await pool.query('SELECT storage_file_id FROM storage_managed_references')).rows).toHaveLength(0);
      expect((await pool.query('SELECT user_id,business_profile_id,is_deleted FROM storage_files WHERE id=9')).rows[0]).toEqual({user_id:992,business_profile_id:199,is_deleted:false});
    }));
    it.each([false,true])('runs mounted multipart upload and canonical rollback/compensation (registration fault=%s)', async fault=>{
      const {default:express}=await import('express'); const {default:request}=await import('supertest');
      const {default:contentRouter}=await import('../routes/content.routes.js');
      const app=express();app.use(express.json());app.use('/api/content',contentRouter);
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
      if(fault)await pool.query("CREATE FUNCTION synthetic_upload_reference_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic upload reference outage'; END $$; CREATE TRIGGER synthetic_upload_reference_failure BEFORE INSERT ON storage_managed_references FOR EACH ROW EXECUTE FUNCTION synthetic_upload_reference_failure()");
      let response;
      try {response=await request(app).post('/api/content/assets/upload').field('assetId','1').field('mediaType','image').attach('file',png,{filename:'synthetic.png',contentType:'image/png'});}
      finally {if(fault)await pool.query('DROP TRIGGER synthetic_upload_reference_failure ON storage_managed_references; DROP FUNCTION synthetic_upload_reference_failure()');}
      const files=(await pool.query('SELECT id,storage_key,is_deleted,file_size_bytes,metadata FROM storage_files ORDER BY id')).rows;
      expect({status:response.status,body:response.body}).toMatchObject({status:fault?500:200}); expect(files).toHaveLength(3);
      const uploaded=files[2]; expect(uploaded.is_deleted).toBe(fault); expect(Number(uploaded.file_size_bytes)).toBe(png.length);
      const saved=(await pool.query('SELECT image_url,image_urls,version FROM content_assets WHERE id=1')).rows[0];
      if(fault){expect(saved).toEqual({image_url:null,image_urls:null,version:1});expect(objectBytes.has(uploaded.storage_key)).toBe(false);}
      else {expect(response.body.asset.id).toBe(1);expect(saved).toMatchObject({image_url:response.body.url,image_urls:[response.body.url],version:2});expect(objectBytes.get(uploaded.storage_key)).toEqual(png);}
      const references=(await pool.query('SELECT reference_type,reference_id,storage_file_id FROM storage_managed_references')).rows;
      expect(references).toEqual(fault?[]:[{reference_type:'content_asset',reference_id:'1',storage_file_id:uploaded.id}]);
      expect((await pool.query('SELECT id FROM billing_storage_reservations')).rows).toHaveLength(0);
      const bytes=fault?14:14+png.length;
      expect((await pool.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1',[owner])).rows[0]).toMatchObject({storage_used_bytes:String(bytes),file_count:fault?2:3});
      expect((await pool.query("SELECT usage FROM billing_capacity_totals WHERE organization_id=$1 AND resource_key='storageBytes'",[payer])).rows[0].usage).toBe(String(bytes));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
    it('preserves unresolved public URL behavior without creating a foreign holder capability', async () => asActor(actor, async () => {
      const external='https://public.example.invalid/unknown-frozen-logo.png'; frozenSnapshots=[{brandToolkit:{logoUrl:external}}];
      const {entries}=await batch('unresolved-reference',[{platform:'linkedin',credentialId:13,caption:'Reviewed LinkedIn',postType:'text'}]);
      const {resolveManagedStorageUrls}=await import('../services/managedStorageReferences.js');
      const resolved=await fixtureDb.transaction((tx:any)=>resolveManagedStorageUrls(tx,scope,[external]));
      expect(resolved).toEqual({objects:[],unresolvedUrls:[external]});
      expect(entries[0].attempt.reviewedPayload.brandContextSnapshot).toEqual({brandToolkit:{logoUrl:external}});
      expect((await pool.query('SELECT storage_file_id FROM storage_managed_references')).rows).toHaveLength(0);
      // No byte-preservation claim is made for unresolved external URLs.
    }));
  });

  (process.env.ORGANIC_BROWSER === '1' ? it : it.skip)('interactive production browser through the mounted content router', async () => {
    const { default: express } = await import('express');
    const { default: contentRouter } = await import('../routes/content.routes.js');
    const { responseWrapper } = await import('../middleware/responseWrapper.js');
    const { existsSync, writeFileSync } = await import('node:fs');
    const path = process.env.ORGANIC_EVIDENCE!;
    const trace: any[] = [];
    let providerWrites = 0, providerMode = 'success';
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === 'api.linkedin.com' && init?.method === 'POST') { providerWrites++; return new Response(null,{status:201,headers:{'x-restli-id':'urn:li:share:synthetic-multi'}}); }
      if (parsed.hostname !== 'graph.facebook.com') throw Error('Unmocked external request denied: '+parsed.hostname);
      if (init?.method === 'POST') {
        providerWrites++;
        if (providerMode === 'timeout') throw Error('Synthetic accepted-but-timeout');
        if (providerMode === 'missing_receipt') return new Response('{}',{status:200});
        return new Response(JSON.stringify({ id: 'fixture_page_'+providerWrites }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'fixture_page_'+providerWrites, permalink_url: 'https://www.facebook.com/fixture_page/posts/'+providerWrites }), { status: 200 });
    });
    const reset = async () => {
      await worker!.pause(); await queue.obliterate({ force: true }); trace.length = 0; providerWrites = 0; providerMode = 'success';
      await pool.query('TRUNCATE content_assets,social_publish_attempts,channel_credentials,content_plans,content_templates RESTART IDENTITY');
      await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,account_name,access_token,is_active,is_selected) VALUES(14,991,'facebook_page','fixture-page','Synthetic reviewed Page','synthetic-page-token',true,true)");
      for (let id=1;id<=3;id++) await pool.query("INSERT INTO content_assets(id,user_id,type,title,content,status,version) VALUES($1,991,'social_post',$2,'Synthetic reviewed text','draft',1)",[id,'Synthetic audit post '+id]);
      await pool.query("SELECT setval(pg_get_serial_sequence('content_assets','id'),3)");
    };
    const app = express(); app.use(express.json()); app.use('/api',responseWrapper);
    app.use((req,_res,next)=>{trace.push({method:req.method,path:req.path,key:req.get('Idempotency-Key'),body:req.method==='POST'?req.body:undefined});next();});
    app.post('/__audit/reset', async (_req,res)=>{await reset();res.json({ok:true});});
    app.post('/__audit/multi',async(_req,res)=>{await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,account_name,access_token,is_active,is_selected) VALUES(13,991,'linkedin','urn:li:person:synthetic','Synthetic LinkedIn author','synthetic-token',true,true)");res.json({ok:true});});
    app.post('/__audit/stale', async (_req,res)=>{await pool.query("UPDATE content_assets SET version=version+1,content='Changed after browser review' WHERE id=1");res.json({ok:true});});
    app.post('/__audit/provider', (req,res)=>{providerMode=req.body.mode;res.json({ok:true});});
    app.post('/__audit/dispatch', async (_req,res)=>{
      await pool.query("UPDATE social_publish_attempts SET next_attempt_at=now()-interval '1 minute' WHERE status='pending'");
      const ids=(await pool.query("SELECT id FROM social_publish_attempts WHERE status='pending'")).rows;
      const jobs=[];
      for(const {id} of ids) {
        const jobId=await asActor(owner,async()=>enqueueOrganicPublishAttempt((await SocialPublishAttemptModel.findByIdForUser(Number(id),owner))!));
        const job=await queue.getJob(String(jobId));if(job)jobs.push(job);
      }
      await worker!.resume(); await Promise.all(jobs.map(job=>job.waitUntilFinished(events,10000))); await worker!.pause();
      res.json({ok:true,jobs:jobs.length});
    });
    app.get('/__audit/state',async(_req,res)=>res.json({providerWrites,trace,
      assets:(await pool.query('SELECT id,status,version,content,published_post_id,metadata FROM content_assets ORDER BY id')).rows,
      attempts:(await pool.query('SELECT id,asset_id,status,idempotency_key,reviewed_payload,provider_post_id,attempt_count FROM social_publish_attempts ORDER BY id')).rows}));
    app.use('/api/content',contentRouter);
    await reset();
    const server=app.listen(30474,'127.0.0.1');
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    writeFileSync(path+'/ready.json',JSON.stringify({port:30474,schema,baseSha:'24c66b9cac2936ccbd119e39cf78b5b83b1e6212'}));
    try {
      const until=Date.now()+480000;
      while(!existsSync(path+'/done')&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,200));
      if(!existsSync(path+'/done'))throw Error('Audit browser did not signal completion');
      writeFileSync(path+'/backend-final.json',JSON.stringify({providerWrites,trace},null,2));
    } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },500000);

});
