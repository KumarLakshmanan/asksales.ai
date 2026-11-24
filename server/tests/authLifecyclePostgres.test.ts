/** Actual Express routes, models, PostgreSQL isolation adapter, bcrypt and Redis.
 * Only the outbound email provider is mocked. This suite never loads env.ts.
 * Run only against the disposable database created by this audit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import bcrypt from 'bcryptjs';
import jsonwebtoken from 'jsonwebtoken';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { leadsTable } from '../models/leads/schema.js';
import { randomUUID } from 'node:crypto';

const enabled = process.env.AUTH_PRIVACY_AUDIT === 'disposable-local';
const suite = enabled ? describe : describe.skip;
if (enabled && (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55432'
  || process.env.DB_NAME !== 'audit_auth' || process.env.REDIS_PORT !== '56379')) {
  throw new Error('This audit requires its explicit disposable local PostgreSQL and Redis fixtures');
}
const pool = new Pool({ host: '127.0.0.1', port: 55432, user: 'audit_fixture',
  password: 'audit_fixture_disposable', database: 'audit_auth', max: 12 });
const database = drizzle(createBusinessScopedPool(pool));
jest.unstable_mockModule('../models/db.js', () => ({ db: database }));
const deliveries: Array<{ kind: string; email: string; otp: string }> = [];
let deliveryFails = false;
jest.unstable_mockModule('../utils/email.js', () => ({
  sendVerificationEmail: async (email: string, otp: string) => {
    deliveries.push({ kind: 'verify', email, otp }); return { success: !deliveryFails };
  },
  sendResetPasswordEmail: async (email: string, otp: string) => {
    deliveries.push({ kind: 'reset', email, otp }); return { success: !deliveryFails };
  },
  sendApprovalPendingEmail: async () => ({ success: true }),
  sendNewUserNotificationToAdmin: async () => ({ success: true }),
}));
const { generateToken, isTokenRevoked } = await import('../utils/jwt.js');
const { closeRedisConnections, getRedisConnection } = await import('../infrastructure/redis.js');
const app = express(); app.use(express.json());
if (enabled) {
  app.use('/api/auth', (await import('../routes/auth.routes.js')).default);
  app.use('/api/legal', (await import('../routes/legal.routes.js')).default);
  app.use('/api/privacy', (await import('../routes/privacy.routes.js')).default);
}

let email: string;
let caseNumber = 0;
const password = 'Synthetic!Fixture2026';
let userId: number;
async function seed(verified = true) {
  const result = await pool.query(`INSERT INTO users(email,name,password,is_verified,is_approved)
    VALUES($1,'Synthetic Audit',$2,$3,true) RETURNING id`, [email, await bcrypt.hash(password, 4), verified]);
  userId = result.rows[0].id;
  return userId;
}
function session(id = userId) { return generateToken({ userId: id, email }); }
async function resetCode() {
  const hash = await bcrypt.hash('123456', 4);
  await pool.query(`UPDATE users SET reset_password_token=$1,reset_password_token_expiry=NOW()+interval '5 minutes' WHERE id=$2`, [hash, userId]);
}
async function verificationCode() {
  await pool.query(`UPDATE users SET verification_token=$1,verification_token_expiry=NOW()+interval '5 minutes' WHERE id=$2`, [await bcrypt.hash('123456', 4), userId]);
}
async function business() {
  return (await pool.query(`INSERT INTO company_settings(user_id,company_name,is_default) VALUES($1,'Synthetic business',true) RETURNING id`, [userId])).rows[0].id as number;
}

suite('Auth/legal/privacy audit against actual local implementations', () => {
  beforeAll(async () => { await assertBusinessScopeSchema(pool); await getRedisConnection().ping(); });
  beforeEach(async () => {
    // Dedicated disposable fixture only; no inherited database is accepted.
    email = `auth-audit-${Date.now()}-${++caseNumber}@example.invalid`;
    await getRedisConnection().flushdb(); deliveries.length = 0; deliveryFails = false;
  });
  afterAll(async () => { await pool.end(); await closeRedisConnections(); });

  it('registers, hashes the OTP, rejects a wrong code, verifies, rejects replay and restores /me', async () => {
    const signup = await request(app).post('/api/auth/register').send({ email, password, name: 'Synthetic Audit' });
    expect(signup.status).toBe(201); userId = signup.body.userId;
    const code = deliveries.at(-1)!.otp;
    const row = (await pool.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    expect(row.verification_token).not.toBe(code); expect(await bcrypt.compare(code, row.verification_token)).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email, password })).status).toBe(403);
    expect((await request(app).post('/api/auth/verify-email').send({ email, otp: '000000' })).status).toBe(400);
    const verified = await request(app).post('/api/auth/verify-email').send({ email, otp: code });
    expect(verified.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', verified.headers['set-cookie'])).status).toBe(200);
    expect((await request(app).post('/api/auth/verify-email').send({ email, otp: code })).status).toBe(400);
  });

  it.each(['12345', 'abcdef', '1234567', 123456, { '$ne': null }])('rejects malformed reset OTP %p at HTTP validation', async otp => {
    await seed(); const result = await request(app).post('/api/auth/reset-password').send({ email, otp, newPassword: password });
    expect(result.status).toBe(400);
  });

  it('rejects expired verification and reset codes', async () => {
    await seed(false); await resetCode(); await verificationCode();
    await pool.query(`UPDATE users SET verification_token_expiry=NOW()-interval '1 second',reset_password_token_expiry=NOW()-interval '1 second' WHERE id=$1`, [userId]);
    expect((await request(app).post('/api/auth/verify-email').send({ email, otp: '123456' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password').send({ email, otp: '123456', newPassword: password })).status).toBe(400);
  });

  it('revokes an existing session after reset and rejects sequential reset replay', async () => {
    await seed(); await resetCode(); const oldToken = session();
    expect((await request(app).post('/api/auth/reset-password').send({ email, otp: '123456', newPassword: password + 'Changed' })).status).toBe(200);
    expect((await request(app).get('/api/auth/me').auth(oldToken, { type: 'bearer' })).status).toBe(401);
    expect((await request(app).post('/api/auth/reset-password').send({ email, otp: '123456', newPassword: password })).status).toBe(400);
  });

  it('allows only one concurrent reset consumer', async () => {
    await seed(); await resetCode();
    const results = await Promise.all([0, 1].map(i => request(app).post('/api/auth/reset-password')
      .send({ email, otp: '123456', newPassword: password + i })));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it('logs out and prevents session replay', async () => {
    await seed(); const token = session();
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').auth(token, { type: 'bearer' })).status).toBe(204);
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(401);
  });

  it.each(['admin', 'revoked'])('does not copy a rejected %s bearer into an owner session cookie', async kind => {
    await seed();
    const token = kind === 'admin' ? jsonwebtoken.sign({ adminId: 1, role: 'admin', email }, process.env.JWT_SECRET!, { expiresIn: 60 }) : session();
    if (kind === 'revoked') expect((await request(app).post('/api/auth/logout').auth(token, { type: 'bearer' })).status).toBe(204);
    const response = await request(app).get('/api/auth/me').auth(token, { type: 'bearer' });
    expect(response.status).toBe(kind === 'admin' ? 403 : 401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it.each(['malformed', 'expired', 'wrong-signature', 'admin', 'support'])('rejects %s tokens from account privacy', async kind => {
    await seed();
    const secret = process.env.JWT_SECRET!;
    const token = kind === 'malformed' ? 'malformed' : jsonwebtoken.sign(
      kind === 'admin' ? { adminId: 1, role: 'admin', email } : kind === 'support' ? { supportMemberId: 1, email } : { userId, email },
      kind === 'wrong-signature' ? 'different-synthetic-secret' : secret, { expiresIn: kind === 'expired' ? -10 : 60 });
    const result = await request(app).get('/api/privacy/consents').auth(token, { type: 'bearer' });
    expect([401, 403]).toContain(result.status);
  });

  it('returns only the signed-in account consents when a workspace exists', async () => {
    await seed(); await business();
    await pool.query(`INSERT INTO user_consents(user_id,consent_type,granted,reason) VALUES ($1,'email',false,'Synthetic private reason')`, [userId]);
    const other = (await pool.query(`INSERT INTO users(email,name,is_verified) VALUES($1,'Other synthetic',true) RETURNING id`, ['other-' + email])).rows[0].id;
    await pool.query(`INSERT INTO user_consents(user_id,consent_type,granted,reason) VALUES ($1,'email',false,'Other account secret')`, [other]);
    const result = await request(app).get('/api/privacy/consents?userId=' + other).auth(session(), { type: 'bearer' });
    expect(result.status).toBe(200);
    expect(result.body.consents).toHaveLength(1);
    expect(result.body.consents[0].userId).toBe(userId);
    expect(JSON.stringify(result.body)).not.toContain('Other account secret');
  });

  it('public deletion records remain unlinked to the claimed account and do not delete it', async () => {
    await seed();
    expect((await request(app).post('/api/legal/account-deletion-requests')
      .send({ email, userId, status: 'completed', fullName: 'Synthetic' })).status).toBe(400);
    const result = await request(app).post('/api/legal/account-deletion-requests').send({ email, fullName: 'Synthetic' });
    expect(result.status).toBe(201);
    const row = (await pool.query('SELECT * FROM account_deletion_requests WHERE id=$1', [result.body.data.id])).rows[0];
    expect(row.user_id).toBeNull(); expect(row.status).toBe('pending');
    expect((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [userId])).rows[0].deleted_at).toBeNull();
  });

  it('serves the published legal version and withholds unpublished policies', async () => {
    const slug = 'synthetic-legal-' + Date.now();
    await pool.query(`INSERT INTO policy_pages(slug,title,content_markdown,published,legal_version,approval_status)
      VALUES($1,'Synthetic published policy','Synthetic published wording',true,'audit-v3','published'),
      ($2,'Synthetic draft policy','Synthetic private draft',false,'audit-v4','draft')`, [slug, slug + '-draft']);
    const published = await request(app).get('/api/legal/policies/' + slug);
    expect(published.status).toBe(200); expect(published.body.data.legalVersion).toBe('audit-v3');
    expect((await request(app).get('/api/legal/policies/' + slug + '-draft')).status).toBe(404);
    const list = await request(app).get('/api/legal/policies');
    expect(list.status).toBe(200);
    expect(list.body.data.some((p: { slug: string }) => p.slug === slug + '-draft')).toBe(false);
  });

  it('reports email delivery failure and permits a verification resend retry', async () => {
    deliveryFails = true;
    const signup = await request(app).post('/api/auth/register').send({ email, password, name: 'Synthetic' });
    expect(signup.status).toBe(201); expect(signup.body.verificationEmailSent).toBe(false);
    deliveryFails = false;
    expect((await request(app).post('/api/auth/resend-verification').send({ email })).status).toBe(200);
    expect((await request(app).post('/api/auth/verify-email').send({ email, otp: deliveries.at(-1)!.otp })).status).toBe(200);
  });

  it('allows only one concurrent verification consumer', async () => {
    await seed(false); await verificationCode();
    await pool.query(`CREATE FUNCTION audit_delay_verification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
      CREATE TRIGGER audit_delay_verification BEFORE UPDATE ON users FOR EACH ROW
      WHEN (OLD.id=${userId} AND NEW.is_verified) EXECUTE FUNCTION audit_delay_verification()`);
    try {
      const results = await Promise.all([0, 1].map(() => request(app).post('/api/auth/verify-email').send({ email, otp: '123456' })));
      expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    } finally { await pool.query('DROP TRIGGER audit_delay_verification ON users; DROP FUNCTION audit_delay_verification()'); }
  });


  it('rejects deleted accounts at login without issuing a session cookie', async () => {
    await seed(); await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [userId]);
    const result = await request(app).post('/api/auth/login').send({ email, password });
    expect(result.status).toBe(401); expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('does not send recovery mail or consume credentials for a deleted account', async () => {
    await seed(false); await resetCode(); await verificationCode();
    await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [userId]);
    expect((await request(app).post('/api/auth/forgot-password').send({ email })).status).toBe(200);
    expect((await request(app).post('/api/auth/resend-verification').send({ email })).status).toBe(200);
    expect(deliveries).toHaveLength(0);
    expect((await request(app).post('/api/auth/reset-password').send({ email, otp: '123456', newPassword: password })).status).toBe(400);
    expect((await request(app).post('/api/auth/verify-email').send({ email, otp: '123456' })).status).toBe(400);
    const row = (await pool.query('SELECT is_verified,reset_password_token,verification_token FROM users WHERE id=$1', [userId])).rows[0];
    expect(row.is_verified).toBe(false); expect(row.reset_password_token).not.toBeNull(); expect(row.verification_token).not.toBeNull();
  });


  it('counts concurrent invalid passwords without losing failed attempts', async () => {
    await seed();
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/auth/login').send({ email, password: 'Wrong!Fixture2026' })));
    expect(responses.every(r => r.status === 401)).toBe(true);
    const row = (await pool.query('SELECT failed_login_attempts,locked_until FROM users WHERE id=$1', [userId])).rows[0];
    expect(row.failed_login_attempts).toBe(5); expect(row.locked_until).not.toBeNull();
    expect((await request(app).post('/api/auth/login').send({ email, password })).status).toBe(429);
  });

  it('starts a fresh failure window after the login lock expires', async () => {
    await seed();
    await pool.query(`UPDATE users SET failed_login_attempts=5,locked_until=NOW()-interval '1 minute' WHERE id=$1`, [userId]);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'Wrong!Fixture2026' })).status).toBe(401);
    const row = (await pool.query('SELECT failed_login_attempts,locked_until FROM users WHERE id=$1', [userId])).rows[0];
    expect(row.failed_login_attempts).toBe(1); expect(row.locked_until).toBeNull();
    expect((await request(app).post('/api/auth/login').send({ email, password })).status).toBe(200);
  });


  it('does not let an unsigned forged logout token revoke a valid session', async () => {
    await seed(); const token = session(); const claims = jsonwebtoken.decode(token) as { jti: string; exp: number };
    const forged = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.';
    await request(app).post('/api/auth/logout').auth(forged, { type: 'bearer' });
    expect(await isTokenRevoked(claims.jti)).toBe(false);
  });


  it('does not acknowledge logout when revocation failed', async () => {
    await seed(); const token = session(); const redis = getRedisConnection();
    redis.disconnect();
    let status: number;
    try { status = (await request(app).post('/api/auth/logout').auth(token, { type: 'bearer' })).status; }
    finally { await redis.connect(); }
    const replay = await request(app).get('/api/auth/me').auth(token, { type: 'bearer' });
    expect({ logout: status!, replay: replay.status }).toEqual({ logout: 503, replay: 200 });
    expect((await request(app).post('/api/auth/logout').auth(token, { type: 'bearer' })).status).toBe(204);
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(401);
  });

  it('distinguishes sessions issued before and after a password change within one second', async () => {
    await seed(); const second = Math.floor(Date.now() / 1000) * 1000 - 1000;
    await pool.query('UPDATE users SET password_changed_at=$1 WHERE id=$2', [new Date(second + 250), userId]);
    const clock = jest.spyOn(Date, 'now'); let before: string; let after: string;
    try {
      clock.mockReturnValue(second + 100); before = session();
      clock.mockReturnValue(second + 500); after = session();
    } finally { clock.mockRestore(); }
    expect((await request(app).get('/api/auth/me').auth(before!, { type: 'bearer' })).status).toBe(401);
    expect((await request(app).get('/api/auth/me').auth(after!, { type: 'bearer' })).status).toBe(200);
  });

  it.each(['Synthetic!9' + 'x'.repeat(62), 'Synthetic!9' + 'é'.repeat(31)])('refuses new bcrypt passwords exceeding 72 UTF-8 bytes (%s)', async longPassword => {
    const signup = await request(app).post('/api/auth/register').send({ email, password: longPassword, name: 'Synthetic length boundary' });
    expect(signup.status).toBe(400);
    expect((await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows).toHaveLength(0);
  });

  it('accepts the 72-byte boundary, rejects oversized reset without consuming its code, and preserves legacy login', async () => {
    await seed(); await resetCode();
    const tooLong = 'Synthetic!9' + 'é'.repeat(31);
    expect((await request(app).post('/api/auth/reset-password').send({ email, otp: '123456', newPassword: tooLong })).status).toBe(400);
    expect((await pool.query('SELECT reset_password_token FROM users WHERE id=$1', [userId])).rows[0].reset_password_token).not.toBeNull();
    const boundary = 'Synthetic!9' + 'é'.repeat(30) + 'x';
    expect(Buffer.byteLength(boundary)).toBe(72);
    expect((await request(app).post('/api/auth/reset-password').send({ email, otp: '123456', newPassword: boundary })).status).toBe(200);
    const validLogin = await request(app).post('/api/auth/login').send({ email, password: boundary });
    expect(validLogin.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', validLogin.headers['set-cookie'])).status).toBe(200);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [await bcrypt.hash(tooLong, 4), userId]);
    expect((await request(app).post('/api/auth/login').send({ email, password: tooLong })).status).toBe(200);
  });


  it('rolls back the opt-out consent if the lead update fails', async () => {
    await seed(); const profileId = await business();
    await withBusinessScope({ userId, businessProfileId: profileId }, () => database.insert(leadsTable)
      .values({ userId, businessProfileId: profileId, name: 'Synthetic lead', uuid: randomUUID(), source: 'manual', status: 'new' }));
    await pool.query(`CREATE OR REPLACE FUNCTION audit_reject_lead_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit write failure'; END $$;
      CREATE TRIGGER audit_reject_lead_update BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION audit_reject_lead_update()`);
    try {
      const response = await request(app).post('/api/privacy/opt-out').auth(session(), { type: 'bearer' }).send({ channels: ['all'] });
      expect(response.status).toBe(500);
      const consents = await pool.query('SELECT id FROM user_consents WHERE user_id=$1', [userId]);
      expect(consents.rows).toHaveLength(0);
    } finally { await pool.query('DROP TRIGGER audit_reject_lead_update ON leads; DROP FUNCTION audit_reject_lead_update()'); }
    expect((await request(app).post('/api/privacy/opt-out').auth(session(), { type: 'bearer' }).send({ channels: ['all'] })).status).toBe(200);
    expect((await pool.query('SELECT id FROM user_consents WHERE user_id=$1', [userId])).rows).toHaveLength(1);
    expect((await pool.query('SELECT do_not_contact FROM leads WHERE user_id=$1', [userId])).rows[0].do_not_contact).toBe(true);
  });


});
