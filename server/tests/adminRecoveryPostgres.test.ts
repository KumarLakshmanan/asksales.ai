import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import { responseWrapper } from '../middleware/responseWrapper.js';
import request from 'supertest';
import bcrypt from 'bcryptjs';

let database: ReturnType<typeof drizzle>;
const blocked = new Map<string, string>();
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) { const value = Reflect.get(database, key); return typeof value === 'function' ? value.bind(database) : value; },
}) }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  get: async (key: string) => blocked.get(key) ?? null,
  set: async (key: string, value: string) => { blocked.set(key, value); return 'OK'; },
}) }));
jest.unstable_mockModule('../utils/email.js', () => ({ sendResetPasswordEmail: async () => undefined }));
jest.unstable_mockModule('../services/SmartThrottlingService.js', () => ({ SmartThrottlingService: { getInstance: () => ({}) } }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: async () => { throw Error('Unexpected user lookup in administrator authentication'); } }));
jest.unstable_mockModule('../middleware/businessProfileScope.js', () => ({ businessProfileScope: (_q: unknown, _r: unknown, next: () => void) => next() }));
jest.unstable_mockModule('../middleware/billingOrganizationScope.js', () => ({ billingOrganizationScope: (_q: unknown, _r: unknown, next: () => void) => next() }));
jest.unstable_mockModule('../middleware/subscriptionAccess.js', () => ({ checkSubscriptionRequest: async () => true }));
const controller = await import('../controllers/adminController.js');
const { authenticateAdminToken } = await import('../middleware/auth.js');
const { generateToken, revokeToken } = await import('../utils/jwt.js');
const { validateBody } = await import('../middleware/validation.js');
const { adminResetPasswordSchema, loginSchema } = await import('../middleware/schemas.js');
const app = express(); app.use(express.json()); app.use('/api', responseWrapper);
app.post('/api/admin/reset-password', validateBody(adminResetPasswordSchema), controller.resetAdminPassword);
app.post('/api/admin/login', validateBody(loginSchema), controller.loginAdmin);
app.get('/api/admin/me', authenticateAdminToken, controller.getCurrentAdmin);
const otp = '584721';
const account = { email: 'admin-recovery@example.invalid', password: 'SyntheticOriginal123!' };
const suite = process.env.ADMIN_MANAGEMENT_LOCAL_QA === '1' ? describe : describe.skip;
suite('administrator recovery with real HTTP, JWT, bcrypt and disposable PostgreSQL', () => {
  let pool: Pool, control: Pool, schema: string;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '')) throw Error('Disposable local PostgreSQL only');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, database: process.env.DB_NAME, connectionTimeoutMillis: 3000 };
    control = new Pool({ ...config, max: 1 }); schema = `admin_recovery_${randomBytes(6).toString('hex')}`;
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 3, application_name: schema, options: `-c search_path=${schema},pg_catalog` }); database = drizzle(pool);
    await pool.query(`CREATE TABLE admins(id integer PRIMARY KEY,email text UNIQUE NOT NULL,password text NOT NULL,name text NOT NULL,
      role text NOT NULL,is_verified boolean DEFAULT true,avatar text,phone text,reset_password_token text,
      reset_password_token_expiry timestamp,password_changed_at timestamp,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now())`);
  });
  beforeEach(async () => {
    blocked.clear();
    await pool.query('DELETE FROM admins');
    await pool.query(`INSERT INTO admins(id,email,password,name,role,reset_password_token,reset_password_token_expiry)
      VALUES(1,$1,$2,'Synthetic administrator','super_admin',$3,clock_timestamp()+interval '15 minutes')`,
      [account.email, await bcrypt.hash(account.password, 4), await bcrypt.hash(otp, 4)]);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  afterAll(async () => { await pool?.end(); if (control && schema) await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control?.end(); });
  describe('AUTH-A01 atomic reset claim', () => {
    it('allows exactly one of two requests that verified the same grant to change the password', async () => {
      const compare = (value: string, hash: string) => bcrypt.compare(value, hash);
      const originalCompare = bcrypt.compare;
      let arrived = 0, release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      jest.spyOn(bcrypt, 'compare').mockImplementation(async (value: string, hash: string) => {
        const result = await originalCompare(value, hash);
        if (value === otp) { if (++arrived === 2) release(); await barrier; }
        return result;
      });
      const passwords = ['SyntheticWinner123!', 'SyntheticOther123!'];
      const results = await Promise.all(passwords.map(newPassword => request(app).post('/api/admin/reset-password').send({ email: account.email, otp, newPassword })));
      expect(results.map(res => res.status).sort()).toEqual([200, 400]);
      const row = (await pool.query('SELECT * FROM admins WHERE id=1')).rows[0];
      const winner = results.findIndex(res => res.status === 200);
      expect(await compare(passwords[winner], row.password)).toBe(true);
      expect(await compare(passwords[1 - winner], row.password)).toBe(false);
      expect(row.reset_password_token).toBeNull(); expect(row.reset_password_token_expiry).toBeNull();
      expect(row.password_changed_at).toBeInstanceOf(Date);
      expect((await request(app).post('/api/admin/reset-password').send({ email: account.email, otp, newPassword: passwords[0] })).status).toBe(400);
    });
    it('does not consume a replacement grant that arrived while the password hash was being computed', async () => {
      const originalHash = bcrypt.hash;
      const replacement = await bcrypt.hash('693812', 4);
      jest.spyOn(bcrypt, 'hash').mockImplementation(async (value: string, rounds: string | number) => {
        const result = await originalHash(value, rounds);
        if (value === 'SyntheticReplacement123!') await pool.query('UPDATE admins SET reset_password_token=$1 WHERE id=1', [replacement]);
        return result;
      });
      const res = await request(app).post('/api/admin/reset-password').send({ email: account.email, otp, newPassword: 'SyntheticReplacement123!' });
      expect(res.status).toBe(400);
      const row = (await pool.query('SELECT * FROM admins WHERE id=1')).rows[0];
      expect(row.reset_password_token).toBe(replacement); expect(row.password_changed_at).toBeNull();
    });
  });
  describe('AUTH-A02 expiry at the reset claim', () => {
    it('rechecks expiry after waiting for an unchanged locked administrator row', async () => {
      const originalHash = bcrypt.hash;
      const lock: { client?: PoolClient } = {};
      jest.spyOn(bcrypt, 'hash').mockImplementation(async (value: string, rounds: string | number) => {
        const result = await originalHash(value, rounds);
        await pool.query("UPDATE admins SET reset_password_token_expiry=clock_timestamp()+interval '300 milliseconds' WHERE id=1");
        const client = await pool.connect(); lock.client = client;
        await client.query('BEGIN'); await client.query('SELECT id FROM admins WHERE id=1 FOR UPDATE');
        return result;
      });
      const pending = request(app).post('/api/admin/reset-password').send({
        email: account.email, otp, newPassword: 'SyntheticExpiresWhileLocked123!',
      }).then(res => res);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await control.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [schema]);
          if (result.rowCount) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await control.query('SELECT pg_sleep(0.35)');
      } finally {
        await lock.client?.query('ROLLBACK'); lock.client?.release();
      }
      const res = await pending;
      expect(res.status).toBe(400);
      const row = (await pool.query('SELECT * FROM admins WHERE id=1')).rows[0];
      expect(row.reset_password_token).not.toBeNull();
      expect(row.password_changed_at).toBeNull();
    });
    it('rejects a grant that expires after verification and before consumption without changing the password', async () => {
      const initial = (await pool.query('SELECT * FROM admins WHERE id=1')).rows[0];
      const originalHash = bcrypt.hash;
      jest.spyOn(bcrypt, 'hash').mockImplementation(async (value: string, rounds: string | number) => {
        const result = await originalHash(value, rounds);
        // Deterministically move the stored deadline across the claim boundary.
        await pool.query("UPDATE admins SET reset_password_token_expiry=clock_timestamp()-interval '1 second' WHERE id=1");
        return result;
      });
      const res = await request(app).post('/api/admin/reset-password').send({
        email: account.email, otp, newPassword: 'SyntheticExpiredAtClaim123!',
      });
      expect(res.status).toBe(400);
      const row = (await pool.query('SELECT * FROM admins WHERE id=1')).rows[0];
      expect(row.password).toBe(initial.password);
      expect(row.reset_password_token).toBe(initial.reset_password_token);
      expect(row.password_changed_at).toBeNull();
    });
    it('rejects an already expired grant without consuming it', async () => {
      await pool.query("UPDATE admins SET reset_password_token_expiry=clock_timestamp()-interval '1 second' WHERE id=1");
      const res = await request(app).post('/api/admin/reset-password').send({
        email: account.email, otp, newPassword: 'SyntheticExpiredBeforeClaim123!',
      });
      expect(res.status).toBe(400);
      const row = (await pool.query('SELECT * FROM admins WHERE id=1')).rows[0];
      expect(row.reset_password_token).not.toBeNull();
      expect(row.password_changed_at).toBeNull();
    });
  });
  describe('AUTH-A05 administrator cookie principal binding', () => {
    it.each([
      { userId: 1, email: account.email, role: 'user' },
      { supportMemberId: 1, email: account.email, role: 'support' },
      { adminId: 1, userId: 1, email: account.email, role: 'super_admin' },
    ])('never writes an administrator cookie for the rejected principal %j', async claims => {
      const res = await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + generateToken(claims));
      expect(res.status).toBe(403); expect(res.headers['set-cookie']).toBeUndefined();
    });
    it('does not migrate a revoked token into a cookie', async () => {
      const token = generateToken({ adminId: 1, email: account.email, role: 'super_admin' });
      expect(await revokeToken(token)).toBe(true);
      const res = await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + token);
      expect(res.status).toBe(401); expect(res.headers['set-cookie']).toBeUndefined();
    });
    it('does not write a cookie for a deleted administrator or an old password session', async () => {
      const unknown = await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + generateToken({ adminId: 999, email: account.email, role: 'super_admin' }));
      expect(unknown.status).toBe(403); expect(unknown.headers['set-cookie']).toBeUndefined();
      const earlier = Date.now() - 120000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(earlier);
      const old = generateToken({ adminId: 1, email: account.email, role: 'super_admin' });
      clock.mockRestore();
      await pool.query('UPDATE admins SET password_changed_at=clock_timestamp() WHERE id=1');
      const stale = await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + old);
      expect(stale.status).toBe(401); expect(stale.headers['set-cookie']).toBeUndefined();
    });
    it('still migrates an authenticated administrator and preserves an existing cookie', async () => {
      const token = generateToken({ adminId: 1, email: account.email, role: 'super_admin' });
      const first = await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + token);
      expect(first.status).toBe(200); expect(first.headers['set-cookie'][0]).toContain('asksales_admin_session=');
      expect(first.body.data.admin).toMatchObject({ id: 1, role: 'super_admin' });
      const existing = await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + token).set('Cookie', 'asksales_admin_session=' + token);
      expect(existing.status).toBe(200); expect(existing.headers['set-cookie']).toBeUndefined();
    });
  });
  describe('AUTH-A04 fresh administrator session precision', () => {
    it('accepts the new login in the reset second and still rejects the pre-reset session', async () => {
      const second = Math.floor(Date.now() / 1000) * 1000;
      jest.useFakeTimers({ now: second + 100, doNotFake: [
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
        'nextTick', 'queueMicrotask', 'performance', 'hrtime',
      ] });
      const old = generateToken({ adminId: 1, email: account.email, role: 'super_admin' });
      jest.setSystemTime(second + 500);
      const newPassword = 'SyntheticFreshLogin123!';
      const reset = await request(app).post('/api/admin/reset-password').send({ email: account.email, otp, newPassword });
      expect(reset.status).toBe(200);
      const cutoff = (await pool.query('SELECT password_changed_at FROM admins WHERE id=1')).rows[0].password_changed_at;
      expect(cutoff.getTime()).toBe(second + 500);
      jest.setSystemTime(second + 750);
      const login = await request(app).post('/api/admin/login').send({ email: account.email, password: newPassword });
      expect(login.status).toBe(200);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const fresh = await request(app).get('/api/admin/me').set('Cookie', cookie);
      expect(fresh.status).toBe(200);
      expect((await request(app).get('/api/admin/me').set('Authorization', 'Bearer ' + old)).status).toBe(401);
    });
  });
});
