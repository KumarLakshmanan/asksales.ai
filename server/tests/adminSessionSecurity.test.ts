import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const get = jest.fn<() => Promise<string | null>>();
const set = jest.fn<() => Promise<string>>();
const transaction = jest.fn();
jest.unstable_mockModule('../infrastructure/redis', () => ({ getRedisConnection: () => ({ get, set }) }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction } }));
jest.unstable_mockModule('../models/admins/functions', () => ({ consumeAdminPasswordReset: jest.fn(), getAdminByEmail: jest.fn(), updateAdmin: jest.fn() }));
jest.unstable_mockModule('../utils/email', () => ({ sendResetPasswordEmail: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
const jwt = await import('../utils/jwt.js');
const { bootstrapAdmin, logoutAdmin } = await import('../controllers/adminController.js');
function response() {
  const res = { status: jest.fn(), json: jest.fn(), send: jest.fn(), clearCookie: jest.fn(), cookie: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}
beforeEach(() => { jest.clearAllMocks(); delete process.env.ADMIN_BOOTSTRAP_SECRET; delete process.env.ADMIN_BOOTSTRAP_EXPIRES_AT; });

describe('privileged session and bootstrap failures', () => {
  it('fails closed on admin revocation-store failure and limits admin token lifetime', async () => {
    get.mockRejectedValue(new Error('redis unavailable'));
    await expect(jwt.isTokenRevoked('copied-admin-token', true)).rejects.toThrow('redis unavailable');
    const token = jwt.generateToken({ adminId: 7, email: 'admin@example.test', role: 'admin' });
    const claims = jwt.verifyToken(token) as any;
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
  });
  it('does not claim logout succeeded when revocation could not persist', async () => {
    set.mockRejectedValue(new Error('redis unavailable'));
    const token = jwt.generateToken({ adminId: 7, email: 'admin@example.test', role: 'admin' });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const failed = response();
    await logoutAdmin(req, failed);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(failed.clearCookie).not.toHaveBeenCalled();
    set.mockResolvedValue('OK');
    const retry = response();
    await logoutAdmin(req, retry);
    expect(retry.status).toHaveBeenCalledWith(204);
    expect(retry.clearCookie).toHaveBeenCalled();
  });
  it('rejects public bootstrap before database access when disabled, expired, or incorrectly authorized', async () => {
    const req = { get: () => 'incorrect', body: { email: 'x@example.test', password: 'unused', name: 'x' } } as unknown as Request;
    const disabled = response();
    await bootstrapAdmin(req, disabled);
    expect(disabled.status).toHaveBeenCalledWith(404);
    process.env.ADMIN_BOOTSTRAP_SECRET = 'test-only-operator-bootstrap-secret-32';
    process.env.ADMIN_BOOTSTRAP_EXPIRES_AT = new Date(Date.now() + 30 * 60_000).toISOString();
    const wrong = response();
    await bootstrapAdmin(req, wrong);
    expect(wrong.status).toHaveBeenCalledWith(403);
    process.env.ADMIN_BOOTSTRAP_EXPIRES_AT = new Date(Date.now() - 1).toISOString();
    const expired = response();
    await bootstrapAdmin(req, expired);
    expect(expired.status).toHaveBeenCalledWith(404);
    expect(transaction).not.toHaveBeenCalled();
  });
});
