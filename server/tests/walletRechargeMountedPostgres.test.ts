import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { logger } from '../utils/logger.js';
import type { RazorpayOrder, RazorpayPayment } from '../services/RazorpayService.js';

const suite = process.env.WALLET_RECHARGE_FULL_QA === '1' ? describe : describe.skip;
let database: ReturnType<typeof drizzle>;
const proxy = new Proxy({}, { get(_target, key) {
  const value = Reflect.get(database, key);
  return typeof value === 'function' ? value.bind(database) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
// Transport/session and nonfinancial infrastructure only. User lookup, scopes,
// role authorization, validation, services, RLS and payment ledgers remain real.
jest.unstable_mockModule('../utils/jwt', () => ({
  verifyToken: (token: string) => /^synthetic-\d+$/.test(token) ? { userId: Number(token.split('-')[1]), iat: Math.floor(Date.now() / 1000) } : null,
  isTokenRevoked: async () => false,
}));
jest.unstable_mockModule('../services/SmartThrottlingService', () => ({ SmartThrottlingService: { getInstance: () => ({
  isAllowed: async () => ({ allowed: true }), recordRequest: async () => {},
}) } }));
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({ apiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { publish: async () => {} } }));
jest.unstable_mockModule('../services/dashboardCache.js', () => ({ invalidateDashboardCache: async () => {} }));
const { default: walletRouter } = await import('../routes/wallet.routes.js');
const { subscriptions } = await import('../services/subscriptions/service.js');

suite('mounted wallet API with synthetic full-schema PostgreSQL and fake Razorpay', () => {
  let control: Pool; let admin: Pool; let runtime: Pool; let clone: string;
  let app: ReturnType<typeof express>;
  let owner: number; let staff: number; let other: number; let peer: number;
  let profile: number; let personalProfile: number; let organization: number; let personalOrganization: number;
  let credentialA: number; let credentialB: number;
  const orders = new Map<string, { key: string; order: RazorpayOrder }>();
  const payments = new Map<string, { key: string; payment: RazorpayPayment }>();
  const providerCalls: { path: string; key: string }[] = [];
  const errorCodes: { message: string; codes: { code: string; constraint: string | null; routine: string | null }[] }[] = [];
  const keyA = 'rzp_live_mountedFixtureA'; const keyB = 'rzp_live_mountedFixtureB';
  const secretA = 'synthetic-mounted-secret-A';

  beforeAll(async () => {
    const host = process.env.DB_HOST || '';
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Mounted recharge QA requires explicit loopback PostgreSQL.');
    const config = { host, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
    control = new Pool({ ...config, database: 'postgres', max: 1 });
    clone = `wallet_recharge_full_qa_${crypto.randomBytes(8).toString('hex')}`;
    // A portable template can be created from empty template0 and checked-in
    // migrations with qa/tenant-remediation-20261023/create-wallet-template.mjs.
    const template = process.env.WALLET_RECHARGE_QA_TEMPLATE || 'salesmarketing_tenant_remediation_qa_20261023';
    if (!/^(salesmarketing_tenant_remediation_qa_20261023|synthetic_wallet_qa_[a-z0-9_]+)$/.test(template) || template.length > 63) {
      throw new Error('An explicitly named synthetic wallet template is required.');
    }
    await control.query(`CREATE DATABASE "${clone}" TEMPLATE "${template}"`);
    admin = new Pool({ ...config, database: clone, max: 2 });
    if (!(await admin.query("SELECT to_regclass('public.wallet_recharge_order_origins') AS name")).rows[0].name) {
      const path = '../migrations/344_wallet_recharge_order_origins.js';
      const migration: { up(client: Pool): Promise<void> } = await import(path);
      await migration.up(admin);
    }
    await assertBusinessScopeSchema(admin);
    runtime = createBusinessScopedPool(new Pool({ ...config, database: clone, max: 6 }));
    database = drizzle(runtime);
    const tag = crypto.randomBytes(6).toString('hex');
    const created = (await admin.query(`INSERT INTO users(email,password,name,is_verified,is_approved,is_setup_complete)
      VALUES($1,'synthetic','Recharge owner',true,true,true),($2,'synthetic','Recharge billing admin',true,true,true),
      ($3,'synthetic','Recharge other owner',true,true,true),($4,'synthetic','Recharge peer billing admin',true,true,true) RETURNING id`,
    [`owner-${tag}@example.invalid`, `staff-${tag}@example.invalid`, `other-${tag}@example.invalid`, `peer-${tag}@example.invalid`])).rows;
    [owner, staff, other, peer] = created.map(row => Number(row.id));
    const shared = (await admin.query(`INSERT INTO company_settings(user_id,name,company_name,is_default,is_approved)
      VALUES($1,'Recharge shared','Recharge shared',true,true) RETURNING id,billing_organization_id`, [owner])).rows[0];
    const personal = (await admin.query(`INSERT INTO company_settings(user_id,name,company_name,is_default,is_approved)
      VALUES($1,'Recharge personal','Recharge personal',true,true) RETURNING id,billing_organization_id`, [staff])).rows[0];
    await admin.query(`INSERT INTO company_settings(user_id,name,company_name,is_default,is_approved)
      VALUES($1,'Recharge other','Recharge other',true,true)`, [other]);
    profile = Number(shared.id); organization = Number(shared.billing_organization_id);
    personalProfile = Number(personal.id); personalOrganization = Number(personal.billing_organization_id);
    await admin.query(`INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status)
      SELECT $1,id,email,'billing_admin','active' FROM users WHERE id IN($2,$3)`, [profile, staff, peer]);
    const credentials = (await admin.query(`INSERT INTO admin_api_credentials(platform,name,api_key,api_secret,is_encrypted,is_active)
      VALUES('razorpay','Synthetic recharge A',$1,$2,false,true),('razorpay','Synthetic recharge B',$3,'synthetic-mounted-secret-B',false,true) RETURNING id`,
    [keyA, secretA, keyB])).rows;
    [credentialA, credentialB] = credentials.map(row => Number(row.id));
    await admin.query('UPDATE subscription_settings SET enforced=false,capacity_enforced=false,credential_id=$1 WHERE id=1', [credentialA]);
    await admin.query(`INSERT INTO credit_pricing(event_key,name,category,credits_per_unit)
      VALUES('recharge_rate','Synthetic recharge rate','recharge',10)
      ON CONFLICT(event_key) DO UPDATE SET credits_per_unit=10`);
    // Only paid top-up eligibility is supplied. The actual access query, owner
    // approval, membership and selected payer resolution still execute.
    const access = subscriptions.access.bind(subscriptions);
    jest.spyOn(subscriptions, 'access').mockImplementation(async userId => ({ ...await access(userId), canTopUp: true }));
    jest.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      const [entry, message] = args;
      let error = entry && typeof entry === 'object' ? (entry as { err?: unknown }).err : undefined;
      const codes: { code: string; constraint: string | null; routine: string | null }[] = [];
      for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth++) {
        const value = error as { code?: unknown; cause?: unknown; constraint?: unknown; routine?: unknown };
        codes.push({ code: typeof value.code === 'string' ? value.code : '(no direct code)',
          constraint: typeof value.constraint === 'string' ? value.constraint : null,
          routine: typeof value.routine === 'string' ? value.routine : null });
        error = value.cause;
      }
      // Only SQLSTATE/constraint/routine names; no detail/where, SQL, values or secrets.
      errorCodes.push({ message: typeof message === 'string' ? message : '(no static message)', codes });
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const address = new URL(String(url));
      if (address.origin !== 'https://api.razorpay.com') throw new Error('Nonfixture outbound fetch forbidden');
      const auth = String((options?.headers as Record<string, string>)?.Authorization || '');
      const key = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':')[0];
      providerCalls.push({ path: address.pathname, key });
      if (address.pathname === '/v1/orders' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        const order: RazorpayOrder = { id: `order_mounted${orders.size + 1}`, entity: 'order', ...body,
          status: 'created', amount_paid: 0, amount_due: body.amount, created_at: Math.floor(Date.now() / 1000) };
        orders.set(order.id, { key, order });
        // Simulate admin selection changing while provider creation is in flight.
        await admin.query('UPDATE subscription_settings SET credential_id=$1 WHERE id=1', [credentialB]);
        return { ok: true, json: async () => structuredClone(order) } as globalThis.Response;
      }
      const id = address.pathname.split('/').at(-1) || '';
      const object = address.pathname.startsWith('/v1/payments/') ? payments.get(id) : orders.get(id);
      if (!object || object.key !== key) return { ok: false, status: 404 } as globalThis.Response;
      const payload = 'payment' in object ? object.payment : object.order;
      return { ok: true, json: async () => structuredClone(payload) } as globalThis.Response;
    });
    app = express(); app.use(express.json()); app.use('/api/wallet', walletRouter);
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: error.message }));
  }, 60000);

  afterAll(async () => {
    jest.restoreAllMocks(); await runtime?.end(); await admin?.end();
    if (control && clone) await control.query(`DROP DATABASE IF EXISTS "${clone}"`);
    await control?.end();
  });

  function post(path: string, actor: number, selectedProfile: number, selectedOrganization: number, body: object) {
    return request(app).post(`/api/wallet${path}`).set('Authorization', `Bearer synthetic-${actor}`)
      .set('x-business-profile-id', String(selectedProfile)).set('x-billing-organization-id', String(selectedOrganization)).send(body);
  }
  async function capturedRecharge() {
    await admin.query('UPDATE admin_api_credentials SET is_active=true WHERE id=$1', [credentialA]);
    await admin.query('UPDATE subscription_settings SET credential_id=$1 WHERE id=1', [credentialA]);
    const created = await post('/recharge/create-order', staff, profile, organization, { amount: 100 });
    expect(created.status).toBe(200); expect(created.body.data.keyId).toBe(keyA);
    const orderId = String(created.body.data.orderId);
    const entry = orders.get(orderId)!;
    entry.order.status = 'paid'; entry.order.amount_paid = entry.order.amount; entry.order.amount_due = 0;
    const paymentId = `pay_mounted${payments.size + 1}`;
    payments.set(paymentId, { key: keyA, payment: { id: paymentId, entity: 'payment', amount: entry.order.amount,
      currency: 'INR', status: 'captured', order_id: orderId, captured: true } });
    await admin.query('UPDATE admin_api_credentials SET is_active=false WHERE id=$1', [credentialA]);
    return { razorpay_order_id: orderId, razorpay_payment_id: paymentId,
      razorpay_signature: crypto.createHmac('sha256', secretA).update(`${orderId}|${paymentId}`).digest('hex') };
  }
  async function balance(payer: number) {
    return Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [payer])).rows[0]?.balance || 0);
  }

  it('creates with key A, rereads its durable origin on verification, and credits the shared original payer exactly once under concurrent retries', async () => {
    const before = await balance(organization); const personalBefore = await balance(personalOrganization);
    const body = await capturedRecharge();
    const origin = (await admin.query('SELECT * FROM wallet_recharge_order_origins WHERE order_id=$1', [body.razorpay_order_id])).rows[0];
    expect(origin).toMatchObject({ user_id: staff, organization_id: organization, credential_id: credentialA, key_id: keyA });
    const callsBefore = providerCalls.length;
    errorCodes.length = 0;
    const results = await Promise.all(Array.from({ length: 2 }, () => post('/recharge/verify', staff, profile, organization, body)));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    console.info('N04 mounted safe error diagnostics', JSON.stringify(errorCodes));
    expect(errorCodes.filter(error => error.message === 'Failed to verify recharge payment')).toEqual([]);
    expect(results.filter(result => result.body.data.alreadyProcessed === false)).toHaveLength(1);
    expect(providerCalls.slice(callsBefore).map(call => call.key)).toEqual(Array(4).fill(keyA));
    expect(await balance(organization)).toBe(before + 1000);
    expect(await balance(personalOrganization)).toBe(personalBefore);
    const claims = (await admin.query('SELECT organization_id,user_id FROM wallet_recharge_claims WHERE payment_order_id=$1', [body.razorpay_order_id])).rows;
    expect(claims).toEqual([{ organization_id: organization, user_id: staff }]);
    expect((await admin.query('SELECT id FROM wallet_transactions WHERE payment_order_id=$1', [body.razorpay_order_id])).rows).toHaveLength(1);
  });

  it('rejects another authorized billing actor and a different selected payer before any provider read or credit', async () => {
    const body = await capturedRecharge(); const before = await balance(organization); const callsBefore = providerCalls.length;
    const actor = await post('/recharge/verify', peer, profile, organization, body);
    expect(actor.status).toBe(404); expect(actor.body.code).toBe('RECHARGE_ORDER_FORBIDDEN');
    const payer = await post('/recharge/verify', staff, personalProfile, personalOrganization, body);
    expect(payer.status).toBe(404); expect(payer.body.code).toBe('RECHARGE_ORDER_FORBIDDEN');
    expect(providerCalls).toHaveLength(callsBefore); expect(await balance(organization)).toBe(before);
    expect((await admin.query('SELECT id FROM wallet_recharge_claims WHERE payment_order_id=$1', [body.razorpay_order_id])).rows).toHaveLength(0);
  });

  it('rechecks revoked membership on the next request before any provider read or credit', async () => {
    const body = await capturedRecharge(); const before = await balance(organization); const callsBefore = providerCalls.length;
    await admin.query("UPDATE business_profile_memberships SET status='revoked' WHERE business_profile_id=$1 AND user_id=$2", [profile, staff]);
    const result = await post('/recharge/verify', staff, profile, organization, body);
    expect(result.status).toBe(403); expect(result.body.code).toBe('BUSINESS_PROFILE_FORBIDDEN');
    expect(providerCalls).toHaveLength(callsBefore); expect(await balance(organization)).toBe(before);
    expect((await admin.query('SELECT id FROM wallet_recharge_claims WHERE payment_order_id=$1', [body.razorpay_order_id])).rows).toHaveLength(0);
  });
});
