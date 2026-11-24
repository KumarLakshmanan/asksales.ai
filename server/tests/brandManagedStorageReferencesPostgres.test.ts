import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { ManagedStorageTransaction } from '../services/managedStorageReferences.js';
import express from 'express';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const database = process.env.BRAND_CALENDAR_TEST_DATABASE;
const suite = database ? describe : describe.skip;
let admin: Pool, pool: Pool, server: Server, base: string;
const databaseProxy = new Proxy({}, { get: (_target, key) => Reflect.get(drizzle(pool), key) });
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const changeSchedule = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ affected: 1 });
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({
  changeOrganicPublishSchedule: changeSchedule, publishAttemptCapabilities: () => ({}),
}));
jest.unstable_mockModule('../controllers/contentEstimateController.js', () => ({getContentEstimate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentStudioController.js', () => ({generateContentPlan: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateAdCopy: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateContent: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateCreatives: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentPlans: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateOutreachCopy: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateMetaPrompt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generatePromptVariations: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getMediaStatus: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateEmail: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateSMS: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateSocial: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateSocialMessage: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateAdCopyContent: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateMagicPrompt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateBlogPost: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),enhancePrompt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getGenerationStatus: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateEmailHtmlTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateImage: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateVideo: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),startVideoGeneration: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),checkVideoStatus: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentTemplatesController.js', () => ({getContentTemplates: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentTemplateById: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),createContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),updateContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),deleteContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),useTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getMostUsedTemplates: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentTemplateCounts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),duplicateContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getPredefinedTemplates: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),importPredefinedTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentTemplateVersions: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),approveContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentAssetController.js', () => ({getContentAssets: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),createContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),updateContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),deleteContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),uploadContentMedia: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),uploadMediaMiddleware: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),publishContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getOrganicPublishingAccounts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),rescheduleContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),cancelContentAssetSchedule: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),recoverContentAssetPublishAttempt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentAssetPublishAttempts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),unpublishContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentAssetCounts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentAssetPreviewController.js', () => ({getContentAssetPreviews: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),createContentAssetPreview: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),updateContentAssetPreview: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
await import('../middleware/auth.js');
await import('../middleware/platformAccess.js');
const { generateToken } = await import('../utils/jwt.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');
await import('../middleware/validation.js');
await import('../middleware/schemas.js');
await import('../controllers/brandToolkitController.js');
await import('../controllers/contentCalendarController.js');
const { objectStorage } = await import('../services/ObjectStorageService.js');
const { StorageService } = await import('../services/StorageService.js');
const { lockManagedStorageReferences, syncManagedStorageOwners, releaseManagedStorageOwners } = await import('../services/managedStorageReferences.js');
const { collectContentManagedReferenceUrls } = await import('../utils/contentManagedReferences.js');
const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
const { contentTemplatesTable, contentTemplateVersionsTable } = await import('../models/contentTemplates/schema.js');
const { BrandToolkitModel, stageBrandToolkitDeletionForBusinessInTransaction } = await import('../models/brandToolkits/functions.js');
let fetchGuard: ReturnType<typeof jest.spyOn>;
let owner: number, member: number, other: number, north: number, south: number, _foreign: number;
let ownerToken: string, _memberToken: string, otherToken: string;


