/**
 * Admin Controller Tests
 * Tests: registerAdmin, loginAdmin, getCurrentAdmin, forgotAdminPassword,
 *        resetAdminPassword
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock ALL dependencies BEFORE importing controller
jest.unstable_mockModule('../models/db', () => ({
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from: jest.fn<any>().mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: jest.fn<any>().mockResolvedValue([]),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: jest.fn<any>().mockResolvedValue({ rows: [] }),
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../models/admins/functions', () => ({
  consumeAdminPasswordReset: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminByEmail: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAdmin: jest.fn<any>().mockResolvedValue({ id: 1, email: 'admin@test.com', name: 'Admin' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateAdmin: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminById: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminByVerificationToken: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminByResetToken: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllAdmins: jest.fn<any>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../utils/jwt', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateToken: jest.fn<any>().mockReturnValue('mock-admin-token'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateRandomToken: jest.fn<any>().mockReturnValue('mock-random-token'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyToken: jest.fn<any>().mockReturnValue({ adminId: 1, role: 'admin' }),
}));
jest.unstable_mockModule('../utils/email', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendVerificationEmail: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendResetPasswordEmail: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendApprovalPendingEmail: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('bcryptjs', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hash: jest.fn<any>().mockResolvedValue('hashed-password'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    compare: jest.fn<any>().mockResolvedValue(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    genSalt: jest.fn<any>().mockResolvedValue('salt'),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hash: jest.fn<any>().mockResolvedValue('hashed-password'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compare: jest.fn<any>().mockResolvedValue(true),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  genSalt: jest.fn<any>().mockResolvedValue('salt'),
}));

const { mockRequest, mockResponse, mockAdminRequest } = await import('./helpers/mockHelpers');
const adminController = await import('../controllers/adminController');

describe('Admin Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('bootstrapAdmin', () => {
    it('should return 400 if email is missing', async () => {
      const req = mockRequest({ body: { name: 'Admin', password: 'password123' } });
      const res = mockResponse();
      await adminController.bootstrapAdmin(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 400 if password is missing', async () => {
      const req = mockRequest({ body: { email: 'admin@test.com', name: 'Admin' } });
      const res = mockResponse();
      await adminController.bootstrapAdmin(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 400 if name is missing', async () => {
      const req = mockRequest({ body: { email: 'admin@test.com', password: 'password123' } });
      const res = mockResponse();
      await adminController.bootstrapAdmin(req, res);
      expect(res._status).toBe(400);
    });

    it('should register admin with valid data', async () => {
      const req = mockRequest({ body: { email: 'admin@test.com', password: 'password123', name: 'Admin User' } });
      const res = mockResponse();
      await adminController.bootstrapAdmin(req, res);
      expect(res._status).not.toBe(400);
    });
  });

  describe('loginAdmin', () => {
    it('should return 400 if email is missing', async () => {
      const req = mockRequest({ body: { password: 'password123' } });
      const res = mockResponse();
      await adminController.loginAdmin(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 400 if password is missing', async () => {
      const req = mockRequest({ body: { email: 'admin@test.com' } });
      const res = mockResponse();
      await adminController.loginAdmin(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 401 if admin not found', async () => {
      const req = mockRequest({ body: { email: 'notfound@test.com', password: 'password123' } });
      const res = mockResponse();
      await adminController.loginAdmin(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getCurrentAdmin', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await adminController.getCurrentAdmin(req, res);
      expect(res._status).toBe(401);
    });

    it('should return admin data for authenticated admin', async () => {
      const req = mockAdminRequest(1);
      const res = mockResponse();
      await adminController.getCurrentAdmin(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  describe('forgotAdminPassword', () => {
    it('should return 400 if email is missing', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await adminController.forgotAdminPassword(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('resetAdminPassword', () => {
    it('should return 400 if token or password is missing', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await adminController.resetAdminPassword(req, res);
      expect(res._status).toBe(400);
    });
  });

});
