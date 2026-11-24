/** Loopback-only synthetic PostgreSQL and HTTP; never load a live environment. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { leadsTable } from '../models/leads/schema.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const suite = process.env.LEAD_EXPORT_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase;
let moduleEnabled = true;
const moduleLookup = jest.fn(async (_owner: number) => [{ key: 'lead_generation', enabled: moduleEnabled }]);
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = database?.[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: {} }));
jest.unstable_mockModule('../services/dashboardCache.js', () => ({ invalidateDashboardCache: jest.fn() }));
jest.unstable_mockModule('../services/ICPGenerationService.js', () => ({ ICPGenerationService: class {} }));
jest.unstable_mockModule('../services/credentialService.js', () => ({ getApifyKey: jest.fn() }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: {
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
} }));
// Only unrelated infrastructure/account lookups are isolated. JWT verification,
// authenticateToken, business membership resolution, permissions, module gate,
// CSRF, route registration, controller SQL and runtime pool are real modules.
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({ get: async () => null }) }));
jest.unstable_mockModule('../services/SmartThrottlingService.js', () => ({ SmartThrottlingService: class {
  static getInstance() { return { isAllowed: async () => ({ allowed: true }), recordRequest: async () => {} }; }
} }));
jest.unstable_mockModule('../models/users/functions.js', () => ({
  getUserById: async (id: number) => [1, 2, 3, 4].includes(id)
    ? { id, email: `actor-${id}@example.test`, deletedAt: null, passwordChangedAt: null } : null,
}));
jest.unstable_mockModule('../models/admins/functions.js', () => ({ getAdminById: async () => null }));
jest.unstable_mockModule('../middleware/subscriptionAccess.js', () => ({ checkSubscriptionRequest: async () => true }));
jest.unstable_mockModule('../middleware/billingOrganizationScope.js', () => ({
  billingOrganizationScope: (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({
  requireCredits: (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getEffectiveModuleAccess: moduleLookup, getMaintenanceSettings: async () => ({ enabled: false }),
}));
process.env.JWT_SECRET = 'lead-export-local-synthetic-signing-only';
const { generateToken } = await import('../utils/jwt.js');
const { AUTH_COOKIES } = await import('../utils/authCookies.js');
const { csrfProtection } = await import('../middleware/csrf.js');
const { default: leadRoutes } = await import('../routes/leads.routes.js');

suite('lead export through authenticated middleware and PostgreSQL runtime RLS', () => {
  let admin: Pool, pool: Pool, schema: string, server: http.Server, origin: string;
  const token = (actor: number) => generateToken({ userId: actor, email: `actor-${actor}@example.test` });
  const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const scoped = <T>(business: number, work: () => T) => withBusinessScope({ userId: 1, businessProfileId: business }, work);
  const request = async (path: string, options: {
    actor?: number; business?: number | string; ids?: unknown; cookie?: boolean; csrf?: boolean; anonymous?: boolean;
  } = {}) => {
    const { actor = 1, business = 101, ids, cookie, csrf, anonymous } = options;
    const headers: Record<string, string> = { 'x-business-profile-id': String(business) };
    if (!anonymous) {
      if (cookie) headers.Cookie = `${AUTH_COOKIES.user}=${token(actor)}; XSRF-TOKEN=synthetic-xsrf`;
      else headers.Authorization = `Bearer ${token(actor)}`;
    }
    if (csrf) headers['X-XSRF-TOKEN'] = 'synthetic-xsrf';
    if (ids !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${origin}/api/leads${path}`, {
      method: ids === undefined ? 'GET' : 'POST', headers,
      ...(ids === undefined ? {} : { body: JSON.stringify({ ids }) }),
    });
  };
  const csvIds = async (response: globalThis.Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    return (await response.text()).split('\r\n').slice(1).map(row => Number(row.split(',')[0].replaceAll('"', '')));
  };

  beforeAll(async () => {
    const host = process.env.DB_HOST || '';
    const name = process.env.DB_NAME || '';
    const isolatedSocket = host === process.env.BUSINESS_ISOLATION_TEST_SOCKET
      && /^\/tmp\/salesmarketing-business-isolation-qa-[a-zA-Z0-9]+\/socket$/.test(host)
      && name.startsWith('salesmarketing_business_isolation_qa_');
    if ((!['localhost', '127.0.0.1', '::1'].includes(host) && !isolatedSocket) || !/(synthetic|qa)/i.test(name)) {
      throw new Error('Lead export integration requires an explicit loopback or owned-socket synthetic database.');
    }
    const config = { host, port: Number(process.env.DB_PORT || 5432), database: name,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
    admin = new Pool({ ...config, max: 1 });
    schema = `lead_export_qa_${crypto.randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${quoted(schema)}; GRANT USAGE ON SCHEMA ${quoted(schema)} TO salesmarketing_business_runtime`);
    pool = new Pool({ ...config, max: 4, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    const columns = getTableConfig(leadsTable).columns;
    await pool.query(`
      CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamp);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,archived_at timestamp,is_default boolean);
      CREATE TABLE business_profile_memberships(id integer PRIMARY KEY,business_profile_id integer,user_id integer,status text,role text);
      CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer);
      CREATE TABLE leads(${columns.map(column => `${quoted(column.name)} ${column.name === 'id' ? 'integer PRIMARY KEY' : column.getSQLType()}`).join(',')});
      INSERT INTO users VALUES(1,NULL),(2,NULL),(3,NULL),(4,NULL);
      INSERT INTO company_settings VALUES(101,1,NULL,true),(102,1,NULL,false),(201,3,NULL,true);
      INSERT INTO business_profile_memberships VALUES(1,101,2,'active','member'),(2,101,4,'revoked','member');
      INSERT INTO leads(id,user_id,business_profile_id,name,email,lead_status,status,source,score,created_at)
        SELECT id,1,101,'Synthetic lead '||id,'lead-'||id||'@example.test','replied','new','inbound_email',80,'2026-10-27 12:00:00'
        FROM generate_series(1,17) id;
      INSERT INTO leads(id,user_id,business_profile_id,name,email,lead_status,source,score,created_at) VALUES
        (101,3,101,'Foreign owner synthetic','foreign-owner@example.test','replied','inbound_email',80,'2026-10-27 12:00:00'),
        (102,1,102,'Other profile synthetic','other-profile@example.test','replied','inbound_email',80,'2026-10-27 12:00:00'),
        (103,3,201,'Other business synthetic','other-business@example.test','replied','inbound_email',80,'2026-10-27 12:00:00');
      UPDATE leads SET role = CASE WHEN id >= 10 THEN 'QA Operations Manager' ELSE 'Account Coordinator' END;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${quoted(schema)} TO salesmarketing_business_runtime;
      ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
      ALTER TABLE leads FORCE ROW LEVEL SECURITY;
      CREATE POLICY synthetic_business_scope ON leads FOR SELECT TO salesmarketing_business_runtime USING(
        business_profile_id=NULLIF(current_setting('app.business_profile_id',true),'')::integer
        AND user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer);
    `);
    database = drizzle(createBusinessScopedPool(pool));
    const app = express();
    app.use(express.json());
    app.use(csrfProtection);
    app.use('/api/leads', leadRoutes);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic HTTP server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30000);

  beforeEach(() => { moduleEnabled = true; moduleLookup.mockClear(); });
  afterAll(async () => {
    if (server) { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await pool?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${quoted(schema)} CASCADE`);
    await admin?.end();
  });

  it('uses a non-bypass runtime role and enforces RLS even without controller predicates', async () => {
    const role = await scoped(101, () => database.execute(sql`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`));
    expect(role.rows[0]).toMatchObject({ current_user: 'salesmarketing_business_runtime', rolsuper: false, rolbypassrls: false });
    const rows = await scoped(101, () => database.execute(sql`SELECT id FROM leads ORDER BY id`));
    expect(rows.rows.map(row => row.id)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect((await database.execute(sql`SELECT id FROM leads`)).rows).toEqual([]);
  });

  it('exports the selected ID through POST with real authentication and selected-business scope', async () => {
    expect(await csvIds(await request('/export?format=csv&search=not-matching', { actor: 2, ids: [1] }))).toEqual([1]);
  });

  it('exports every matching page for an active member using the owner business, not the member ID', async () => {
    const list = await request('/?pageSize=5&status=replied&source=email&scoreRange=75-100', { actor: 2 });
    expect(list.status).toBe(200);
    const body = await list.json() as { total: number; data: unknown[] };
    expect(body.total).toBe(17);
    expect(body.data).toHaveLength(5);
    expect(await csvIds(await request('/export?format=csv&page=2&pageSize=5&status=replied&source=email&scoreRange=75-100', { actor: 2 })))
      .toEqual(Array.from({ length: 17 }, (_, i) => 17 - i));
    expect(moduleLookup).toHaveBeenCalledWith(1);
  });

  it('matches roles through authenticated listing and full filtered export without crossing owner/business RLS', async () => {
    for (const search of ['QA Operations Manager', 'operations manager']) {
      const filters = `search=${encodeURIComponent(search)}&status=replied&source=email&scoreRange=75-100`;
      const response = await request(`/?pageSize=5&${filters}`, { actor: 2 });
      expect(response.status).toBe(200);
      const body = await response.json() as { total: number; data: { id: number; role: string }[] };
      expect(body.total).toBe(8);
      expect(body.data.map(lead => lead.id)).toEqual([17, 16, 15, 14, 13]);
      expect(body.data.every(lead => lead.role === 'QA Operations Manager')).toBe(true);
      expect(await csvIds(await request(`/export?format=csv&page=2&pageSize=5&${filters}`, { actor: 2 })))
        .toEqual([17, 16, 15, 14, 13, 12, 11, 10]);
    }
    const narrowed = await request('/?search=operations%20manager&status=qualified', { actor: 2 });
    expect(narrowed.status).toBe(200);
    expect(await narrowed.json()).toMatchObject({ total: 0, data: [] });
  });

  it.each([101, 102, 103, 9999])('fails the complete selected batch for unavailable ID %i without returning CSV', async id => {
    const response = await request('/export?format=csv', { actor: 2, ids: [1, id] });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('unavailable') });
  });

  it('denies missing/invalid authentication and revoked/foreign business membership', async () => {
    expect((await request('/export', { anonymous: true })).status).toBe(401);
    const invalid = await fetch(`${origin}/api/leads/export`, { headers: { Authorization: 'Bearer invalid', 'x-business-profile-id': '101' } });
    expect(invalid.status).toBe(401);
    expect((await request('/export', { actor: 4 })).status).toBe(403);
    expect((await request('/export', { actor: 4, ids: [1] })).status).toBe(403);
    expect((await request('/export', { actor: 3 })).status).toBe(403);
    expect((await request('/export', { actor: 2, business: 102 })).status).toBe(403);
    expect((await request('/export', { business: '101 OR true' })).status).toBe(400);
  });

  it('keeps the new POST behind cookie-session CSRF and the module gate', async () => {
    expect((await request('/export?format=csv', { ids: [1], cookie: true })).status).toBe(403);
    expect(await csvIds(await request('/export?format=csv', { ids: [1], cookie: true, csrf: true }))).toEqual([1]);
    moduleEnabled = false;
    for (const options of [{}, { ids: [1] }]) {
      const response = await request('/export?format=csv', options);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'MODULE_UNAVAILABLE' });
    }
  });

  it('keeps concurrent owner requests in their independently selected business scopes', async () => {
    const [first, second] = await Promise.all([
      request('/export?format=csv', { business: 101 }), request('/export?format=csv', { business: 102 }),
    ]);
    expect(await csvIds(first)).toEqual(Array.from({ length: 17 }, (_, i) => 17 - i));
    expect(await csvIds(second)).toEqual([102]);
  });
});
