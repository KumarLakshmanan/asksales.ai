import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import request from 'supertest';
import { responseWrapper } from '../middleware/responseWrapper.js';

let database: ReturnType<typeof drizzle>;
let reads = 0;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = Reflect.get(database, key);
    return typeof value === 'function' ? (...args: unknown[]) => {
      if (key === 'execute') reads++;
      return value.apply(database, args);
    } : value;
  },
}) }));
const { getUnifiedAdminAudit } = await import('../controllers/adminAuditController.js');
// Selected read-handler/SQL boundary only. Production authorization is not replaced or changed.
const app = express(); app.use('/api', responseWrapper);
app.get('/api/admin/audit-logs', getUnifiedAdminAudit);
const suite = process.env.ADMIN_HELD_READ_LOCAL_QA === '1' ? describe : describe.skip;
suite('bounded administrator audit reads in a disposable synthetic schema', () => {
  let pool: Pool, control: Pool, schema: string;
  beforeAll(async () => {
    if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55439'
      || process.env.DB_NAME !== 'postgres' || !process.env.AUDIT_PG_SOCKET?.endsWith('/admin-held-continuation-evidence/pgsocket')) {
      throw Error('Use the explicitly configured disposable read-only audit fixture');
    }
    const config = { host: '127.0.0.1', port: 55439, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 3000 };
    control = new Pool({ ...config, max: 1 }); schema = 'admin_audit_read_' + randomBytes(6).toString('hex');
    await control.query('CREATE SCHEMA "' + schema + '"');
    pool = new Pool({ ...config, max: 2, options: '-c search_path=' + schema + ',pg_catalog' }); database = drizzle(pool);
    // No accounts, credentials, roles, plans or ledgers: these are minimal named projection fixtures.
    await pool.query(`CREATE TABLE admins(id integer PRIMARY KEY,name text);
      CREATE TABLE pricing_change_audit(id integer,action text,domain text,pricing_key text,record_id integer,
        admin_id integer,before_value jsonb,after_value jsonb,effective_at timestamp,created_at timestamp);
      CREATE TABLE platform_access_audit(id integer,target_type text,target_key text,user_id integer,admin_id integer,
        before_value jsonb,after_value jsonb,created_at timestamp);
      CREATE TABLE admin_credential_audit(id integer,action text,platform text,credential_id integer,admin_id integer,
        changed_fields jsonb,validation_status text,message text,created_at timestamp)`);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE admins,pricing_change_audit,platform_access_audit,admin_credential_audit');
    await pool.query(`INSERT INTO admins VALUES(7,'Synthetic reader name');
      INSERT INTO pricing_change_audit VALUES(1,'update','credit_pricing','synthetic',NULL,7,'{"apiKey":"synthetic-only"}','{}','2026-10-20','2026-10-20');
      INSERT INTO platform_access_audit VALUES(2,'module','synthetic_module',NULL,7,'{}','{}','2026-10-21');
      INSERT INTO admin_credential_audit VALUES(3,'validate','synthetic_provider',NULL,7,'[]','valid','Synthetic fixture','2026-10-22')`);
    reads = 0;
  });
  afterAll(async () => {
    await pool?.end();
    if (control && schema) await control.query('DROP SCHEMA "' + schema + '" CASCADE');
    await control?.end();
  });
  const get = (query: string) => request(app).get('/api/admin/audit-logs?' + query);
  it('preserves the actual filtered total when a requested page is empty', async () => {
    const first = await get('page=1&limit=2');
    expect(first.status).toBe(200); expect(first.body.data).toMatchObject({ total: 3, totalPages: 2 });
    expect(first.body.data.entries).toHaveLength(2);
    const beyond = await get('page=3&limit=2');
    expect(beyond.status).toBe(200);
    expect(beyond.body.data).toMatchObject({ entries: [], total: 3, page: 3, totalPages: 2 });
  });
  it('uses the same domain and search predicates for empty-page totals', async () => {
    const response = await get('domain=pricing&search=synthetic&page=2&limit=1');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ entries: [], total: 1, totalPages: 1 });
  });
  it('keeps truly empty filters empty and does not manufacture a null event', async () => {
    const response = await get('search=no_such_synthetic_event&page=1&limit=2');
    expect(response.body.data).toMatchObject({ entries: [], total: 0, totalPages: 0 });
  });
  it('retains the last page and existing event redaction', async () => {
    const response = await get('page=2&limit=2');
    expect(response.body.data).toMatchObject({ total: 3, totalPages: 2 });
    expect(response.body.data.entries).toHaveLength(1);
    expect(response.body.data.entries[0].details.before.apiKey).toBe('[REDACTED]');
    expect(response.body.data.entries[0]).not.toHaveProperty('total_count');
  });
  it('enumerates equal-time cross-domain events without duplicates or omissions', async () => {
    await pool.query(`TRUNCATE pricing_change_audit,platform_access_audit,admin_credential_audit;
      INSERT INTO pricing_change_audit SELECT i,'update','credit_pricing','tie_'||i,NULL,7,'{}','{}','2026-10-23','2026-10-23' FROM generate_series(1,50) i;
      INSERT INTO platform_access_audit SELECT i,'module','tie_'||i,NULL,7,'{}','{}','2026-10-23' FROM generate_series(1,50) i;
      INSERT INTO admin_credential_audit SELECT i,'validate','synthetic',i,7,'[]','valid','Synthetic fixture','2026-10-23' FROM generate_series(1,50) i`);
    const seen: string[] = [];
    for (let page = 1; page <= 15; page++) {
      const response = await get('page=' + page + '&limit=10');
      expect(response.status).toBe(200); expect(response.body.data.total).toBe(150);
      for (const entry of response.body.data.entries) seen.push(entry.domain + ':' + entry.source_id);
    }
    expect(seen).toHaveLength(150); expect(new Set(seen).size).toBe(150);
  });
  it.each(['page=1e20&limit=100', 'page=9007199254740992', 'page=9007199254740991&limit=100'])('rejects unrepresentable pagination before SQL: %s', async query => {
    const response = await get(query);
    expect(response.status).toBe(400); expect(reads).toBe(0);
  });
  it.each(['page=0', 'limit=101', 'page=1.5', 'domain=membership'])('retains existing invalid-argument rejection: %s', async query => {
    expect((await get(query)).status).toBe(400); expect(reads).toBe(0);
  });
  it('characterizes current actor labels as a live join, not a historical identity snapshot', async () => {
    const before = (await get('domain=pricing')).body.data.entries[0];
    await pool.query("UPDATE admins SET name='Synthetic renamed reader' WHERE id=7");
    const after = (await get('domain=pricing')).body.data.entries[0];
    expect(after.admin_name).toBe('Synthetic renamed reader');
    expect({ ...after, admin_name: before.admin_name }).toEqual(before);
    // Characterization only: changing identity-snapshot policy is deliberately held.
  });
  (process.env.ADMIN_HELD_READ_BROWSER === '1' ? it : it.skip)('recovers from a shrinking read result through the actual page, HTTP wrapper and PostgreSQL', async () => {
    await pool.query(`TRUNCATE pricing_change_audit,platform_access_audit,admin_credential_audit;
      INSERT INTO admins VALUES(8,'Synthetic reader name');
      INSERT INTO pricing_change_audit
      SELECT i,'update','credit_pricing','synthetic_'||i,NULL,CASE WHEN i=51 THEN 8 ELSE 7 END,'{}','{}','2026-10-23','2026-10-23'
      FROM generate_series(1,51) i`);
    let shrunk = false;
    const browserApp = express(); browserApp.use('/api', responseWrapper);
    browserApp.get('/api/admin/audit-logs', async (req, res) => {
      if (!shrunk && req.query.page === '2') {
        shrunk = true;
        await pool.query("UPDATE admins SET name='Synthetic renamed reader' WHERE id=7");
      }
      await getUnifiedAdminAudit(req, res);
    });
    const { withAdminAuditReadBrowser } = await import('./helpers/adminAuditReadBrowser.js');
    await withAdminAuditReadBrowser(browserApp, async page => {
      await page.getByLabel('Search administrator audit').fill('Synthetic reader name');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText('No audit events on this page.', { exact: false }).waitFor();
      expect(await page.getByRole('button', { name: 'Previous', exact: true }).isEnabled()).toBe(true);
      expect(await page.getByText('Page 2 · 1 matching event').count()).toBe(1);
      await page.getByRole('button', { name: 'Return to first page', exact: true }).click();
      await page.getByText('credit_pricing:synthetic_51', { exact: true }).waitFor();
      expect(await page.getByText('credit_pricing:synthetic_1', { exact: true }).count()).toBe(0);
    });
  }, 30000);
});
