/**
 * Auth Controller Tests
 * Tests: register, login, verifyEmail, forgotPassword, resetPassword,
 *        getCurrentUser, resendVerificationEmail, markSetupComplete
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock modules before importing controllers
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
jest.unstable_mockModule('../models/users/functions', () => ({
  getUserByEmail: jest.fn(),
  getUserByGoogleSub: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  consumeUserPasswordReset: jest.fn(),
  consumeUserVerification: jest.fn(),
  recordFailedUserLogin: jest.fn(),
  completeUserPasswordLogin: jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: 1 }),
  getUserById: jest.fn(),
  getUserByVerificationToken: jest.fn(),
}));
jest.unstable_mockModule('../utils/jwt', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateToken: jest.fn<any>().mockReturnValue('mock-jwt-token'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateRandomToken: jest.fn<any>().mockReturnValue('123456'),
  generateOpaqueToken: jest.fn<any>().mockReturnValue('a'.repeat(43)),
  hashOpaqueToken: jest.fn<any>().mockReturnValue('b'.repeat(64)),
  verifyToken: jest.fn(),
  revokeToken: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));
jest.unstable_mockModule('../utils/email', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendVerificationEmail: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendResetPasswordEmail: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendApprovalPendingEmail: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNewUserNotificationToAdmin: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('bcryptjs', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: { hash: jest.fn<any>().mockResolvedValue('hashed-password'), compare: jest.fn() },
}));
jest.unstable_mockModule('../services/businessProfileStaff.js', () => ({ accessibleBusinessProfiles: async () => [] }));
jest.unstable_mockModule('../models/companySettings/schema', () => ({
  companySettings: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/brandToolkits/schema', () => ({
  brandToolkitsTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/users/schema', () => ({
  usersTable: { id: 'id', email: 'email', name: 'name', password: 'password', isVerified: 'isVerified' },
}));
jest.unstable_mockModule('../models/admins/schema', () => ({
  adminsTable: { id: 'id', email: 'email', name: 'name' },
}));

const { mockRequest, mockResponse, mockAuthRequest } = await import('./helpers/mockHelpers');
const { register, login, getCurrentUser, forgotPassword, resetPassword, verifyEmail, resendVerificationEmail } = await import('../controllers/authController');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { getUserByEmail, createUser, updateUser, consumeUserPasswordReset, consumeUserVerification } = await import('../models/users/functions') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bcrypt = (await import('bcryptjs')).default as any;

describe('Auth Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/register', () => {
    it('should return 400 if email is missing', async () => {
      const req = mockRequest({ body: { password: 'test123', name: 'Test' } });
      const res = mockResponse();
      await register(req, res);
      expect(res._status).toBe(400);
      expect(res._json.message).toContain('required');
    });

    it('should return 400 if password is missing', async () => {
      const req = mockRequest({ body: { email: 'test@test.com', name: 'Test' } });
      const res = mockResponse();
      await register(req, res);
      expect(res._status).toBe(400);
      expect(res._json.message).toContain('required');
    });

    it('should return 400 if name is missing', async () => {
      const req = mockRequest({ body: { email: 'test@test.com', password: 'test123' } });
      const res = mockResponse();
      await register(req, res);
      expect(res._status).toBe(400);
      expect(res._json.message).toContain('required');
    });

    it('should return 400 if user already exists', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getUserByEmail as any).mockResolvedValue({ id: 1, email: 'test@test.com' });
      const req = mockRequest({ body: { email: 'test@test.com', password: 'test123', name: 'Test' } });
      const res = mockResponse();
      await register(req, res);
      expect(res._status).toBe(400);
      expect(res._json.message).toContain('already exists');
    });

    it('should return 201 on successful registration', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getUserByEmail as any).mockResolvedValue(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (createUser as any).mockResolvedValue({ id: 1 });
      const req = mockRequest({ body: { email: 'new@test.com', password: 'test123', name: 'New User' } });
      const res = mockResponse();
      await register(req, res);
      expect(res._status).toBe(201);
      expect(res._json.userId).toBe(1);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return 400 if email or password is missing', async () => {
      const req = mockRequest({ body: { email: 'test@test.com' } });
      const res = mockResponse();
      await login(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 401 if user not found', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getUserByEmail as any).mockResolvedValue(null);
      const req = mockRequest({ body: { email: 'nouser@test.com', password: 'test123' } });
      const res = mockResponse();
      await login(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 403 if user not verified', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getUserByEmail as any).mockResolvedValue({ id: 1, email: 'test@test.com', password: 'hashed', isVerified: false });
      bcrypt.compare.mockResolvedValue(true);
      const req = mockRequest({ body: { email: 'test@test.com', password: 'test123' } });
      const res = mockResponse();
      await login(req, res);
      expect(res._status).toBe(403);
    });

    it('should return 401 if password is invalid', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getUserByEmail as any).mockResolvedValue({ id: 1, email: 'test@test.com', password: 'hashed', isVerified: true });
      bcrypt.compare.mockResolvedValue(false);
      const req = mockRequest({ body: { email: 'test@test.com', password: 'wrong' } });
      const res = mockResponse();
      await login(req, res);
      expect(res._status).toBe(401);
    });

    it('should set an HttpOnly session cookie on successful login', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getUserByEmail as any).mockResolvedValue({
        id: 1, email: 'test@test.com', password: 'hashed', isVerified: true,
        name: 'Test', setupComplete: true, approvalStatus: 'approved',
      });
      bcrypt.compare.mockResolvedValue(true);
      const req = mockRequest({ body: { email: 'test@test.com', password: 'test123' } });
      const res = mockResponse();
      const cookieSpy = jest.spyOn(res, 'cookie');
      await login(req, res);
      expect(res._status).toBe(200);
      expect(res._json.token).toBeUndefined();
      expect(cookieSpy).toHaveBeenCalled();
      const cookieCall = cookieSpy.mock.calls[0] as unknown as [
        string,
        string,
        { httpOnly: boolean; sameSite: string },
      ];
      expect(cookieCall[0]).toBe('asksales_session');
      expect(cookieCall[1]).toBe('mock-jwt-token');
      expect(cookieCall[2]).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return current user info', async () => {
      const req = mockAuthRequest(1, {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).user = { id: 1, email: 'test@test.com', name: 'Test', isVerified: true, isSetupComplete: false, isApproved: true };
      const res = mockResponse();
      await getCurrentUser(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toBeDefined();
    });
  });

  describe('POST /api/auth/forgot-password', () => {
    it('should return 400 if email is missing', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await forgotPassword(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('should return 400 if token or password is missing', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await resetPassword(req, res);
      expect(res._status).toBe(400);
    });
  });
});


describe('email verification and password reset OTP lifecycle', () => {
  beforeEach(() => { jest.clearAllMocks(); bcrypt.compare.mockResolvedValue(true); });

  it.each(['12345', '1234567', 'abcdef', 123456])('rejects malformed reset OTP %s before accessing a user', async (otp) => {
    const req = mockRequest({ body: { email: 'test@example.com', otp, newPassword: 'NewSecure!2026' } });
    const res = mockResponse(); await resetPassword(req, res);
    expect(res._status).toBe(400); expect(getUserByEmail).not.toHaveBeenCalled();
  });
  it.each([null, new Date(Date.now() - 1000)])('rejects a reset token without a valid expiry (%s)', async (expiry) => {
    getUserByEmail.mockResolvedValue({ id: 1, resetPasswordToken: '$2b$hashed', resetPasswordTokenExpiry: expiry });
    const res = mockResponse();
    await resetPassword(mockRequest({ body: { email: 'test@example.com', otp: '123456', newPassword: 'NewSecure!2026' } }), res);
    expect(res._status).toBe(400); expect(updateUser).not.toHaveBeenCalled();
  });
  it('consumes a valid reset code and clears the login lock', async () => {
    getUserByEmail.mockResolvedValue({ id: 1, resetPasswordToken: '$2b$hashed', resetPasswordTokenExpiry: new Date(Date.now() + 60_000) });
    consumeUserPasswordReset.mockResolvedValue({ id: 1 });
    const res = mockResponse();
    await resetPassword(mockRequest({ body: { email: 'test@example.com', otp: '123456', newPassword: 'NewSecure!2026' } }), res);
    expect(res._status).toBe(200);
    expect(consumeUserPasswordReset).toHaveBeenCalledWith(1, '$2b$hashed', 'hashed-password');
  });
  it('rejects a previously consumed reset token', async () => {
    getUserByEmail.mockResolvedValue({ id: 1, resetPasswordToken: null, resetPasswordTokenExpiry: null });
    const res = mockResponse();
    await resetPassword(mockRequest({ body: { email: 'test@example.com', otp: '123456', newPassword: 'NewSecure!2026' } }), res);
    expect(res._status).toBe(400); expect(updateUser).not.toHaveBeenCalled();
  });
  it('consumes a valid verification OTP and signs the user in', async () => {
    getUserByEmail.mockResolvedValue({ id: 1, email: 'test@example.com', name: 'Test', verificationToken: '$2b$hashed', verificationTokenExpiry: new Date(Date.now() + 60_000) });
    consumeUserVerification.mockResolvedValue({ id: 1 });
    const res = mockResponse();
    await verifyEmail(mockRequest({ body: { email: 'test@example.com', otp: '123456' } }), res);
    expect(res._status).toBe(200);
    expect(consumeUserVerification).toHaveBeenCalledWith(1, '$2b$hashed');
    expect(res._json.user).toMatchObject({ hasBusinessProfile: false, hasBrandToolkit: false });
  });
  it.each([null, new Date(Date.now() - 1000)])('rejects missing or expired verification expiry (%s)', async expiry => {
    getUserByEmail.mockResolvedValue({ id: 1, verificationToken: '$2b$hashed', verificationTokenExpiry: expiry });
    const res = mockResponse(); await verifyEmail(mockRequest({ body: { email: 'test@example.com', otp: '123456' } }), res);
    expect(res._status).toBe(400); expect(updateUser).not.toHaveBeenCalled();
  });
  it('resending replaces the previous verification hash and sets a new expiry', async () => {
    getUserByEmail.mockResolvedValue({ id: 1, email: 'test@example.com', name: 'Test', isVerified: false });
    const res = mockResponse(); await resendVerificationEmail(mockRequest({ body: { email: 'test@example.com' } }), res);
    expect(res._status).toBe(200);
    expect(bcrypt.hash).toHaveBeenCalledWith('123456', 10);
    expect(updateUser).toHaveBeenCalledWith(1, expect.objectContaining({ verificationToken: 'hashed-password', verificationTokenExpiry: expect.any(Date) }));
  });
});
