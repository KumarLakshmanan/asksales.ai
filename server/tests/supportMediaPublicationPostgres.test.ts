import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';

const localPostgres = process.env.SUPPORT_MEDIA_LOCAL_QA === '1' ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  transaction: (callback: Parameters<typeof fixtureDb.transaction>[0]) => fixtureDb.transaction(callback),
  execute: (query: Parameters<typeof fixtureDb.execute>[0]) => fixtureDb.execute(query),
} }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: {} }));
jest.unstable_mockModule('../services/supportMedia/SupportMediaSafetyService.js', () => ({
  scanSupportMedia: jest.fn(), validateSupportMediaMetadata: () => ({ safe: true }),
}));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: {} }));
const { SupportMediaGalleryService } = await import('../services/supportMedia/SupportMediaGalleryService.js');
const tables = await import('../models/supportMedia/schema.js');

localPostgres('media draft publication isolation (local isolated PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const service = new SupportMediaGalleryService();
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Media QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || process.env.DB_DATABASE,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_media_publication_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    for (const table of [tables.supportMediaGalleriesTable, tables.supportMediaGalleryVersionsTable, tables.supportMediaAssetsTable]) {
      const definition = getTableConfig(table);
      await pool.query(`CREATE TABLE "${definition.name}" (${definition.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
    }
    await pool.query(`CREATE TABLE company_settings(id integer,user_id integer);
      CREATE TABLE support_media_review_audits(id bigserial,user_id integer,asset_id bigint,decision text,reason text);
      CREATE TABLE support_media_asset_embeddings(user_id integer,asset_id bigint,index_version_id bigint,provider text,model text,dimensions integer,content_hash text,embedding text)`);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_media_publication_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE support_media_galleries,support_media_gallery_versions,support_media_assets,support_media_review_audits,company_settings RESTART IDENTITY');
    const metadata = JSON.stringify({ title: 'Live rooms', description: 'Live description', business_profile_id: null,
      audience: 'customer', allowed_channels: ['web'], usage_scopes: ['support_answer'], entity_tags: ['room'], helpful_auto_attach: true });
    await pool.query(`INSERT INTO support_media_galleries(id,user_id,title,description,status,audience,allowed_channels,usage_scopes,current_published_version_id)
      VALUES(2,9,'Live rooms','Live description','active','customer',ARRAY['web'],ARRAY['support_answer'],20);
      INSERT INTO company_settings VALUES(42,9),(43,10)`);
    await pool.query(`INSERT INTO support_media_gallery_versions(id,user_id,gallery_id,version_no,status,metadata_snapshot)
      VALUES(20,9,2,1,'published',$1),(21,9,2,2,'ready_for_review',$1)`, [metadata]);
    await pool.query(`INSERT INTO support_media_assets(id,user_id,gallery_id,gallery_version_id,evidence_id,name,publication_state,scan_results)
      VALUES(30,9,2,20,'media-live','Room','published','{}'),(31,9,2,21,'media-draft','Room','ready_for_review','{"scannerUnavailable":true}')`);
  });
  it('keeps changed title/property/audience/channels off the live gallery until owner review succeeds', async () => {
    const updated = await service.update(9, 2, { title: 'Internal property images', description: 'Draft description',
      businessProfileId: 42, audience: 'internal', allowedChannels: ['email'], helpfulAutoAttach: false, entityTags: ['villa'] });
    expect(updated).toMatchObject({ title: 'Internal property images', business_profile_id: 42, audience: 'internal', version_status: 'ready_for_review' });
    const live = (await pool.query('SELECT * FROM support_media_galleries WHERE id=2')).rows[0];
    expect(live).toMatchObject({ title: 'Live rooms', business_profile_id: null, audience: 'customer', allowed_channels: ['web'], current_published_version_id: '20' });
    await service.reviewAsset(9, 2, 31, 'approve', 'Owner checked sanitized image and privacy.');
    const published = (await pool.query('SELECT * FROM support_media_galleries WHERE id=2')).rows[0];
    expect(published).toMatchObject({ title: 'Internal property images', business_profile_id: 42, audience: 'internal', allowed_channels: ['email'], current_published_version_id: '21' });
    expect((await pool.query('SELECT * FROM support_media_review_audits')).rows).toHaveLength(1);
  });
  it('rejects a foreign property and preserves both live and draft metadata', async () => {
    await expect(service.update(9, 2, { title: 'Foreign', businessProfileId: 43 })).rejects.toThrow('not available to this tenant');
    expect(await service.get(9, 2)).toMatchObject({ title: 'Live rooms' });
    expect((await pool.query('SELECT title FROM support_media_galleries WHERE id=2')).rows[0].title).toBe('Live rooms');
  });
  it('keeps a rejected draft unavailable while preserving the previous approved version', async () => {
    await service.reviewAsset(9, 2, 31, 'reject', 'Image is not suitable for customer use.');
    expect(await service.get(9, 2)).toMatchObject({ version_status: 'quarantined' });
    expect((await pool.query('SELECT current_published_version_id FROM support_media_galleries WHERE id=2')).rows[0].current_published_version_id).toBe('20');
  });
});
