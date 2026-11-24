/** Actual latest capacity-plan SQL, synthetic schema on coordinator's disposable local DB only. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const connection = { host: '127.0.0.1', port: 55432, user: 'postgres', password: '', database: 'salesmarketing_tenant_audit_qa' };
const schema = `audit_capacity_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ ...connection, max: 1 });
const pool = new pg.Pool({ ...connection, max: 1, options: `-c search_path=${schema},public -c timezone=UTC` });

(process.env.CAPACITY_LOCAL_QA === '1' ? describe : describe.skip)('latest migration capacity plan adoption with isolated SQL fixtures', () => {
  beforeAll(async () => {
    const identity = await admin.query('SELECT current_database() name,host(inet_server_addr()) host');
    // Docker NAT can report its bridge address inside PostgreSQL. The selected
    // client endpoint and exact disposable database remain fixed to loopback.
    expect(connection.host).toBe('127.0.0.1');
    expect(connection.port).toBe(55432);
    expect(identity.rows[0]).toMatchObject({ name: 'salesmarketing_tenant_audit_qa' });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer);
      CREATE TABLE subscription_plans(version integer,slug text,limits jsonb);
      CREATE TABLE billing_subscriptions(id text PRIMARY KEY,version integer,slug text,mode text);
      CREATE TABLE subscription_charges(subscription_id text,organization_id integer,period_start timestamptz,refund_amount_paise integer DEFAULT 0);
      CREATE TABLE billing_admin_plan_terms(organization_id integer,version integer,slug text,starts_at timestamptz,ends_at timestamptz,cancelled_at timestamptz);
      CREATE TABLE storage_plans(id integer PRIMARY KEY,max_storage_bytes bigint,is_default boolean);
      CREATE TABLE storage_quotas(user_id integer,plan_id integer,max_storage_bytes bigint);
      CREATE FUNCTION billing_capacity_authorize(integer) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      INSERT INTO billing_organizations VALUES(901,901);
      INSERT INTO storage_plans VALUES(1,1073741824,true);
      INSERT INTO subscription_plans VALUES
        (2,'starter','{"businessProfiles":1,"contacts":5000,"storageBytes":2000000000}'::jsonb),
        (2,'scale','{"businessProfiles":20,"contacts":100000,"storageBytes":50000000000}'::jsonb);
    `);
    const actual = readFileSync(new URL('../migrations/340_live_capacity_plan_retention.js', import.meta.url), 'utf8')
      .match(/CREATE OR REPLACE FUNCTION billing_capacity_plan\(p_org integer\)[\s\S]*?END \$\$;/)?.[0];
    if (!actual) throw new Error('Cannot locate actual latest billing_capacity_plan function');
    await pool.query(actual);
  });
  beforeEach(async () => { await pool.query('TRUNCATE subscription_charges,billing_subscriptions,billing_admin_plan_terms'); });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  const plan = async () => (await pool.query('SELECT billing_capacity_plan(901) AS plan')).rows[0].plan;

  it('control: a live Starter charge gives Starter capacity', async () => {
    await pool.query("INSERT INTO billing_subscriptions VALUES('live-starter',2,'starter','live'); INSERT INTO subscription_charges VALUES('live-starter',901,now()-interval '2 days',0)");
    expect(await plan()).toMatchObject({ catalogVersion: 2, planSlug: 'starter', limits: { businessProfiles: 1 } });
  });
  it('ignores a later simulated test Scale charge', async () => {
    await pool.query("INSERT INTO billing_subscriptions VALUES('live-starter',2,'starter','live'),('test-scale',2,'scale','test'); INSERT INTO subscription_charges VALUES('live-starter',901,now()-interval '2 days',0),('test-scale',901,now()-interval '1 day',0)");
    expect(await plan()).toMatchObject({ catalogVersion: 2, planSlug: 'starter', limits: { businessProfiles: 1, contacts: 5000 } });
  });
  it('retains adopted caps after a partial refund', async () => {
    await pool.query("INSERT INTO billing_subscriptions VALUES('live-starter',2,'starter','live'); INSERT INTO subscription_charges VALUES('live-starter',901,now()-interval '2 days',100)");
    expect(await plan()).toMatchObject({catalogVersion:2,planSlug:'starter',limits:{contacts:5000}});
  });
  it('retains the latest downgraded cap after refund', async () => {
    await pool.query("INSERT INTO billing_subscriptions VALUES('old-scale',2,'scale','live'),('new-starter',2,'starter','live'); INSERT INTO subscription_charges VALUES('old-scale',901,now()-interval '60 days',0),('new-starter',901,now()-interval '2 days',100)");
    expect(await plan()).toMatchObject({ planSlug: 'starter', limits: { businessProfiles: 1, contacts: 5000 } });
  });
});