async function request(path: string, method = 'GET', body?: unknown, profile = north, token = ownerToken, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/content${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Business-Profile-Id': String(profile), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? {} : await response.json() as Record<string, any> };
}
suite('BC-S02 Brand durable writers: real HTTP, scoped PostgreSQL and local objects', () => {
  jest.setTimeout(20000);
  beforeAll(async () => {
    if (!database?.startsWith('asksales_brand_calendar_audit') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '5546' || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '6396' || process.env.STORAGE_BACKEND !== 'local' || !process.env.LOCAL_STORAGE_PATH?.startsWith('/tmp/asksales-brand-calendar-')) throw new Error('Only disposable local audit infrastructure is allowed');
    const config = { host: '127.0.0.1', port: 5546, user: 'postgres', database };
    admin = new Pool({ ...config, max: 2 });
    pool = createBusinessScopedPool(new Pool({ ...config, max: 8 }));
    await assertBusinessScopeSchema(admin);
    const suffix = randomUUID();
    const users = await admin.query("INSERT INTO users(email,password,name,is_verified,is_approved,is_setup_complete) VALUES($1,'fixture','Owner',true,true,true),($2,'fixture','Member',true,true,true),($3,'fixture','Other',true,true,true) RETURNING id", [`owner-${suffix}@example.invalid`, `member-${suffix}@example.invalid`, `other-${suffix}@example.invalid`]);
    [owner, member, other] = users.rows.map(row => row.id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,name,is_default,is_approved) VALUES($1,'North',true,true),($1,'South',false,true),($2,'Foreign',true,true) RETURNING id", [owner, other]);
    [north, south, _foreign] = profiles.rows.map(row => row.id);
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')", [north, member, `member-${suffix}@example.invalid`]);
    ownerToken = generateToken({ userId: owner, email: `owner-${suffix}@example.invalid` });
    _memberToken = generateToken({ userId: member, email: `member-${suffix}@example.invalid` });
    otherToken = generateToken({ userId: other, email: `other-${suffix}@example.invalid` });
    const app = express(); app.use(express.json());
    app.use('/api/content', (await import('../routes/content.routes.js')).default);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const actualFetch = globalThis.fetch;
    fetchGuard = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${base}/`)) throw new Error('External network calls are forbidden in the brand/calendar fixture');
      return actualFetch(input, init);
    });
    const created = await request('/brand-toolkits', 'POST', { name: 'Audit brand' });
    expect(created.status).toBe(201);
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    SmartThrottlingService.getInstance().destroy();
    await closeRedisConnections();
    fetchGuard?.mockRestore();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });

  const scoped = <T>(work: () => T) => withBusinessScope({ userId: owner, businessProfileId: north }, work);

  async function logoForm(version: number) {
    const buffer = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#33669980' } }).png().toBuffer();
    const form = new FormData();
    form.append('logo', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), 'synthetic-reference.png');
    form.append('expectedVersion', String(version));
    return form;
  }

  async function assertRetainedBytes(url: string) {
    const retained = await withBusinessScope({ userId: owner, businessProfileId: north }, () => StorageService.getInstance().downloadByUrl(url, owner));
    expect(retained).not.toBeNull();
    expect(retained!.buffer.length).toBeGreaterThan(0);
    expect(await objectStorage.exists(retained!.file.storageKey)).toBe(true);
  }

  it('deleting toolkit A preserves the same managed logo still held by toolkit B', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Shared source ' + randomUUID() });
    expect(first.status).toBe(201);
    const upload = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(upload.status).toBe(200);
    const url = upload.body.url as string;
    const second = await request('/brand-toolkits', 'POST', { name: 'Retaining toolkit ' + randomUUID(), logoUrl: url, logoUrls: [url] });
    expect(second.status).toBe(201);
    await assertRetainedBytes(url);
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE')).status).toBe(204);
    const retained = await request(`/brand-toolkits/${second.body.id}`);
    expect(retained.status).toBe(200);
    expect(retained.body.logoUrls).toContain(url);
    await assertRetainedBytes(url);
  });

  it('failed logo attachment compensation preserves a concurrent toolkit holder', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'CAS source ' + randomUUID() });
    expect(first.status).toBe(201);
    const service = StorageService.getInstance(), originalUpload = service.upload.bind(service);
    let release!: () => void;
    let captured!: (url: string) => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const uploaded = new Promise<string>(resolve => { captured = resolve; });
    const delay = jest.spyOn(service, 'upload').mockImplementationOnce(async (...args) => {
      const result = await originalUpload(...args);
      captured(result.url);
      await pending;
      return result;
    });
    let attaching: Promise<Awaited<ReturnType<typeof request>>> | undefined;
    try {
      const form = await logoForm(first.body.version);
      attaching = request(`/brand-toolkits/${first.body.id}/logo`, 'POST', form);
      const url = await uploaded;
      const second = await request('/brand-toolkits', 'POST', { name: 'Concurrent holder ' + randomUUID(), logoUrl: url, logoUrls: [url] });
      expect(second.status).toBe(201);
      const changed = await request(`/brand-toolkits/${first.body.id}`, 'PUT', { name: 'Concurrent edit', expectedVersion: first.body.version });
      expect(changed.status).toBe(200);
      release();
      expect((await attaching).status).toBe(409);
      const retained = await request(`/brand-toolkits/${second.body.id}`);
      expect(retained.status).toBe(200);
      expect(retained.body.logoUrls).toContain(url);
      await assertRetainedBytes(url);
    } finally {
      release?.();
      if (attaching) await attaching;
      delay.mockRestore();
    }
  });

  it('rolls back media replacement on deferred commit failure', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Rollback source ' + randomUUID() });
    expect(first.status).toBe(201);
    const uploaded = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(uploaded.status).toBe(200);
    const staged = await request('/brand-toolkits/upload-logo', 'POST', await logoForm(1));
    expect(staged.status).toBe(200);
    const functionName = 'brand_ref_rollback_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const marker = 'RollbackMarker' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=${first.body.id} AND NEW.name='${marker}' THEN RAISE EXCEPTION 'synthetic deferred commit failure'; END IF;
      RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER ${functionName} AFTER UPDATE ON brand_toolkits DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const failed = await request(`/brand-toolkits/${first.body.id}`, 'PUT', {
        name: marker, logoUrl: staged.body.url, logoUrls: [staged.body.url], expectedVersion: uploaded.body.toolkit.version,
      });
      expect(failed.status).toBe(500);
      const retained = await request(`/brand-toolkits/${first.body.id}`);
      expect(retained.body.version).toBe(uploaded.body.toolkit.version);
      expect(retained.body.logoUrl).toBe(uploaded.body.url);
      expect(retained.body.logoUrls).toContain(uploaded.body.url);
      await assertRetainedBytes(uploaded.body.url);
      await assertRetainedBytes(staged.body.url);
    } finally {
      await admin.query(`DROP TRIGGER ${functionName} ON brand_toolkits; DROP FUNCTION ${functionName}()`);
    }
    const retry = await request(`/brand-toolkits/${first.body.id}`, 'PUT', { name: 'Verified rollback retry', expectedVersion: uploaded.body.toolkit.version });
    expect(retry.status).toBe(200);
    expect(retry.body.version).toBe(uploaded.body.toolkit.version + 1);
  });

  it('concurrent attach versus last-holder delete never commits a reference to reclaimed bytes', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Last holder ' + randomUUID() });
    const target = await request('/brand-toolkits', 'POST', { name: 'Attaching target ' + randomUUID() });
    expect(first.status).toBe(201); expect(target.status).toBe(201);
    const uploaded = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(uploaded.status).toBe(200);
    const [deleted, attaching] = await Promise.all([
      request(`/brand-toolkits/${first.body.id}`, 'DELETE'),
      request(`/brand-toolkits/${target.body.id}`, 'PUT', { logoUrl: uploaded.body.url, logoUrls: [uploaded.body.url], expectedVersion: target.body.version }),
    ]);
    expect(deleted.status).toBe(204);
    const retained = await request(`/brand-toolkits/${target.body.id}`);
    expect(retained.status).toBe(200);
    const committed = (retained.body.logoUrls || []).includes(uploaded.body.url);
    expect(attaching.status === 200).toBe(committed);
    if (committed) await assertRetainedBytes(uploaded.body.url);
  });

  it('concurrent releases/deletes preserve a third toolkit holder', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Concurrent source ' + randomUUID() });
    expect(first.status).toBe(201);
    const uploaded = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(uploaded.status).toBe(200);
    const second = await request('/brand-toolkits', 'POST', { name: 'Concurrent releaser ' + randomUUID(), logoUrl: uploaded.body.url, logoUrls: [uploaded.body.url] });
    const third = await request('/brand-toolkits', 'POST', { name: 'Surviving holder ' + randomUUID(), logoUrl: uploaded.body.url, logoUrls: [uploaded.body.url] });
    expect(second.status).toBe(201); expect(third.status).toBe(201);
    const released = await Promise.all([
      request(`/brand-toolkits/${first.body.id}`, 'DELETE'),
      request(`/brand-toolkits/${second.body.id}`, 'DELETE'),
    ]);
    expect(released.map(result => result.status)).toEqual([204, 204]);
    const retained = await request(`/brand-toolkits/${third.body.id}`);
    expect(retained.status).toBe(200);
    expect(retained.body.logoUrls).toContain(uploaded.body.url);
    await assertRetainedBytes(uploaded.body.url);
  });

  it('reclaims the final Brand-only object after commit and does not double-release accounting', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Final holder ' + randomUUID() });
    const uploaded = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(uploaded.status).toBe(200);
    const file = (await admin.query('SELECT id,storage_key FROM storage_files WHERE url=$1 AND user_id=$2', [uploaded.body.url, owner])).rows[0];
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE')).status).toBe(204);
    expect(await objectStorage.exists(file.storage_key)).toBe(false);
    const quota = (await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows;
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE')).status).toBe(404);
    expect((await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows).toEqual(quota);
    expect((await admin.query('SELECT is_deleted FROM storage_files WHERE id=$1', [file.id])).rows[0].is_deleted).toBe(true);
    expect((await admin.query('SELECT 1 FROM storage_managed_references WHERE storage_file_id=$1', [file.id])).rows).toEqual([]);
  });

  it('compensation-first rejects late registration of the deleted exact revision', async () => {
    const staged = await request('/brand-toolkits/upload-logo', 'POST', await logoForm(1));
    expect(staged.status).toBe(200);
    const file = (await admin.query('SELECT id FROM storage_files WHERE url=$1 AND user_id=$2', [staged.body.url, owner])).rows[0];
    const deleted = await scoped(() => StorageService.getInstance().compensateFailedUpload({ userId: owner, businessProfileId: north }, file.id));
    expect(deleted).toBe(true);
    const late = await request('/brand-toolkits', 'POST', { name: 'Late registration ' + randomUUID(), logoUrl: staged.body.url, logoUrls: [staged.body.url] });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('STORAGE_REFERENCE_CONFLICT');
    expect(await scoped(() => StorageService.getInstance().compensateFailedUpload({ userId: owner, businessProfileId: north }, file.id))).toBe(false);
  });

  it('retains a committed cleanup intent on physical IO failure and retries without another quota release', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Cleanup retry ' + randomUUID() });
    const uploaded = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(uploaded.status).toBe(200);
    const file = (await admin.query('SELECT id,storage_key FROM storage_files WHERE url=$1 AND user_id=$2', [uploaded.body.url, owner])).rows[0];
    const failure = jest.spyOn(objectStorage, 'delete').mockRejectedValueOnce(new Error('Synthetic local IO failure'));
    try { expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE')).status).toBe(204); }
    finally { failure.mockRestore(); }
    expect(await objectStorage.exists(file.storage_key)).toBe(true);
    const stored = (await admin.query('SELECT is_deleted,metadata FROM storage_files WHERE id=$1', [file.id])).rows[0];
    expect(stored.is_deleted).toBe(true); expect(stored.metadata.pendingCleanupKeys).toContain(file.storage_key);
    const quota = (await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows;
    expect(await scoped(() => StorageService.getInstance().flushManagedStorageCleanup({ userId: owner, businessProfileId: north }, [file.id]))).toEqual({ processed: 1, remaining: 0 });
    expect(await objectStorage.exists(file.storage_key)).toBe(false);
    expect((await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows).toEqual(quota);
  });

  it('tracks every Brand media field once and preserves creation replay against the current row', async () => {
    const urls: string[] = [];
    for (let index = 0; index < 6; index++) {
      const uploaded = await request('/brand-toolkits/upload-logo', 'POST', await logoForm(1));
      expect(uploaded.status).toBe(200); urls.push(uploaded.body.url);
    }
    const key = randomUUID(), payload = { name: 'Full reference set ' + randomUUID(), idempotencyKey: key,
      logoUrl: urls[0], logoUrls: [urls[0], urls[1]], imageAssets: [{ url: urls[2], originalUrl: urls[3], thumbnailUrl: urls[4] }], websiteScreenshotUrl: urls[5] };
    const first = await request('/brand-toolkits', 'POST', payload);
    expect(first.status).toBe(201);
    const edges = () => admin.query("SELECT storage_file_id FROM storage_managed_references WHERE reference_type='brand_toolkit' AND reference_id=$1 AND user_id=$2", [String(first.body.id), owner]);
    expect((await edges()).rows).toHaveLength(6);
    const changed = await request(`/brand-toolkits/${first.body.id}`, 'PUT', { logoUrl: urls[1], logoUrls: [urls[1]], expectedVersion: first.body.version });
    expect(changed.status).toBe(200);
    expect((await edges()).rows).toHaveLength(5);
    const replay = await request('/brand-toolkits', 'POST', payload);
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.version).toBe(changed.body.version);
    expect(replay.body.logoUrls).toEqual([urls[1]]);
    expect((await edges()).rows).toHaveLength(5);
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE')).status).toBe(204);
    for (const url of urls) {
      const file = (await admin.query('SELECT storage_key,is_deleted FROM storage_files WHERE url=$1 AND user_id=$2', [url, owner])).rows[0];
      expect(file.is_deleted).toBe(true); expect(await objectStorage.exists(file.storage_key)).toBe(false);
    }
  });

  it('preserves frozen Content asset and version holders with the published Content projector', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Frozen holder source ' + randomUUID() });
    const uploaded = await request(`/brand-toolkits/${first.body.id}/logo`, 'POST', await logoForm(first.body.version));
    expect(uploaded.status).toBe(200);
    const snapshot = { brandToolkit: uploaded.body.toolkit };
    const saved = await scoped(() => drizzle(pool).transaction(async tx => {
      await lockManagedStorageReferences(tx, { userId: owner, businessProfileId: north });
      const [asset] = await tx.insert(contentAssetsTable).values({ userId: owner, businessProfileId: north, brandToolkitId: first.body.id,
        type: 'social_post', channel: 'instagram', title: 'Synthetic frozen asset', content: 'Synthetic frozen copy', status: 'draft', brandContextSnapshot: snapshot }).returning();
      const [template] = await tx.insert(contentTemplatesTable).values({ userId: owner, businessProfileId: north, brandToolkitId: first.body.id,
        name: 'Synthetic frozen template', type: 'social', content: 'Synthetic', brandContextSnapshot: snapshot }).returning();
      const [version] = await tx.insert(contentTemplateVersionsTable).values({ userId: owner, businessProfileId: north, templateId: template.id,
        version: 317, snapshot: { brandContextSnapshot: snapshot }, createdBy: owner }).returning();
      await syncManagedStorageOwners(tx, { entries: [
        { owner: { kind: 'content_asset', id: String(asset.id), userId: owner, businessProfileId: north }, urls: collectContentManagedReferenceUrls(asset) },
        { owner: { kind: 'content_template', id: String(template.id), userId: owner, businessProfileId: north }, urls: collectContentManagedReferenceUrls(template) },
        { owner: { kind: 'content_template_version', id: String(version.id), userId: owner, businessProfileId: north }, urls: collectContentManagedReferenceUrls(version.snapshot) },
      ] });
      return { asset, template, version };
    }));
    expect(String(saved.version.id)).not.toBe('317');
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE')).status).toBe(204);
    await assertRetainedBytes(uploaded.body.url);
    expect((await admin.query("SELECT r.reference_type FROM storage_managed_references r JOIN storage_files f ON f.id=r.storage_file_id WHERE f.url=$1 AND r.user_id=$2 ORDER BY r.reference_type", [uploaded.body.url, owner])).rows.map(row => row.reference_type)).toEqual(['content_asset', 'content_template', 'content_template_version']);
    expect((await admin.query('SELECT brand_context_snapshot FROM content_assets WHERE id=$1', [saved.asset.id])).rows[0].brand_context_snapshot.brandToolkit.logoUrl).toBe(uploaded.body.url);
  });

  it('rejects foreign private IDs and unauthorized mutation without minting cross-business holders', async () => {
    const first = await request('/brand-toolkits', 'POST', { name: 'Authority fixture ' + randomUUID() });
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE', undefined, north, '')).status).toBe(401);
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE', undefined, north, otherToken)).status).toBe(403);
    expect((await request(`/brand-toolkits/${first.body.id}`, 'DELETE', undefined, south)).status).toBe(404);
    const staged = await request('/brand-toolkits/upload-logo', 'POST', await logoForm(1), south);
    expect(staged.status).toBe(200);
    const file = (await admin.query('SELECT id FROM storage_files WHERE url=$1 AND business_profile_id=$2', [staged.body.url, south])).rows[0];
    const refused = await request('/brand-toolkits', 'POST', { name: 'Forbidden private reference', logoUrl: `/api/settings/storage/files/${file.id}/download` });
    expect(refused.status).toBe(409);
    const unresolved = await request('/brand-toolkits', 'POST', { name: 'Unresolved public compatibility', logoUrl: staged.body.url });
    expect(unresolved.status).toBe(201);
    expect((await admin.query("SELECT 1 FROM storage_managed_references WHERE reference_type='brand_toolkit' AND reference_id=$1 AND user_id=$2", [String(unresolved.body.id), owner])).rows).toEqual([]);
    expect((await request(`/brand-toolkits/${unresolved.body.id}`, 'DELETE')).status).toBe(204);
    expect((await admin.query('SELECT is_deleted FROM storage_files WHERE id=$1', [file.id])).rows[0].is_deleted).toBe(false);
  });

  it('legacy Brand writers register and release their own references without changing approval/version semantics', async () => {
    const staged = await request('/brand-toolkits/upload-logo', 'POST', await logoForm(1));
    expect(staged.status).toBe(200);
    const row = await scoped(() => BrandToolkitModel.create({ userId: owner, name: 'Legacy source', logoUrl: staged.body.url, logoUrls: [staged.body.url] }));
    const updated = await scoped(() => BrandToolkitModel.update(row.id, { tagline: 'Legacy edit', isApproved: false }));
    expect(updated?.version).toBe(row.version); expect(updated?.isApproved).toBe(false);
    await assertRetainedBytes(staged.body.url);
    await scoped(() => BrandToolkitModel.delete(row.id));
    expect((await admin.query('SELECT is_deleted FROM storage_files WHERE url=$1 AND user_id=$2', [staged.body.url, owner])).rows[0].is_deleted).toBe(true);
  });

  it('rolls back actual migration enrollment of a genuinely legacy Brand row, then repairs it through the production writer', async () => {
    const staged = await request('/brand-toolkits/upload-logo', 'POST', await logoForm(1));
    expect(staged.status).toBe(200);
    const row = (await scoped(() => drizzle(pool).execute(sql`INSERT INTO brand_toolkits(user_id,business_profile_id,name,logo_url) VALUES(${owner},${north},'Synthetic legacy enrollment',${staged.body.url}) RETURNING id`))).rows[0];
    const count = async () => Number((await admin.query('SELECT count(*) AS count FROM storage_managed_references WHERE user_id=$1', [owner])).rows[0].count);
    const before = await count();
    const migrationPath = '../migrations/' + '480_storage_managed_references.js';
    const migration: { up(client: PoolClient): Promise<void> } = await import(migrationPath);
    const client = await admin.connect();
    try {
      await client.query('BEGIN'); await migration.up(client);
      expect(Number((await client.query('SELECT count(*) AS count FROM storage_managed_references WHERE user_id=$1', [owner])).rows[0].count)).toBeGreaterThan(before);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await count()).toBe(before);
    await scoped(() => BrandToolkitModel.update(Number(row.id), { tagline: 'Verified legacy enrollment retry' }));
    expect(await count()).toBe(before + 1);
    await assertRetainedBytes(staged.body.url);
    await scoped(() => BrandToolkitModel.delete(Number(row.id)));
  });

  it('refuses a real nontransactional executor before deleting any Brand domain rows', async () => {
    const before = (await admin.query('SELECT id FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 ORDER BY id', [owner, north])).rows;
    await expect(scoped(() => stageBrandToolkitDeletionForBusinessInTransaction(drizzle(pool) as unknown as ManagedStorageTransaction, north))).rejects.toThrow('requires the caller transaction');
    expect((await admin.query('SELECT id FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 ORDER BY id', [owner, north])).rows).toEqual(before);
  });

  it('staged business deletion rolls back domain rows and keeps holders until the caller final batch', async () => {
    const before = (await admin.query('SELECT id FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2', [owner, north])).rows;
    await expect(scoped(() => drizzle(pool).transaction(async tx => {
      await lockManagedStorageReferences(tx, { userId: owner, businessProfileId: north });
      const plan = await stageBrandToolkitDeletionForBusinessInTransaction(tx, north);
      expect(plan.deletedCount).toBe(before.length);
      expect(plan.owners.every(holder => holder.kind === 'brand_toolkit')).toBe(true);
      expect((await tx.execute(sql`SELECT 1 FROM brand_toolkits WHERE user_id=${owner} AND business_profile_id=${north}`)).rows).toEqual([]);
      throw new Error('Synthetic caller rollback');
    }))).rejects.toThrow('Synthetic caller rollback');
    expect((await admin.query('SELECT id FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 ORDER BY id', [owner, north])).rows).toEqual(before.sort((a, b) => a.id - b.id));
  });

  it('Data staging takes no object locks, permits remaining domain writes, and releases only Brand owners in one final batch', async () => {
    const scope = { userId: owner, businessProfileId: north };
    const change = await scoped(() => drizzle(pool).transaction(async tx => {
      await lockManagedStorageReferences(tx, scope);
      const plan = await stageBrandToolkitDeletionForBusinessInTransaction(tx, north);
      const held = await tx.execute(sql`SELECT r.storage_key,r.storage_backend FROM storage_managed_references r WHERE r.user_id=${owner} AND r.business_profile_id=${north} AND r.reference_type='brand_toolkit' ORDER BY r.storage_file_id LIMIT 1`);
      expect(held.rows.length).toBe(1);
      const probe = await admin.connect();
      try {
        await probe.query('BEGIN');
        const object = held.rows[0];
        const key = `${owner}:${object.storage_backend === 'aws' ? 's3' : object.storage_backend}:${object.storage_key}`;
        expect((await probe.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", ['storage-object:' + key])).rows[0].acquired).toBe(true);
      } finally { await probe.query('ROLLBACK'); probe.release(); }
      await tx.execute(sql`UPDATE company_settings SET updated_at=now() WHERE id=${north} AND user_id=${owner}`);
      return releaseManagedStorageOwners(tx, { owners: plan.owners, cleanupReleased: true });
    }));
    await scoped(() => StorageService.getInstance().flushManagedStorageCleanup(scope, change.cleanupFileIds));
    expect((await admin.query("SELECT 1 FROM storage_managed_references WHERE user_id=$1 AND business_profile_id=$2 AND reference_type='brand_toolkit'", [owner, north])).rows).toEqual([]);
    expect((await admin.query("SELECT 1 FROM storage_managed_references WHERE user_id=$1 AND business_profile_id=$2 AND reference_type='content_template_version'", [owner, north])).rows.length).toBeGreaterThan(0);
  });

});
