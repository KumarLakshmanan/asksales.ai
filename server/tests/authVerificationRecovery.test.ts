import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const allowed = jest.fn<() => Promise<{ allowed: boolean }>>();
const getUser = jest.fn<() => Promise<unknown>>();
const revoked = jest.fn<() => Promise<boolean>>();
const verify = jest.fn<() => unknown>();
const setCookie = jest.fn();
jest.unstable_mockModule('../services/SmartThrottlingService', () => ({ SmartThrottlingService: { getInstance: () => ({ isAllowed: allowed, recordRequest: async () => {} }) } }));
jest.unstable_mockModule('../models/users/functions', () => ({ getUserById: getUser }));
jest.unstable_mockModule('../models/admins/functions', () => ({ getAdminById: jest.fn() }));
jest.unstable_mockModule('../utils/jwt', () => ({ verifyToken: verify, isTokenRevoked: revoked }));
jest.unstable_mockModule('../utils/authCookies.js', () => ({ AUTH_COOKIES: { user: 'session' }, readAuthCookie: () => 'synthetic-cookie', setAuthCookie: setCookie }));
jest.unstable_mockModule('../middleware/businessProfileScope.js', () => ({ businessProfileScope: async (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.unstable_mockModule('../middleware/businessPermissions.js', () => ({ businessPermissions: async (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.unstable_mockModule('../middleware/billingOrganizationScope.js', () => ({ billingOrganizationScope: async (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.unstable_mockModule('../middleware/subscriptionAccess.js', () => ({ checkSubscriptionRequest: async () => true }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { authenticateToken } = await import('../middleware/auth.js');

function request() { return { headers: {}, ip: '127.0.0.1' } as Request; }
function response() {
  const result = { status: jest.fn(), json: jest.fn() };
  result.status.mockReturnValue(result);
  return result as unknown as Response;
}
beforeEach(() => {
  jest.clearAllMocks();
  allowed.mockResolvedValue({ allowed: true });
  getUser.mockResolvedValue({ id: 11 });
  revoked.mockResolvedValue(false);
  verify.mockReturnValue({ userId: 11, jti: 'synthetic-session', iat: 1700000000 });
});
describe('user-session verification recovery', () => {
  it.each(['throttling', 'revocation', 'account lookup'] as const)('denies access with a recoverable response when %s is unavailable, then verifies again on retry', async dependency => {
    const failure = new Error('Synthetic dependency failure; private detail');
    if (dependency === 'throttling') allowed.mockRejectedValueOnce(failure);
    else if (dependency === 'revocation') revoked.mockRejectedValueOnce(failure);
    else getUser.mockRejectedValueOnce(failure);
    const res = response(), next = jest.fn();
    await authenticateToken(request(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ code: 'SESSION_VERIFICATION_UNAVAILABLE', message: 'Your session could not be verified. Please try again.' });
    expect(setCookie).not.toHaveBeenCalled();
    const retried = response();
    await authenticateToken(request(), retried, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(retried.status).not.toHaveBeenCalled();
  });
  it.each(['invalid token', 'revoked token', 'missing account', 'deleted account'] as const)('still rejects a genuinely %s session', async reason => {
    if (reason === 'invalid token') verify.mockReturnValue(null);
    else if (reason === 'revoked token') revoked.mockResolvedValue(true);
    else if (reason === 'missing account') getUser.mockResolvedValue(undefined);
    else getUser.mockResolvedValue({ id: 11, deletedAt: new Date() });
    const res = response(), next = jest.fn();
    await authenticateToken(request(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
