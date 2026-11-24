import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import express from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';

// Inject only the real fixture connection. Canonical Storage APIs, SQL, locks,
// migrations, model transactions and the local object backend remain real.
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = database[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const local = process.env.CONTENT_MANAGED_LOCAL_QA === '1' ? describe : describe.skip;

local('Content durable references on real PostgreSQL and actual local bytes', () => {
  let bootstrap: Pool, admin: Pool, runtime: Pool, root: string;
  let owner: number, profile: number, otherProfile: number, payer: number;
  const name = `content_bcs02_${process.pid}`;
  let templates: typeof import('../models/contentTemplates/functions.js');
  let assets: (typeof import('../models/contentAssets/functions.js'))['ContentAssetModel'];
  let storage: (typeof import('../services/StorageService.js'))['storageService'];
  let objects: (typeof import('../services/ObjectStorageService.js'))['objectStorage'];
  const blocked: string[] = [];
  const scope = <T>(work: () => T) => withBusinessScope({ userId: owner, businessProfileId: profile },
    () => withBillingScope({ organizationId: payer, actorUserId: owner, businessProfileId: profile, businessOwnerUserId: owner }, work));
  const brand = (url: string) => ({ brandToolkit: { logoUrl: url, logoUrls: [url] } });
  const input = (url: string) => ({ userId: owner, businessProfileId: profile, name: 'Synthetic template', type: 'email',
    content: 'Synthetic copy', brandContextSnapshot: brand(url) });
  const assetInput = (url: string) => ({ userId: owner, businessProfileId: profile, type: 'email', channel: 'email',
    title: 'Synthetic asset', content: 'Synthetic copy', status: 'draft', brandContextSnapshot: brand(url) });
  async function file(label: string, selectedProfile = profile) {
    const key = `${owner}/brand_asset/${label}.txt`;
    const bytes = Buffer.from(`synthetic ${label}`);
    const url = await objects.upload(key, bytes, 'text/plain');
    const row = (await withBusinessScope({ userId: owner, businessProfileId: selectedProfile }, () => database.execute(sql`
      INSERT INTO storage_files(user_id,business_profile_id,file_name,storage_key,storage_backend,url,file_size_bytes,category)
      VALUES(${owner},${selectedProfile},${key},${key},'local',${url},${bytes.length},'brand_asset') RETURNING id`))).rows[0];
    await admin.query(`INSERT INTO storage_quotas(user_id,storage_used_bytes,file_count) VALUES($1,$2,1)
      ON CONFLICT(user_id) DO UPDATE SET storage_used_bytes=storage_quotas.storage_used_bytes+$2,file_count=storage_quotas.file_count+1`, [owner, bytes.length]);
    return { id: Number(row.id), key, url, bytes };
  }
  const edges = async () => (await admin.query(`SELECT reference_type,reference_id,storage_file_id FROM storage_managed_references WHERE user_id=$1
    ORDER BY reference_type,reference_id,storage_file_id`, [owner])).rows;
  async function receiptCount() { return Number((await admin.query('SELECT count(*) FROM content_request_receipts WHERE user_id=$1', [owner])).rows[0].count); }

  beforeAll(async () => {
    if (process.env.CONTENT_MANAGED_PG_PORT !== '55267') throw Error('Explicit disposable Content PostgreSQL fixture required');
    const connect = net.Socket.prototype.connect;
    jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      const host = options && typeof options === 'object' ? (options as { host?: string }).host : typeof args[1] === 'string' ? args[1] : undefined;
      if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) { blocked.push(host); throw Error('Content fixture refused an external socket'); }
      return Reflect.apply(connect, this, args) as net.Socket;
    });
    const connection = { host: '127.0.0.1', port: 55267, user: 'postgres', password: '', connectionTimeoutMillis: 3000 };
    bootstrap = new Pool({ ...connection, database: 'postgres', max: 1 });
    await bootstrap.query(`CREATE DATABASE ${name}`);
    admin = new Pool({ ...connection, database: name, max: 4 });
    runtime = createBusinessScopedPool(new Pool({ ...connection, database: name, max: 10 }));
    database = drizzle(runtime);
    root = await mkdtemp(join(tmpdir(), 'content-managed-objects-'));
    process.env.LOCAL_STORAGE_PATH = root;
    process.env.STORAGE_BACKEND = 'local';
    // Model columns come from actual Drizzle schemas. Only unrelated FKs and
    // billing provisioning defaults are omitted in this bounded fixture.
    const tables = [
      (await import('../models/companySettings/schema.js')).companySettings,
      (await import('../models/brandToolkits/schema.js')).brandToolkitsTable,
      (await import('../models/contentAssets/schema.js')).contentAssetsTable,
      (await import('../models/contentTemplates/schema.js')).contentTemplatesTable,
      (await import('../models/contentTemplates/schema.js')).contentTemplateVersionsTable,
      (await import('../models/storageFiles/schema.js')).storageFilesTable,
      (await import('../models/storageQuotas/schema.js')).storageQuotasTable,
      (await import('../models/socialPublishAttempts/schema.js')).socialPublishAttemptsTable,
    ];
    const dialect = new PgDialect();
    await admin.query('CREATE TABLE users(id serial PRIMARY KEY,email text)');
    for (const table of tables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        let defaultSql = '';
        if (column.default instanceof SQL) defaultSql = dialect.sqlToQuery(column.default).sql;
        else if (column.default !== undefined) defaultSql = typeof column.default === 'object'
          ? `'${JSON.stringify(column.default).replaceAll("'", "''")}'::jsonb`
          : typeof column.default === 'string' ? `'${column.default.replaceAll("'", "''")}'` : String(column.default);
        if (defaultSql.includes('app_')) defaultSql = '';
        const type = column.getSQLType().includes('identity') ? 'bigserial' : column.getSQLType();
        return `"${column.name}" ${type}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql ? ` DEFAULT ${defaultSql}` : ''}`;
      });
      await admin.query(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    await admin.query(`ALTER TABLE storage_quotas ADD UNIQUE(user_id);
      ALTER TABLE content_template_versions ADD FOREIGN KEY(template_id) REFERENCES content_templates(id) ON DELETE CASCADE;
      CREATE UNIQUE INDEX template_version_uq ON content_template_versions(template_id,version);
      CREATE TABLE content_request_receipts(business_profile_id integer,user_id integer,request_key text,request_hash text,state text,status_code integer,
        response_body jsonb,completed_at timestamptz,PRIMARY KEY(business_profile_id,user_id,request_key))`);
    const isolationPath = '../migrations/299_business_profile_isolation.js';
    const managedPath = '../migrations/480_storage_managed_references.js';
    const isolation = await import(isolationPath), managed = await import(managedPath);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await isolation.up(client);
      await client.query(`CREATE TABLE billing_organizations(id serial PRIMARY KEY);
        GRANT SELECT,INSERT,UPDATE,DELETE ON billing_organizations TO salesmarketing_business_runtime;
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO salesmarketing_business_runtime`);
      await managed.up(client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    templates = await import('../models/contentTemplates/functions.js');
    ({ ContentAssetModel: assets } = await import('../models/contentAssets/functions.js'));
    ({ storageService: storage } = await import('../services/StorageService.js'));
    ({ objectStorage: objects } = await import('../services/ObjectStorageService.js'));
  }, 30000);
  beforeEach(async () => {
    owner = Number((await admin.query("INSERT INTO users(email) VALUES('synthetic@example.invalid') RETURNING id")).rows[0].id);
    payer = Number((await admin.query('INSERT INTO billing_organizations DEFAULT VALUES RETURNING id')).rows[0].id);
    [profile, otherProfile] = (await admin.query(`INSERT INTO company_settings(user_id,billing_organization_id,name,company_name,is_default)
      VALUES($1,$2,'Alpha','Synthetic Alpha',true),($1,$2,'Beta','Synthetic Beta',false) RETURNING id`, [owner, payer])).rows.map(row => Number(row.id));
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await runtime?.end(); await admin?.end();
    if (bootstrap) { await bootstrap.query(`DROP DATABASE ${name}`); await bootstrap.end(); }
    if (root) await rm(root, { recursive: true, force: true });
    expect(blocked).toEqual([]);
  });

  it('registers the current template and each persisted version with its actual history row ID', async () => {
    const logo = await file('template-logo');
    const saved = await scope(() => templates.createContentTemplate(input(logo.url)));
    const versions = await scope(() => templates.getContentTemplateVersionsForUser(saved.id, owner));
    expect(await edges()).toEqual([
      { reference_type: 'content_template', reference_id: String(saved.id), storage_file_id: logo.id },
      { reference_type: 'content_template_version', reference_id: String(versions[0].id), storage_file_id: logo.id },
    ]);
  });

  it('rolls back template, history and completed receipt when canonical registration rejects a private foreign revision', async () => {
    const foreign = await file('foreign', otherProfile);
    await expect(scope(() => templates.createContentTemplate(input(`/api/settings/storage/files/${foreign.id}/download`),
      { key: 'synthetic-create', hash: 'synthetic-hash' }))).rejects.toThrow('unavailable');
    expect(Number((await admin.query('SELECT count(*) FROM content_templates WHERE user_id=$1', [owner])).rows[0].count)).toBe(0);
    expect(Number((await admin.query('SELECT count(*) FROM content_template_versions WHERE user_id=$1', [owner])).rows[0].count)).toBe(0);
    expect(await receiptCount()).toBe(0);
    expect(await edges()).toEqual([]);
    expect(await objects.download(foreign.key)).toEqual(foreign.bytes);
  });

  it('keeps a frozen historical template logo through replacement and releases all version owners only on deletion', async () => {
    const a = await file('history-a'), b = await file('history-b');
    const saved = await scope(() => templates.createContentTemplate(input(a.url)));
    await scope(() => templates.updateContentTemplateForUser(saved.id, owner, { brandContextSnapshot: brand(b.url) }, 1));
    await scope(() => templates.approveContentTemplateForUser(saved.id, owner, undefined, 2));
    expect(await scope(() => storage.deleteFile(a.id, owner))).toBe(false);
    expect(await objects.download(a.key)).toEqual(a.bytes);
    expect((await edges()).filter(edge => edge.storage_file_id === a.id)).toHaveLength(1);
    expect((await edges()).filter(edge => edge.storage_file_id === b.id)).toHaveLength(3);
    expect(await scope(() => templates.deleteContentTemplateForUser(saved.id, owner))).toBe(true);
    expect(await edges()).toEqual([]);
    expect(await scope(() => storage.deleteFile(a.id, owner))).toBe(true);
    expect(await objects.exists(a.key)).toBe(false);
  });

  it('rolls back a template replacement and approval history when registration fails', async () => {
    const logo = await file('rollback-old'), foreign = await file('rollback-foreign', otherProfile);
    const saved = await scope(() => templates.createContentTemplate(input(logo.url)));
    const before = await edges();
    const forbidden = brand(`/api/settings/storage/files/${foreign.id}/download`);
    await expect(scope(() => templates.updateContentTemplateForUser(saved.id, owner, { brandContextSnapshot: forbidden }, 1))).rejects.toThrow('unavailable');
    await expect(scope(() => templates.approveContentTemplateForUser(saved.id, owner,
      { businessProfileId: profile, brandToolkitId: 19, brandContextSnapshot: forbidden }, 1))).rejects.toThrow('unavailable');
    expect(await scope(() => templates.getContentTemplateById(saved.id))).toMatchObject({ version: 1, isApproved: false, brandContextSnapshot: brand(logo.url) });
    expect(await scope(() => templates.getContentTemplateVersionsForUser(saved.id, owner))).toHaveLength(1);
    expect(await edges()).toEqual(before);
    expect(await objects.download(logo.key)).toEqual(logo.bytes);
  });

  it('retains shared template bytes when one template and all its historical owners are deleted', async () => {
    const logo = await file('shared-templates');
    const a = await scope(() => templates.createContentTemplate(input(logo.url)));
    const b = await scope(() => templates.duplicateContentTemplate(a.id, owner));
    expect(b).not.toBeNull();
    await scope(() => templates.deleteContentTemplateForUser(a.id, owner));
    expect(await edges()).toHaveLength(2);
    expect(await scope(() => storage.deleteFile(logo.id, owner))).toBe(false);
    expect(await objects.download(logo.key)).toEqual(logo.bytes);
    await scope(() => templates.deleteContentTemplateForUser(b!.id, owner));
    expect(await edges()).toEqual([]);
    expect(await scope(() => storage.deleteFile(logo.id, owner))).toBe(true);
  });

  it('replays one completed template receipt without another domain, history or reference write', async () => {
    const logo = await file('receipt-logo');
    const request = { key: 'synthetic-replay', hash: 'same-synthetic-content' };
    const first = await scope(() => templates.createContentTemplate(input(logo.url), request));
    const again = await scope(() => templates.createContentTemplate(input(logo.url), request));
    expect(again.id).toBe(first.id);
    expect(await receiptCount()).toBe(1);
    expect(await scope(() => templates.getContentTemplateVersionsForUser(first.id, owner))).toHaveLength(1);
    expect(await edges()).toHaveLength(2);
  });

  it('keeps predefined admin templates global without fabricating a business owner', async () => {
    const logo = await file('global-not-adopted');
    const global = await withSystemScope('synthetic predefined Content test', () => templates.createContentTemplate({
      userId: null, businessProfileId: null, isPredefined: true, isApproved: true,
      name: 'Global synthetic', type: 'email', content: 'Global copy', brandContextSnapshot: brand(logo.url),
    }));
    expect(global.businessProfileId).toBeNull();
    expect((await admin.query('SELECT business_profile_id FROM content_template_versions WHERE template_id=$1', [global.id])).rows).toEqual([{ business_profile_id: null }]);
    expect(await edges()).toEqual([]);
    const imported = await scope(() => templates.duplicateContentTemplate(global.id, owner,
      { businessProfileId: profile, brandToolkitId: 20, brandContextSnapshot: brand(logo.url) }));
    expect(imported?.businessProfileId).toBe(profile);
    expect(await edges()).toHaveLength(2);
    await withSystemScope('synthetic predefined Content removal', () => templates.deleteContentTemplate(global.id));
    expect(await edges()).toHaveLength(2);
  });

  it('does not gain an edge or cross-business capability for an unresolved public URL', async () => {
    const foreign = await file('public-foreign', otherProfile);
    await scope(() => templates.createContentTemplate(input(foreign.url)));
    expect(await edges()).toEqual([]);
    expect(await objects.download(foreign.key)).toEqual(foreign.bytes);
  });

  it('registers a current asset with its frozen brand, current media and saved reviewed snapshot', async () => {
    const a = await file('asset-brand'), b = await file('asset-media'), c = await file('reviewed-thumbnail');
    const saved = await scope(() => assets.create({ ...assetInput(a.url), imageUrl: b.url,
      metadata: { reviewedPublishSnapshot: { youtubeOptions: { thumbnailUrl: c.url }, brandContextSnapshot: brand(a.url) } } }));
    expect(await edges()).toEqual([a, b, c].map(item => ({ reference_type: 'content_asset', reference_id: String(saved.id), storage_file_id: item.id })));
    expect(await scope(() => storage.deleteFile(a.id, owner))).toBe(false);
    expect(await objects.download(a.key)).toEqual(a.bytes);
  });

  it('rolls back a current asset create and replacement on canonical rejection', async () => {
    const a = await file('asset-old'), foreign = await file('asset-foreign', otherProfile);
    const unavailable = `/api/settings/storage/files/${foreign.id}/download`;
    await expect(scope(() => assets.create(assetInput(unavailable)))).rejects.toThrow('unavailable');
    expect(Number((await admin.query('SELECT count(*) FROM content_assets WHERE user_id=$1', [owner])).rows[0].count)).toBe(0);
    const saved = await scope(() => assets.create(assetInput(a.url)));
    const before = await edges();
    await expect(scope(() => assets.updateForUser(saved.id, owner, { brandContextSnapshot: brand(unavailable) }))).rejects.toThrow('unavailable');
    expect(await scope(() => assets.findByIdForUser(saved.id, owner))).toMatchObject({ brandContextSnapshot: brand(a.url) });
    expect(await edges()).toEqual(before);
  });

  it('replaces and releases asset owners while retaining a shared template logo and quota', async () => {
    const a = await file('asset-shared'), b = await file('asset-replacement');
    const template = await scope(() => templates.createContentTemplate(input(a.url)));
    const saved = await scope(() => assets.create(assetInput(a.url)));
    const quota = (await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0];
    await scope(() => assets.update(saved.id, { brandContextSnapshot: brand(b.url) }));
    expect((await edges()).filter(edge => edge.storage_file_id === a.id)).toHaveLength(2);
    expect((await edges()).filter(edge => edge.storage_file_id === b.id)).toHaveLength(1);
    await scope(() => assets.deleteForUser(saved.id, owner));
    expect((await edges()).filter(edge => edge.reference_type === 'content_asset')).toEqual([]);
    expect(await scope(() => storage.deleteFile(a.id, owner))).toBe(false);
    expect((await admin.query('SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0]).toEqual(quota);
    expect(await objects.download(a.key)).toEqual(a.bytes);
    await scope(() => templates.deleteContentTemplate(template.id));
    expect(await scope(() => storage.deleteFile(a.id, owner))).toBe(true);
    expect(await objects.exists(a.key)).toBe(false);
  });

  async function controllerApp(logo: string) {
    await admin.query('UPDATE company_settings SET is_approved=true WHERE id=$1', [profile]);
    const toolkit = (await scope(() => database.execute(sql`INSERT INTO brand_toolkits(user_id,business_profile_id,name,is_default,is_approved,logo_url)
      VALUES(${owner},${profile},'Synthetic approved toolkit',true,true,${logo}) RETURNING id`))).rows[0];
    const { createContentAsset, publishContentAsset } = await import('../controllers/contentAssetController.js');
    const { createContentTemplate } = await import('../controllers/contentTemplatesController.js');
    const app = express();
    app.use(express.json());
    // Synthetic authenticated authority; actual production handler, context
    // resolver, model SQL and source-template transaction. Not full auth/router.
    app.post('/api/content/assets', (req, res) => scope(() => {
      req.user = { id: owner } as NonNullable<typeof req.user>;
      return createContentAsset(req, res);
    }));
    app.post('/api/content/templates', (req, res) => scope(() => {
      req.user = { id: owner } as NonNullable<typeof req.user>;
      return createContentTemplate(req, res);
    }));
    app.post('/api/content/assets/:assetId/publish', (req, res) => scope(() => {
      req.user = { id: owner } as NonNullable<typeof req.user>;
      return publishContentAsset(req, res);
    }));
    return { app, toolkitId: Number(toolkit.id) };
  }

  it('registers the asset created inside the real source-template controller transaction', async () => {
    const logo = await file('source-template-logo');
    const source = await scope(() => templates.createContentTemplate(input(logo.url)));
    const { app, toolkitId } = await controllerApp(logo.url);
    const created = await request(app).post('/api/content/assets').send({ type: 'email', channel: 'email', status: 'draft',
      title: 'Source-template asset', content: 'Synthetic copy', brandToolkitId: toolkitId, sourceTemplateId: source.id, sourceTemplateVersion: 1 });
    expect({ status: created.status, error: created.body.error }).toEqual({ status: 201, error: undefined });
    expect((await edges()).filter(edge => edge.reference_type === 'content_asset')).toEqual([
      { reference_type: 'content_asset', reference_id: String(created.body.id), storage_file_id: logo.id },
    ]);
  });

  it('rolls back the source-template controller asset when its frozen brand revision is unavailable', async () => {
    const source = await scope(() => templates.createContentTemplate(input('https://external.example.invalid/logo.png')));
    const foreign = await file('source-template-foreign', otherProfile);
    const { app, toolkitId } = await controllerApp(`/api/settings/storage/files/${foreign.id}/download`);
    const created = await request(app).post('/api/content/assets').send({ type: 'email', channel: 'email', status: 'draft',
      title: 'Must roll back', content: 'Synthetic copy', brandToolkitId: toolkitId, sourceTemplateId: source.id, sourceTemplateVersion: 1 });
    expect(created.status).toBe(409);
    expect(Number((await admin.query('SELECT count(*) FROM content_assets WHERE user_id=$1', [owner])).rows[0].count)).toBe(0);
    expect(await edges()).toEqual([]);
    expect(await objects.download(foreign.key)).toEqual(foreign.bytes);
  });

  it('returns a useful template conflict and rolls back the actual HTTP controller request', async () => {
    const foreign = await file('http-template-foreign', otherProfile);
    const { app, toolkitId } = await controllerApp(`/api/settings/storage/files/${foreign.id}/download`);
    const created = await request(app).post('/api/content/templates').send({ name: 'Synthetic template request', type: 'email',
      content: 'Synthetic copy', brandToolkitId: toolkitId });
    expect(created.status).toBe(409);
    expect(created.body.code).toBe('STORAGE_REFERENCE_CONFLICT');
    expect(Number((await admin.query('SELECT count(*) FROM content_templates WHERE user_id=$1', [owner])).rows[0].count)).toBe(0);
    expect(await edges()).toEqual([]);
  });

  it('allows status-only recovery after an existing authorized Storage revocation without re-adopting bytes', async () => {
    const logo = await file('revoked-logo');
    const saved = await scope(() => assets.create(assetInput(`/api/settings/storage/files/${logo.id}/download`)));
    expect(await scope(() => storage.deleteFile(logo.id, owner, undefined, 'storage_delete'))).toBe(true);
    expect(await objects.exists(logo.key)).toBe(false);
    expect(await scope(() => assets.updateForUser(saved.id, owner, { status: 'failed', lastError: 'Synthetic provider result' }))).toMatchObject({ status: 'failed' });
    expect(await edges()).toEqual([]);
    await scope(() => assets.delete(saved.id));
  });

  async function waitForLock(queryPart: string) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const { rows } = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
        AND query ILIKE $2 LIMIT 1`, [name, `%${queryPart}%`]);
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Expected synthetic PostgreSQL lock wait was not observed');
  }

  it('serializes writer-first asset registration against concurrent upload compensation and preserves actual bytes', async () => {
    const logo = await file('writer-first');
    await admin.query(`CREATE FUNCTION content_fixture_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.title='Synthetic paused writer' THEN PERFORM pg_advisory_xact_lock(724918); END IF; RETURN NEW; END $$;
      CREATE TRIGGER content_fixture_wait BEFORE INSERT ON content_assets FOR EACH ROW EXECUTE FUNCTION content_fixture_wait()`);
    const gate = await admin.connect();
    await gate.query('BEGIN'); await gate.query('SELECT pg_advisory_xact_lock(724918)');
    const writer = scope(() => assets.create({ ...assetInput(logo.url), title: 'Synthetic paused writer' }));
    void writer.catch(() => undefined);
    let compensation: Promise<boolean> | undefined;
    try {
      await waitForLock('insert into "content_assets"');
      compensation = scope(() => storage.compensateFailedUpload({ userId: owner, businessProfileId: profile }, logo.id));
      void compensation.catch(() => undefined);
      await waitForLock('SELECT o.id FROM billing_organizations');
    } finally {
      await gate.query('COMMIT'); gate.release();
      await Promise.allSettled([writer, ...(compensation ? [compensation] : [])]);
      await admin.query('DROP TRIGGER content_fixture_wait ON content_assets; DROP FUNCTION content_fixture_wait()');
    }
    expect(await writer).toMatchObject({ title: 'Synthetic paused writer' });
    expect(await compensation).toBe(false);
    expect(await edges()).toHaveLength(1);
    expect(await objects.download(logo.key)).toEqual(logo.bytes);
    expect((await admin.query('SELECT file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0].file_count).toBe(1);
  });

  it('rejects a late asset writer when concurrent cleanup commits first, then consumes the real durable intent', async () => {
    const logo = await file('cleanup-first');
    let release!: () => void, signal!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const claimed = new Promise<void>(resolve => { signal = resolve; });
    const deletion = scope(() => database.transaction(async tx => {
      const result = await storage.claimFileDeletion(tx, logo.id, owner);
      signal(); await hold;
      return result;
    }));
    void deletion.catch(() => undefined);
    await claimed;
    const writer = scope(() => assets.create(assetInput(`/api/settings/storage/files/${logo.id}/download`)));
    void writer.catch(() => undefined);
    try { await waitForLock('SELECT o.id FROM billing_organizations'); }
    finally { release(); await Promise.allSettled([deletion, writer]); }
    expect(await deletion).not.toBeNull();
    await expect(writer).rejects.toThrow('unavailable');
    expect(Number((await admin.query('SELECT count(*) FROM content_assets WHERE user_id=$1', [owner])).rows[0].count)).toBe(0);
    expect(await scope(() => storage.flushManagedStorageCleanup({ userId: owner, businessProfileId: profile }, [logo.id]))).toEqual({ processed: 1, remaining: 0 });
    expect(await objects.exists(logo.key)).toBe(false);
    expect((await admin.query('SELECT file_count FROM storage_quotas WHERE user_id=$1', [owner])).rows[0].file_count).toBe(0);
  });

  it('compensates an upload only after rejected asset registration has rolled back', async () => {
    const upload = await file('failed-upload'), foreign = await file('failed-upload-foreign', otherProfile);
    await expect(scope(() => assets.create({ ...assetInput(upload.url), imageUrl: `/api/settings/storage/files/${foreign.id}/download` }))).rejects.toThrow('unavailable');
    expect(await edges()).toEqual([]);
    expect(await scope(() => storage.compensateFailedUpload({ userId: owner, businessProfileId: profile }, upload.id))).toBe(true);
    expect(await objects.exists(upload.key)).toBe(false);
    expect(await objects.download(foreign.key)).toEqual(foreign.bytes);
  });

  it('atomically replaces the retained Twitter schedule and releases deleted child owners in one complete batch', async () => {
    const old = await file('scheduled-old'), current = await file('scheduled-current');
    const { app, toolkitId } = await controllerApp(current.url);
    const saved = await scope(() => assets.create({ ...assetInput(old.url), type: 'social_post', channel: 'twitter',
      content: JSON.stringify({ caption: 'Synthetic scheduled copy' }), brandToolkitId: toolkitId }));
    const child = await scope(() => assets.create({ ...assetInput(old.url), type: 'social_post', channel: 'twitter', status: 'scheduled', parentAssetId: saved.id }));
    const result = await request(app).post(`/api/content/assets/${saved.id}/publish`).send({ platform: 'twitter', scheduledFor: new Date(Date.now() + 3600000).toISOString() });
    expect({ status: result.status, error: result.body.error }).toEqual({ status: 200, error: undefined });
    expect(await scope(() => assets.findByIdForUser(child.id, owner))).toBeUndefined();
    expect(await edges()).toEqual([{ reference_type: 'content_asset', reference_id: String(saved.id), storage_file_id: current.id }]);
    expect(await scope(() => storage.deleteFile(current.id, owner))).toBe(false);
    expect(await objects.download(current.key)).toEqual(current.bytes);
  });

  it('rolls back scheduled root replacement and child deletion when the complete reference batch fails', async () => {
    const old = await file('scheduled-rollback'), foreign = await file('scheduled-unavailable', otherProfile);
    const { app, toolkitId } = await controllerApp(`/api/settings/storage/files/${foreign.id}/download`);
    const saved = await scope(() => assets.create({ ...assetInput(old.url), type: 'social_post', channel: 'twitter',
      content: JSON.stringify({ caption: 'Synthetic scheduled copy' }), brandToolkitId: toolkitId }));
    const child = await scope(() => assets.create({ ...assetInput(old.url), parentAssetId: saved.id, status: 'scheduled' }));
    const before = await edges();
    const result = await request(app).post(`/api/content/assets/${saved.id}/publish`).send({ platform: 'twitter', scheduledFor: new Date(Date.now() + 3600000).toISOString() });
    expect(result.status).toBe(409);
    expect(await scope(() => assets.findByIdForUser(saved.id, owner))).toMatchObject({ status: 'draft', brandContextSnapshot: brand(old.url) });
    expect(await scope(() => assets.findByIdForUser(child.id, owner))).toMatchObject({ status: 'scheduled' });
    expect(await edges()).toEqual(before);
    expect(await objects.download(old.key)).toEqual(old.bytes);
  });

  it('serializes concurrent template saves and refuses cross-owner and stale mutations without extra history', async () => {
    const logo = await file('concurrent-template');
    const saved = await scope(() => templates.createContentTemplate(input(logo.url)));
    const changes = await Promise.allSettled(['First', 'Second'].map(content => scope(() => templates.updateContentTemplateForUser(saved.id, owner, { content }, 1))));
    expect(changes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(changes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await scope(() => templates.updateContentTemplateForUser(saved.id, owner + 1000, { content: 'Foreign' }))).toBeNull();
    await expect(scope(() => templates.approveContentTemplateForUser(saved.id, owner, undefined, 1))).rejects.toBeInstanceOf(templates.ContentTemplateVersionConflictError);
    expect(await scope(() => templates.getContentTemplateVersionsForUser(saved.id, owner))).toHaveLength(2);
    expect(await edges()).toHaveLength(3);
  });
});
