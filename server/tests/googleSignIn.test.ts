import { beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';

const selectRows = jest.fn<any>();
jest.unstable_mockModule('../models/db', () => ({
  db: {
    select: jest.fn<any>().mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => selectRows() }) }),
    })),
  },
}));
jest.unstable_mockModule('../services/businessProfileStaff.js', () => ({
  accessibleBusinessProfiles: async () => [],
}));
jest.unstable_mockModule('../tenancy/businessScopeResolver.js', () => ({
  resolveBusinessScope: async () => null,
}));
jest.unstable_mockModule('../models/users/functions', () => ({
  getUserByEmail: jest.fn(),
  getUserByGoogleSub: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
}));
jest.unstable_mockModule('../services/googleSignIn.js', () => ({ verifyGoogleCredential: jest.fn() }));
jest.unstable_mockModule('../utils/jwt', () => ({ generateToken: jest.fn<any>().mockReturnValue('session-token'), generateRandomToken: jest.fn() }));
jest.unstable_mockModule('../utils/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendResetPasswordEmail: jest.fn(),
  sendApprovalPendingEmail: jest.fn(),
  sendNewUserNotificationToAdmin: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('bcryptjs', () => ({ default: { hash: jest.fn(), compare: jest.fn() } }));
jest.unstable_mockModule('../models/companySettings/schema', () => ({ companySettings: { id: 'id', userId: 'userId' } }));
jest.unstable_mockModule('../models/brandToolkits/schema', () => ({ brandToolkitsTable: { id: 'id', userId: 'userId' } }));
jest.unstable_mockModule('../models/users/schema', () => ({ usersTable: { id: 'id', email: 'email' } }));
jest.unstable_mockModule('../models/admins/schema', () => ({ adminsTable: { email: 'email' } }));

const { mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const { googleSignIn, login } = await import('../controllers/authController');
const { getUserByEmail, getUserByGoogleSub, createUser, updateUser } = await import('../models/users/functions');
const { verifyGoogleCredential } = await import('../services/googleSignIn.js');
const sendVerificationEmail = (await import('../utils/email')).sendVerificationEmail;
const originalClientId = process.env.GOOGLE_SIGN_IN_CLIENT_ID;

const identity = { sub: 'google-123', email: 'person@gmail.com', name: 'Test Person' };
const googleUser = { id: 42, ...identity, googleSub: identity.sub, isVerified: true, isSetupComplete: false, isApproved: false };

describe('Google account sign-in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_SIGN_IN_CLIENT_ID = 'configured-client-id.apps.googleusercontent.com';
    selectRows.mockResolvedValue([]);
    (verifyGoogleCredential as jest.Mock<any>).mockResolvedValue(identity);
    (getUserByGoogleSub as jest.Mock<any>).mockResolvedValue(undefined);
    (createUser as jest.Mock<any>).mockResolvedValue(googleUser);
    (updateUser as jest.Mock<any>).mockResolvedValue(googleUser);
  });

  afterAll(() => {
    if (originalClientId === undefined) delete process.env.GOOGLE_SIGN_IN_CLIENT_ID;
    else process.env.GOOGLE_SIGN_IN_CLIENT_ID = originalClientId;
  });

  it('rejects an invalid Google credential before touching the database', async () => {
    (verifyGoogleCredential as jest.Mock<any>).mockRejectedValue(new Error('invalid token'));
    const res = mockResponse();
    await googleSignIn(mockRequest({ body: { credential: 'invalid' } }), res);
    expect(res._status).toBe(401);
    expect(getUserByGoogleSub).not.toHaveBeenCalled();
  });

  it('creates a verified Google account without sending an email code', async () => {
    const res = mockResponse();
    await googleSignIn(mockRequest({ body: { credential: 'valid-token' } }), res);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name,
      isVerified: true,
    }));
    expect((createUser as jest.Mock<any>).mock.calls[0][0]).not.toHaveProperty('password');
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._json.user.email).toBe(identity.email);
    expect(res._json.user.isVerified).toBe(true);
  });

  it('does not silently link a Google identity to an existing password account', async () => {
    selectRows.mockResolvedValueOnce([{ id: 8 }]);
    const res = mockResponse();
    await googleSignIn(mockRequest({ body: { credential: 'valid-token' } }), res);
    expect(res._status).toBe(409);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('recognizes a returning Google user by subject ID', async () => {
    (getUserByGoogleSub as jest.Mock<any>).mockResolvedValue(googleUser);
    const res = mockResponse();
    await googleSignIn(mockRequest({ body: { credential: 'valid-token' } }), res);
    expect(res._status).toBe(200);
    expect(createUser).not.toHaveBeenCalled();
    expect(res._json.user.id).toBe(googleUser.id);
  });

  it('does not accept a password for a Google-only account', async () => {
    (getUserByEmail as jest.Mock<any>).mockResolvedValue({ ...googleUser, password: null, failedLoginAttempts: 0 });
    const res = mockResponse();
    await login(mockRequest({ body: { email: identity.email, password: 'any-password' } }), res);
    expect(res._status).toBe(401);
  });
});
