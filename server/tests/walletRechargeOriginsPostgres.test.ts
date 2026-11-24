import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBillingScope } from '../tenancy/billingContext.js';

// Explicit opt-in, loopback host and synthetic database only. No .env/provider IO.
const suite = process.env.SUBSCRIPTIONS_LOCAL_QA === '1' ? describe : describe.skip;
let database: ReturnType<typeof drizzle>;
type Executor = { execute(statement: SQL): Promise<{ rows: Record<string, unknown>[] }> };
const proxy = {
  execute: (statement: SQL) => database.execute(statement),
  transaction: <T>(work: (tx: Executor) => Promise<T>) => database.transaction(tx => work(tx)),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
const { saveRechargeOrderOrigin, findRechargeOrderOrigin } = await import('../services/walletRechargeOrigins.js');
const { assertBillingCredentialMutation } = await import('../services/subscriptions/credentialPolicy.js');

suite('wallet recharge migration344 with isolated PostgreSQL and real runtime scopes', () => {
  let admin: Pool; let pool: Pool; let schema: string;
  const quote = { userId: 7, organizationId: 70, amountPaise: 10000, currency: 'INR', credits: 1000.01, rechargeRate: 10.00012345 };
  const identity = { source: 'admin' as const, credentialId: 1, keyId: 'rzp_live_fixtureA', storedKey: 'rzp_live_fixtureA', storedSecret: 'synthetic-secret-A', encrypted: false };
  const scoped = <T>(actor: number, payer: number, work: () => T) => withBillingScope({ actorUserId: actor, organizationId: payer }, work);

  beforeAll(async () => {
    const host = process.env.DB_HOST || '';
    const name = process.env.DB_NAME || process.env.DB_DATABASE || '';
    if (!['localhost', '127.0.0.1', '::1'].includes(host) || !/(synthetic|audit|qa)/i.test(name)) {
      throw new Error('Recharge QA requires an explicitly configured local synthetic database.');
    }
    const config = { host, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: name, connectionTimeoutMillis: 5000 };
    admin = new Pool({ ...config, max: 1 });
    const role = (await admin.query("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='salesmarketing_business_runtime'")).rows[0];
    if (!role || role.rolsuper || role.rolbypassrls || role.rolcanlogin) throw new Error('Create the isolated runtime-role prerequisite before recharge QA.');
    schema = `wallet_origins_qa_${crypto.randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"; GRANT USAGE ON SCHEMA "${schema}" TO salesmarketing_business_runtime`);
    pool = new Pool({ ...config, max: 4, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE billing_organizations(id INTEGER PRIMARY KEY);
      CREATE TABLE admin_api_credentials(id INTEGER PRIMARY KEY,platform TEXT NOT NULL,api_key TEXT NOT NULL,
        api_secret TEXT,is_encrypted BOOLEAN NOT NULL DEFAULT false,is_active BOOLEAN NOT NULL DEFAULT true,config JSONB DEFAULT '{}');
      CREATE TABLE subscription_settings(id INTEGER PRIMARY KEY,enforced BOOLEAN NOT NULL,credential_id INTEGER);
      CREATE TABLE subscription_provider_plans(credential_id INTEGER);
      CREATE TABLE billing_subscriptions(credential_id INTEGER);
      CREATE TABLE business_scope_accounts(table_name TEXT PRIMARY KEY);
      CREATE FUNCTION app_business_system() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
        SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
      CREATE FUNCTION app_billing_organization_id() RETURNS INTEGER LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.billing_organization_id',true),'')::integer $$;
      CREATE FUNCTION app_billing_actor_user_id() RETURNS INTEGER LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.billing_actor_user_id',true),'')::integer $$;
      INSERT INTO users VALUES(7),(8); INSERT INTO billing_organizations VALUES(70),(71);
      INSERT INTO admin_api_credentials(id,platform,api_key,api_secret) VALUES(1,'razorpay','rzp_live_fixtureA','synthetic-secret-A');
      INSERT INTO subscription_settings VALUES(1,false,1);
      GRANT SELECT,UPDATE ON admin_api_credentials,subscription_settings TO salesmarketing_business_runtime;
      GRANT SELECT ON subscription_provider_plans,billing_subscriptions TO salesmarketing_business_runtime;`);
    // Nonliteral imports keep this fixture independent of JS declaration files.
    const integrityPath = '../migrations/342_subscription_credential_integrity.js';
    const originPath = '../migrations/344_wallet_recharge_order_origins.js';
    const integrity: { up(client: Pool): Promise<void> } = await import(integrityPath);
    const migration: { up(client: Pool): Promise<void>; down(): Promise<void>; irreversible: boolean } = await import(originPath);
    await integrity.up(pool);
    await migration.up(pool);
    expect(migration.irreversible).toBe(true);
    await expect(migration.down()).rejects.toThrow('forward migration');
    database = drizzle(createBusinessScopedPool(pool));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Provider IO forbidden in recharge PostgreSQL fixture'); });
    await scoped(7, 70, () => saveRechargeOrderOrigin('order_pg_origin', quote, identity));
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks(); await pool?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it('registers account ownership, forced RLS and only SELECT/INSERT runtime grants', async () => {
    expect((await pool.query("SELECT table_name FROM business_scope_accounts WHERE table_name='wallet_recharge_order_origins'")).rows).toHaveLength(1);
    const metadata = (await pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='wallet_recharge_order_origins'::regclass")).rows[0];
    expect(metadata).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const privileges = (await pool.query(`SELECT
      has_table_privilege('salesmarketing_business_runtime','wallet_recharge_order_origins','SELECT') AS read,
      has_table_privilege('salesmarketing_business_runtime','wallet_recharge_order_origins','INSERT') AS insert,
      has_table_privilege('salesmarketing_business_runtime','wallet_recharge_order_origins','UPDATE') AS update,
      has_table_privilege('salesmarketing_business_runtime','wallet_recharge_order_origins','DELETE') AS delete`)).rows[0];
    expect(privileges).toEqual({ read: true, insert: true, update: false, delete: false });
  });

  it('preserves full quote precision and enforces actor/payer reads and inserts through the actual runtime adapter', async () => {
    const origin = await scoped(7, 70, () => findRechargeOrderOrigin('order_pg_origin', 7, 70));
    expect(origin).toMatchObject({ ...quote, credentialId: 1, keyId: identity.keyId });
    expect((await scoped(8, 70, () => database.execute(sql`SELECT * FROM wallet_recharge_order_origins`))).rows).toHaveLength(0);
    expect((await scoped(7, 71, () => database.execute(sql`SELECT * FROM wallet_recharge_order_origins`))).rows).toHaveLength(0);
    expect((await database.execute(sql`SELECT * FROM wallet_recharge_order_origins`)).rows).toHaveLength(0);
    await expect(scoped(8, 70, () => findRechargeOrderOrigin('order_pg_origin', 8, 70))).rejects.toMatchObject({ code: 'RECHARGE_ORDER_FORBIDDEN' });
    await expect(scoped(7, 71, () => findRechargeOrderOrigin('order_pg_origin', 7, 71))).rejects.toMatchObject({ code: 'RECHARGE_ORDER_FORBIDDEN' });
    await expect(scoped(8, 70, () => saveRechargeOrderOrigin('order_wrong_actor', quote, identity))).rejects.toMatchObject({ code: 'RECHARGE_ORIGIN_UNAVAILABLE' });
    expect(await scoped(7, 70, () => findRechargeOrderOrigin('order_genuinely_legacy', 7, 70))).toBeNull();
  });

  it('enforces unique immutable origins and refuses runtime UPDATE/DELETE', async () => {
    await expect(pool.query("INSERT INTO wallet_recharge_order_origins SELECT * FROM wallet_recharge_order_origins WHERE order_id='order_pg_origin'")).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query("UPDATE wallet_recharge_order_origins SET credits=1 WHERE order_id='order_pg_origin'")).rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query("DELETE FROM wallet_recharge_order_origins WHERE order_id='order_pg_origin'")).rejects.toMatchObject({ code: 'P0001' });
    await expect(scoped(7, 70, () => database.execute(sql`UPDATE wallet_recharge_order_origins SET credits=1`))).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(scoped(7, 70, () => database.execute(sql`DELETE FROM wallet_recharge_order_origins`))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('extends342 history guards to recharge-only credentials without preventing retained inactive use', async () => {
    const before = (await pool.query('SELECT * FROM admin_api_credentials WHERE id=1')).rows[0];
    await expect(scoped(7, 70, () => assertBillingCredentialMutation({ id: 1, platform: 'razorpay', apiKey: identity.keyId }, { delete: true }))).rejects.toMatchObject({ code: 'BILLING_CREDENTIAL_HISTORY' });
    await expect(pool.query('DELETE FROM admin_api_credentials WHERE id=1')).rejects.toMatchObject({ detail: '{"code":"BILLING_CREDENTIAL_HISTORY"}' });
    await expect(pool.query("UPDATE admin_api_credentials SET api_key='rzp_live_changed' WHERE id=1")).rejects.toMatchObject({ detail: '{"code":"BILLING_CREDENTIAL_IDENTITY"}' });
    await expect(pool.query("UPDATE admin_api_credentials SET platform='other' WHERE id=1")).rejects.toMatchObject({ detail: '{"code":"BILLING_CREDENTIAL_IDENTITY"}' });
    await expect(pool.query('UPDATE admin_api_credentials SET is_encrypted=true WHERE id=1')).rejects.toMatchObject({ detail: '{"code":"BILLING_CREDENTIAL_IDENTITY"}' });
    await pool.query('UPDATE admin_api_credentials SET is_active=false WHERE id=1');
    expect((await scoped(7, 70, () => findRechargeOrderOrigin('order_pg_origin', 7, 70)))?.credentialId).toBe(1);
    expect((await pool.query('SELECT api_key,api_secret FROM admin_api_credentials WHERE id=1')).rows[0]).toEqual({ api_key: before.api_key, api_secret: before.api_secret });
  });
});
