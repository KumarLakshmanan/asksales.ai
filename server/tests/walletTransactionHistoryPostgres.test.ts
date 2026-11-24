import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';

const suite = process.env.BILLING_HISTORY_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = database?.[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const { getTransactionsByUserId, getTransactionSummary } = await import('../models/walletTransactions/functions.js');

suite('separate billing ledger entries with identical displayed financial fields', () => {
  let admin: Pool, pool: Pool, schema: string;
  const scoped = <T>(actor: number, organization: number, work: () => T) =>
    withBusinessScope({ userId: 1, actorUserId: actor, businessProfileId: 101 }, () =>
      withBillingScope({ actorUserId: actor, organizationId: organization }, work));

  beforeAll(async () => {
    const host = process.env.DB_HOST || '';
    const name = process.env.DB_NAME || '';
    if (!['localhost', '127.0.0.1', '::1'].includes(host) || !/(synthetic|qa)/i.test(name)) {
      throw new Error('Billing history QA requires an explicitly configured loopback synthetic database.');
    }
    const config = { host, port: Number(process.env.DB_PORT || 5432), database: name,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
    admin = new Pool({ ...config, max: 1 });
    schema = `billing_history_qa_${crypto.randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"; GRANT USAGE ON SCHEMA "${schema}" TO salesmarketing_business_runtime`);
    pool = new Pool({ ...config, max: 4, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    await pool.query(`
      CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamp);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer,default_for_user_id integer,billing_eligibility_at timestamp);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,billing_organization_id integer,company_name text,business_name text,name text);
      CREATE TABLE business_profile_memberships(id integer PRIMARY KEY,business_profile_id integer,user_id integer,status text,role text);
      CREATE TABLE billing_organization_memberships(organization_id integer,user_id integer,status text,role text);
      CREATE TABLE wallet_transactions(id integer PRIMARY KEY,organization_id integer,actor_user_id integer,billing_business_profile_id integer,user_id integer,
        type text,amount numeric(12,2),balance_after numeric(12,2),description text,category text,reference_type text,reference_id text,
        payment_provider text,payment_id text,payment_order_id text,amount_paid numeric,currency text,metadata jsonb,created_at timestamp);
      INSERT INTO users VALUES(1,NULL),(2,NULL);
      INSERT INTO billing_organizations VALUES(10,1,1,'2026-01-01'),(20,2,2,'2026-01-01');
      INSERT INTO company_settings VALUES(101,1,10,'Synthetic business',NULL,NULL),(201,2,20,'Other synthetic business',NULL,NULL);
      INSERT INTO business_profile_memberships VALUES(1,101,2,'revoked','member');
      INSERT INTO wallet_transactions(id,organization_id,user_id,type,amount,balance_after,description,category,reference_type,reference_id,metadata,created_at)
        SELECT id,10,1,'refund',2,500,'Repeated rejection refund','outreach','wallet_transaction',id::text,'{}','2026-10-25 04:48:30.253'
        FROM generate_series(1,12) AS id;
      INSERT INTO wallet_transactions(id,organization_id,user_id,type,amount,balance_after,description,category,reference_type,reference_id,metadata,created_at) VALUES
        (13,10,2,'refund',2,500,'Private other-owner description','outreach','wallet_transaction','private-reference','{"private":"hidden"}','2026-10-25 04:48:30.253'),
        (14,20,2,'refund',999,999,'Other payer refund','outreach',NULL,NULL,NULL,'2026-10-25 04:49:00'),
        (15,10,1,'deduction',-2,498,'Older deduction','outreach',NULL,NULL,NULL,'2026-10-24 04:48:30');
      GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO salesmarketing_business_runtime;
      ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wallet_transactions FORCE ROW LEVEL SECURITY;
      CREATE POLICY payer_read ON wallet_transactions FOR SELECT TO salesmarketing_business_runtime
        USING(organization_id=NULLIF(current_setting('app.billing_organization_id',true),'')::integer);
    `);
    database = drizzle(createBusinessScopedPool(pool));
  }, 30000);

  afterAll(async () => {
    await pool?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it('retains distinct refunds and pages identical timestamps deterministically with matching filtered totals', async () => {
    const options = { type: 'refund', category: 'outreach', startDate: new Date('2026-10-25T00:00:00Z'), endDate: new Date('2026-10-25T23:59:59Z'), limit: 10 };
    const first = await scoped(1, 10, () => getTransactionsByUserId(1, options));
    const second = await scoped(1, 10, () => getTransactionsByUserId(1, { ...options, offset: 10 }));
    expect(first.total).toBe(13);
    expect(second.total).toBe(13);
    expect(first.transactions.map(row => row.id)).toEqual([13,12,11,10,9,8,7,6,5,4]);
    expect(second.transactions.map(row => row.id)).toEqual([3,2,1]);
    expect(new Set([...first.transactions, ...second.transactions].map(row => row.id)).size).toBe(13);
    expect(first.transactions.every(row => row.amount === '2.00')).toBe(true);
    const repeat = await scoped(1, 10, () => getTransactionsByUserId(1, options));
    expect(repeat).toEqual(first);
  });

  it('preserves cross-owner description/reference redaction within an authorized payer', async () => {
    const { transactions } = await scoped(1, 10, () => getTransactionsByUserId(1, { type: 'refund' }));
    expect(transactions[0]).toMatchObject({ id: 13, description: 'outreach credit refund', referenceId: null, referenceType: null, metadata: null });
    expect(transactions.find(row => row.id === 12)).toMatchObject({ description: 'Repeated rejection refund', referenceId: '12', metadata: {} });
    expect(transactions.some(row => row.id === 14)).toBe(false);
  });

  it('keeps all ledger entries in the summary and applies the same date and payer scope', async () => {
    const summary = await scoped(1, 10, () => getTransactionSummary(1, new Date('2026-10-25T00:00:00Z'), new Date('2026-10-25T23:59:59Z')));
    expect(summary).toEqual({ totalRecharges: 0, totalDeductions: 0, totalRefunds: 26, transactionCount: 13 });
  });

  it('rejects a different payer and revoked actor membership before returning history', async () => {
    await expect(scoped(1, 20, () => getTransactionsByUserId(1))).rejects.toMatchObject({ status: 403 });
    await expect(scoped(2, 10, () => getTransactionsByUserId(1))).rejects.toMatchObject({ status: 403 });
  });
});
