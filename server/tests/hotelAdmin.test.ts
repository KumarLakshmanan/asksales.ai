import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { SQL } from 'drizzle-orm';

// Mock ALL dependencies BEFORE importing controller
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecute = jest.fn<any>();
jest.unstable_mockModule('../models/db', () => ({
  db: {
    execute: mockExecute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: async (callback: any) => callback({ execute: mockExecute }),
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const hotelAdminController = await import('../controllers/hotelAdminController');

describe('Hotel Admin Controller - Property', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getHotelProperty', () => {
    it('should return 401 if unauthorized', async () => {
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const req = mockRequest({ user: null });
      const res = mockResponse();
      await hotelAdminController.getHotelProperty(req, res);
      expect(res._status).toBe(401);
    });

    it('should return hotel property if authorized', async () => {
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const req = mockRequest({ user: { id: 1 } });
      const res = mockResponse();
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 101, name: 'Grand Palace', city: 'Goa', address: '123 Anjuna' }],
      });
      await hotelAdminController.getHotelProperty(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.property.name).toBe('Grand Palace');
      expect(res._json.property.address).toBe('123 Anjuna');
    });
  });

  describe('saveHotelProperty', () => {
    it('should return 401 if unauthorized', async () => {
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const req = mockRequest({ user: null });
      const res = mockResponse();
      await hotelAdminController.saveHotelProperty(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if name is missing', async () => {
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const req = mockRequest({ user: { id: 1 }, body: { city: 'Goa' } });
      const res = mockResponse();
      await hotelAdminController.saveHotelProperty(req, res);
      expect(res._status).toBe(400);
    });

    it('should insert new property with extra fields if none exists', async () => {
      const req = mockRequest({
        // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
        user: { id: 1 },
        body: {
          name: 'New Resort',
          city: 'Goa',
          address: '123 Anjuna Beach Road',
          phone: '+91 9999988888',
          email: 'goa@newresort.com',
          description: 'A beautiful resort near beach',
          checkInTime: '14:00',
          checkOutTime: '11:00',
          amenities: ['WiFi']
        },
      });
      const res = mockResponse();

      // Advisory lock, then select existing returns empty
      mockExecute.mockResolvedValueOnce({ rows: [] });
      mockExecute.mockResolvedValueOnce({ rows: [] });
      // Mock insert returning new row
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 102, name: 'New Resort', city: 'Goa', address: '123 Anjuna Beach Road' }],
      });

      await hotelAdminController.saveHotelProperty(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.property.name).toBe('New Resort');
    });

    it('should update existing property with extra fields if it exists', async () => {
      const req = mockRequest({
        // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
        user: { id: 1 },
        body: {
          name: 'Updated Resort',
          city: 'Goa',
          address: '123 Updated Anjuna Beach Road',
          phone: '+91 9999988888',
          email: 'goa@updatedresort.com',
          description: 'An updated beautiful resort near beach',
          checkInTime: '14:00',
          checkOutTime: '11:00',
          amenities: ['WiFi']
        },
      });
      const res = mockResponse();

      // Advisory lock, then select existing returns one row
      mockExecute.mockResolvedValueOnce({ rows: [] });
      mockExecute.mockResolvedValueOnce({ rows: [{ id: 102 }] });
      // Mock update returning updated row
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 102, name: 'Updated Resort', city: 'Goa', address: '123 Updated Anjuna Beach Road' }],
      });

      await hotelAdminController.saveHotelProperty(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.property.name).toBe('Updated Resort');
    });
  });
});

describe('Hotel Admin Controller - dashboard summary', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('requires authentication before querying', async () => {
    const res = mockResponse();
    await hotelAdminController.getHotelSummary(mockRequest(), res);
    expect(res._status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });
  it('aggregates all owner-scoped records and preserves separate currency totals', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const summary = {totalRoomTypes: 4, totalBookings: 350, confirmedBookings: 250, revenueByCurrency: {USD: 1234, INR: 90000}};
    mockExecute.mockResolvedValueOnce({rows: [summary]});
    const res = mockResponse();
    // @ts-expect-error -- Test actor only requires its authenticated ID.
    await hotelAdminController.getHotelSummary(mockRequest({user: {id: 7}}), res);
    expect(res._json).toEqual(summary);
    const query = new PgDialect().sqlToQuery(mockExecute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("GROUP BY");
    expect(query.sql).toContain("jsonb_object_agg");
    expect(query.sql).not.toContain("LIMIT 200");
    expect(query.params).toEqual([7, 7, 7]);
  });
  it('returns a recoverable summary error', async () => {
    mockExecute.mockRejectedValueOnce(new Error('Database unavailable'));
    const res = mockResponse();
    // @ts-expect-error -- Test actor only requires its authenticated ID.
    await hotelAdminController.getHotelSummary(mockRequest({user: {id: 7}}), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe('Failed to load hotel summary.');
  });
});
