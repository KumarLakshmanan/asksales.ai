import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool, type PoolClient, type QueryConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import express from 'express';
import request from 'supertest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import { sql } from 'drizzle-orm';

let database: NodePgDatabase;
type QueryWitness = { client: PoolClient; text: string; params: unknown[] };
let beforeQuery: ((query: QueryWitness) => Promise<void>) | undefined;
let afterQuery: ((query: QueryWitness) => Promise<void>) | undefined;
function observedPool(pool: Pool): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, property) {
        if (property === 'query') return async (query: string | QueryConfig, values?: unknown[]) => {
          const witness = { client: connection, text: typeof query === 'string' ? query : query.text, params: values ?? (typeof query === 'string' ? [] : query.values ?? []) };
          await beforeQuery?.(witness);
          const result = await connection.query(query, values);
          await afterQuery?.(witness);
          return result;
        };
        const value = Reflect.get(connection, property, connection); return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({} as NodePgDatabase, {
  get(_target, key) { const value = database[key as keyof NodePgDatabase]; return typeof value === 'function' ? value.bind(database) : value; },
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Simulate website/provider extraction only. The existing analysis worker,
// its commit callback, KnowledgeBase model, scoped SQL and quota triggers run.
jest.unstable_mockModule('../controllers/setupController.js', () => ({ analyzeWebsite: async (req: { user: { id: number } }, res: { json(value: unknown): unknown }) => {
  const { withSetupAnalysisCommit } = await import('../services/setupAnalysisProgress.js');
  const { requireBusinessScope } = await import('../tenancy/businessContext.js');
  const { KnowledgeBaseModel } = await import('../models/knowledgeBase/functions.js');
  const business = requireBusinessScope();
  await withSetupAnalysisCommit(executor => KnowledgeBaseModel.create({ userId: req.user.id, businessProfileId: business.businessProfileId,
    title: 'Synthetic analysis commit', content: 'Synthetic extracted content', type: 'url', sourceUrl: 'https://synthetic.example.invalid/' }, executor));
  return res.json({ success: true, data: { companyName: 'Synthetic' } });
} }));
const local = process.env.DATA_MANAGED_LOCAL_QA === '1' ? describe : describe.skip;

local('BC-S02 mounted profile deletion with actual Brand, Storage and scoped PostgreSQL', () => {
  let admin: Pool, runtime: Pool, root: string, app: express.Express;
  let owner: number, profile: number, payer: number, token: string;
  let service: (typeof import('../services/StorageService.js'))['storageService'];
  let objects: (typeof import('../services/ObjectStorageService.js'))['objectStorage'];
  let closeRedis: () => Promise<void>, destroyThrottle: () => void;
  const duplicates: Redis[] = [];
  const scope = <T>(work: () => T) => withBusinessScope({ userId: owner, businessProfileId: profile, actorUserId: owner, role: 'owner' }, () =>
    withBillingScope({ organizationId: payer, actorUserId: owner, businessProfileId: profile, businessOwnerUserId: owner }, work));
  const upload = () => scope(() => service.upload(Buffer.from('Synthetic controller bytes'), {
    userId: owner, category: 'brand_asset', originalName: 'synthetic.txt', mimeType: 'text/plain', referenceType: 'brand_toolkit_logo',
  }));
  const api = (method: 'get' | 'post' | 'delete', path: string) => request(app)[method](path).set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(profile));
  const usage = async () => (await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0];
  const brandFor = async (url: string) => {
    const response = await api('post', '/api/content/brand-toolkits').send({ name: 'Synthetic registered brand', logoUrl: url, logoUrls: [url] });
    expect(response.status).toBe(201);
    const id = Number((response.body.data ?? response.body).id); expect(Number.isSafeInteger(id) && id > 0).toBe(true); return id;
  };
  function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
  async function waitForLock() {
    for (let count = 0; count < 100; count++) {
      if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()")).rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Expected a bounded real PostgreSQL lock wait');
  }
  async function setupWork() {
    const id = randomUUID();
    await admin.query("INSERT INTO workspace_setup_drafts(user_id,draft_key,data) VALUES($1,$2,$3::jsonb)", [owner, `brand:${profile}`, JSON.stringify({ profileId: profile, companyName: 'Synthetic draft' })]);
    await scope(() => database.execute(sql`INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,status)
      VALUES(${id}::uuid,${owner},${profile},'https://synthetic.example.invalid/','queued')`));
    return id;
  }
  async function alternatePayerProfile() {
    // Model a legacy owner's two persisted payers without changing any profile's
    // immutable payer or disabling a guard. Both new profiles pass today's normal
    // INSERT triggers; only this synthetic owner's default-organization fixture
    // is switched while the second profile is created, then restored.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const organization = Number((await client.query("INSERT INTO billing_organizations(owner_user_id,name,billing_eligibility_at) VALUES($1,'Synthetic alternate payer',now()) RETURNING id", [owner])).rows[0].id);
      await client.query("INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status) SELECT $1,id,email,'owner','active' FROM users WHERE id=$2", [organization, owner]);
      await client.query('UPDATE billing_organizations SET default_for_user_id=NULL WHERE id=$1 AND owner_user_id=$2', [payer, owner]);
      await client.query('UPDATE billing_organizations SET default_for_user_id=$1 WHERE id=$2 AND owner_user_id=$1', [owner, organization]);
      const replacement = (await client.query("INSERT INTO company_settings(user_id,company_name,is_default,is_approved) VALUES($1,'Synthetic alternate business',false,true) RETURNING id,billing_organization_id", [owner])).rows[0];
      expect(Number(replacement.billing_organization_id)).toBe(organization);
      await client.query('UPDATE billing_organizations SET default_for_user_id=NULL WHERE id=$1 AND owner_user_id=$2', [organization, owner]);
      await client.query('UPDATE billing_organizations SET default_for_user_id=$1 WHERE id=$2 AND owner_user_id=$1', [owner, payer]);
      await client.query('COMMIT'); return { id: Number(replacement.id), payer: organization };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  beforeAll(async () => {
    const url = new URL(process.env.STORAGE_AUDIT_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== '55483' || url.username !== 'postgres' || url.password || url.pathname !== '/storage_audit_bcs02' || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '56483') throw new Error('Explicit disposable Data controller fixtures required');
    admin = new Pool({ connectionString: url.href, max: 3 }); runtime = createBusinessScopedPool(observedPool(new Pool({ connectionString: url.href, max: 6 }))); database = drizzle(runtime);
    expect((await admin.query("SELECT 1 FROM js_migrations WHERE name='480_storage_managed_references.js'")).rowCount).toBe(1);
    root = await mkdtemp(join(tmpdir(), 'data-bcs02-controller-'));
    process.env.LOCAL_STORAGE_PATH = root; process.env.STORAGE_BACKEND = 'local'; process.env.JWT_SECRET = 'data-bcs02-synthetic-only-key';
    jest.spyOn(Redis.prototype, 'duplicate').mockImplementation(function(this: Redis, options) { const connection = new Redis({ ...this.options, ...options }); duplicates.push(connection); return connection; });
    ({ storageService: service } = await import('../services/StorageService.js')); ({ objectStorage: objects } = await import('../services/ObjectStorageService.js'));
    ({ closeRedisConnections: closeRedis } = await import('../infrastructure/redis.js'));
    const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js'); destroyThrottle = () => SmartThrottlingService.getInstance().destroy();
    const { responseWrapper } = await import('../middleware/responseWrapper.js');
    app = express(); app.use(express.json()); app.use('/api', responseWrapper);
    app.use('/api/settings', (await import('../routes/settings.routes.js')).default);
    app.use('/api/content', (await import('../routes/content.routes.js')).default);
  }, 30000);
  beforeEach(async () => {
    const email = `data-controller-${randomUUID()}@example.invalid`;
    owner = Number((await admin.query("INSERT INTO users(email,name,is_verified,is_approved,is_setup_complete) VALUES($1,'Synthetic controller owner',true,true,true) RETURNING id", [email])).rows[0].id);
    const row = (await admin.query("INSERT INTO company_settings(user_id,company_name,is_default,is_approved) VALUES($1,'Synthetic controller business',true,true) RETURNING id,billing_organization_id", [owner])).rows[0];
    profile = Number(row.id); payer = Number(row.billing_organization_id);
    const { generateToken } = await import('../utils/jwt.js'); token = generateToken({ userId: owner, email });
  });
  afterEach(() => { beforeQuery = undefined; afterQuery = undefined; jest.clearAllMocks(); });
  afterAll(async () => {
    destroyThrottle?.(); jest.restoreAllMocks(); for (const connection of duplicates) connection.disconnect();
    await closeRedis?.(); await runtime?.end(); await admin?.end(); if (root) await rm(root, { recursive: true, force: true });
  });

  it('deletes the final profile after actual Brand registration and cleans only after commit', async () => {
    const file = await upload();
    const brandId = await brandFor(file.url);
    expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(1);
    const deletion = jest.spyOn(objects, 'delete');
    let original: PoolClient | undefined, committed = false;
    beforeQuery = async query => {
      if (!original && query.params.some(value => typeof value === 'string' && value.startsWith('storage-object:'))) original = query.client;
      if (original === query.client && query.text === 'commit' && !committed) {
        expect(deletion).not.toHaveBeenCalled(); expect(await objects.exists(file.storageKey)).toBe(true);
        expect((await query.client.query('SELECT id FROM storage_files WHERE id=$1', [file.fileId])).rowCount).toBe(0);
      }
    };
    afterQuery = async query => { if (query.client === original && query.text === 'commit') committed = true; };
    try {
      const response = await api('delete', `/api/settings/business-profiles/${profile}`);
      if (response.status === 500) {
        const { logger } = await import('../utils/logger.js');
        const logged = jest.mocked(logger.error).mock.calls.at(-1)?.[0] as { err?: unknown } | undefined;
        const details: string[] = [];
        for (let cause = logged?.err as { message?: string; code?: string; cause?: unknown } | undefined; cause; cause = cause.cause as typeof cause) details.push(`${cause.code || 'wrapped'}: ${cause.message}`);
        throw new Error(`Synthetic controller failure: ${details.join('\n')}`);
      }
      expect(response.status).toBe(200);
      expect((await admin.query('SELECT id FROM company_settings WHERE id=$1', [profile])).rowCount).toBe(0);
      expect((await admin.query('SELECT id FROM brand_toolkits WHERE id=$1', [brandId])).rowCount).toBe(0);
      expect((await admin.query('SELECT id FROM storage_files WHERE id=$1', [file.fileId])).rowCount).toBe(0);
      expect((await admin.query('SELECT id FROM business_profile_asset_cleanup WHERE user_id=$1', [owner])).rowCount).toBe(0);
      expect(deletion.mock.calls.filter(([key]) => key === file.storageKey)).toHaveLength(1);
      expect(committed).toBe(true);
      await expect(objects.download(file.storageKey)).rejects.toThrow();
    } finally { deletion.mockRestore(); }
  });

  it('rolls back Brand holders, files, quota, drafts, jobs and preferences when records restrict deletion', async () => {
    const file = await upload(), brandId = await brandFor(file.url), job = await setupWork(), quota = await usage();
    await scope(() => database.execute(sql`INSERT INTO crm_contacts(user_id,business_profile_id) VALUES(${owner},${profile})`));
    const deletion = jest.spyOn(objects, 'delete');
    try {
      const response = await api('delete', `/api/settings/business-profiles/${profile}`);
      expect(response.status).toBe(409); expect(response.body.code).toBe('BUSINESS_PROFILE_HAS_RECORDS');
      expect((await admin.query('SELECT id FROM brand_toolkits WHERE id=$1', [brandId])).rowCount).toBe(1);
      expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(1);
      expect((await admin.query('SELECT id FROM storage_files WHERE id=$1', [file.fileId])).rowCount).toBe(1);
      expect((await admin.query('SELECT id FROM workspace_website_analysis_jobs WHERE id=$1', [job])).rowCount).toBe(1);
      expect((await admin.query('SELECT data FROM workspace_setup_drafts WHERE user_id=$1', [owner])).rows[0].data.profileId).toBe(profile);
      expect(Number((await admin.query('SELECT default_business_profile_id FROM business_profile_preferences WHERE user_id=$1', [owner])).rows[0].default_business_profile_id)).toBe(profile);
      expect((await admin.query('SELECT id FROM business_profile_asset_cleanup WHERE user_id=$1', [owner])).rowCount).toBe(0);
      expect(await usage()).toEqual(quota); expect(deletion).not.toHaveBeenCalled();
      expect(await objects.exists(file.storageKey)).toBe(true);
    } finally { deletion.mockRestore(); }
  });

  it('preserves an actual frozen template-version snapshot and its canonical registered reference', async () => {
    const file = await upload(), brandId = await brandFor(file.url);
    const { syncManagedStorageOwners, lockManagedStorageReferences } = await import('../services/managedStorageReferences.js');
    const { collectContentManagedReferenceUrls } = await import('../utils/contentManagedReferences.js');
    const version = await scope(() => database.transaction(async tx => {
      await lockManagedStorageReferences(tx, { userId: owner, businessProfileId: profile });
      const template = await tx.execute(sql`INSERT INTO content_templates(user_id,business_profile_id,brand_toolkit_id,name,type,content)
        VALUES(${owner},${profile},${brandId},'Synthetic frozen template','email','Synthetic copy') RETURNING id`);
      const snapshot = { name: 'Synthetic frozen snapshot', content: 'Synthetic copy', brandContextSnapshot: { brandToolkit: { logoUrl: file.url } } };
      const saved = await tx.execute(sql`INSERT INTO content_template_versions(template_id,user_id,business_profile_id,version,snapshot)
        VALUES(${Number(template.rows[0].id)},${owner},${profile},1,${JSON.stringify(snapshot)}::jsonb) RETURNING id,snapshot`);
      await syncManagedStorageOwners(tx, { entries: [{ owner: { kind: 'content_template_version', id: String(saved.rows[0].id), userId: owner, businessProfileId: profile }, urls: collectContentManagedReferenceUrls(saved.rows[0].snapshot) }] });
      return Number(saved.rows[0].id);
    }));
    const deletion = jest.spyOn(objects, 'delete');
    try {
      const response = await api('delete', `/api/settings/business-profiles/${profile}`);
      expect(response.status).toBe(409); expect(response.body.code).toBe('BUSINESS_PROFILE_HAS_RECORDS'); expect(deletion).not.toHaveBeenCalled();
      expect((await admin.query('SELECT snapshot FROM content_template_versions WHERE id=$1', [version])).rows[0].snapshot.brandContextSnapshot.brandToolkit.logoUrl).toBe(file.url);
      expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(2);
      expect(await objects.exists(file.storageKey)).toBe(true);
    } finally { deletion.mockRestore(); }
  });

  it('commits profile removal while preserving a failed provider receipt for actual worker recovery', async () => {
    const file = await upload(); await brandFor(file.url);
    const deletion = jest.spyOn(objects, 'delete').mockRejectedValueOnce(new Error('Synthetic controller provider outage'));
    try {
      expect((await api('delete', `/api/settings/business-profiles/${profile}`)).status).toBe(200);
      expect((await admin.query('SELECT id FROM company_settings WHERE id=$1', [profile])).rowCount).toBe(0);
      const row = (await admin.query('SELECT id,attempts FROM business_profile_asset_cleanup WHERE user_id=$1', [owner])).rows[0];
      expect(row.attempts).toBe(1); expect(await objects.exists(file.storageKey)).toBe(true);
      const { cleanupDeletedProfileAssets } = await import('../services/businessProfileAssetCleanup.js');
      await cleanupDeletedProfileAssets(owner, [String(row.id)]); await cleanupDeletedProfileAssets(owner, [String(row.id)]);
      expect((await admin.query('SELECT id FROM business_profile_asset_cleanup WHERE user_id=$1', [owner])).rowCount).toBe(0);
      expect(deletion.mock.calls.filter(([key]) => key === file.storageKey)).toHaveLength(2);
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { deletion.mockRestore(); }
  });

  it('fails promptly if an older account writer holds the inverse-order advisory lock', async () => {
    const file = await upload(); await brandFor(file.url);
    const blocker = await admin.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1)', [owner]);
    const deletion = jest.spyOn(objects, 'delete');
    try {
      const response = await api('delete', `/api/settings/business-profiles/${profile}`);
      expect(response.status).toBe(409); expect(deletion).not.toHaveBeenCalled();
      expect((await admin.query('SELECT id FROM company_settings WHERE id=$1', [profile])).rowCount).toBe(1);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); deletion.mockRestore(); }
  });

  it('waits for a concurrent durable acquisition, then preserves its reference and rolls back Brand staging', async () => {
    const file = await upload(), brand = await brandFor(file.url), ready = gate(), finish = gate();
    const { syncManagedStorageOwners, lockManagedStorageReferences } = await import('../services/managedStorageReferences.js');
    const registration = scope(() => database.transaction(async tx => {
      await lockManagedStorageReferences(tx, { userId: owner, businessProfileId: profile });
      const template = await tx.execute(sql`INSERT INTO content_templates(user_id,business_profile_id,name,type,content)
        VALUES(${owner},${profile},'Concurrent frozen owner','email','Synthetic') RETURNING id`);
      await syncManagedStorageOwners(tx, { entries: [{ owner: { kind: 'content_template', id: String(template.rows[0].id), userId: owner, businessProfileId: profile }, urls: [file.url] }] });
      ready.release(); await finish.promise;
    }));
    await ready.promise;
    const deletion = jest.spyOn(objects, 'delete');
    const removal = api('delete', `/api/settings/business-profiles/${profile}`).then(response => response);
    try {
      await waitForLock(); finish.release(); await registration;
      expect((await removal).status).toBe(409); expect(deletion).not.toHaveBeenCalled();
      expect((await admin.query('SELECT id FROM brand_toolkits WHERE id=$1', [brand])).rowCount).toBe(1);
      expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(2);
      expect(await objects.exists(file.storageKey)).toBe(true);
    } finally { finish.release(); await Promise.allSettled([registration, removal]); deletion.mockRestore(); }
  });

  it('locks separately authorized alternate payers ascending before business locks and restores the default', async () => {
    const file = await upload(); await brandFor(file.url);
    const replacement = await alternatePayerProfile(), trace: QueryWitness[] = [];
    const blocker = await admin.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM billing_organizations WHERE id=$1 FOR UPDATE', [replacement.payer]);
    beforeQuery = async witness => { trace.push(witness); };
    // An unrelated selected payer and an untrusted body must not substitute for
    // the deletion target's persisted identity or the validated destination.
    const removal = api('delete', `/api/settings/business-profiles/${profile}`).set('X-Business-Profile-Id', String(replacement.id)).send({ organizationId: 987654321 }).then(response => response);
    try {
      await waitForLock();
      const prefix = trace.find(query => /^SELECT id FROM billing_organizations WHERE id IN/.test(query.text));
      expect(prefix?.params).toEqual([payer, replacement.payer].sort((a, b) => a - b)); expect(prefix?.text).toMatch(/ORDER BY id FOR UPDATE/);
      expect(trace.some(query => /pg_advisory_xact_lock/.test(query.text))).toBe(false);
      await blocker.query('COMMIT'); blocker.release();
      expect((await removal).status).toBe(200);
      const remaining = (await admin.query('SELECT is_default,billing_organization_id FROM company_settings WHERE id=$1', [replacement.id])).rows[0];
      expect(remaining.is_default).toBe(true); expect(Number(remaining.billing_organization_id)).toBe(replacement.payer);
      expect(Number((await admin.query('SELECT default_business_profile_id FROM business_profile_preferences WHERE user_id=$1', [owner])).rows[0].default_business_profile_id)).toBe(replacement.id);
    } catch (error) { await blocker.query('ROLLBACK').catch(() => undefined); blocker.release(); throw error; }
    finally { await Promise.allSettled([removal]); }
  });

  it('prelocks the migrated cascade closure and existing populated rows before the first object key', async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgrowlocks');
    const file = await upload(); await brandFor(file.url); await setupWork();
    const audit = (await admin.query("INSERT INTO business_profile_membership_audit(business_profile_id,actor_user_id,action) VALUES($1,$2,'synthetic') RETURNING id", [profile, owner])).rows[0].id;
    const rows: Array<{ table: string; id: number }> = [{ table: 'company_settings', id: profile }];
    const membership = (await admin.query('SELECT id FROM business_profile_memberships WHERE business_profile_id=$1', [profile])).rows[0]; rows.push({ table: 'business_profile_memberships', id: Number(membership.id) });
    const workspace = await scope(() => database.execute(sql`INSERT INTO ai_visibility_workspaces(owner_user_id,name,billing_organization_id,business_profile_id)
      VALUES(${owner},'Synthetic cascade workspace',${payer},${profile}) RETURNING id`));
    const workspaceId = Number(workspace.rows[0].id); rows.push({ table: 'ai_visibility_workspaces', id: workspaceId });
    const membershipId = Number((await admin.query("INSERT INTO ai_visibility_workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner') RETURNING id", [workspaceId, owner])).rows[0].id); rows.push({ table: 'ai_visibility_workspace_memberships', id: membershipId });
    const automation = await scope(() => database.execute(sql`INSERT INTO instagram_automation_profiles(user_id,business_profile_id,account_id,kind,config)
      VALUES(${owner},${profile},'synthetic-local-account','menu','{}'::jsonb) RETURNING id`)); rows.push({ table: 'instagram_automation_profiles', id: Number(automation.rows[0].id) });
    const outcome = await scope(() => database.execute(sql`INSERT INTO sales_outcome_events(user_id,actor_user_id,business_profile_id,source_key,kind,evidence,occurred_at)
      VALUES(${owner},${owner},${profile},${randomUUID()},'contact_created','synthetic',now()) RETURNING id`)); rows.push({ table: 'sales_outcome_events', id: Number(outcome.rows[0].id) });
    const direct = await admin.query("SELECT count(*)::integer AS count FROM pg_constraint WHERE confrelid='company_settings'::regclass AND contype='f' AND confdeltype IN('c','n')"); expect(direct.rows[0].count).toBe(19);
    const closure = await admin.query("WITH RECURSIVE affected(relid) AS (SELECT 'company_settings'::regclass::oid UNION SELECT c.conrelid FROM pg_constraint c JOIN affected a ON c.confrelid=a.relid WHERE c.contype='f' AND c.confdeltype='c') SELECT DISTINCT c.conrelid::regclass::text AS name FROM pg_constraint c WHERE c.contype='f' AND c.confrelid IN(SELECT relid FROM affected) AND c.confdeltype IN('c','n')");
    const trace: QueryWitness[] = []; let observed = false;
    beforeQuery = async witness => {
      trace.push(witness);
      if (observed || !witness.params.some(value => typeof value === 'string' && value.startsWith('storage-object:'))) return;
      observed = true;
      const pid = Number((await witness.client.query('SELECT pg_backend_pid() AS id')).rows[0].id);
      for (const row of rows) {
        const ctid = (await witness.client.query(`SELECT ctid::text FROM public."${row.table}" WHERE id=$1`, [row.id])).rows[0].ctid;
        const lock = (await witness.client.query('SELECT pids,modes FROM pgrowlocks($1) WHERE locked_row=$2::tid', [`public.${row.table}`, ctid])).rows[0];
        expect({ table: row.table, pids: lock?.pids }).toEqual({ table: row.table, pids: expect.arrayContaining([pid]) });
      }
      // Existing SET NULL effects were staged, retaining history before keys.
      expect((await witness.client.query('SELECT business_profile_id FROM business_profile_membership_audit WHERE id=$1', [audit])).rows[0].business_profile_id).toBeNull();
      for (const { name } of closure.rows) expect(trace.some(query => query.text.includes(`public."${name}" AS`) && query.text.includes('FOR UPDATE OF'))).toBe(true);
    };
    const response = await api('delete', `/api/settings/business-profiles/${profile}`);
    expect(response.status).toBe(200); expect(observed).toBe(true);
    const phase = trace.findIndex(query => query.params.some(value => typeof value === 'string' && value.startsWith('storage-object:')));
    expect(phase).toBeGreaterThan(0);
    expect(trace.slice(phase).some(query => /(?:UPDATE|INSERT INTO|DELETE FROM) (?:workspace_(?:setup_drafts|website_analysis_jobs)|brand_toolkits|business_profile_(?:preferences|memberships|membership_audit))\b/.test(query.text))).toBe(false);
    for (const row of rows) expect((await admin.query(`SELECT id FROM public."${row.table}" WHERE id=$1`, [row.id])).rowCount).toBe(0);
    expect((await admin.query('SELECT business_profile_id FROM business_profile_membership_audit WHERE id=$1', [audit])).rows[0].business_profile_id).toBeNull();
  });

  it('releases both actual Brand owners in the same final batch and deletes shared bytes once', async () => {
    const file = await upload(); await brandFor(file.url); await brandFor(file.url);
    expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(2);
    const deletion = jest.spyOn(objects, 'delete');
    try {
      expect((await api('delete', `/api/settings/business-profiles/${profile}`)).status).toBe(200);
      expect(deletion.mock.calls.filter(([key]) => key === file.storageKey)).toHaveLength(1);
      expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(0);
      expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 });
    } finally { deletion.mockRestore(); }
  });

  it('prelocks the complete object set and storage IDs before removing multiple revisions', async () => {
    const files = [];
    for (const name of ['z-last-key', 'a-first-key']) files.push(await scope(() => service.upload(Buffer.from('Synthetic reversed key bytes'), {
      userId: owner, category: 'brand_asset', originalName: 'synthetic.txt', mimeType: 'text/plain', referenceType: 'brand_toolkit_logo', storageKey: `${owner}/brand_asset/${name}.txt`,
    })));
    const created = await api('post', '/api/content/brand-toolkits').send({ name: 'Synthetic multiple revisions', logoUrls: files.map(file => file.url) }); expect(created.status).toBe(201);
    const keys: string[] = [], rowLocks: unknown[][] = [];
    beforeQuery = async query => {
      for (const param of query.params) if (typeof param === 'string' && param.startsWith('storage-object:')) keys.push(param);
      if (/SELECT id FROM storage_files/.test(query.text) && /ORDER BY id FOR UPDATE/.test(query.text)) rowLocks.push(query.params);
    };
    expect((await api('delete', `/api/settings/business-profiles/${profile}`)).status).toBe(200);
    expect(keys.slice(0, 2)).toEqual([...keys.slice(0, 2)].sort());
    expect(rowLocks[0]?.slice(2)).toEqual(files.map(file => file.fileId).sort((a, b) => a - b));
    for (const file of files) expect(await objects.exists(file.storageKey)).toBe(false);
  });

  it('commits deletion before rejecting a waiting durable writer without reacquiring an object', async () => {
    const file = await upload(); await brandFor(file.url);
    const ready = gate(), finish = gate();
    afterQuery = async query => {
      if (/^DELETE FROM company_settings WHERE id=/.test(query.text)) { ready.release(); await finish.promise; }
    };
    const deletion = jest.spyOn(objects, 'delete');
    const removal = api('delete', `/api/settings/business-profiles/${profile}`).then(response => response);
    await ready.promise;
    const { lockManagedStorageReferences, syncManagedStorageOwners } = await import('../services/managedStorageReferences.js');
    const registration = scope(() => database.transaction(async tx => {
      await lockManagedStorageReferences(tx, { userId: owner, businessProfileId: profile });
      const saved = await tx.execute(sql`INSERT INTO content_templates(user_id,business_profile_id,name,type,content)
        VALUES(${owner},${profile},'Late synthetic owner','email','Synthetic') RETURNING id`);
      await syncManagedStorageOwners(tx, { entries: [{ owner: { kind: 'content_template', id: String(saved.rows[0].id), userId: owner, businessProfileId: profile }, urls: [file.url] }] });
    })).then(() => ({ accepted: true }), () => ({ accepted: false }));
    try {
      await waitForLock(); expect(deletion).not.toHaveBeenCalled(); expect(await objects.exists(file.storageKey)).toBe(true);
      finish.release(); expect((await removal).status).toBe(200); expect((await registration).accepted).toBe(false);
      expect((await admin.query("SELECT id FROM content_templates WHERE user_id=$1 AND name='Late synthetic owner'", [owner])).rowCount).toBe(0);
      expect((await admin.query('SELECT * FROM storage_managed_references WHERE storage_file_id=$1', [file.fileId])).rowCount).toBe(0);
      expect(deletion.mock.calls.filter(([key]) => key === file.storageKey)).toHaveLength(1);
    } finally { finish.release(); await Promise.allSettled([removal, registration]); deletion.mockRestore(); }
  });

  it('preserves owner isolation for staff, foreign users and missing authentication', async () => {
    const file = await upload(); await brandFor(file.url);
    const users = await admin.query("INSERT INTO users(email,name,is_verified,is_approved,is_setup_complete) VALUES($1,'Synthetic member',true,true,true),($2,'Synthetic foreign',true,true,true) RETURNING id,email", [`member-${randomUUID()}@example.invalid`, `foreign-${randomUUID()}@example.invalid`]);
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')", [profile, users.rows[0].id, users.rows[0].email]);
    const { generateToken } = await import('../utils/jwt.js');
    const deletion = jest.spyOn(objects, 'delete');
    try {
      for (const user of users.rows) expect((await request(app).delete(`/api/settings/business-profiles/${profile}`).set('Authorization', `Bearer ${generateToken({ userId: Number(user.id), email: user.email })}`).set('X-Business-Profile-Id', String(profile))).status).toBe(404);
      expect((await request(app).delete(`/api/settings/business-profiles/${profile}`)).status).toBe(401);
      expect(deletion).not.toHaveBeenCalled(); expect(await objects.exists(file.storageKey)).toBe(true);
    } finally { deletion.mockRestore(); }
  });

  it.each([false, true])('retains compatible deletion without registered holders (setup file: %s)', async hasFile => {
    const file = hasFile ? await upload() : undefined;
    expect((await api('delete', `/api/settings/business-profiles/${profile}`)).status).toBe(200);
    expect((await admin.query('SELECT id FROM company_settings WHERE id=$1', [profile])).rowCount).toBe(0);
    expect((await admin.query('SELECT default_business_profile_id FROM business_profile_preferences WHERE user_id=$1', [owner])).rows[0].default_business_profile_id).toBeNull();
    if (file) { expect(await objects.exists(file.storageKey)).toBe(false); expect(await usage()).toMatchObject({ storage_used_bytes: '0', file_count: 0 }); }
  });

  it('returns a retry conflict while the actual analysis commit holds the inverse profile lock', async () => {
    const file = await upload(); await brandFor(file.url); const job = await setupWork();
    const locked = gate(), finish = gate(), attempted = gate(); let analysisHasLock = false;
    beforeQuery = async query => {
      if (analysisHasLock && /pg_(?:try_)?advisory_xact_lock\(740322/.test(query.text)) attempted.release();
    };
    afterQuery = async query => {
      if (!analysisHasLock && /pg_advisory_xact_lock\(740322/.test(query.text)) { analysisHasLock = true; locked.release(); await finish.promise; }
    };
    const { processWorkspaceWebsiteAnalysis } = await import('../services/workspaceWebsiteAnalysisJobs.js');
    const analysis = scope(() => processWorkspaceWebsiteAnalysis({ data: { analysisJobId: job }, opts: { attempts: 1 } })).then(() => true, () => false);
    await locked.promise;
    const removal = api('delete', `/api/settings/business-profiles/${profile}`).then(response => response);
    try {
      await attempted.promise;
      const response = await Promise.race([removal, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 500))]);
      expect(response?.status).toBe(409);
      finish.release(); expect(await analysis).toBe(true);
      expect((await admin.query("SELECT id FROM knowledge_base WHERE user_id=$1 AND title='Synthetic analysis commit'", [owner])).rowCount).toBe(1);
      expect((await admin.query('SELECT id FROM company_settings WHERE id=$1', [profile])).rowCount).toBe(1);
      expect(await objects.exists(file.storageKey)).toBe(true);
    } finally { finish.release(); await Promise.allSettled([analysis, removal]); }
  });

  it('preserves PostgreSQL default-recovery ordering for nullable legacy timestamps', async () => {
    await admin.query("INSERT INTO company_settings(user_id,company_name,is_default,is_approved,updated_at) VALUES($1,'Synthetic recent',false,true,now())", [owner]);
    const legacy = Number((await admin.query("INSERT INTO company_settings(user_id,company_name,is_default,is_approved,updated_at) VALUES($1,'Synthetic nullable legacy',false,true,NULL) RETURNING id", [owner])).rows[0].id);
    expect((await api('delete', `/api/settings/business-profiles/${profile}`)).status).toBe(200);
    expect((await admin.query('SELECT id FROM company_settings WHERE user_id=$1 AND is_default', [owner])).rows.map(row => Number(row.id))).toEqual([legacy]);
    expect(Number((await admin.query('SELECT default_business_profile_id FROM business_profile_preferences WHERE user_id=$1', [owner])).rows[0].default_business_profile_id)).toBe(legacy);
  });
});
