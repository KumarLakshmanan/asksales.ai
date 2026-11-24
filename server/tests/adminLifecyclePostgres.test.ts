import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

let database: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) { const value = Reflect.get(database, key); return typeof value === 'function' ? value.bind(database) : value; },
}) }));
const { updateAdmin, deleteAdmin } = await import('../models/admins/functions.js');
const suite = process.env.ADMIN_MANAGEMENT_LOCAL_QA === '1' ? describe : describe.skip;
suite('transactional administrator lifecycle with disposable PostgreSQL', () => {
  let pool: Pool, control: Pool, schema: string;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Use disposable local PostgreSQL only');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
      database: process.env.DB_NAME, connectionTimeoutMillis: 3000 };
    control = new Pool({ ...config, max: 1 }); schema = `admin_lifecycle_qa_${randomBytes(6).toString('hex')}`;
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 4, options: `-c search_path=${schema},pg_catalog` }); database = drizzle(pool);
    await pool.query(`CREATE TABLE admins(id integer PRIMARY KEY,email text UNIQUE NOT NULL,password text NOT NULL,name text NOT NULL,
      role text NOT NULL,is_verified boolean DEFAULT true,avatar text,phone text,reset_password_token text,
      reset_password_token_expiry timestamp,password_changed_at timestamp,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now())`);
  });
  afterAll(async () => { await pool?.end(); if (control && schema) await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control?.end(); });
  beforeEach(async () => {
    await pool.query(`DELETE FROM admins; INSERT INTO admins(id,email,password,name,role) VALUES
      (1,'one@example.invalid','synthetic','One','super_admin'),(2,'two@example.invalid','synthetic','Two','super_admin'),
      (3,'operator@example.invalid','synthetic','Operator','admin')`);
  });
  const superCount = async () => Number((await pool.query("SELECT count(*) FROM admins WHERE role='super_admin'")).rows[0].count);
  it('serializes concurrent self-demotions and retains the last super admin', async () => {
    const results = await Promise.allSettled([updateAdmin(1, { role: 'admin' }, 1), updateAdmin(2, { role: 'admin' }, 2)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.status).toBe(409); expect(await superCount()).toBe(1);
  });
  it('rechecks an actor who was concurrently demoted', async () => {
    const results = await Promise.allSettled([updateAdmin(2, { role: 'admin' }, 1), updateAdmin(1, { role: 'admin' }, 2)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.status).toBe(403); expect(await superCount()).toBe(1);
  });
  it('uses the same lock for deletion and demotion', async () => {
    const results = await Promise.allSettled([deleteAdmin(2, 1), updateAdmin(1, { role: 'admin' }, 2)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(await superCount()).toBe(1);
  });
  it('does not allow two super admins to delete each other', async () => {
    const results = await Promise.allSettled([deleteAdmin(2, 1), deleteAdmin(1, 2)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(await superCount()).toBe(1);
  });
  it('preserves the invariant with one remaining super admin and forbids self-deletion', async () => {
    await updateAdmin(2, { role: 'admin' }, 1);
    await expect(updateAdmin(1, { role: 'admin' }, 1)).rejects.toMatchObject({ status: 409 });
    await expect(deleteAdmin(1, 1)).rejects.toMatchObject({ status: 400 }); expect(await superCount()).toBe(1);
  });
  it('requires a current super-admin actor for lifecycle writes', async () => {
    await expect(updateAdmin(2, { role: 'admin' }, 3)).rejects.toMatchObject({ status: 403 });
    await expect(updateAdmin(2, { role: 'admin' })).rejects.toMatchObject({ status: 403 });
    await expect(deleteAdmin(2, 3)).rejects.toMatchObject({ status: 403 });
    await expect(updateAdmin(2, { name: 'Unauthorized edit' }, 3)).rejects.toMatchObject({ status: 403 });
    expect(await superCount()).toBe(2);
  });
  it('keeps non-role profile/password updates working and rolls back failed role mutations', async () => {
    expect((await updateAdmin(3, { name: 'Edited operator' }))?.name).toBe('Edited operator');
    await expect(updateAdmin(2, { role: 'admin', email: 'one@example.invalid' }, 1)).rejects.toThrow();
    expect(await superCount()).toBe(2);
    expect((await updateAdmin(2, { role: 'admin' }, 1))?.role).toBe('admin');
  });
});
