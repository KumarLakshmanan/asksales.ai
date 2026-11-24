import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withSystemScope } from '../tenancy/businessContext.js';

const suite = process.env.CATALOG_FULL_QA === '1' ? describe : describe.skip;
let database: ReturnType<typeof drizzle>;
const proxy = new Proxy({}, { get(_target, key) {
  const value = Reflect.get(database, key);
  return typeof value === 'function' ? value.bind(database) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
// Session transport and request throttling only: the fresh admin lookup,
// super-admin guard, mounted routes, catalog service and PostgreSQL stay real.
jest.unstable_mockModule('../utils/jwt', () => ({
  verifyToken: (token: string) => /^qa-admin-\d+$/.test(token)
    ? { adminId: Number(token.split('-').at(-1)), role: 'super_admin', iat: Math.floor(Date.now() / 1000) } : null,
  isTokenRevoked: async () => false,
}));
jest.unstable_mockModule('../services/SmartThrottlingService', () => ({ SmartThrottlingService: { getInstance: () => ({
  isAllowed: async () => ({ allowed: true }), recordRequest: async () => {},
}) } }));
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({ apiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next() }));
const { subscriptionAdminRoutes } = await import('../routes/subscriptions.routes.js');
const { getCatalog } = await import('../services/subscriptions/catalog.js');
const { RazorpaySubscriptionGateway, SubscriptionError } = await import('../services/subscriptions/gateway.js');
const createGatewaySpy = () => jest.spyOn(RazorpaySubscriptionGateway, 'forCredential').mockImplementation(async () => {
  throw new SubscriptionError('Provider calls disabled in catalog QA.', 503, 'QA_PROVIDER_DISABLED');
});

suite('mounted catalog validation with a disposable full-schema PostgreSQL clone', () => {
  let control: Pool; let admin: Pool; let runtime: Pool; let clone: string;
  let app: ReturnType<typeof express>; let actor: number; let reader: number;
  let gateway: ReturnType<typeof createGatewaySpy>;

  beforeAll(async () => {
    const host = process.env.DB_HOST || '';
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Catalog QA requires explicit loopback PostgreSQL.');
    const config = { host, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
    control = new Pool({ ...config, database: 'postgres', max: 1 });
    clone = `catalog_capacity_full_qa_${crypto.randomBytes(8).toString('hex')}`;
    await control.query(`CREATE DATABASE "${clone}" TEMPLATE "salesmarketing_tenant_remediation_qa_20261023"`);
    admin = new Pool({ ...config, database: clone, max: 1 });
    runtime = createBusinessScopedPool(new Pool({ ...config, database: clone, max: 3 }));
    database = drizzle(runtime);
    const tag = crypto.randomBytes(6).toString('hex');
    const actors = (await admin.query(`INSERT INTO admins(email,password,name,role)
      VALUES($1,'synthetic','Catalog super admin','super_admin'),($2,'synthetic','Catalog reader','admin') RETURNING id`,
    [`super-${tag}@example.invalid`, `reader-${tag}@example.invalid`])).rows;
    [actor, reader] = actors.map(row => Number(row.id));
    const credential = (await admin.query(`INSERT INTO admin_api_credentials(platform,name,api_key,api_secret,is_encrypted,is_active)
      VALUES('razorpay','Synthetic catalog gateway','rzp_live_catalogFixture','synthetic-catalog-secret',false,true) RETURNING id`)).rows[0];
    await admin.query('UPDATE subscription_settings SET enforced=false,credential_id=$1 WHERE id=1', [credential.id]);
    gateway = createGatewaySpy();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Provider IO forbidden in catalog QA'); });
    app = express(); app.use(express.json()); app.use('/api/admin/subscriptions', subscriptionAdminRoutes);
  }, 60000);
  afterAll(async () => {
    jest.restoreAllMocks(); await runtime?.end(); await admin?.end();
    if (control && clone) await control.query(`DROP DATABASE IF EXISTS "${clone}"`);
    await control?.end();
  });
  function post(path: string, id = actor) {
    return request(app).post(`/api/admin/subscriptions${path}`).set('Authorization', `Bearer qa-admin-${id}`);
  }
  async function draft() {
    const response = await post('/catalog/drafts'); expect(response.status).toBe(200);
    return response.body as Awaited<ReturnType<typeof getCatalog>>;
  }
  async function snapshot(version: number) {
    return {
      plans: (await admin.query('SELECT * FROM subscription_plans WHERE version=$1 ORDER BY slug', [version])).rows,
      catalog: (await admin.query('SELECT version,status,published_at FROM subscription_catalogs WHERE version=$1', [version])).rows,
      pointer: (await admin.query('SELECT published_catalog_version FROM subscription_settings WHERE id=1')).rows,
      mappings: (await admin.query('SELECT * FROM subscription_provider_plans WHERE version=$1', [version])).rows,
      audits: (await admin.query('SELECT count(*)::int AS count FROM subscription_audit')).rows,
    };
  }
  it('rejects divergent draft saves before any row, audit or provider mutation', async () => {
    const catalog = await draft(); const before = await snapshot(catalog.version);
    catalog.plans[0].limits.businessProfiles = 5; catalog.plans[0].limits.workspaces = 1;
    const result = await request(app).put(`/api/admin/subscriptions/catalog/drafts/${catalog.version}`)
      .set('Authorization', `Bearer qa-admin-${actor}`).send({ plans: catalog.plans });
    expect(result.status).toBe(400); expect(result.body).toEqual({ success: false, error: 'Invalid subscription request.' });
    expect(await snapshot(catalog.version)).toEqual(before); expect(gateway).not.toHaveBeenCalled();
  });
  it('rejects a previously persisted divergent draft before constructing a payment gateway', async () => {
    const catalog = await draft();
    await admin.query(`UPDATE subscription_plans SET limits=limits || '{"businessProfiles":5,"workspaces":1}'::jsonb WHERE version=$1`, [catalog.version]);
    const before = await snapshot(catalog.version); gateway.mockClear();
    const result = await post(`/catalog/${catalog.version}/publish`);
    expect(result.status).toBe(400); expect(await snapshot(catalog.version)).toEqual(before);
    expect(gateway).not.toHaveBeenCalled();
  });
  it.each([0, null])('accepts matching %s aliases through the mounted draft route', async value => {
    const catalog = await draft(); Object.assign(catalog.plans[0].limits, { businessProfiles: value, workspaces: value });
    const result = await request(app).put(`/api/admin/subscriptions/catalog/drafts/${catalog.version}`)
      .set('Authorization', `Bearer qa-admin-${actor}`).send({ plans: catalog.plans });
    expect(result.status).toBe(200);
    expect(result.body.plans[0].limits).toMatchObject({ businessProfiles: value, workspaces: value });
  });
  it('keeps a historical divergent catalog readable without changing its stored limits', async () => {
    const catalog = await draft();
    await admin.query(`UPDATE subscription_plans SET limits=limits || '{"businessProfiles":5,"workspaces":1}'::jsonb WHERE version=$1`, [catalog.version]);
    await admin.query("UPDATE subscription_catalogs SET status='retired' WHERE version=$1", [catalog.version]);
    const before = await snapshot(catalog.version);
    const historical = await withSystemScope('Read synthetic historical catalog', () => getCatalog(catalog.version));
    expect(historical.plans[0].limits).toMatchObject({ businessProfiles: 5, workspaces: 1 });
    expect(await snapshot(catalog.version)).toEqual(before);
  });
  it('preserves the actual fresh-admin capability guard', async () => {
    const before = (await admin.query('SELECT count(*)::int AS count FROM subscription_catalogs')).rows;
    expect((await post('/catalog/drafts', reader)).status).toBe(403);
    expect((await admin.query('SELECT count(*)::int AS count FROM subscription_catalogs')).rows).toEqual(before);
  });
});
