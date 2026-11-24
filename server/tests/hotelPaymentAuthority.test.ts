import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Request } from 'express';
import request from 'supertest';
import { withBusinessScope, type BusinessRole } from '../tenancy/businessContext.js';

const execute = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
const configuration = jest.fn<(userId: number) => Promise<Record<string, unknown>>>();
const encrypt = jest.fn((value: string) => `synthetic-encrypted:${value}`);
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/booking/HotelRagSyncService.js', () => ({ hotelRagSyncService: {} }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: {} }));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({
  encodeHotelPaymentSecret: encrypt, getHotelPaymentConfiguration: configuration, isMockPaymentAllowed: () => false,
  safeExternalBookingUrl: () => null, validateExternalBookingUrlDestination: jest.fn(),
}));
const { savePaymentSettings } = await import('../controllers/hotelAdminController.js');
const { businessPermissions } = await import('../middleware/businessPermissions.js');
const payload = {
  provider: 'razorpay', methods: { bankTransfer: { enabled: true, bankName: 'SYNTHETIC BANK', payeeName: 'SYNTHETIC PAYEE',
    accountNumber: 'NO-REAL-ACCOUNT', ifscCode: 'AUDIT0000' } },
};
let role: BusinessRole = 'member';
let authenticated = true;
function makeApp() {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (!authenticated) return res.status(401).json({ error: 'Authentication required' });
    const actorUserId = role === 'owner' ? 7 : 99;
    req.user = { id: actorUserId } as Request['user'];
    return withBusinessScope({ userId: 7, businessProfileId: 101, actorUserId, role }, next);
  });
  app.use(businessPermissions);
  app.post('/api/hotel/payment-settings', savePaymentSettings);
  app.post('/api/integrations/razorpay', (_req, res) => res.json({ reached: true }));
  return app;
}
beforeEach(() => {
  jest.clearAllMocks(); role = 'member'; authenticated = true;
  configuration.mockResolvedValue({ paymentMethodsEnabled: true, keyId: null, keySecret: null, webhookSecret: null,
    externalBooking: { url: null, linkTitle: 'Continue' }, methods: {} });
});
describe('hotel financial configuration follows business connection authority', () => {
  it('denies an ordinary member before reading, encrypting or writing payment configuration', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/integrations/razorpay').send({})).status).toBe(403);
    const result = await request(app).post('/api/hotel/payment-settings').send(payload);
    expect(result.status).toBe(403); expect(result.body.code).toBe('BUSINESS_MANAGER_REQUIRED');
    expect(configuration).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it.each(['owner', 'billing_admin'] as const)('permits %s to save synthetic payment configuration', async allowedRole => {
    role = allowedRole;
    const result = await request(makeApp()).post('/api/hotel/payment-settings').send(payload);
    expect(result.status).toBe(200); expect(result.body.success).toBe(true);
    expect(configuration).toHaveBeenCalledWith(7); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('denies member requests even before validation of a malformed payment body', async () => {
    const result = await request(makeApp()).post('/api/hotel/payment-settings').send({ provider: 'mock', keySecret: 'synthetic' });
    expect(result.status).toBe(403); expect(execute).not.toHaveBeenCalled(); expect(configuration).not.toHaveBeenCalled();
  });
  it('keeps unauthenticated requests denied', async () => {
    authenticated = false;
    expect((await request(makeApp()).post('/api/hotel/payment-settings').send(payload)).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});
