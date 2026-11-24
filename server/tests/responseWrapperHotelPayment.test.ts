import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Request } from 'express';
import request from 'supertest';
import { withBusinessScope, type BusinessRole } from '../tenancy/businessContext.js';
import { responseWrapper } from '../middleware/responseWrapper.js';

const execute = jest.fn<() => Promise<{ rows: unknown[] }>>();
const configuration = jest.fn<() => Promise<Record<string, unknown>>>();
const encrypt = jest.fn<(value: string) => string>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/booking/HotelRagSyncService.js', () => ({ hotelRagSyncService: {} }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: {} }));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({
  encodeHotelPaymentSecret: encrypt, getHotelPaymentConfiguration: configuration, isMockPaymentAllowed: () => false,
  safeExternalBookingUrl: () => null, validateExternalBookingUrlDestination: jest.fn(),
}));
const { savePaymentSettings } = await import('../controllers/hotelAdminController.js');
const { businessPermissions } = await import('../middleware/businessPermissions.js');
function makeApp(role: BusinessRole) {
  const app = express(); app.use(express.json()); app.use('/api', responseWrapper);
  app.use((req, _res, next) => {
    const actorUserId = role === 'owner' ? 7 : 99;
    req.user = { id: actorUserId } as Request['user'];
    withBusinessScope({ userId: 7, businessProfileId: 101, actorUserId, role }, next);
  });
  app.use(businessPermissions);
  app.post('/api/hotel/payment-settings', savePaymentSettings);
  return app;
}
beforeEach(() => {
  jest.clearAllMocks();
  configuration.mockResolvedValue({ paymentMethodsEnabled: true, keyId: null, keySecret: null, webhookSecret: null,
    externalBooking: { url: null, linkTitle: 'Continue' }, methods: {} });
});
describe('Hotel payment consumers through the global response wrapper (COV2-01)', () => {
  it('retains the member denial code with zero configuration reads, encryption or SQL', async () => {
    const response = await request(makeApp('member')).post('/api/hotel/payment-settings').send({ provider: 'razorpay', methods: {} });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ success: false, code: 'BUSINESS_MANAGER_REQUIRED', error: 'Ask the business owner or billing admin to manage payment settings.' });
    expect(configuration).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('retains the invalid payment configuration field without making a write or provider call', async () => {
    const response = await request(makeApp('owner')).post('/api/hotel/payment-settings').send({ provider: 'razorpay', methods: {} });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ success: false, error: 'Enable and completely configure at least one payment method, or switch to external booking mode.', field: 'methods' });
    expect(configuration).toHaveBeenCalledTimes(1); expect(encrypt).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
