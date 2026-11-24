import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Redis from 'ioredis';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { currentDatabaseScope, withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import type { ManagedStorageTransaction } from '../services/managedStorageReferences.js';

let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    const value = database[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const local = process.env.DATA_MANAGED_LOCAL_QA === '1' ? describe : describe.skip;
local('Data receipt worker with real scoped PostgreSQL, canonical locks and local objects', () => {
  let admin: Pool, runtime: Pool, root: string, owner: number, profile: number, payer: number;
  let service: (typeof import('../services/StorageService.js'))['storageService'];
  let objects: (typeof import('../services/ObjectStorageService.js'))['objectStorage'];
  let refs: typeof import('../services/managedStorageReferences.js');
  let worker: (typeof import('../services/businessProfileAssetCleanup.js'))['cleanupDeletedProfileAssets'];
  let closeRedis: () => Promise<void>;
  const duplicates: Redis[] = [];
  const scope = <T>(work: () => T) => withBusinessScope({ userId: owner, businessProfileId: profile, actorUserId: owner, role: 'owner' }, () =>
    withBillingScope({ organizationId: payer, actorUserId: owner, businessProfileId: profile, businessOwnerUserId: owner }, work));
  const ctx = () => ({ userId: owner, businessProfileId: profile });
  const tx = <T>(work: (transaction: ManagedStorageTransaction) => Promise<T>) => scope(() => database.transaction(work));
  const upload = () => scope(() => service.upload(Buffer.from('Synthetic profile bytes'), {
    userId: owner, category: 'brand_asset', originalName: 'synthetic.txt', mimeType: 'text/plain', referenceType: 'brand_toolkit_logo',
  }));
  const usage = async () => (await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0];
  const receiptRow = async (id: string) => (await admin.query('SELECT * FROM business_profile_asset_cleanup WHERE id=$1', [id])).rows[0];
  async function receipt(key: string) {
    return String((await admin.query("INSERT INTO business_profile_asset_cleanup(user_id,storage_key,storage_backend) VALUES($1,$2,'local') RETURNING id", [owner, key])).rows[0].id);
  }
  async function removeProfile() {
    return tx(async transaction => {
      await refs.lockManagedStorageReferences(transaction, ctx());
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(740322,${profile})`);
      await transaction.execute(sql`SELECT id FROM company_settings WHERE id=${profile} AND user_id=${owner} FOR UPDATE`);
      const ids = await service.deleteBusinessSetupAssets(transaction, owner, profile);
      await transaction.execute(sql`DELETE FROM company_settings WHERE id=${profile} AND user_id=${owner}`);
      return ids;
    });
  }
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }
  // Observe PostgreSQL's real lock wait rather than infer overlap from a timer.
  async function waitForLock() {
    for (let count = 0; count < 100; count++) {
      const waiting = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()");
      if (waiting.rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Expected a bounded PostgreSQL lock wait');
  }
  beforeAll(async () => {
    const url = new URL(process.env.STORAGE_AUDIT_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/storage_audit_bcs02' ||
        process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '56483') {
      throw new Error('Explicit disposable Data storage database and Redis required');
    }
    admin = new Pool({ connectionString: url.href, max: 2 });
    runtime = createBusinessScopedPool(new Pool({ connectionString: url.href, max: 4 }));
    database = drizzle(runtime);
    expect((await admin.query("SELECT 1 FROM js_migrations WHERE name='480_storage_managed_references.js'")).rowCount).toBe(1);
    root = await mkdtemp(join(tmpdir(), 'data-bcs02-objects-'));
    process.env.LOCAL_STORAGE_PATH = root; process.env.STORAGE_BACKEND = 'local';
    jest.spyOn(Redis.prototype, 'duplicate').mockImplementation(function(this: Redis, options) {
      const connection = new Redis({ ...this.options, ...options }); duplicates.push(connection); return connection;
    });
    ({ storageService: service } = await import('../services/StorageService.js'));
    ({ objectStorage: objects } = await import('../services/ObjectStorageService.js'));
    refs = await import('../services/managedStorageReferences.js');
    ({ cleanupDeletedProfileAssets: worker } = await import('../services/businessProfileAssetCleanup.js'));
    ({ closeRedisConnections: closeRedis } = await import('../infrastructure/redis.js'));
  }, 30000);
  beforeEach(async () => {
    owner = Number((await admin.query("INSERT INTO users(email,name,is_verified,is_approved,is_setup_complete) VALUES($1,'Synthetic Data owner',true,true,true) RETURNING id", [`data-${randomUUID()}@example.invalid`])).rows[0].id);
    const row = (await admin.query("INSERT INTO company_settings(user_id,company_name,is_default,is_approved) VALUES($1,'Synthetic Data business',true,true) RETURNING id,billing_organization_id", [owner])).rows[0];
    profile = Number(row.id); payer = Number(row.billing_organization_id);
  });
  afterEach(async () => {
    await admin.query('DROP TRIGGER IF EXISTS data_bcs02_ack_failure ON business_profile_asset_cleanup');
    await admin.query('DROP FUNCTION IF EXISTS public.data_bcs02_ack_failure()');
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    for (const connection of duplicates) connection.disconnect();
    await closeRedis?.(); await runtime?.end(); await admin?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('rolls back setup metadata, quota and receipts without touching provider bytes', async () => {
    const file = await upload(), before = await usage();
    const deletion = jest.spyOn(objects, 'delete');
    try {
      await expect(tx(async transaction => {
        await refs.lockManagedStorageReferences(transaction, ctx());
        expect(await service.deleteBusinessSetupAssets(transaction, owner, profile)).toHaveLength(1);
        throw new Error('Synthetic caller rollback');
      })).rejects.toThrow('Synthetic caller rollback');
      expect((await admin.query('SELECT id FROM storage_files WHERE id=$1', [file.fileId])).rowCount).toBe(1);
      expect((await admin.query('SELECT id FROM business_profile_asset_cleanup WHERE user_id=$1', [owner])).rowCount).toBe(0);
      expect(await usage()).toEqual(before); expect(deletion).not.toHaveBeenCalled();
      expect((await objects.download(file.storageKey)).toString()).toBe('Synthetic profile bytes');
    } finally { deletion.mockRestore(); }
  });

  it('consumes the actual worker receipt after final profile deletion and replays without a second quota release', async () => {
    const file = await upload(), ids = await removeProfile();
    expect(ids).toHaveLength(1); expect((await receiptRow(ids[0])).attempts).toBe(0);
    expect((await admin.query('SELECT id FROM company_settings WHERE id=$1', [profile])).rowCount).toBe(0);
    const deletion = jest.spyOn(objects, 'delete');
    try {
      await worker(owner, ids); await worker(owner, ids);
      expect(await receiptRow(ids[0])).toBeUndefined(); expect(deletion).toHaveBeenCalledTimes(1);
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
      await expect(objects.download(file.storageKey)).rejects.toThrow();
      expect(currentDatabaseScope()).toBeUndefined();
    } finally { deletion.mockRestore(); }
  });

  it.each(['content_template_version', 'social_publish_attempt'] as const)('preserves bytes and intent held by frozen %s', async kind => {
    const file = await upload(), id = await receipt(file.storageKey), before = await usage();
    await tx(transaction => refs.syncManagedStorageReferences(transaction, { owner: { ...ctx(), kind, id: randomUUID() }, urls: [file.url] }));
    const deletion = jest.spyOn(objects, 'delete');
    try {
      await worker(owner, [id]);
      expect(deletion).not.toHaveBeenCalled(); expect((await receiptRow(id)).attempts).toBe(0);
      expect(await usage()).toEqual(before); expect((await objects.download(file.storageKey)).toString()).toBe('Synthetic profile bytes');
    } finally { deletion.mockRestore(); }
  });

  it('defers a still-active unreferenced object, then consumes the committed deletion claim', async () => {
    const file = await upload(), id = await receipt(file.storageKey), before = await usage();
    const deletion = jest.spyOn(objects, 'delete');
    try {
      await worker(owner, [id]);
      expect(deletion).not.toHaveBeenCalled(); expect((await receiptRow(id)).attempts).toBe(1); expect(await usage()).toEqual(before);
      await tx(transaction => service.claimFileDeletion(transaction, file.fileId, owner));
      await worker(owner, [id]); await worker(owner, [id]);
      expect(await receiptRow(id)).toBeUndefined(); expect(deletion).toHaveBeenCalledTimes(1);
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { deletion.mockRestore(); }
  });

  it('retains final-profile work on provider failure and acknowledges only a successful retry', async () => {
    const file = await upload(), ids = await removeProfile();
    const deletion = jest.spyOn(objects, 'delete').mockRejectedValueOnce(new Error('Synthetic object outage'));
    try {
      await worker(owner, ids);
      expect((await receiptRow(ids[0])).attempts).toBe(1);
      expect((await objects.download(file.storageKey)).toString()).toBe('Synthetic profile bytes');
      await worker(owner, ids); expect(await receiptRow(ids[0])).toBeUndefined(); expect(deletion).toHaveBeenCalledTimes(2);
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { deletion.mockRestore(); }
  });

  it('retains a receipt when provider deletion succeeds but SQL acknowledgment rolls back', async () => {
    const file = await upload(), ids = await removeProfile();
    await admin.query("CREATE FUNCTION public.data_bcs02_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic acknowledgment outage'; END $$");
    await admin.query(`CREATE TRIGGER data_bcs02_ack_failure BEFORE DELETE ON business_profile_asset_cleanup FOR EACH ROW WHEN (OLD.user_id=${owner}) EXECUTE FUNCTION public.data_bcs02_ack_failure()`);
    const deletion = jest.spyOn(objects, 'delete');
    try {
      await worker(owner, ids);
      expect((await receiptRow(ids[0])).attempts).toBe(1); expect(deletion).toHaveBeenCalledTimes(1);
      await expect(objects.download(file.storageKey)).rejects.toThrow();
      await admin.query('DROP TRIGGER data_bcs02_ack_failure ON business_profile_asset_cleanup');
      await worker(owner, ids); expect(await receiptRow(ids[0])).toBeUndefined(); expect(deletion).toHaveBeenCalledTimes(2);
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { deletion.mockRestore(); }
  });

  it('waits for concurrent registration and preserves the committed holder', async () => {
    const file = await upload(), id = await receipt(file.storageKey), ready = gate(), finish = gate();
    const registration = tx(async transaction => {
      await refs.syncManagedStorageReferences(transaction, { owner: { ...ctx(), kind: 'content_template_version', id: randomUUID() }, urls: [file.url] });
      ready.release(); await finish.promise;
    });
    await ready.promise;
    const deletion = jest.spyOn(objects, 'delete');
    const sweep = worker(owner, [id]);
    try {
      await waitForLock(); finish.release(); await registration; await sweep;
      expect((await receiptRow(id)).attempts).toBe(0); expect(deletion).not.toHaveBeenCalled();
      expect((await objects.download(file.storageKey)).toString()).toBe('Synthetic profile bytes');
    } finally { finish.release(); await Promise.allSettled([registration, sweep]); deletion.mockRestore(); }
  });

  it('does not compensate a failed upload acquired by a concurrent durable writer', async () => {
    const file = await upload(), ready = gate(), finish = gate(), before = await usage();
    const registration = tx(async transaction => {
      await refs.syncManagedStorageReferences(transaction, { owner: { ...ctx(), kind: 'content_asset', id: randomUUID() }, urls: [file.url] });
      ready.release(); await finish.promise;
    });
    await ready.promise;
    const compensation = scope(() => service.compensateFailedUpload(ctx(), file.fileId));
    try {
      await waitForLock(); finish.release(); await registration;
      expect(await compensation).toBe(false); expect(await usage()).toEqual(before);
      expect((await objects.download(file.storageKey)).toString()).toBe('Synthetic profile bytes');
    } finally { finish.release(); await Promise.allSettled([registration, compensation]); }
  });

  it('retains a compensation provider retry and refuses a late durable acquisition', async () => {
    const file = await upload();
    const deletion = jest.spyOn(objects, 'delete').mockRejectedValueOnce(new Error('Synthetic compensation outage'));
    try {
      expect(await scope(() => service.compensateFailedUpload(ctx(), file.fileId))).toBe(true);
      const row = (await admin.query('SELECT is_deleted,metadata FROM storage_files WHERE id=$1', [file.fileId])).rows[0];
      expect(row.is_deleted).toBe(true); expect(row.metadata.pendingCleanupKeys).toContain(file.storageKey);
      await expect(tx(transaction => refs.syncManagedStorageReferences(transaction, {
        owner: { ...ctx(), kind: 'social_publish_attempt', id: randomUUID() }, urls: [file.url],
      }))).rejects.toMatchObject({ code: 'STORAGE_REFERENCE_CONFLICT' });
      expect((await objects.download(file.storageKey)).toString()).toBe('Synthetic profile bytes');
      await scope(() => service.cleanupPendingObjects());
      expect(deletion).toHaveBeenCalledTimes(2);
      expect((await admin.query('SELECT metadata FROM storage_files WHERE id=$1', [file.fileId])).rows[0].metadata.pendingCleanupKeys).toBeUndefined();
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
      expect(await scope(() => service.compensateFailedUpload(ctx(), file.fileId))).toBe(false);
    } finally { deletion.mockRestore(); }
  });

  it('reaches surviving receipts through the actual global cron origin boundary', async () => {
    const file = await upload(), ids = await removeProfile();
    const { runBusinessJob } = await import('../tenancy/jobBusinessScope.js');
    const deletion = jest.spyOn(objects, 'delete');
    try {
      // The real GENERAL worker invokes this origin boundary before dispatching
      // per-business storage maintenance. There is no remaining target profile.
      // Queue transport is not under test; no origin/receipt consumer is mocked.
      await runBusinessJob({ systemJob: true, type: 'cron-storage-object-cleanup' }, async () => undefined);
      expect(await receiptRow(ids[0])).toBeUndefined();
      expect(deletion.mock.calls.filter(([key]) => key === file.storageKey)).toHaveLength(1);
      await expect(objects.download(file.storageKey)).rejects.toThrow();
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { deletion.mockRestore(); }
  });
});
