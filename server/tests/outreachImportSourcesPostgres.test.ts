import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, gt, isNull, getTableColumns } from 'drizzle-orm';
import { leadsTable } from '../models/leads/schema.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
// @ts-expect-error Custom JavaScript migration.
import * as migration from '../migrations/573_campaign_lead_imports.js';

const connectionString = process.env.OUTREACH_IMPORT_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `outreach_import_qa_${process.pid}`;
let pool: Pool;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = (database as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const syncLead = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null);
jest.unstable_mockModule('../services/CRMService.js', () => ({
  crmService: { syncLeadContact: syncLead },
  lockCrmContactResolution: async () => undefined,
}));
const { creationImportPredicate, getCreationImportSources } = await import('../services/outreach/CreationImportSources.js');
const { saveCampaignLeadImport } = await import('../services/CampaignLeadImportService.js');
const scoped = <T>(businessProfileId: number, work: () => T) => withBusinessScope({ userId: 1, businessProfileId }, work);

suite('outreach import sources against PostgreSQL', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('An explicit local QA database is required');
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}; DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN CREATE ROLE salesmarketing_business_runtime; END IF; END $$;`);
    await admin.end();
    pool = new Pool({ connectionString, options: `-c search_path=${schema},pg_catalog` });
    database = drizzle(pool);
    await pool.query(`
      CREATE FUNCTION app_business_profile_id() RETURNS int LANGUAGE SQL AS 'SELECT 10';
      CREATE FUNCTION app_business_user_id() RETURNS int LANGUAGE SQL AS 'SELECT 1';
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE SQL AS 'SELECT true';
      CREATE FUNCTION app_business_access(integer) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
      CREATE TABLE business_scope_tables(table_name text,owner_column text,global_read boolean,parent_links jsonb);
      CREATE TABLE users(id int PRIMARY KEY);
      CREATE TABLE company_settings(id int PRIMARY KEY,user_id int);
      CREATE TABLE chat_threads(id int PRIMARY KEY,user_id int,business_profile_id int,title text,deleted_at timestamp);
      CREATE TABLE leads(id int PRIMARY KEY,user_id int,business_profile_id int,source text,campaign_data jsonb,deleted_at timestamp,
        legacy_campaign_thread_key text GENERATED ALWAYS AS (CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10 THEN campaign_data->>'threadId' END) STORED);
      CREATE TABLE crm_contacts(id int PRIMARY KEY,user_id int,business_profile_id int,lead_id int,merged_into_contact_id int,deleted_at timestamp,email text);
      CREATE TABLE crm_contact_imports(id int PRIMARY KEY,user_id int,business_profile_id int,file_name text,created_at timestamp,import_status text);
      CREATE TABLE crm_contact_import_details(import_id int,business_profile_id int,created_contact_id int,status text);
      INSERT INTO users VALUES(1),(2); INSERT INTO company_settings VALUES(10,1),(20,1),(30,2);
      INSERT INTO chat_threads(id,user_id,business_profile_id,title) VALUES(11,1,10,'Campaign A'),(12,1,10,'Campaign B'),(21,1,20,'Other business');
      INSERT INTO leads VALUES
        (1,1,10,'crm_import',NULL,NULL),(2,1,10,'import','{"threadId":11,"source":"csv_import"}',NULL),
        (3,1,10,'import','{"threadId":11,"source":"csv_import"}',NULL),(4,1,10,'import','{"threadId":11,"source":"csv_import"}',NULL),
        (5,1,10,'crm_import',NULL,NULL),(6,1,20,'import','{"threadId":21,"source":"csv_import"}',NULL),
        (7,1,10,'crm_import',NULL,NULL),(8,1,10,'import','{"threadId":11,"source":"csv_import"}',NULL),
        (9,2,30,'import',NULL,NULL),(10,1,10,'crm_import',NULL,now());
      INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,merged_into_contact_id,deleted_at) VALUES(1,1,10,1,NULL,NULL),(5,1,10,5,NULL,NULL),(6,1,20,6,NULL,NULL),
        (21,1,10,8,22,now()),(22,1,10,7,NULL,NULL),(23,1,10,10,NULL,NULL);
      INSERT INTO crm_contact_imports VALUES(200,1,10,'crm-a.csv',now(),'completed'),(201,1,10,'crm-b.csv',now(),'completed'),(202,1,20,'foreign.csv',now(),'completed');
      INSERT INTO crm_contact_import_details VALUES(200,10,1,'success'),(200,10,5,'duplicate'),(200,10,23,'success'),(201,10,5,'warning'),(202,20,6,'success');
    `);
    const ownershipSource = readFileSync(new URL('../migrations/299_business_profile_isolation.js', import.meta.url), 'utf8');
    const start = ownershipSource.indexOf('CREATE OR REPLACE FUNCTION enforce_business_ownership()');
    await pool.query(ownershipSource.slice(start, ownershipSource.indexOf('END $$', start) + 6));
    const existingColumns = new Set(['id', 'user_id', 'business_profile_id', 'source', 'campaign_data', 'deleted_at']);
    for (const column of Object.values(getTableColumns(leadsTable))) {
      if (!existingColumns.has(column.name)) await pool.query(`ALTER TABLE leads ADD COLUMN "${column.name}" ${column.getSQLType()}`);
    }
    await pool.query("CREATE SEQUENCE leads_qa_id_seq START WITH 100; ALTER TABLE leads ALTER COLUMN id SET DEFAULT nextval('leads_qa_id_seq'); ALTER TABLE leads ALTER COLUMN business_profile_id SET DEFAULT 10");
    const client = await pool.connect();
    try { await client.query('BEGIN'); await migration.up(client); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await pool.query(`INSERT INTO campaign_lead_imports(id,user_id,business_profile_id,thread_id,file_name,total_records,request_fingerprint)
      VALUES(100,1,10,11,'first.csv',3,'a'),(101,1,10,12,'second.csv',1,'b'),(102,1,20,21,'private.csv',1,'c');
      INSERT INTO campaign_lead_import_members(user_id,business_profile_id,import_id,lead_id,recipient_lead_id,contact_id)
      VALUES(1,10,100,2,1,1),(1,10,100,3,3,NULL),(1,10,100,8,8,21),(1,10,101,2,1,1),(1,20,102,6,6,6)`);
    await pool.query("SELECT setval('campaign_lead_imports_id_seq',102)");
  }, 30000);
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
  });
  const ids = (filter: Parameters<typeof creationImportPredicate>[1], after = 0, limit = 100, business = 10) => scoped(business, async () => {
    const rows = await database.select({ id: leadsTable.id }).from(leadsTable).where(and(
      eq(leadsTable.userId, 1), eq(leadsTable.businessProfileId, business), isNull(leadsTable.deletedAt), gt(leadsTable.id, after),
      creationImportPredicate(1, filter),
    )).orderBy(leadsTable.id).limit(limit);
    return rows.map(row => row.id);
  });

  it('preserves UTC import instants across configured runtime time zones', async () => {
    const original = await pool.query('SELECT created_at::text AS stamp FROM crm_contact_imports WHERE id=200');
    try {
      // Run with TZ=Asia/Kolkata to cover the non-UTC production clock.
      if (process.env.TZ === 'Asia/Kolkata') expect(new Date('2026-10-28T23:00:00Z').getTimezoneOffset()).toBe(-330);
      await pool.query("UPDATE crm_contact_imports SET created_at='2026-10-28 23:00:00' WHERE id=200");
      await pool.query("INSERT INTO campaign_lead_imports(id,user_id,business_profile_id,thread_id,file_name,total_records,request_fingerprint,created_at) VALUES(398,1,10,11,'utc.csv',1,'timezone-regression','2026-10-28 23:00:00')");
      const sources = await scoped(10, () => getCreationImportSources(1));
      expect(sources.crmImports.find(batch => batch.id === 200)?.createdAt).toBe('2026-10-28T23:00:00.000Z');
      expect(sources.campaigns.flatMap(group => group.uploads).find(batch => batch.id === 398)?.createdAt).toBe('2026-10-28T23:00:00.000Z');
    } finally {
      await pool.query('DELETE FROM campaign_lead_imports WHERE id=398');
      await pool.query('UPDATE crm_contact_imports SET created_at=$1::timestamp WHERE id=200', [original.rows[0].stamp]);
    }
  });
  it('filters exact CRM receipts and excludes skipped duplicates and other businesses', async () => {
    // The recipient query separately excludes deleted leads, as it does in production.
    expect(await ids({ source: 'crm', importId: 200 })).toEqual([1]);
    expect(await ids({ source: 'crm' })).toEqual([1, 5]);
    expect(await ids({ source: 'crm', importId: 202 })).toEqual([]);
    expect(await ids({ source: 'crm', importId: 202 }, 0, 100, 20)).toEqual([6]);
  });
  it('matches each batch, merged contact and historical group without duplicates', async () => {
    expect(await ids({ source: 'campaign', campaignId: 11, importId: 100 })).toEqual([1, 3, 7]);
    expect(await ids({ source: 'campaign', campaignId: 11 })).toEqual([1, 3, 4, 7]);
    expect(await ids({ source: 'campaign', campaignId: 12 })).toEqual([1]);
    expect(await ids({ source: 'campaign_legacy', campaignId: 11 })).toEqual([4]);
    expect(await ids({ source: 'campaign', campaignId: 21, importId: 102 })).toEqual([]);
    expect(await ids({ source: 'campaign', campaignId: 11 }, 1, 2)).toEqual([3, 4]);
  });
  it('lists file names and distinct available counts for the current business only', async () => {
    const sources = await scoped(10, () => getCreationImportSources(1));
    expect(sources.crmImports).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 200, fileName: 'crm-a.csv', count: 1 }),
      expect.objectContaining({ id: 201, fileName: 'crm-b.csv', count: 1 }),
    ]));
    expect(sources.crmImports.some(item => item.id === 202)).toBe(false);
    expect(sources.campaigns.find(item => item.id === 11)).toMatchObject({
      name: 'Campaign A', historicalCount: 1,
      uploads: [expect.objectContaining({ id: 100, fileName: 'first.csv', count: 3 })],
    });
    expect(sources.campaigns.find(item => item.id === 12)?.uploads[0].count).toBe(1);
    expect(sources.campaigns.some(item => item.id === 21)).toBe(false);
  });
  it('commits an upload once on concurrent retry, deduplicates its audience, and rejects a changed replay', async () => {
    const input = { threadId: 11, fileName: 'new.csv', requestId: 'upload-request-1', fingerprint: 'same', records: [
      { userId: 1, source: 'import', status: 'new', email: 'new@example.test' },
      { userId: 1, source: 'import', status: 'new', email: 'NEW@example.test' },
    ] };
    const [a, b] = await scoped(10, () => Promise.all([saveCampaignLeadImport(1, input), saveCampaignLeadImport(1, input)]));
    expect(a.importId).toBe(b.importId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await ids({ source: 'campaign', campaignId: 11, importId: a.importId })).toHaveLength(1);
    expect(await scoped(10, () => saveCampaignLeadImport(1, { ...input, fingerprint: 'different' }))).toEqual({ conflict: true });
    expect((await pool.query("SELECT count(*)::int count FROM campaign_lead_imports WHERE request_id='upload-request-1'")).rows[0].count).toBe(1);
  });
  it('rolls back a failed upload and rejects a thread from another business', async () => {
    const input = { threadId: 11, fileName: 'rollback.csv', requestId: 'rollback', fingerprint: 'hash', records: [{ userId: 1, source: 'import', status: 'new', email: 'rollback@example.test' }] };
    syncLead.mockRejectedValueOnce(new Error('Synthetic CRM failure'));
    await expect(scoped(10, () => saveCampaignLeadImport(1, input))).rejects.toThrow('Synthetic CRM failure');
    expect((await pool.query("SELECT count(*)::int count FROM campaign_lead_imports WHERE request_id='rollback'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM leads WHERE email='rollback@example.test'")).rows[0].count).toBe(0);
    await expect(scoped(10, () => saveCampaignLeadImport(1, { ...input, threadId: 21 }))).rejects.toThrow('Campaign workspace not found');
  });
  it('enforces same-business relationships through the production ownership trigger', async () => {
    await expect(pool.query(`INSERT INTO campaign_lead_import_members(user_id,business_profile_id,import_id,lead_id)
      VALUES(1,10,100,6)`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO campaign_lead_imports(user_id,business_profile_id,thread_id,file_name,total_records,request_fingerprint)
      VALUES(1,10,21,'foreign-thread.csv',1,'x')`)).rejects.toMatchObject({ code: '23514' });
  });
});
