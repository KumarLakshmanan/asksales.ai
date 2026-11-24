import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import { responseWrapper } from '../middleware/responseWrapper.js';
import { withAdminReadBrowser } from './helpers/adminReadBrowser.js';
let database: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) { const value = Reflect.get(database, key); return typeof value === 'function' ? value.bind(database) : value; },
}) }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: {} }));
const { listOrganizationWallets } = await import('../services/billing/adminWallets.js');
const suite = process.env.ADMIN_MANAGEMENT_LOCAL_QA === '1' ? describe : describe.skip;
suite('bounded billing-account discovery with disposable PostgreSQL', () => {
  let pool: Pool, control: Pool, schema: string;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Disposable local PostgreSQL only');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, database: process.env.DB_NAME };
    control = new Pool({ ...config, max: 1 }); schema = `admin_wallet_discovery_${randomBytes(6).toString('hex')}`;
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` }); database = drizzle(pool);
    await pool.query(`CREATE TABLE users(id int PRIMARY KEY,email text);
      CREATE TABLE billing_organizations(id int PRIMARY KEY,name text,owner_user_id int);
      CREATE TABLE wallets(organization_id int,balance numeric);
      CREATE TABLE subscription_charges(organization_id int,subscription_id int,refund_amount_paise int,period_start timestamp,period_end timestamp);
      CREATE TABLE billing_subscriptions(id int,version int,slug text,mode text);
      CREATE TABLE subscription_plans(version int,slug text,name text);
      CREATE TABLE billing_admin_plan_terms(organization_id int,version int,slug text,cancelled_at timestamp,starts_at timestamp,ends_at timestamp);
      INSERT INTO users SELECT id,'owner'||id||'@example.invalid' FROM generate_series(1,105) id;
      INSERT INTO billing_organizations SELECT id,'Synthetic '||id,id FROM generate_series(1,105) id;`);
  });
  afterAll(async () => { await pool?.end(); if (control && schema) await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control?.end(); });
  it('reports that 105 matches exceed the bounded stable result set', async () => {
    const result = await listOrganizationWallets('Synthetic');
    expect(result.organizations).toHaveLength(100);
    expect(result.organizations.map((row: { id: number }) => row.id)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(result).toMatchObject({ hasMore: true, resultLimit: 100 });
  });
  it('finds an omitted account by a narrower known email or exact ID', async () => {
    for (const search of ['owner105@example.invalid', '105']) {
      const result = await listOrganizationWallets(search);
      expect(result.organizations.map((row: { id: number }) => row.id)).toEqual([105]);
      expect(result.hasMore).toBe(false);
    }
  });
  it('preserves Tenant live-mode plan selection', async () => {
    await pool.query(`INSERT INTO billing_subscriptions VALUES(1,1,'fixture','live'),(2,2,'fixture','test');
      INSERT INTO subscription_plans VALUES(1,'fixture','Live fixture'),(2,'fixture','Test fixture');
      INSERT INTO subscription_charges VALUES(1,1,0,now()-interval '2 hours',now()+interval '1 day'),
      (1,2,0,now()-interval '1 hour',now()+interval '1 day');`);
    expect((await listOrganizationWallets('owner1@example.invalid')).organizations[0].planName).toBe('Live fixture');
  });
  (process.env.ADMIN_USAGE_LOCAL_BROWSER === '1' ? it : it.skip)('discloses the cap through actual PostgreSQL/HTTP and allows browser narrowing without financial writes', async () => {
    const app = express(); app.use('/api', responseWrapper);
    app.get('/api/admin/subscriptions/organizations', async (req, res) => res.json(await listOrganizationWallets(String(req.query.search || ''))));
    await withAdminReadBrowser(app, 'wallets', async page => {
      await page.getByRole('option', { name: /owner100@example.invalid/ }).waitFor({ state: 'attached' });
      expect(await page.getByRole('option').count()).toBe(101);
      expect(await page.getByText(/Showing the first 100 matching billing accounts/).count()).toBe(1);
      await page.getByLabel('Find a billing account').fill('owner105@example.invalid');
      await page.getByRole('option', { name: /owner105@example.invalid/ }).waitFor({ state: 'attached' });
      expect(await page.getByText(/More accounts match/).count()).toBe(0);
    });
  }, 60000);
  it('does not announce truncation for exactly 100 matches or none', async () => {
    await pool.query('DELETE FROM billing_organizations WHERE id>100');
    expect(await listOrganizationWallets('Synthetic')).toMatchObject({ hasMore: false, resultLimit: 100 });
    expect(await listOrganizationWallets('missing@example.invalid')).toMatchObject({ organizations: [], hasMore: false });
  });
});
