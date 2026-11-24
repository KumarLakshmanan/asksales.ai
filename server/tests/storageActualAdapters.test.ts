import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { get } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Only the database singleton is redirected. SQL, forced RLS, capacity functions,
// transactions, local object adapter, Redis commands and HTTP controllers are real.
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy({} as NodePgDatabase, {
    get(_target, key) {
      const value = database[key as keyof NodePgDatabase];
      return typeof value === 'function' ? value.bind(database) : value;
    },
  }),
}));

const local = process.env.STORAGE_ACTUAL_LOCAL_QA === '1' ? describe : describe.skip;
local('storage with actual scoped PostgreSQL, Redis and disposable local objects', () => {
  let admin: Pool, runtime: Pool, root: string, owner: number, profile: number, otherProfile: number;
  let service: typeof import('../services/StorageService.js')['storageService'];
  let objects: typeof import('../services/ObjectStorageService.js')['objectStorage'];
  let workspace: typeof import('../services/storageWorkspace.js');
  let capacity: typeof import('../services/billing/entitlements.js');
  let redisModule: typeof import('../infrastructure/redis.js');
  let app: express.Express;
  const duplicates: Redis[] = [];
  const scope = <T>(work: () => T, businessProfileId = profile) =>
    withBusinessScope({ userId: owner, businessProfileId, actorUserId: owner, role: 'owner' }, work);
  const upload = (text = 'synthetic content', extra = {}) => scope(() => service.upload(Buffer.from(text), {
    userId: owner, category: 'document', originalName: 'fixture.txt', mimeType: 'text/plain',
    referenceType: 'user_upload', ...extra,
  }));
  const mutate = (action: string, fileIds: number[], extra = {}) => scope(() => workspace.mutateWorkspace(owner,
    workspace.storageMutationSchema.parse({ action, fileIds, ...extra })));

  beforeAll(async () => {
    // Never load application .env files, accept a remote DSN, or reuse a database.
    const url = new URL(process.env.STORAGE_AUDIT_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/storage_audit(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
        process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '56483')
      throw new Error('Use the explicitly provisioned disposable storage audit database and Redis');
    admin = new Pool({ connectionString: url.href, max: 2 });
    runtime = createBusinessScopedPool(new Pool({ connectionString: url.href, max: 8 }));
    database = drizzle(runtime);
    const marker = await admin.query("SELECT name FROM js_migrations WHERE name='320_storage_workspace_indexes.js'");
    expect(marker.rowCount).toBe(1);
    root = await mkdtemp(join(tmpdir(), 'storage-actual-audit-'));
    process.env.LOCAL_STORAGE_PATH = root;
    process.env.STORAGE_BACKEND = 'local';
    process.env.DB_POOL_SIZE = '8';
    jest.spyOn(Redis.prototype, 'duplicate').mockImplementation(function (this: Redis, options) {
      const connection = new Redis({ ...this.options, ...options });
      duplicates.push(connection);
      return connection;
    });
    ({ storageService: service } = await import('../services/StorageService.js'));
    ({ objectStorage: objects } = await import('../services/ObjectStorageService.js'));
    workspace = await import('../services/storageWorkspace.js');
    capacity = await import('../services/billing/entitlements.js');
    redisModule = await import('../infrastructure/redis.js');
    const controllers = await import('../controllers/storageWorkspaceController.js');
    const legacy = await import('../controllers/storageController.js');
    const { businessProfileScope } = await import('../middleware/businessProfileScope.js');
    app = express();
    app.use(express.json());
    app.get(['/download-ticket', '/api/settings/storage/download-ticket'], controllers.redeemStorageDownload);
    app.use((req, _res, next) => {
      req.user = { id: owner, email: 'storage-fixture@example.invalid' };
      req.headers['x-business-profile-id'] = String(Number(req.headers['x-fixture-profile']) || profile);
      next();
    });
    app.use(businessProfileScope);
    app.post('/files', multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single('file'), legacy.uploadMyFile);
    app.post('/api/settings/storage/files', multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single('file'), legacy.uploadMyFile);
    app.get('/files/:fileId/content', controllers.streamStorageFile);
    app.get('/legacy/:fileId/download', legacy.downloadMyFile);
    app.get('/files/:fileId/thumbnail', controllers.getStorageThumbnail);
    app.get('/files', controllers.getStorageWorkspaceFiles);
    app.post('/download', controllers.createStorageDownload);
    app.post('/actions', controllers.changeStorageWorkspace);
    app.get('/api/settings/storage/workspace', controllers.getStorageWorkspace);
    app.get('/api/settings/storage/workspace/files', controllers.getStorageWorkspaceFiles);
    app.get('/api/settings/storage/workspace/files/:fileId', controllers.getStorageWorkspaceFile);
    app.get('/api/settings/storage/workspace/files/:fileId/content', controllers.streamStorageFile);
    app.get('/api/settings/storage/workspace/files/:fileId/thumbnail', controllers.getStorageThumbnail);
    app.get('/api/settings/storage/workspace/folders', controllers.getStorageActorFolders);
    app.get('/api/settings/storage/workspace/activity', controllers.getStorageActivity);
    app.post('/api/settings/storage/workspace/actions', controllers.changeStorageWorkspace);
    app.post('/api/settings/storage/workspace/download', controllers.createStorageDownload);
    app.get('/api/settings/storage/check-upload', legacy.checkUploadAllowed);
  }, 30000);

  beforeEach(async () => {
    const user = await admin.query("INSERT INTO users(email,name) VALUES($1,'Synthetic Storage Audit') RETURNING id", [`storage-${randomUUID()}@example.invalid`]);
    owner = Number(user.rows[0].id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,company_name) VALUES($1,'Synthetic Alpha'),($1,'Synthetic Beta') RETURNING id", [owner]);
    [profile, otherProfile] = profiles.rows.map(row => Number(row.id));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    for (const duplicate of duplicates) duplicate.disconnect();
    await redisModule?.closeRedisConnections();
    await runtime?.end();
    await admin?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('uses the unprivileged role and hides the same owner’s other business before opening bytes', async () => {
    const file = await upload();
    const identity = await scope(() => database.execute(sql`SELECT current_user AS role`));
    expect(identity.rows[0].role).toBe('salesmarketing_business_runtime');
    const open = jest.spyOn(objects, 'openReadStream');
    expect((await request(app).get(`/files/${file.fileId}/content`).set('x-fixture-profile', String(otherProfile))).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    const result = await request(app).get(`/files/${file.fileId}/content`).set('Range', 'bytes=0-8');
    expect(result.status).toBe(206);
    expect(result.text).toBe('synthetic');
  });

  it('streams the legacy private generated-file URL without buffering the entire object', async () => {
    const file = await upload('synthetic generated output', { category: 'actor_output' });
    const download = jest.spyOn(objects, 'download');
    const open = jest.spyOn(objects, 'openReadStream');
    try {
      const response = await request(app).get(`/legacy/${file.fileId}/download?inline=true`).set('Range', 'bytes=0-8');
      expect(response.status).toBe(206);
      expect(response.text).toBe('synthetic');
      expect(response.headers['content-range']).toBe(`bytes 0-8/${file.fileSizeBytes}`);
      expect(download).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(file.storageKey, { start: 0, end: 8 });
    } finally { download.mockRestore(); open.mockRestore(); }
  });

  it('deduplicates concurrent multipart retries and resolves a committed receipt after reload', async () => {
    const receipt = randomUUID();
    const send = () => request(app).post('/files').set('x-storage-upload-id', receipt)
      .attach('file', Buffer.from('{"synthetic":"same upload"}'), { filename: 'retry.json', contentType: 'application/json' });
    const results = await Promise.all(Array.from({ length: 8 }, send));
    expect(results.map(result => result.body.error).filter(Boolean)).toEqual([]);
    expect(results.map(result => result.status)).toEqual(Array(8).fill(201));
    expect(new Set(results.map(result => result.body.data.id)).size).toBe(1);
    expect((await send()).body.data.id).toBe(results[0].body.data.id);
    const changed = await request(app).post('/files').set('x-storage-upload-id', receipt)
      .attach('file', Buffer.from('{"synthetic":"changed"}'), { filename: 'retry.json', contentType: 'application/json' });
    expect(changed.status).toBe(409);
    expect((await admin.query('SELECT count(*)::int AS n FROM storage_files WHERE user_id=$1', [owner])).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM billing_storage_reservations WHERE user_id=$1', [owner])).rows[0].n).toBe(0);
  });

  it('enforces real shared capacity reservations concurrently and releases them idempotently', async () => {
    const entitlement = await scope(() => capacity.storageOrganizationEntitlements(owner));
    const cap = entitlement!.limits.storageBytes!;
    expect(Number.isSafeInteger(cap)).toBe(true);
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => scope(() => capacity.reserveOrganizationStorage(owner, Math.floor(cap * 0.6)))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const held = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof capacity.reserveOrganizationStorage>>>).value;
    await scope(() => capacity.releaseOrganizationStorage(held));
    await scope(() => capacity.releaseOrganizationStorage(held));
    expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(0);
  });

  it('rolls back metadata, object and both accounting reservations when metadata persistence fails', async () => {
    await expect(upload('rollback bytes', { referenceId: 'x'.repeat(256) })).rejects.toThrow();
    expect(await readdir(root)).toContain(String(owner));
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
    };
    expect(await walk(join(root, String(owner)))).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM storage_files WHERE user_id=$1', [owner])).rows[0].n).toBe(0);
    expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(0);
    const quota = (await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0];
    expect(quota).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
  });

  it('releases accounting after object-write failure and allows a later retry', async () => {
    const write = jest.spyOn(objects, 'upload').mockRejectedValueOnce(new Error('Synthetic object provider unavailable'));
    try {
      await expect(upload()).rejects.toThrow('Synthetic object provider unavailable');
      expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(0);
      expect((await admin.query('SELECT count(*)::int AS n FROM billing_storage_reservations WHERE user_id=$1', [owner])).rows[0].n).toBe(0);
      const result = await upload();
      expect((await objects.download(result.storageKey)).toString()).toBe('synthetic content');
    } finally { write.mockRestore(); }
  });

  it('retries failed object deletion without reclaiming quota twice', async () => {
    const file = await upload();
    const remove = jest.spyOn(objects, 'delete').mockRejectedValueOnce(new Error('Synthetic provider delete failure'));
    try {
      expect(await scope(() => service.deleteFile(file.fileId, owner))).toBe(true);
      expect(await objects.exists(file.storageKey)).toBe(true);
      expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(0);
      expect(await scope(() => service.cleanupPendingObjects())).toEqual({ processed: 1, remaining: 0 });
      expect(await scope(() => service.cleanupPendingObjects())).toEqual({ processed: 0, remaining: 0 });
      expect(await objects.exists(file.storageKey)).toBe(false);
      expect((await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0])
        .toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { remove.mockRestore(); }
  });

  it('closes the actual local source stream when an HTTP download is cancelled', async () => {
    const file = await upload('x'.repeat(4 * 1024 * 1024));
    const original = objects.openReadStream!.bind(objects);
    let source: Readable | undefined;
    let finished!: () => void;
    const closed = new Promise<void>(resolve => { finished = resolve; });
    const open = jest.spyOn(objects, 'openReadStream').mockImplementation(async (...args) => {
      source = await original(...args);
      source.once('close', finished);
      return source;
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      await new Promise<void>((resolve, reject) => {
        const client = get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/legacy/${file.fileId}/download`, response => {
          response.once('data', () => { response.destroy(); resolve(); });
          response.on('error', () => { /* Cancellation intentionally closes the socket. */ });
        });
        client.on('error', reject);
      });
      await closed;
      expect(source?.destroyed).toBe(true);
    } finally {
      open.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('replaces generated files with a new object and preserves the original after a failed replacement', async () => {
    const storageKey = `${owner}/actor_output/export/run/output.json`;
    const file = await upload('{"v":1}', { storageKey, category: 'actor_output', referenceType: 'actor_run', referenceId: 'synthetic-run' });
    await expect(upload('{"v":2}', { storageKey, category: 'actor_output', referenceId: 'x'.repeat(256) })).rejects.toThrow();
    expect((await objects.download(file.storageKey)).toString()).toBe('{"v":1}');
    const next = await upload('{"version":3}', { storageKey, category: 'actor_output' });
    expect(next.fileId).toBe(file.fileId);
    expect(next.storageKey).not.toBe(file.storageKey);
    expect(await objects.exists(file.storageKey)).toBe(false);
    expect((await objects.download(next.storageKey)).toString()).toBe('{"version":3}');
    expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(next.fileSizeBytes);
  });

  it('stores a generated-output hook with its reference through the actual adapters', async () => {
    const { trackGeneratedOutput } = await import('../services/StorageTrackingHooks.js');
    const id = await scope(() => trackGeneratedOutput({ userId: owner, content: '{"synthetic":true}',
      category: 'actor_output', fileName: 'generated.json', mimeType: 'application/json',
      referenceType: 'actor_run', referenceId: 'synthetic-run' }));
    expect(id).not.toBeNull();
    const file = await scope(() => workspace.workspaceFile(owner, id!));
    expect(file.referenceType).toBe('actor_run');
    expect(file.referenceId).toBe('synthetic-run');
    expect((await objects.download(file.storageKey)).toString()).toBe('{"synthetic":true}');
    await expect(mutate('trash', [id!])).rejects.toMatchObject({ status: 409 });
    await mutate('trash', [id!], { acknowledgeReferences: true });
  });

  it('allows only one first writer to claim a generated destination and lets the loser retry as a replacement', async () => {
    const storageKey = `${owner}/actor_output/export/concurrent/output.json`;
    const original = objects.upload.bind(objects);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const write = jest.spyOn(objects, 'upload').mockImplementation(async (...args) => {
      if (++arrivals === 2) release();
      await barrier;
      return original(...args);
    });
    try {
      const results = await Promise.allSettled([
        upload('{"writer":1}', { storageKey, category: 'actor_output' }),
        upload('{"writer":2}', { storageKey, category: 'actor_output' }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    } finally { release(); write.mockRestore(); }
    const rows = await admin.query("SELECT id FROM storage_files WHERE user_id=$1 AND metadata->>'requestedStorageKey'=$2 AND is_deleted=false", [owner, storageKey]);
    expect(rows.rowCount).toBe(1);
    const retried = await upload('{"writer":"retry"}', { storageKey, category: 'actor_output' });
    expect(retried.fileId).toBe(rows.rows[0].id);
    expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(retried.fileSizeBytes);
    expect((await admin.query('SELECT file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0].file_count).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM billing_storage_reservations WHERE user_id=$1', [owner])).rows[0].n).toBe(0);
  });

  it('charges Trash, blocks private downloads, restores metadata, and makes repeated deletion harmless', async () => {
    const file = await upload();
    await mutate('organize', [file.fileId], { tags: ['synthetic'], collection: 'Fixture' });
    await mutate('trash', [file.fileId]);
    expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(file.fileSizeBytes);
    expect((await request(app).get(`/files/${file.fileId}/content`)).status).toBe(404);
    await mutate('restore', [file.fileId]);
    expect((await scope(() => workspace.workspaceFile(owner, file.fileId))).metadata?.storageWorkspace).toMatchObject({ tags: ['synthetic'], collection: 'Fixture' });
    expect(await scope(() => service.deleteFile(file.fileId, owner))).toBe(true);
    expect(await scope(() => service.deleteFile(file.fileId, owner))).toBe(false);
    expect((await scope(() => capacity.storageOrganizationEntitlements(owner)))!.usage.storageBytes).toBe(0);
    expect(await objects.exists(file.storageKey)).toBe(false);
  });

  it('consumes a Redis capability exactly once under concurrent HTTP redemption', async () => {
    const file = await upload();
    const issued = await request(app).post('/download').send({ fileIds: [file.fileId] });
    expect(issued.status).toBe(200);
    const url = '/download-ticket' + new URL(issued.body.data.url, 'http://fixture.invalid').search;
    const results = await Promise.all(Array.from({ length: 6 }, () => request(app).get(url)));
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.status === 410)).toHaveLength(5);
    expect(results.find(result => result.status === 200)!.text).toBe('synthetic content');
  });

  it('rechecks Trash when a previously issued Redis ticket is redeemed', async () => {
    const file = await upload();
    const issued = await request(app).post('/download').send({ fileIds: [file.fileId] });
    await mutate('trash', [file.fileId]);
    const url = '/download-ticket' + new URL(issued.body.data.url, 'http://fixture.invalid').search;
    expect((await request(app).get(url)).status).toBe(404);
    expect((await request(app).get(url)).status).toBe(410);
  });

  it('stores the two-minute Redis TTL and rejects a capability after Redis expiry', async () => {
    const file = await upload();
    const issued = await request(app).post('/download').send({ fileIds: [file.fileId] });
    const url = new URL(issued.body.data.url, 'http://fixture.invalid');
    const key = `storage:download:${createHash('sha256').update(url.searchParams.get('ticket')!).digest('hex')}`;
    const ttl = await redisModule.getRedisConnection().ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
    await redisModule.getRedisConnection().expire(key, 0);
    expect((await request(app).get('/download-ticket' + url.search)).status).toBe(410);
  });

  it('rechecks the ZIP budget after issuance before opening any object', async () => {
    const first = await upload('first');
    const second = await upload('second');
    const issued = await request(app).post('/download').send({ fileIds: [first.fileId, second.fileId] });
    expect(issued.status).toBe(200);
    // Sparse metadata change models an existing generated output growing while
    // its ticket is outstanding. No large allocation or provider call is made.
    await scope(() => database.execute(sql`UPDATE storage_files SET file_size_bytes=${500 * 1024 * 1024} WHERE id=${first.fileId}`));
    const open = jest.spyOn(objects, 'openReadStream').mockImplementation(async () => Readable.from([Buffer.from('first')]));
    try {
      const url = '/download-ticket' + new URL(issued.body.data.url, 'http://fixture.invalid').search;
      const response = await request(app).get(url);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('500 MB');
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });

  const browserTest = process.env.STORAGE_BROWSER_LOCAL_QA === '1' ? it : it.skip;
  browserTest('runs upload, reload, Redis download, Trash and restore through the actual storage page and adapters', async () => {
    const base = new URL(process.env.STORAGE_BROWSER_BASE_URL || 'http://127.0.0.1:3012');
    if (base.hostname !== '127.0.0.1') throw new Error('Browser fixture requires a loopback Next.js server');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: process.env.STORAGE_BROWSER_EXECUTABLE || '/usr/bin/chromium' });
    const server = app.listen(0, '127.0.0.1');
    let holdNextUpload = false;
    let releaseHeld = () => {};
    let notifyCommitted = () => {};
    const uploadReceipts: string[] = [];
    try {
      await once(server, 'listening');
      const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
      await page.addInitScript(({ owner, profile }) => {
        localStorage.setItem('user', JSON.stringify({ id: owner, name: 'Synthetic Storage Audit' }));
        sessionStorage.setItem(`active-business-profile:${owner}`, String(profile));
      }, { owner, profile });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
        // All storage calls use real controllers, middleware, SQL and objects.
        if (path.startsWith('/api/settings/storage/')) {
          const isUpload = path === '/api/settings/storage/files' && route.request().method() === 'POST';
          if (isUpload) uploadReceipts.push(route.request().headers()['x-storage-upload-id']);
          const response = await route.fetch({ url: apiBase + path + new URL(route.request().url()).search });
          if (isUpload && holdNextUpload) {
            holdNextUpload = false;
            notifyCommitted();
            await new Promise<void>(resolve => { releaseHeld = resolve; });
            // Simulate loss of the response after an actual durable commit.
            await route.abort('aborted').catch(() => {});
            return;
          }
          return route.fulfill({ response });
        }
        // Only unrelated shell identity/access and preferences are fixtures.
        if (path === '/api/auth/me') return json({ user: { id: owner, email: 'storage-fixture@example.invalid', name: 'Synthetic Storage Audit', isSetupComplete: true, isApproved: true, hasBusinessProfile: true, hasBrandToolkit: true } });
        if (path === '/api/platform/access') return json({ maintenance: { enabled: false, message: '' }, modules: ['campaigns', 'lead_generation', 'content', 'performance_marketing', 'ai_visibility', 'outreach', 'crm', 'support', 'support_ai', 'proposals', 'knowledge_base', 'integrations', 'billing', 'storage'].map(key => ({ key, name: key, description: '', status: 'available', message: null, mode: 'enabled', enabled: true })) });
        if (path === '/api/settings/business-profiles') return json([{ id: profile, name: 'Synthetic Alpha', companyName: 'Synthetic Alpha', isDefault: true, role: 'owner' }]);
        if (path === '/api/settings/preferences') return json({ theme: 'light', language: 'en', timezone: 'UTC' });
        if (path === '/api/organizations') return json({ organizations: [] });
        if (path.includes('csrf')) return json({ csrfToken: 'synthetic-storage-fixture' });
        if (path.includes('/chat/threads')) return json({ threads: [], total: 0 });
        if (path === '/api/wallet') return json({ balance: 10000 });
        return json({ count: 0 });
      });
      await page.goto(new URL('/dashboard/storage', base).href);
      await page.getByRole('button', { name: 'Upload files', exact: true }).click();
      await page.getByLabel('Choose files to upload').setInputFiles({ name: 'Synthetic browser.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
      await page.getByText('done', { exact: false }).first().waitFor();
      await page.getByRole('button', { name: 'Close panel', exact: true }).click();
      await page.getByRole('button', { name: 'Synthetic browser.json', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Synthetic browser.json', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Actions for Synthetic browser.json' }).click();
      const downloading = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe('Synthetic browser.json');
      expect((await readFile((await download.path())!)).toString()).toBe('{"synthetic":true}');
      await page.getByRole('button', { name: 'Actions for Synthetic browser.json' }).click();
      await page.getByRole('menuitem', { name: 'Move to Trash', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: /^Trash, / }).click();
      await page.getByRole('button', { name: 'Actions for Synthetic browser.json' }).click();
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Restore files', exact: true }).click();
      await page.getByText('Trash is empty', { exact: true }).waitFor();
      const rows = await scope(() => workspace.listWorkspaceFiles(owner, workspace.storageQuerySchema.parse({})));
      expect(rows.files.map(file => file.originalName)).toEqual(['Synthetic browser.json']);
      await page.goto(new URL('/dashboard/storage', base).href);
      const committed = new Promise<void>(resolve => { notifyCommitted = resolve; });
      holdNextUpload = true;
      await page.getByRole('button', { name: 'Upload files', exact: true }).click();
      await page.getByLabel('Choose files to upload').setInputFiles({ name: 'Cancelled browser.json', mimeType: 'application/json', buffer: Buffer.from('{"cancelledResponse":true}') });
      await committed;
      await page.getByRole('button', { name: 'Cancel Cancelled browser.json', exact: true }).click();
      releaseHeld();
      const retry = page.getByRole('button', { name: 'Retry Cancelled browser.json', exact: true });
      await retry.click();
      await page.getByText('done', { exact: false }).first().waitFor();
      expect(uploadReceipts.slice(-2)[0]).toBe(uploadReceipts.slice(-2)[1]);
      const recovered = await scope(() => workspace.listWorkspaceFiles(owner, workspace.storageQuerySchema.parse({})));
      expect(recovered.files.filter(file => file.originalName === 'Cancelled browser.json')).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      releaseHeld();
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60000);
});
