import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { currentBusinessScope, currentDatabaseScope } from '../tenancy/businessContext.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

let fixtureDb: ReturnType<typeof drizzle>;
const proxy = new Proxy({} as typeof fixtureDb, { get: (_target, key) => {
  const value = Reflect.get(fixtureDb, key);
  return typeof value === 'function' ? value.bind(fixtureDb) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
let directory: string;
let byteReads = 0;
let duringDownload: (() => Promise<void>) | undefined;
const bytes = Buffer.from('synthetic governed derivative');
const download = jest.fn(async (id: number, owner: number) => {
  expect(currentBusinessScope()).toEqual({ kind: 'business', userId: 9, businessProfileId: 7 });
  expect((await import('../tenancy/billingContext.js')).currentBillingScope()).toBeUndefined();
  const { sql } = await import('drizzle-orm');
  const result = await fixtureDb.execute(sql`SELECT id,user_id,business_profile_id,current_user AS role,current_setting('app.business_system') AS system
    FROM storage_files WHERE id=${id} AND user_id=${owner}`);
  if (!result.rows[0]) return null;
  expect(result.rows[0]).toMatchObject({ role: 'salesmarketing_business_runtime', system: 'off', business_profile_id: 7, user_id: 9 });
  byteReads += 1;
  const buffer = await readFile(path.join(directory, 'derivative.jpg'));
  await duringDownload?.();
  return { buffer, file: { userId: Number(result.rows[0].user_id), businessProfileId: Number(result.rows[0].business_profile_id), mimeType: 'image/jpeg' } };
});
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { downloadFile: download } }));
const router = (await import('../routes/supportMediaDelivery.routes.js')).default;
const { createSupportMediaDeliveryUrl } = await import('../services/supportMedia/SupportMediaDeliveryUrl.js');
const { resolveSupportMediaSignedCapability } = await import('../services/supportMedia/SupportMediaSignedCapability.js');
const local = process.env.SUPPORT_SIGNED_SCOPE_QA === '1' ? describe : describe.skip;

