import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { SQL, sql } from 'drizzle-orm';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { channelCredentialsTable, type InsertChannelCredential } from '../models/channelCredentials/schema.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

// Explicit, disposable local cluster only. Never load application .env or infer
// the target from DB_* variables. All production-model SQL below is real PG.
const socket = process.env.GMAIL_OWNERSHIP_QA_SOCKET;
const suite = socket ? describe : describe.skip;
let database: NodePgDatabase;
const proxy = new Proxy({} as NodePgDatabase, { get(_target, key) {
  const value = database[key as keyof NodePgDatabase];
  return typeof value === 'function' ? value.bind(database) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
const { ChannelCredentialModel, GmailMailboxOwnershipConflictError } = await import('../models/channelCredentials/functions.js');
const profiles = [{ userId: 9, businessProfileId: 11 }, { userId: 9, businessProfileId: 12 }, { userId: 10, businessProfileId: 21 }];
const inProfile = <T>(index: number, work: () => T) => withBusinessScope(profiles[index], work);
const input = (index = 0, changes: Partial<InsertChannelCredential> = {}): InsertChannelCredential => ({
  userId: profiles[index].userId, platform: 'gmail_api', credentialType: 'oauth', accountIdentifier: ' Owner@Example.Test ', isActive: true, ...changes,
});
const connect = (index = 0, changes: Partial<InsertChannelCredential> = {}) => inProfile(index, () => ChannelCredentialModel.upsert(input(index, changes)));

suite('Gmail mailbox ownership through real FORCE RLS and the production pool adapter', () => {
  let admin: Pool, fixture: Pool, runtime: Pool, single: Pool, schema: string;
  let primaryDatabase: NodePgDatabase;
  beforeAll(async () => {
    if (!socket?.startsWith('/tmp/gmail-oauth-followup-') || !/^\/tmp\/gmail-oauth-followup-[a-z0-9-]+\/postgres-socket$/.test(socket)) throw new Error('Use an explicitly created disposable local Gmail QA cluster.');
    const connection = { host: socket, port: 55483, user: 'gmail_qa', database: 'gmail_ownership_qa', connectionTimeoutMillis: 5000 };
    schema = `gmail_ownership_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = `-c search_path=${schema},pg_catalog -c timezone=UTC -c default_transaction_isolation=repeatable\\ read`;
    fixture = new Pool({ ...connection, max: 1, options: `-c search_path=${schema},pg_catalog -c timezone=UTC -c app.business_system=on` });
    runtime = createBusinessScopedPool(new Pool({ ...connection, max: 4, options }));
    single = createBusinessScopedPool(new Pool({ ...connection, max: 1, options }));
    primaryDatabase = drizzle(runtime); database = primaryDatabase;
    await localBusinessFunctions(fixture);
    await fixture.query('CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer NOT NULL); INSERT INTO company_settings VALUES(11,9),(12,9),(21,10)');
    const dialect = new PgDialect();
    const columns = getTableConfig(channelCredentialsTable).columns.map(column => {
      let value = '';
      if (column.default !== undefined) {
        if (column.default instanceof SQL) value = dialect.sqlToQuery(column.default).sql;
        else if (typeof column.default === 'boolean') value = column.default ? 'TRUE' : 'FALSE';
        else if (typeof column.default === 'string') value = `'${column.default.replaceAll("'", "''")}'`;
        else value = `'${JSON.stringify(column.default).replaceAll("'", "''")}'::jsonb`;
      }
      return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${value ? ` DEFAULT ${value}` : ''}`;
    });
    await fixture.query(`CREATE TABLE channel_credentials(${columns.join(',')}); ALTER TABLE channel_credentials ADD FOREIGN KEY(business_profile_id) REFERENCES company_settings(id);
      CREATE UNIQUE INDEX mailbox_business_account ON channel_credentials(business_profile_id,user_id,platform,account_identifier)`);
    // Execute the actual migration's ownership trigger function in this schema.
    const migration = readFileSync(resolve(process.cwd(), 'migrations/299_business_profile_isolation.js'), 'utf8');
    const guard = migration.match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\)[\s\S]*?END \$\$/)?.[0];
    if (!guard) throw new Error('Production ownership trigger source is unavailable');
    await fixture.query(guard);
    const spec = JSON.stringify({ table_name: 'channel_credentials', owner_column: 'user_id', parent_links: [], global_read: false });
    await fixture.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON channel_credentials FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON channel_credentials NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}')`);
    await localBusinessIsolation(fixture, schema, ['channel_credentials']);
    await fixture.query(`ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON company_settings FOR ALL USING(app_business_system() OR (id=app_business_profile_id() AND user_id=app_business_user_id()))
      WITH CHECK(app_business_system() OR (id=app_business_profile_id() AND user_id=app_business_user_id()))`);
  }, 30000);
  afterAll(async () => {
    await runtime?.end(); await single?.end(); await fixture?.end();
    if (schema && admin) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => { database = primaryDatabase; await fixture.query('TRUNCATE channel_credentials RESTART IDENTITY'); });

  it('runs as NOBYPASSRLS, hides other profiles, and demonstrates why context-only elevation inside an open tx fails', async () => {
    const saved = await connect();
    await inProfile(1, async () => {
      const visible = await runtime.query('SELECT id FROM channel_credentials'); expect(visible.rows).toEqual([]);
      const role = await runtime.query('SELECT current_user AS role,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass');
      expect(role.rows[0]).toEqual({ role: 'salesmarketing_business_runtime', bypass: false });
      await database.transaction(async tx => {
        const scoped = await withSystemScope('QA demonstrates fixed transaction scope', () => tx.execute(sql`SELECT id FROM channel_credentials WHERE id=${saved.id}`));
        expect(scoped.rows).toEqual([]);
      });
    });
    await expect(connect(1)).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials')).rows[0].n).toBe(1);
  });
  it('rejects a mailbox in another owner account without exposing or rewriting it', async () => {
    const saved = await connect(2); await expect(connect()).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT id,user_id,business_profile_id FROM channel_credentials')).rows).toEqual([{ id: saved.id, user_id: 10, business_profile_id: 21 }]);
  });
  it('reconnects only the active matching row when inactive case variants exist in the same business', async () => {
    const active = await connect();
    await fixture.query("INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,is_active) VALUES(9,11,'gmail_api','oauth',' Owner@Example.Test ',FALSE)");
    const updated = await connect(0, { accountName: 'Reconnected fixture' }); expect(updated.id).toBe(active.id);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials WHERE is_active')).rows[0].n).toBe(1);
  });
  it('serializes simultaneous same-owner and different-owner business connections with one winner', async () => {
    const attempts = await Promise.allSettled([connect(), connect(1), connect(2)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter(result => result.status === 'rejected'); expect(rejected).toHaveLength(2);
    for (const result of rejected) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials WHERE is_active')).rows[0].n).toBe(1);
  });
  it('allows transfer only after a prior business has locally disconnected its mailbox', async () => {
    const saved = await connect();
    await inProfile(0, () => runtime.query('UPDATE channel_credentials SET is_active=FALSE WHERE id=$1', [saved.id]));
    const other = await connect(1); expect(other.businessProfileId).toBe(12);
    await expect(connect()).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials WHERE is_active')).rows[0].n).toBe(1);
  });
  it('reports preexisting duplicate and unowned legacy mailboxes without silently repairing data', async () => {
    const saved = await connect();
    await fixture.query("INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,is_active) VALUES(9,12,'gmail_api','oauth','owner@example.test',TRUE)");
    await expect(connect()).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials')).rows[0].n).toBe(2);
    await fixture.query('TRUNCATE channel_credentials');
    await fixture.query("INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,is_active) VALUES(9,11,'gmail_api','oauth','owner@example.test',TRUE),(9,11,'gmail_api','oauth',' Owner@Example.Test ',TRUE)");
    await expect(connect()).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials')).rows[0].n).toBe(2);
    await fixture.query('TRUNCATE channel_credentials; ALTER TABLE channel_credentials DISABLE TRIGGER USER');
    try { await fixture.query("INSERT INTO channel_credentials(user_id,platform,credential_type,account_identifier) VALUES(9,'gmail_api','oauth','owner@example.test')"); }
    finally { await fixture.query('ALTER TABLE channel_credentials ENABLE TRIGGER USER'); }
    await expect(connect()).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT business_profile_id FROM channel_credentials')).rows).toEqual([{ business_profile_id: null }]);
    expect(saved.businessProfileId).toBe(11);
  });
  it('never persists explicit foreign identity and keeps tenant RLS on successful writes and subsequent queries', async () => {
    await expect(connect(0, { userId: 10 })).rejects.toThrow('authorized business');
    await expect(connect(0, { businessProfileId: 12 })).rejects.toThrow('authorized business');
    const guardName = 'fixture_tenant_write_guard';
    await fixture.query(`CREATE FUNCTION ${guardName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF app_business_system() THEN RAISE EXCEPTION 'Gmail write executed with global visibility'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_no_system_write BEFORE INSERT OR UPDATE ON channel_credentials FOR EACH ROW EXECUTE FUNCTION ${guardName}()`);
    try { await connect(); await connect(0, { accountName: 'Updated fixture' }); }
    finally { await fixture.query(`DROP TRIGGER fixture_no_system_write ON channel_credentials; DROP FUNCTION ${guardName}()`); }
    await inProfile(1, async () => {
      const after = await runtime.query('SELECT app_business_system() AS system, count(*)::integer AS n FROM channel_credentials');
      expect(after.rows[0]).toEqual({ system: false, n: 0 });
    });
  });
  it('rolls back a failed global conflict read without leaking system visibility to pool reuse', async () => {
    const saved = await connect(2);
    await fixture.query(`CREATE OR REPLACE FUNCTION app_business_system() RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN
      IF current_user='salesmarketing_business_runtime' AND current_setting('app.business_system',true)='on' THEN
        RAISE EXCEPTION 'fixture global conflict read failed';
      END IF; RETURN COALESCE(current_setting('app.business_system',true)='on',false); END $$`);
    try { await expect(connect()).rejects.toThrow(); }
    finally { await fixture.query(`CREATE OR REPLACE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$`); }
    await inProfile(0, async () => {
      expect((await runtime.query('SELECT app_business_system() AS system,count(*)::integer AS n FROM channel_credentials')).rows[0]).toEqual({ system: false, n: 0 });
    });
    await expect(connect()).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT id FROM channel_credentials')).rows).toEqual([{ id: saved.id }]);
  });
  it('works with a single-connection pool and overrides repeatable-read default for race-safe snapshots', async () => {
    database = drizzle(single);
    await fixture.query(`CREATE FUNCTION fixture_committed_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Gmail transaction snapshot is not read committed'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_committed_write BEFORE INSERT OR UPDATE ON channel_credentials FOR EACH ROW EXECUTE FUNCTION fixture_committed_write()`);
    await connect(); await expect(connect(1)).rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);
    expect((await fixture.query('SELECT count(*)::integer AS n FROM channel_credentials')).rows[0].n).toBe(1);
    await fixture.query('DROP TRIGGER fixture_committed_write ON channel_credentials; DROP FUNCTION fixture_committed_write()');
  });
});
