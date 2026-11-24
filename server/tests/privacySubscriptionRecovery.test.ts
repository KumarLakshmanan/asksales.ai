import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const access = jest.fn<() => Promise<{ allowed: boolean; reason?: string }>>();
const handler = jest.fn((req: Request, res: Response) => res.json({ userId: req.user?.id }));
const next = (_req: Request, _res: Response, nextHandler: NextFunction) => nextHandler();
jest.unstable_mockModule('../services/subscriptions/service.js', () => ({ subscriptions: { access } }));
jest.unstable_mockModule('../services/SmartThrottlingService.js', () => ({ SmartThrottlingService: { getInstance: () => ({
  isAllowed: async () => ({ allowed: true }), recordRequest: async () => undefined,
}) } }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: async () => ({ id: 7 }) }));
jest.unstable_mockModule('../models/admins/functions.js', () => ({ getAdminById: jest.fn() }));
jest.unstable_mockModule('../utils/jwt.js', () => ({
  verifyToken: (token: string) => token === 'synthetic-session' ? { userId: 7 } : null,
  isTokenRevoked: async () => false,
}));
jest.unstable_mockModule('../middleware/businessProfileScope.js', () => ({ businessProfileScope: next }));
jest.unstable_mockModule('../middleware/billingOrganizationScope.js', () => ({ billingOrganizationScope: next }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Privacy export/consent persistence belongs to a separate owner. Keep the
// production router, validators, authentication and subscription gate intact.
jest.unstable_mockModule('../controllers/privacyController.js', () => ({ privacyController: {
  listConsents: handler, status: handler, optOut: handler, optIn: handler, dataExport: handler,
} }));
const privacyRoutes = (await import('../routes/privacy.routes.js')).default;
const { authenticateToken } = await import('../middleware/auth.js');
const { isSubscriptionExempt } = await import('../middleware/subscriptionAccess.js');
const app = express(); app.use(express.json()); app.use('/api/privacy', privacyRoutes);
app.get('/api/leads', authenticateToken, handler);
beforeEach(() => { jest.clearAllMocks(); access.mockResolvedValue({ allowed: false, reason: 'expired' }); });

const routes = [
  ['get', '/api/privacy/consents', {}], ['get', '/api/privacy/status', {}],
  ['post', '/api/privacy/opt-out', { channels: ['email'] }],
  ['post', '/api/privacy/opt-in', { channels: ['email'] }], ['post', '/api/privacy/data-export', {}],
] as const;
describe('authenticated personal privacy recovery is independent of commercial access', () => {
  it.each(routes)('allows expired-account %s %s without a billing lookup', async (method, path, body) => {
    const result = await request(app)[method](path).set('Authorization', 'Bearer synthetic-session').send(body);
    expect(result.status).toBe(200); expect(result.body.userId).toBe(7); expect(access).not.toHaveBeenCalled();
  });
  it.each(['paid', 'expired', 'cancelled', 'payment_failed'])('retains privacy access for subscription state %s', async reason => {
    access.mockResolvedValue({ allowed: reason === 'paid', reason });
    expect((await request(app).get('/api/privacy/consents').set('Authorization', 'Bearer synthetic-session')).status).toBe(200);
    expect(access).not.toHaveBeenCalled();
  });
  it('permits privacy recovery during a billing service outage', async () => {
    access.mockRejectedValue(new Error('Synthetic billing outage'));
    expect((await request(app).post('/api/privacy/data-export').set('Authorization', 'Bearer synthetic-session').send({})).status).toBe(200);
    expect(access).not.toHaveBeenCalled();
  });
  it.each(routes)('still requires authentication for %s %s', async (method, path, body) => {
    expect((await request(app)[method](path).send(body)).status).toBe(401);
    expect(handler).not.toHaveBeenCalled(); expect(access).not.toHaveBeenCalled();
  });
  it('still rejects malformed consent requests before the privacy handler', async () => {
    expect((await request(app).post('/api/privacy/opt-out').set('Authorization', 'Bearer synthetic-session').send({ channels: ['unknown'] })).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
  it('retains commercial gating for operational APIs and lookalike namespaces', async () => {
    const result = await request(app).get('/api/leads').set('Authorization', 'Bearer synthetic-session');
    expect(result.status).toBe(402); expect(result.body.code).toBe('SUBSCRIPTION_REQUIRED'); expect(handler).not.toHaveBeenCalled();
    expect(isSubscriptionExempt('/api/privacy-evil/opt-out')).toBe(false);
    expect(isSubscriptionExempt('/api/privacyfoo')).toBe(false);
  });
});
