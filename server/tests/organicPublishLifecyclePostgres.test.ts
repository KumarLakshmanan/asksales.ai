import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { installOrganicManagedStorageFixtures } from './helpers/organicManagedStoragePostgres.js';
import type { Queue } from 'bullmq';
import { Pool, types as pgTypes } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import { withBusinessScope, withAccountScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

const inBusiness = <T>(work: () => T) => withBusinessScope({ userId: 991, businessProfileId: 99 }, work);

// No application tables or provider calls. An opt-in fixture uses a random,
// exclusively owned PostgreSQL schema and a search_path without public.
const suite = process.env.CONTENT_PUBLISH_LOCAL_QA === '1' ? describe : describe.skip;
let fixtureDb: any;
const databaseProxy = new Proxy({}, { get: (_target, key) => (...args: any[]) => fixtureDb[key](...args) });
jest.unstable_mockModule('../models/db', () => ({ db: databaseProxy, pgPool: undefined }));
jest.unstable_mockModule('../services/social/OrganicPublishNotifications.js', () => ({ notifyOrganicPublishFailure: jest.fn() }));
jest.unstable_mockModule('../services/media/PublishingImagePreflight.js', () => ({ preflightPublishingImages: async (urls: string[]) => ({ urls, probes: [] }) }));
const publish = jest.fn<(...args: any[]) => Promise<any>>();
let publicationQueue: Queue | undefined;
jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: { ORGANIC_PUBLISHING: 'organic-publishing' },
  queueRegistry: { addJob: async (_queue: string, name: string, data: any, options: any) => {
    if (!publicationQueue) throw new Error('Disposable publication queue was not initialized');
    return (await publicationQueue.add(name, data, options)).id!;
  } },
}));
jest.unstable_mockModule('../services/social/SocialPublishingService', () => ({
  publishToFacebook: publish, publishToInstagram: publish,
  findPublishedOrganicPostCandidate: jest.fn(),
}));
jest.unstable_mockModule('../services/social/YouTubePublishingService', () => ({
  assignYouTubePlaylist: jest.fn(), setYouTubeThumbnail: jest.fn(), validateYouTubePublishExtras: jest.fn(), generateYouTubeChapterContent: (caption: string) => caption,
  listYouTubePublishingAccounts: async () => [], getYouTubeVideoProcessingStatus: jest.fn(),
  classifyYouTubeProcessingState: jest.fn(), normalizeYouTubePostType: (type: string) => type || 'video',
  publishToYouTube: publish, validateShortMetadata: (probe: any) => {
    if (probe && (probe.height < probe.width || probe.durationSeconds > 180)) throw new Error('Invalid Short metadata');
  },
  validateYouTubePublishInput: () => 'video',
}));
jest.unstable_mockModule('../services/content/ContentBrandContextService', () => ({
  ContentBrandContextError: class extends Error {},
  brandContextSnapshot: () => ({}), resolveContentBrandContext: async () => ({ businessProfile: { id: 99 }, brandToolkit: { id: 99 } }),
}));
jest.unstable_mockModule('../services/content/ContentComplianceService', () => ({
  contentOutputSchemas: {},
  ContentComplianceError: class extends Error {}, validateGeneratedContent: () => undefined,
  extractJsonObject: (value: string) => value, parseStructuredContent: (value: string) => JSON.parse(value),
}));
jest.unstable_mockModule('../mastra/tools/queueBridge.js', () => ({ dispatchAndWait: jest.fn(), shouldUseQueue: () => false }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: jest.fn() }));
const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
const { socialPublishAttemptsTable } = await import('../models/socialPublishAttempts/schema.js');
const { channelCredentialsTable } = await import('../models/channelCredentials/schema.js');
const { contentPlansTable } = await import('../models/contentPlans/schema.js');
const { contentTemplatesTable } = await import('../models/contentTemplates/schema.js');
const { getCalendarItems, getCalendarSummary } = await import('../controllers/contentCalendarController.js');
const { publishContentAsset, createContentAsset, updateContentAsset, getContentAsset } = await import('../controllers/contentAssetController.js');
const { executePublishSocialPost } = await import('../mastra/tools/executors/contentExecutor.js');
const { prepareOrganicPublishBatch, changeOrganicPublishSchedule, updateEditableContentAsset, recoverOrganicPublishAttempt, publishAttemptCapabilities } = await import('../services/social/OrganicPublishLifecycleService.js');
const { getOrganicPublishingReview, executeOrganicPublishAttempt } = await import('../services/social/OrganicPublishingService.js');