local('signed public media with production scoped pool and forced PostgreSQL RLS', () => {
  let admin: Pool, fixture: Pool, runtime: Pool, schema: string;
  const app = express(); app.use('/support-media-delivery', router);
  const signed = (options: { assetId?: number; nowMs?: number } = {}) => {
    const url = new URL(createSupportMediaDeliveryUrl({ assetId: 30, checksum: 'a'.repeat(64), ...options }));
    return url.pathname + url.search;
  };
  beforeAll(async () => {
    if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '5559' || process.env.DB_NAME !== 'support_gallery_audit') {
      throw new Error('Use the explicit disposable signed-scope PostgreSQL fixture only.');
    }
    const config = { host: '127.0.0.1', port: 5559, database: 'support_gallery_audit', user: 'postgres', password: '' };
    directory = await mkdtemp(path.join(tmpdir(), 'govdocs-signed-'));
    await writeFile(path.join(directory, 'derivative.jpg'), bytes);
    schema = 'signed_media_' + randomBytes(8).toString('hex');
    admin = new Pool({ ...config, max: 1 });
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    fixture = new Pool({ ...config, options: `-c search_path=${schema},public,pg_catalog -c app.business_system=on` });
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,archived_at timestamptz,is_default boolean DEFAULT false);
      CREATE TABLE storage_files(id integer PRIMARY KEY,user_id integer);
      CREATE TABLE knowledge_index_versions(id bigint PRIMARY KEY,provider text,model text,dimensions integer,state text);
      INSERT INTO users(id) VALUES(9),(10);
      INSERT INTO company_settings(id,user_id,is_default) VALUES(7,9,false),(8,9,true),(17,10,true);
      INSERT INTO storage_files VALUES(99,9),(100,9);`);
    // @ts-expect-error Production migration is JavaScript.
    await (await import('../migrations/215_create_support_media_gallery.js')).up(fixture);
    // @ts-expect-error Production migration is JavaScript.
    await (await import('../migrations/281_support_media_review_workflows.js')).up(fixture);
    const tables = ['support_media_galleries', 'support_media_gallery_versions', 'support_media_assets', 'storage_files'];
    await localBusinessIsolation(fixture, schema, tables);
    const migration = await readFile('migrations/299_business_profile_isolation.js', 'utf8');
    const definition = migration.match(/await client\.query\(`(CREATE OR REPLACE FUNCTION enforce_business_ownership[\s\S]*?)`\);/);
    if (!definition) throw new Error('Production ownership function missing');
    await fixture.query(definition[1]);
    await fixture.query(`UPDATE storage_files SET business_profile_id=7`);
    for (const table of tables) await fixture.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('{"owner_column":"user_id","parent_links":[],"global_read":false}')`);
    runtime = createBusinessScopedPool(new Pool({ ...config, options: `-c search_path=${schema},public,pg_catalog` }));
    fixtureDb = drizzle(runtime);
  });
  afterAll(async () => {
    await runtime?.end(); await fixture?.end();
    if (admin && /^signed_media_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    download.mockClear(); duringDownload = undefined; byteReads = 0;
    await fixture.query(`TRUNCATE support_media_assets,support_media_gallery_versions,support_media_galleries RESTART IDENTITY CASCADE;
      DELETE FROM storage_files WHERE id=101;
      UPDATE users SET deleted_at=NULL; UPDATE company_settings SET archived_at=NULL; UPDATE company_settings SET user_id=9 WHERE id=7;
      INSERT INTO support_media_galleries(id,user_id,business_profile_id,title,audience,status) VALUES(2,9,7,'Synthetic','customer','active');
      INSERT INTO support_media_gallery_versions(id,user_id,business_profile_id,gallery_id,version_no,status,content_checksum,rights_certified)
      VALUES(20,9,7,2,1,'published','${'a'.repeat(64)}',true);
      UPDATE support_media_galleries SET current_published_version_id=20;
      INSERT INTO support_media_assets(id,user_id,business_profile_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,evidence_id,name,alt_text,width,height,mime_type,size_bytes,checksum,search_text,publication_state)
      VALUES(30,9,7,2,20,99,100,'signed-fixture','Synthetic','Synthetic',8,8,'image/jpeg',32,'${'a'.repeat(64)}','Synthetic','published');`);
  });
  it('returns exact valid bytes from a nondefault profile without ambient business scope', async () => {
    expect(currentDatabaseScope()).toBeUndefined();
    expect((await fixture.query('SELECT id FROM company_settings WHERE user_id=9 AND is_default=true')).rows).toEqual([{ id: 8 }]);
    const response = await request(app).get(signed());
    expect(response.status).toBe(200); expect(response.body).toEqual(bytes);
    expect(download).toHaveBeenCalledTimes(1);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(currentDatabaseScope()).toBeUndefined();
  });
  it('returns only materialized capability fields and leaves system scope without granting an actor or billing scope', async () => {
    const url = new URL('http://fixture.test' + signed());
    const capability = await resolveSupportMediaSignedCapability({ assetId: 30, expiresAt: Number(url.searchParams.get('expires')), token: url.searchParams.get('token')! });
    expect(capability).toEqual({ assetId: 30, checksum: 'a'.repeat(64), expiresAt: Number(url.searchParams.get('expires')), userId: 9, businessProfileId: 7 });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(currentDatabaseScope()).toBeUndefined();
    expect((await import('../tenancy/billingContext.js')).currentBillingScope()).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });
  it('denies expired, invalid and asset-substituted tokens without reading Storage', async () => {
    await fixture.query(`INSERT INTO support_media_assets(id,user_id,business_profile_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,evidence_id,name,alt_text,width,height,mime_type,size_bytes,checksum,search_text,publication_state)
      SELECT 31,user_id,business_profile_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,'other-signed-fixture',name,alt_text,width,height,mime_type,size_bytes,checksum,search_text,publication_state FROM support_media_assets WHERE id=30`);
    for (const path of [signed({ nowMs: Date.now() - 700_000 }), signed().replace(/token=[a-f0-9]+/, 'token=' + 'b'.repeat(64)), signed().replace('/30/', '/31/')]) {
      expect((await request(app).get(path)).status).toBe(404);
    }
    expect(download).not.toHaveBeenCalled();
  });
  it.each([
    "UPDATE support_media_galleries SET audience='internal'",
    "UPDATE support_media_galleries SET status='retired'",
    "UPDATE support_media_assets SET publication_state='quarantined'",
    "UPDATE support_media_assets SET sensitivity='internal'",
    "UPDATE support_media_assets SET checksum=repeat('b',64)",
    "UPDATE support_media_gallery_versions SET expires_at=NOW()-INTERVAL '1 minute'",
    "UPDATE company_settings SET archived_at=NOW() WHERE id=7",
    "UPDATE users SET deleted_at=NOW() WHERE id=9",
  ])('denies current revocation before bytes: %s', async (mutation) => {
    const path = signed(); await fixture.query(mutation);
    expect((await request(app).get(path)).status).toBe(404); expect(download).not.toHaveBeenCalled();
  });
  it.each([
    "UPDATE support_media_galleries SET audience='internal'",
    "UPDATE support_media_assets SET derivative_storage_file_id=99",
    "UPDATE company_settings SET archived_at=NOW() WHERE id=7",
    "UPDATE users SET deleted_at=NOW() WHERE id=9",
    "UPDATE company_settings SET user_id=10 WHERE id=7",
    "UPDATE support_media_assets SET checksum=repeat('b',64)",
    "UPDATE support_media_assets SET publication_state='quarantined'",
    "UPDATE support_media_assets SET retired_at=NOW()",
    "UPDATE support_media_assets SET mime_type='image/png'",
    "UPDATE support_media_galleries SET current_published_version_id=NULL",
    "UPDATE support_media_assets SET sensitivity='internal'",
    "UPDATE support_media_gallery_versions SET expires_at=NOW()-INTERVAL '1 minute'",
  ])('rechecks revocation after object IO: %s', async (mutation) => {
    let applied = false;
    duringDownload = async () => { await fixture.query(mutation); applied = true; };
    expect((await request(app).get(signed())).status).toBe(404);
    expect(download).toHaveBeenCalledTimes(1); expect(applied).toBe(true);
  });
  it('cannot read foreign derivative metadata or bytes through the business scope', async () => {
    await fixture.query('INSERT INTO storage_files(id,user_id,business_profile_id) VALUES(101,10,17)');
    await fixture.query('UPDATE support_media_assets SET derivative_storage_file_id=101 WHERE id=30');
    expect((await request(app).get(signed())).status).toBe(404);
    expect(download).toHaveBeenCalledTimes(1); expect(byteReads).toBe(0);
  });
  it.each([[9, 8], [10, 17]])('never switches to replacement owner/profile %i/%i after IO', async (newOwner, newProfile) => {
    await fixture.query(`INSERT INTO storage_files(id,user_id,business_profile_id) VALUES(101,$1,$2)`, [newOwner, newProfile]);
    duringDownload = async () => {
      await fixture.query(`INSERT INTO support_media_galleries(id,user_id,business_profile_id,title,audience,status) VALUES(3,$1,$2,'Replacement','customer','active')`, [newOwner, newProfile]);
      await fixture.query(`INSERT INTO support_media_gallery_versions(id,user_id,business_profile_id,gallery_id,version_no,status,content_checksum,rights_certified) VALUES(21,$1,$2,3,1,'published',repeat('a',64),true)`, [newOwner, newProfile]);
      await fixture.query('UPDATE support_media_galleries SET current_published_version_id=21 WHERE id=3');
      await fixture.query('DELETE FROM support_media_assets WHERE id=30');
      await fixture.query(`INSERT INTO support_media_assets(id,user_id,business_profile_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,evidence_id,name,alt_text,width,height,mime_type,size_bytes,checksum,search_text,publication_state)
        VALUES(30,$1,$2,3,21,101,101,'replacement-fixture','Replacement','Replacement',8,8,'image/jpeg',32,repeat('a',64),'Replacement','published')`, [newOwner, newProfile]);
    };
    expect((await request(app).get(signed())).status).toBe(404);
    expect(download).toHaveBeenCalledTimes(1);
    expect(currentDatabaseScope()).toBeUndefined();
    expect((await fixture.query('SELECT user_id,business_profile_id FROM support_media_assets WHERE id=30')).rows[0]).toEqual({ user_id: newOwner, business_profile_id: newProfile });
  });

});