suite('organic publishing lifecycle with isolated PostgreSQL and fake providers', () => {
  let pool: Pool;
  let admin: Pool;
  let runtime: Pool;
  let schema: string;
  let fetchSpy: ReturnType<typeof jest.spyOn>;
  const tenant = 991;
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  const facebook = (scheduledFor?: string) => ({ platform: 'facebook' as const, credentialId: 11, caption: 'Exact reviewed copy', postType: 'text', scheduledFor, timezone: 'Asia/Kolkata' });

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Publication QA requires local PostgreSQL');
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK DENIED: publication QA'); });
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `content_publish_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 5, options: `-c search_path=${schema},pg_catalog -c timezone=UTC -c app.business_profile_id=99`, types: {
      getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === 1114 ? (value: string) => new Date(`${value}Z`) : pgTypes.getTypeParser(oid, format),
    } });
    await localBusinessFunctions(pool);
    await pool.query('CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer NOT NULL); INSERT INTO company_settings VALUES(99,991),(100,991),(199,992)');
    await pool.query(`ALTER TABLE company_settings ADD COLUMN name text, ADD COLUMN company_name text, ADD COLUMN business_name text, ADD COLUMN billing_organization_id integer;
      UPDATE company_settings SET billing_organization_id=999;
      CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamp,is_approved boolean DEFAULT true); INSERT INTO users(id) VALUES(991),(992);
      CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,role text,status text);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer,name text,default_for_user_id integer,billing_eligibility_at timestamp DEFAULT now());
      INSERT INTO billing_organizations(id,owner_user_id,name) VALUES(999,991,'Synthetic payer');
      CREATE TABLE billing_organization_memberships(id serial PRIMARY KEY,organization_id integer,user_id integer,status text,role text);`);
    runtime = createBusinessScopedPool(new Pool({ ...config, max: 5, options: `-c search_path=${schema},pg_catalog -c timezone=UTC`, types: {
      getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === 1114 ? (value: string) => new Date(`${value}Z`) : pgTypes.getTypeParser(oid, format),
    } }));
    fixtureDb = drizzle(runtime);
    for (const table of [contentAssetsTable, socialPublishAttemptsTable, channelCredentialsTable, contentPlansTable, contentTemplatesTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        if (column.name === 'id') return 'id SERIAL PRIMARY KEY';
        const value = column.default;
        const defaultSql = value instanceof SQL ? new PgDialect().sqlToQuery(value).sql : value === undefined ? undefined : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('CREATE UNIQUE INDEX fixture_publish_key ON social_publish_attempts(business_profile_id,user_id,idempotency_key)');
    await localBusinessIsolation(pool, schema, ['content_assets', 'social_publish_attempts', 'channel_credentials', 'content_plans', 'content_templates']);
    await installOrganicManagedStorageFixtures(pool, schema);
  }, 30000);
  afterAll(async () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy?.mockRestore();
    await runtime?.end(); await pool?.end();
    if (admin && /^content_publish_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE storage_managed_references,storage_files,storage_quotas,content_assets,social_publish_attempts,channel_credentials,content_templates RESTART IDENTITY');
    await pool.query("INSERT INTO channel_credentials(id,user_id,platform,account_identifier,account_name,is_active,is_selected) VALUES(11,$1,'facebook_page','fixture-page','Fixture page',true,true),(12,$1,'instagram_api','fixture-ig','Fixture IG',true,true)", [tenant]);
    publish.mockReset();
    publish.mockResolvedValue({ success: true, platformPostId: 'MOCK_ONLY_POST' });
  });
  let shownReview: { expectedVersion: number; expectedReviewToken: string };
  async function reviewedSource() {
    const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
    const saved = (await ContentAssetModel.findByIdForUser(1, tenant))!;
    return { expected_version: saved.version, expected_review_token: (await getOrganicPublishingReview(saved)).token };
  }
  async function asset(id = 1, type = 'social_post') {
    const rows = await pool.query("INSERT INTO content_assets(id,user_id,type,title,content,status,version,metadata) VALUES($1,$2,$3,'Fixture','{\"caption\":\"Original\"}','draft',1,'{}') RETURNING *", [id, tenant, type]);
    // Manual fixture IDs must not collide with cross-post inserts.
    await pool.query("SELECT setval(pg_get_serial_sequence('content_assets','id'), (SELECT MAX(id) FROM content_assets))");
    if (id === 1) { const current = await reviewedSource(); shownReview = { expectedVersion: current.expected_version, expectedReviewToken: current.expected_review_token }; }
    return rows.rows[0];
  }
  async function state(id = 1) { return (await pool.query('SELECT * FROM content_assets WHERE id=$1', [id])).rows[0]; }
  async function attempts() { return (await pool.query('SELECT * FROM social_publish_attempts ORDER BY id')).rows; }
  function response() { const res: any = { statusCode: 200 }; res.status = (value: number) => { res.statusCode = value; return res; }; res.json = (value: any) => { res.body = value; return res; }; return res; }
  function request(body: any, key = 'http-fixture'): any { return { user: { id: tenant }, params: { assetId: '1', id: '1' }, body: { ...((body.targets || body.platform) ? shownReview : {}), ...body }, get: () => key }; }

  it('schedules without sending, then claims and sends exactly once at the due time', async () => inBusiness(async () => {
    await asset();
    const at = future();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook(at)], 'schedule');
    expect((await state()).scheduled_publish_at.toISOString()).toBe(at);
    await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture');
    expect(publish).not.toHaveBeenCalled();
    await pool.query("UPDATE social_publish_attempts SET next_attempt_at=NOW()-interval '1 minute'");
    expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture')).status).toBe('succeeded');
    await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toEqual(expect.objectContaining({ message: 'Exact reviewed copy', credentialId: 11, expectedAccountId: 'fixture-page' }));
    expect((await state()).status).toBe('published');
  }));
  it('replaces schedules atomically and allows moves despite cancelled history', async () => inBusiness(async () => {
    await asset();
    await prepareOrganicPublishBatch(tenant, 1, [facebook(future())], 'first');
    const next = new Date(Date.now() + 7_200_000).toISOString();
    await prepareOrganicPublishBatch(tenant, 1, [facebook(next)], 'second');
    expect((await attempts()).map(row => row.status)).toEqual(['cancelled', 'pending']);
    const moved = new Date(Date.now() + 10_800_000);
    await changeOrganicPublishSchedule(tenant, [1], moved);
    expect((await state()).scheduled_publish_at.toISOString()).toBe(moved.toISOString());
    expect((await attempts())[1].reviewed_payload.scheduledFor).toBe(moved.toISOString());
    await changeOrganicPublishSchedule(tenant, [1]);
    await changeOrganicPublishSchedule(tenant, [1]);
    expect((await attempts()).map(row => row.status)).toEqual(['cancelled', 'cancelled']);
    expect(publish).not.toHaveBeenCalled();
  }));
  it('rolls back an invalid cross-platform replacement without losing the old schedule', async () => inBusiness(async () => {
    await asset();
    const at = future();
    await prepareOrganicPublishBatch(tenant, 1, [facebook(at)], 'original');
    await expect(prepareOrganicPublishBatch(tenant, 1, [facebook(future()), { platform: 'instagram', credentialId: 12, postType: 'post', scheduledFor: future() }], 'invalid')).rejects.toThrow();
    expect((await attempts()).map(row => row.status)).toEqual(['pending']);
    expect((await state()).scheduled_publish_at.toISOString()).toBe(at);
    expect((await pool.query('SELECT count(*) FROM content_assets')).rows[0].count).toBe('1');
  }));
  it('moves and cancels only the exact root destination and rejects its stale schedule snapshot', async () => inBusiness(async () => {
    await asset();
    await pool.query("UPDATE content_assets SET image_url='https://media.example.test/fixture.png',thread_id=9 WHERE id=1");
    const at = future();
    const entries = await prepareOrganicPublishBatch(tenant, 1, [
      { ...facebook(at), postType: 'photo' },
      { platform: 'instagram', credentialId: 12, caption: 'Reviewed Instagram copy', postType: 'post', scheduledFor: at, timezone: 'Asia/Kolkata' },
    ], 'exact-root-calendar');
    const childId = entries[1].assetId;
    const version = (await state()).version;
    const selection = { exactAssetOnly: true, expectedVersions: { 1: version }, expectedScheduledFor: { 1: at }, threadId: 9 };
    const moved = new Date(Date.now() + 7_200_000);
    await changeOrganicPublishSchedule(tenant, [1], moved, selection);
    expect((await state(childId)).scheduled_publish_at.toISOString()).toBe(at);
    await expect(changeOrganicPublishSchedule(tenant, [1], undefined, selection)).rejects.toMatchObject({ code: 'CONTENT_VERSION_CONFLICT' });
    expect((await state()).status).toBe('scheduled');
    const result = await changeOrganicPublishSchedule(tenant, [1], undefined, { ...selection, expectedVersions: { 1: version + 1 }, expectedScheduledFor: { 1: moved.toISOString() } });
    expect(result).toEqual({ affected: 1, attempts: [entries[0].attempt.id] });
    expect((await state()).status).toBe('cancelled');
    const child = await state(childId);
    expect(child.status).toBe('scheduled');
    expect(child.scheduled_publish_at.toISOString()).toBe(at);
    const savedAttempts = await attempts();
    expect(savedAttempts.map(row => row.status)).toEqual(['cancelled', 'pending']);
    expect(savedAttempts[1].reviewed_payload).toMatchObject({ caption: 'Reviewed Instagram copy', scheduledFor: at });
    expect(publish).not.toHaveBeenCalled();
  }));
  it('binds retries to the reviewed source and payload and never revives cancelled attempts', async () => inBusiness(async () => {
    await asset(); await asset(2);
    const target = facebook(future());
    const [first] = await prepareOrganicPublishBatch(tenant, 1, [target], 'replay');
    expect((await prepareOrganicPublishBatch(tenant, 1, [target], 'replay'))[0].attempt.id).toBe(first.attempt.id);
    await expect(prepareOrganicPublishBatch(tenant, 2, [target], 'replay')).rejects.toThrow(/another content asset/);
    await expect(prepareOrganicPublishBatch(tenant, 1, [{ ...target, caption: 'Changed' }], 'replay')).rejects.toThrow(/different publishing request/);
    await changeOrganicPublishSchedule(tenant, [1]);
    expect((await prepareOrganicPublishBatch(tenant, 1, [target], 'replay'))[0].attempt.status).toBe('cancelled');
    expect((await state()).status).toBe('cancelled');
  }));
  it('defaults to a single destination and moves siblings only with explicit group scope', async () => inBusiness(async () => {
    await asset();
    await pool.query("UPDATE content_assets SET image_url='https://media.example.test/fixture.png' WHERE id=1");
    const at = future();
    const entries = await prepareOrganicPublishBatch(tenant, 1, [
      { ...facebook(at), postType: 'photo' },
      { platform: 'instagram', credentialId: 12, caption: 'Instagram', postType: 'post', scheduledFor: at },
    ], 'scope');
    const moved = new Date(Date.now() + 7_200_000);
    await changeOrganicPublishSchedule(tenant, [1], moved);
    expect((await state(entries[1].assetId)).scheduled_publish_at.toISOString()).toBe(at);
    const groupTime = new Date(Date.now() + 10_800_000);
    await changeOrganicPublishSchedule(tenant, [entries[1].assetId], groupTime, { exactAssetOnly: false });
    expect((await state()).scheduled_publish_at.toISOString()).toBe(groupTime.toISOString());
    expect((await state(entries[1].assetId)).scheduled_publish_at.toISOString()).toBe(groupTime.toISOString());
    await changeOrganicPublishSchedule(tenant, [1]);
    expect((await state()).scheduled_publish_at.toISOString()).toBe(groupTime.toISOString());
    expect((await state(entries[1].assetId)).status).toBe('scheduled');
  }));
  it('safely recovers a rejected destination once without repeating successful or uncertain sends', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'recovery');
    publish.mockResolvedValueOnce({ success: false, retryable: false, error: 'Mock rejection' });
    const failed = await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture');
    expect(failed.status).toBe('failed');
    expect(publishAttemptCapabilities(failed).retry).toBe(true);
    await expect(recoverOrganicPublishAttempt(tenant + 1, 1, failed.id, 'retry')).rejects.toMatchObject({ code: 'CONTENT_ASSET_NOT_FOUND' });
    const outcomes = await Promise.allSettled([
      recoverOrganicPublishAttempt(tenant, 1, failed.id, 'retry'),
      recoverOrganicPublishAttempt(tenant, 1, failed.id, 'retry'),
    ]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    await Promise.all([
      executeOrganicPublishAttempt(failed.id, tenant, 'fixture-a'),
      executeOrganicPublishAttempt(failed.id, tenant, 'fixture-b'),
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
    await expect(recoverOrganicPublishAttempt(tenant, 1, failed.id, 'retry')).rejects.toMatchObject({ code: 'PUBLISH_RECOVERY_UNAVAILABLE' });
    await pool.query("UPDATE social_publish_attempts SET status='failed',provider_post_id='accepted-video' WHERE id=$1", [failed.id]);
    await expect(recoverOrganicPublishAttempt(tenant, 1, failed.id, 'retry')).rejects.toMatchObject({ code: 'PUBLISH_RECOVERY_UNAVAILABLE' });
    await pool.query("UPDATE social_publish_attempts SET status='ambiguous',provider_post_id=NULL WHERE id=$1", [failed.id]);
    await expect(recoverOrganicPublishAttempt(tenant, 1, failed.id, 'retry')).rejects.toMatchObject({ code: 'PUBLISH_RECOVERY_UNAVAILABLE' });
    expect((await recoverOrganicPublishAttempt(tenant, 1, failed.id, 'reconcile')).status).toBe('ambiguous');
  }));
  it('publishes a scheduled destination now using the reviewed attempt and rejects stale changes', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook(future())], 'publish-now');
    await expect(recoverOrganicPublishAttempt(tenant, 1, entry.attempt.id, 'publish_now', 90)).rejects.toMatchObject({ code: 'CONTENT_VERSION_CONFLICT' });
    const updated = await recoverOrganicPublishAttempt(tenant, 1, entry.attempt.id, 'publish_now', 1);
    expect(updated.reviewedPayload.scheduledFor).toBeUndefined();
    expect((await state()).status).toBe('processing');
    expect((await executeOrganicPublishAttempt(updated.id, tenant, 'fixture')).status).toBe('succeeded');
    expect(publish).toHaveBeenCalledTimes(1);
  }));
  it('rejects edits and plan-only rescheduling, but allows editing after explicit cancellation', async () => inBusiness(async () => {
    await asset(); await asset(2);
    await expect(changeOrganicPublishSchedule(tenant, [2], new Date(future()))).rejects.toThrow(/No durable/);
    await prepareOrganicPublishBatch(tenant, 1, [facebook(future())], 'edit');
    await expect(updateEditableContentAsset(tenant, 1, { content: 'Changed' })).rejects.toThrow(/before editing/);
    await changeOrganicPublishSchedule(tenant, [1]);
    await updateEditableContentAsset(tenant, 1, { content: 'Changed', status: 'draft' });
    expect((await state()).content).toBe('Changed');
  }));
  it('does not cancel or move a claimed attempt, including a concurrent claim', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'claimed');
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query("UPDATE social_publish_attempts SET status='claimed' WHERE id=$1", [entry.attempt.id]);
    const cancelled = changeOrganicPublishSchedule(tenant, [1]);
    await client.query('COMMIT'); client.release();
    await expect(cancelled).rejects.toThrow(/claimed or remotely active/);
    expect((await attempts())[0].status).toBe('claimed');
    expect((await state()).status).not.toBe('cancelled');
  }));
  it('serializes simultaneous schedule replacements to one open attempt', async () => inBusiness(async () => {
    await asset();
    const outcomes = await Promise.allSettled([prepareOrganicPublishBatch(tenant, 1, [facebook(future())], 'parallel-a'), prepareOrganicPublishBatch(tenant, 1, [facebook(future())], 'parallel-b')]);
    expect(outcomes.some(value => value.status === 'fulfilled')).toBe(true);
    for (const value of outcomes) if (value.status === 'rejected') expect(value.reason.code).toBe('CONTENT_VERSION_CONFLICT');
    expect((await attempts()).filter(row => row.status === 'pending')).toHaveLength(1);
  }));
  it('returns the same receipt for simultaneous idempotent submissions', async () => inBusiness(async () => {
    await asset();
    const target = facebook(future());
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => prepareOrganicPublishBatch(tenant, 1, [target], 'same-concurrent-key')));
    expect(new Set(outcomes.map(entries => entries[0].attempt.id)).size).toBe(1);
    expect(await attempts()).toHaveLength(1);
  }));
  it('completes more simultaneous replacements than pool connections without starving locked transactions', async () => inBusiness(async () => {
    await asset();
    const outcomes = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => prepareOrganicPublishBatch(tenant, 1, [facebook(future())], `pool-parallel-${index}`)));
    expect(outcomes.some(value => value.status === 'fulfilled')).toBe(true);
    for (const value of outcomes) if (value.status === 'rejected') expect(value.reason.code).toBe('CONTENT_VERSION_CONFLICT');
    expect((await attempts()).filter(row => row.status === 'pending')).toHaveLength(1);
  }), 20000);
  it('keeps the intended calendar slot on permanent failure', async () => inBusiness(async () => {
    await asset();
    const at = future();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook(at)], 'failure');
    await pool.query("UPDATE social_publish_attempts SET next_attempt_at=NOW()-interval '1 minute'");
    publish.mockResolvedValue({ success: false, retryable: false, error: 'Mock rejection' });
    expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture')).status).toBe('failed');
    expect((await state()).scheduled_publish_at.toISOString()).toBe(at);
  }));
  it('applies trusted media preflight to every entry point', async () => inBusiness(async () => {
    await asset(1, 'video');
    await pool.query("UPDATE content_assets SET video_url='https://media.example.test/video.mp4'");
    await expect(prepareOrganicPublishBatch(tenant, 1, [{ ...facebook(), postType: 'video' }], 'unprobed')).rejects.toThrow(/trusted media/);
    expect(await attempts()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  }));
  it('shows scheduled videos on their local posting date in both calendar and summary', async () => inBusiness(async () => {
    await asset(1, 'video');
    const at = new Date(Date.now() + 2 * 86_400_000);
    at.setUTCHours(23, 0, 0, 0);
    await prepareOrganicPublishBatch(tenant, 1, [facebook(at.toISOString())], 'video-calendar');
    const response = () => { const res: any = { statusCode: 200 }; res.status = (value: number) => { res.statusCode = value; return res; }; res.json = (value: any) => { res.body = value; return res; }; return res; };
    const req: any = { user: { id: tenant }, query: { timezone: 'Asia/Kolkata' } };
    const calendar = response();
    await getCalendarItems(req, calendar);
    expect(calendar.statusCode).toBe(200);
    const summary = response();
    await getCalendarSummary(req, summary);
    expect(summary.statusCode).toBe(200);
    const localDate = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    expect(JSON.stringify(calendar.body)).toContain(localDate);
    expect(summary.body.summary.upcomingThisWeek).toEqual(expect.arrayContaining([expect.objectContaining({ contentAssetId: 1, scheduledDate: localDate, scheduledTime: '04:30' })]));
  }));
  it.each(['http', 'chat'])('publishes now from %s only through the mocked adapter and replays without a second post', async surface => inBusiness(async () => {
    await asset();
    const reviewed = await reviewedSource();
    const invoke = async () => {
      if (surface === 'http') {
        const res = response();
        await publishContentAsset(request({ targets: [facebook()] }, 'http-now-fixture'), res);
        expect(res.statusCode).toBe(200);
        return res.body;
      }
      return executePublishSocialPost({ ...reviewed, content_asset_id: 1, targets: [facebook()], idempotency_key: 'chat-now-fixture' }, { userId: tenant } as any);
    };
    expect(await invoke()).toEqual(expect.objectContaining({ success: true }));
    expect((await state()).status).toBe('published');
    expect((await attempts())[0].status).toBe('succeeded');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toEqual(expect.objectContaining({ message: 'Exact reviewed copy', credentialId: 11 }));
    expect(await invoke()).toEqual(expect.objectContaining({ success: true }));
    expect(publish).toHaveBeenCalledTimes(1);
  }));

  it('uses the same atomic schedule lifecycle from HTTP and campaign chat', async () => inBusiness(async () => {
    await asset();
    const first = future();
    const res = response();
    await publishContentAsset(request({ targets: [facebook()], scheduledFor: first, timezone: 'Asia/Kolkata' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, scheduled: true }));
    const second = new Date(Date.now() + 7_200_000).toISOString();
    const result = await executePublishSocialPost({ ...await reviewedSource(), content_asset_id: 1, targets: [facebook()], scheduled_for: second, idempotency_key: 'chat-fixture' }, { userId: tenant, widgetId: 'fixture' } as any);
    expect(result).toEqual(expect.objectContaining({ success: true, output: expect.objectContaining({ status: 'scheduled', scheduled: true }) }));
    expect((await attempts()).map(row => row.status)).toEqual(['cancelled', 'pending']);
    expect((await state()).scheduled_publish_at.toISOString()).toBe(second);
    expect(publish).not.toHaveBeenCalled();
  }));
  it('never reports a chat schedule receipt when every preflight failed', async () => inBusiness(async () => {
    await asset();
    const result = await executePublishSocialPost({ ...await reviewedSource(), content_asset_id: 1, targets: [{ platform: 'instagram', credentialId: 12, postType: 'post' }], scheduled_for: future(), idempotency_key: 'chat-invalid' }, { userId: tenant } as any);
    expect(result.success).toBe(false);
    expect(result.output?.status).not.toBe('scheduled');
    expect(await attempts()).toHaveLength(0);
  }));
  it('reports background retries as accepted rather than a completed failed chat action', async () => inBusiness(async () => {
    await asset();
    publish.mockResolvedValue({ success: false, retryable: true, error: 'Mock quota limit' });
    const result = await executePublishSocialPost({ ...await reviewedSource(), content_asset_id: 1, targets: [facebook()], idempotency_key: 'chat-retry' }, { userId: tenant } as any);
    expect(result.success).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({ accepted: true, status: 'pending' }));
    expect((await attempts())[0].status).toBe('retryable_failed');
  }));
  it('reports a partial chat publish without treating successful destinations as failed', async () => inBusiness(async () => {
    await asset();
    await pool.query("UPDATE content_assets SET image_url='https://media.example.test/fixture.png' WHERE id=1");
    publish.mockResolvedValueOnce({ success: true, platformPostId: 'PARTIAL_FB_POST' });
    publish.mockResolvedValueOnce({ success: false, retryable: false, error: 'Instagram rejected the fixture' });
    const result = await executePublishSocialPost({ ...await reviewedSource(), content_asset_id: 1, targets: [
      { ...facebook(), postType: 'photo' }, { platform: 'instagram', credentialId: 12, postType: 'post', caption: 'Reviewed copy' },
    ], idempotency_key: 'chat-partial' }, { userId: tenant } as any);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toMatchObject({ partialSuccess: true, status: 'partial_success' });
    expect((result.output?.results as any).facebook).toMatchObject({ success: true, assetId: 1 });
    expect((result.output?.results as any).instagram.success).toBe(false);
  }));
  it('rejects direct publication-state edits before changing the asset', async () => inBusiness(async () => {
    await asset();
    for (const body of [{ status: 'processing' }, { scheduledPublishAt: future() }, { metadata: { mediaProbe: { width: 1 } } }]) {
      const res = response();
      await updateContentAsset(request(body), res);
      expect(res.statusCode).toBe(400);
    }
    expect((await state()).status).toBe('draft');
  }));
  it('checks template ownership and current immutable source version on manual creation', async () => inBusiness(async () => {
    await pool.query("INSERT INTO content_templates(id,user_id,business_profile_id,name,type,content,version) VALUES(21,$1,99,'Mine','social','Original',3),(22,$2,199,'Other','social','Other',1)", [tenant, tenant + 1]);
    const body = { type: 'social_post', title: 'Manual content', content: 'Reviewed copy', channel: 'facebook', status: 'ready', sourceTemplateId: 21, sourceTemplateVersion: 3 };
    const foreign = response(); await createContentAsset(request({ ...body, sourceTemplateId: 22, sourceTemplateVersion: 1 }), foreign);
    expect(foreign.statusCode).toBe(404);
    const stale = response(); await createContentAsset(request({ ...body, sourceTemplateVersion: 2 }), stale);
    expect(stale.statusCode).toBe(409);
    const valid = response(); await createContentAsset(request(body), valid);
    expect(valid.statusCode).toBe(201);
    expect(valid.body).toEqual(expect.objectContaining({ sourceTemplateId: 21, sourceTemplateVersion: 3, userId: tenant }));
  }));

  it('rejects cross-business/tenant publication and raw writes before invoking any fake provider', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant,1,[facebook(future())],'scope-negative');
    const reviewedState = await state();
    const reviewedAttempts = await attempts();
    const role = await runtime.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role.rows).toEqual([{ role: 'salesmarketing_business_runtime', rolsuper: false, rolbypassrls: false }]);
    for (const scope of [{ userId: tenant, businessProfileId: 100 }, { userId: tenant+1, businessProfileId: 199 }]) {
      await withBusinessScope(scope, async () => {
        expect((await runtime.query('SELECT * FROM content_assets')).rows).toEqual([]);
        expect((await runtime.query('SELECT * FROM social_publish_attempts')).rows).toEqual([]);
        await expect(prepareOrganicPublishBatch(scope.userId,1,[facebook()],'foreign')).rejects.toMatchObject({ code: 'CONTENT_ASSET_NOT_FOUND' });
        await expect(executeOrganicPublishAttempt(entry.attempt.id,scope.userId,'foreign')).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
        expect((await runtime.query("UPDATE content_assets SET content='Unauthorized' WHERE id=1")).rowCount).toBe(0);
        await expect(runtime.query("INSERT INTO content_assets(user_id,business_profile_id,type,title,content,status) VALUES(991,99,'social_post','Unauthorized','','draft')"))
          .rejects.toThrow('row-level security');
      });
    }
    expect((await withAccountScope(()=>runtime.query('SELECT * FROM content_assets'))).rows).toEqual([]);
    expect(await state()).toEqual(reviewedState);
    expect(await attempts()).toEqual(reviewedAttempts);
    expect(publish).not.toHaveBeenCalled();
  }));

  it('preserves approved predefined global reads while excluding unapproved, private and quarantined templates', async () => inBusiness(async () => {
    await pool.query(`INSERT INTO content_templates(id,user_id,business_profile_id,name,type,content,is_predefined,is_approved)
      VALUES(21,991,99,'Private','social','Private',false,true),
        (23,NULL,NULL,'Approved global','social','Approved',true,true),
        (24,NULL,NULL,'Unapproved global','social','Unapproved',true,false),
        (25,NULL,NULL,'Not predefined','social','Private',false,true),
        (26,991,NULL,'Quarantined legacy','social','Legacy',true,true)`);
    expect((await runtime.query('SELECT id FROM content_templates ORDER BY id')).rows).toEqual([{ id: 21 },{ id: 23 }]);
    for (const scope of [{ userId: tenant, businessProfileId: 100 }, { userId: tenant+1, businessProfileId: 199 }]) {
      expect((await withBusinessScope(scope,()=>runtime.query('SELECT id FROM content_templates ORDER BY id'))).rows).toEqual([{ id: 23 }]);
    }
    expect((await withAccountScope(()=>runtime.query('SELECT id FROM content_templates ORDER BY id'))).rows).toEqual([{ id: 23 }]);
    expect(publish).not.toHaveBeenCalled();
  }));
  it('quarantines accepted responses without receipts and rejects retry or replay sends', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'missing-receipt');
    publish.mockResolvedValueOnce({ success: true });
    const uncertain = await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture');
    expect(uncertain.status).toBe('ambiguous');
    expect(publishAttemptCapabilities(uncertain).retry).toBe(false);
    await expect(recoverOrganicPublishAttempt(tenant, 1, uncertain.id, 'retry')).rejects.toMatchObject({ code: 'PUBLISH_RECOVERY_UNAVAILABLE' });
    const [replay] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'missing-receipt');
    expect((await executeOrganicPublishAttempt(replay.attempt.id, tenant, 'replay')).status).toBe('ambiguous');
    expect(publish).toHaveBeenCalledTimes(1);
  }));

  it('recovers local finalization failure using its known receipt without a second provider post', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'finalization-failure');
    const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
    const finalize = jest.spyOn(ContentAssetModel, 'markAsPublishedForUser').mockRejectedValueOnce(new Error('Synthetic local finalization outage'));
    try {
      expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture')).status).toBe('provider_succeeded');
    } finally { finalize.mockRestore(); }
    expect((await attempts())[0].provider_post_id).toBe('MOCK_ONLY_POST');
    expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'recovery')).status).toBe('succeeded');
    expect((await state()).status).toBe('published');
    expect(publish).toHaveBeenCalledTimes(1);
  }));

  it('quarantines an accepted post when recording its receipt fails, including worker redelivery', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'receipt-write-failure');
    const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
    const receipt = jest.spyOn(SocialPublishAttemptModel, 'markProviderSucceeded').mockRejectedValueOnce(new Error('Synthetic receipt write outage'));
    try {
      await expect(executeOrganicPublishAttempt(entry.attempt.id, tenant, 'fixture')).rejects.toThrow('Synthetic receipt write outage');
    } finally { receipt.mockRestore(); }
    expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'redelivery')).status).toBe('claimed');
    await pool.query("UPDATE social_publish_attempts SET lease_expires_at=NOW()-interval '1 second' WHERE id=$1", [entry.attempt.id]);
    expect(await SocialPublishAttemptModel.quarantineExpiredClaims()).toBe(1);
    expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'redelivery-after-expiry')).status).toBe('ambiguous');
    await expect(recoverOrganicPublishAttempt(tenant, 1, entry.attempt.id, 'retry')).rejects.toMatchObject({ code: 'PUBLISH_RECOVERY_UNAVAILABLE' });
    expect(publish).toHaveBeenCalledTimes(1);
  }));

  (process.env.PUBLICATION_REDIS_LOCAL_QA === '1' ? it : it.skip)('uses real Redis worker delivery and PostgreSQL claims for duplicate and cancelled jobs', async () => inBusiness(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.REDIS_HOST || '') || !process.env.REDIS_PORT) throw new Error('Publication Redis QA requires an explicit local fixture');
    const { Queue, QueueEvents, Worker } = await import('bullmq');
    const connection = { host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT), maxRetriesPerRequest: null };
    const name = `organic-audit-${randomBytes(8).toString('hex')}`;
    publicationQueue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    await events.waitUntilReady();
    let worker: { close(): Promise<void> } | undefined;
    try {
      await asset();
      const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook()], 'redis-delivery');
      const { enqueueOrganicPublishAttempt, processOrganicPublishJob } = await import('../services/social/OrganicPublishQueue.js');
      const firstId = await enqueueOrganicPublishAttempt(entry.attempt);
      expect(await enqueueOrganicPublishAttempt(entry.attempt)).toBe(firstId);
      expect(await publicationQueue.getWaitingCount()).toBe(1);
      const duplicate = await publicationQueue.add('redelivery', { ...entry.attempt.reviewedPayload.publicationOrigin, userId: tenant, attemptId: entry.attempt.id });
      const original = await publicationQueue.getJob(firstId);
      worker = new Worker<{ userId: number; attemptId: number }>(name, job => inBusiness(() => processOrganicPublishJob(job.data, `fixture-${job.id}`)), { connection, concurrency: 4 });
      await Promise.all([original!.waitUntilFinished(events, 10000), duplicate.waitUntilFinished(events, 10000)]);
      expect(publish).toHaveBeenCalledTimes(1);
      expect((await attempts())[0].status).toBe('succeeded');
      await asset(2);
      const [cancelled] = await prepareOrganicPublishBatch(tenant, 2, [facebook(future())], 'redis-cancelled');
      await changeOrganicPublishSchedule(tenant, [2]);
      const stale = await publicationQueue.add('stale-cancelled', { userId: tenant, attemptId: cancelled.attempt.id });
      await stale.waitUntilFinished(events, 10000);
      expect(publish).toHaveBeenCalledTimes(1);
      expect((await state(2)).status).toBe('cancelled');
    } finally {
      await worker?.close(); await events.close();
      await publicationQueue.obliterate({ force: true }); await publicationQueue.close();
      publicationQueue = undefined;
    }
  }), 20000);

  it('blocks asset retirement until cancellation and ignores delivery after retirement', async () => inBusiness(async () => {
    await asset();
    const [entry] = await prepareOrganicPublishBatch(tenant, 1, [facebook(future())], 'retirement');
    const { deleteEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
    await expect(deleteEditableContentAsset(tenant, 1)).rejects.toMatchObject({ code: 'CONTENT_PUBLISHING_IMMUTABLE' });
    await changeOrganicPublishSchedule(tenant, [1]);
    await deleteEditableContentAsset(tenant, 1);
    expect(await state()).toBeUndefined();
    expect((await executeOrganicPublishAttempt(entry.attempt.id, tenant, 'stale-retired-worker')).status).toBe('cancelled');
    expect(publish).not.toHaveBeenCalled();
  }));

  it('rejects a stale browser source version before creating an attempt or sending', async () => inBusiness(async () => {
    await asset();
    await pool.query("UPDATE content_assets SET version=2,content='Changed after review' WHERE id=1");
    const res = response();
    await publishContentAsset(request({ expectedVersion: 1, expectedReviewToken: 'old-reviewed-source', targets: [facebook()] }, 'stale-browser'), res);
    expect(res.statusCode).toBe(409);
    expect(await attempts()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  }));
  it('requires a source review for new HTTP publication instead of approving unseen latest media', async () => inBusiness(async () => {
    await asset();
    const res = response();
    await publishContentAsset(request({ expectedVersion: undefined, expectedReviewToken: undefined, targets: [facebook()] }, 'missing-browser-review'), res);
    expect(res.statusCode).toBe(400);
    expect(await attempts()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  }));

  it('binds a browser review to media even when the parent version does not change', async () => inBusiness(async () => {
    await asset();
    await asset(2, 'image');
    await pool.query("UPDATE content_assets SET parent_asset_id=1,image_url='https://media.example.test/reviewed.jpg' WHERE id=2");
    const loaded = response(); await getContentAsset(request({}), loaded);
    expect(loaded.body.publishingReviewToken).toEqual(expect.any(String));
    await pool.query("UPDATE content_assets SET image_url='https://media.example.test/unreviewed.jpg' WHERE id=2");
    const res = response();
    await publishContentAsset(request({ expectedVersion: loaded.body.version, expectedReviewToken: loaded.body.publishingReviewToken, targets: [{ ...facebook(), postType: 'photo' }] }, 'changed-media'), res);
    expect(res.statusCode).toBe(409); expect(await attempts()).toHaveLength(0); expect(publish).not.toHaveBeenCalled();
  }));
  it('binds reviewed copy even when an internal write leaves the source version unchanged', async () => inBusiness(async () => {
    await asset();
    const loaded = response(); await getContentAsset(request({}), loaded);
    await pool.query("UPDATE content_assets SET content='Unreviewed internal copy',title='Changed title' WHERE id=1");
    const res = response();
    await publishContentAsset(request({ expectedVersion: loaded.body.version, expectedReviewToken: loaded.body.publishingReviewToken, targets: [facebook()] }, 'changed-copy'), res);
    expect(res.statusCode).toBe(409); expect(await attempts()).toHaveLength(0); expect(publish).not.toHaveBeenCalled();
  }));
  it('replays the accepted review after the source advances without sending again', async () => inBusiness(async () => {
    await asset();
    const res = response(); await publishContentAsset(request({ targets: [facebook()] }, 'bound-replay'), res);
    expect(res.statusCode).toBe(200);
    const reloaded = response(); await getContentAsset(request({}), reloaded);
    expect(reloaded.body.publishingReviewToken).not.toBe(shownReview.expectedReviewToken);
    expect((await attempts())[0].reviewed_payload).toMatchObject({ sourceAssetVersion: 1, sourceReviewToken: shownReview.expectedReviewToken });
    await pool.query("UPDATE content_assets SET version=version+1 WHERE id=1");
    const replay = response(); await publishContentAsset(request({ targets: [facebook()] }, 'bound-replay'), replay);
    expect(replay.statusCode).toBe(200); expect(publish).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1);
  }));

  it('round-trips source review, stale rejection and replay through real local HTTP and SQL', async () => inBusiness(async () => {
    await asset();
    const { default: express } = await import('express');
    const { default: http } = await import('supertest');
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.get('x-fixture-user') === '992' ? 992 : 991;
      req.user = { id } as any;
      withBusinessScope({ userId: id, businessProfileId: id === 991 ? 99 : 199 }, next);
    });
    app.get('/api/content/assets/:assetId', getContentAsset);
    app.post('/api/content/assets/:assetId/publish', publishContentAsset);
    const old = await http(app).get('/api/content/assets/1');
    expect(old.status).toBe(200);
    const body = { expectedVersion: old.body.version, expectedReviewToken: old.body.publishingReviewToken, targets: [facebook()] };
    await pool.query('UPDATE content_assets SET version=2 WHERE id=1');
    expect((await http(app).post('/api/content/assets/1/publish').set('Idempotency-Key', 'http-review').send(body)).status).toBe(409);
    expect(publish).not.toHaveBeenCalled();
    const fresh = await http(app).get('/api/content/assets/1');
    const reviewed = { ...body, expectedVersion: fresh.body.version, expectedReviewToken: fresh.body.publishingReviewToken };
    expect((await http(app).post('/api/content/assets/1/publish').set('Idempotency-Key', 'http-review').send(reviewed)).status).toBe(200);
    expect((await http(app).post('/api/content/assets/1/publish').set('Idempotency-Key', 'http-review').send(reviewed)).status).toBe(200);
    expect((await http(app).get('/api/content/assets/1').set('x-fixture-user', '992')).status).toBe(404);
    expect(publish).toHaveBeenCalledTimes(1);
  }));

});
