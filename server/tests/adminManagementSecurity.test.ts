import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { UserRecord } from '../models/users/schema.js';

let user: UserRecord;
const createUser = jest.fn<(input: Partial<UserRecord>) => Promise<UserRecord>>(async input => (user = { ...user, ...input }));
const updateUser = jest.fn<(id: number, patch: Partial<UserRecord>) => Promise<UserRecord | undefined>>(async (id, patch) => {
  if (id !== user.id) return undefined;
  user = { ...user, ...patch };
  return user;
});
const emptyRows = () => {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
  return chain;
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: emptyRows, execute: async () => ({ rows: [] }) } }));
jest.unstable_mockModule('../models/users/functions.js', () => ({
  createUser, updateUser, getUserById: async () => user, getAllUsers: async () => [user],
  getUserByEmail: async () => undefined, deleteUser: async () => true,
}));
const syntheticAdmin = (id: number) => ({ id, name: 'Synthetic operator', email: 'operator@example.invalid',
  role: id === 1 ? 'super_admin' : 'admin', password: 'synthetic-stored-hash', resetPasswordToken: 'synthetic-reset-digest',
  passwordChangedAt: null, futureSecurityField: 'synthetic-new-field' });
jest.unstable_mockModule('../models/admins/functions.js', () => ({
  getAdminById: async (id: number) => syntheticAdmin(id),
  getAllAdmins: async () => [syntheticAdmin(1)], createAdmin: jest.fn(), updateAdmin: jest.fn(), deleteAdmin: jest.fn(),
}));
jest.unstable_mockModule('../utils/email.js', () => ({ sendApprovalConfirmationEmail: async () => undefined }));
jest.unstable_mockModule('../utils/jwt.js', () => ({
  verifyToken: (token: string) => token === 'synthetic-user-no-time' ? { userId: 11 }
    : token === 'synthetic-user' ? { userId: 11, iat: 1 }
    : { adminId: token === 'synthetic-super' ? 1 : 2, role: token === 'synthetic-super' ? 'super_admin' : 'admin', iat: 1 },
  isTokenRevoked: async () => false,
}));
jest.unstable_mockModule('../services/SmartThrottlingService.js', () => ({
  SmartThrottlingService: { getInstance: () => ({ isAllowed: async () => ({ allowed: true }), recordRequest: async () => undefined }) },
}));
jest.unstable_mockModule('../middleware/businessProfileScope.js', () => ({ businessProfileScope: (_q: unknown, _r: unknown, next: () => void) => next() }));
jest.unstable_mockModule('../middleware/billingOrganizationScope.js', () => ({ billingOrganizationScope: (_q: unknown, _r: unknown, next: () => void) => next() }));
jest.unstable_mockModule('../middleware/subscriptionAccess.js', () => ({ checkSubscriptionRequest: async () => true }));
const controller = await import('../controllers/adminManagementController.js');
const auth = await import('../middleware/auth.js');
const { validateBody, validateParams } = await import('../middleware/validation.js');
const { adminUserCreateSchema, adminUserUpdateSchema, adminManagementIdSchema } = await import('../utils/adminManagementValidation.js');
const { resetMemberPasswordSchema } = await import('../middleware/schemas.js');
const service = await import('../services/adminUserService.js');
const app = express(); app.use(express.json());
app.get('/api/admin/admins', auth.authenticateAdminToken, controller.getAdmins);
app.get('/api/admin/admins/:id', auth.authenticateAdminToken, validateParams(adminManagementIdSchema), controller.getAdminByIdHandler);
app.get('/api/admin/users', auth.authenticateAdminToken, controller.getUsers);
app.get('/api/admin/users/:id', auth.authenticateAdminToken, validateParams(adminManagementIdSchema), controller.getUserHandler);
app.post('/api/admin/users', auth.authenticateAdminToken, validateBody(adminUserCreateSchema), controller.createUserHandler);
app.put('/api/admin/users/:id', auth.authenticateAdminToken, validateParams(adminManagementIdSchema), validateBody(adminUserUpdateSchema), controller.updateUserHandler);
app.post('/api/admin/users/:id/verify', auth.authenticateAdminToken, validateParams(adminManagementIdSchema), controller.verifyUserHandler);
app.post('/api/admin/users/:id/approve', auth.authenticateAdminToken, validateParams(adminManagementIdSchema), controller.approveUserHandler);
app.post('/api/admin/users/:id/reject', auth.authenticateAdminToken, validateParams(adminManagementIdSchema), controller.rejectUserHandler);
app.put('/api/admin/users/:id/password', auth.authenticateAdminToken, auth.requireSuperAdmin, validateParams(adminManagementIdSchema), validateBody(resetMemberPasswordSchema), controller.updateUserPasswordHandler);
app.get('/api/fixture', auth.authenticateToken, (_q, res) => res.json({ ok: true }));
const admin = 'Bearer synthetic-admin', superAdmin = 'Bearer synthetic-super';
const forbiddenFields = ['password', 'resetPasswordToken', 'resetPasswordTokenExpiry', 'verificationToken', 'verificationTokenExpiry',
  'webhookTokenNonce', 'googleSub', 'passwordChangedAt', 'failedLoginAttempts', 'lockedUntil', 'futureSecurityField'];
function expectSafe(value: Record<string, unknown>) {
  expect(value).toMatchObject({ id: 11, email: expect.any(String), name: expect.any(String) });
  for (const field of forbiddenFields) expect(value).not.toHaveProperty(field);
}
beforeEach(() => {
  jest.clearAllMocks();
  user = { id: 11, name: 'Synthetic User', email: 'fixture@example.invalid', role: 'user', isVerified: true,
    isApproved: false, isSetupComplete: true, password: 'synthetic-stored-hash', passwordChangedAt: null,
    resetPasswordToken: 'synthetic-reset-digest', verificationToken: 'synthetic-verification-digest',
    webhookTokenNonce: 'synthetic-nonce', futureSecurityField: 'synthetic-new-field' } as unknown as UserRecord;
});
describe('administrator user security acceptance', () => {
  it('allowlists platform-administrator responses as well as customer-user responses', async () => {
    const list = await request(app).get('/api/admin/admins').set('Authorization', admin);
    const detail = await request(app).get('/api/admin/admins/1').set('Authorization', admin);
    expect(list.status).toBe(200); expect(detail.status).toBe(200);
    for (const record of [list.body.admins[0], detail.body.admin]) {
      expect(record).toMatchObject({ id: 1, name: 'Synthetic operator' });
      for (const field of forbiddenFields) expect(record).not.toHaveProperty(field);
    }
  });
  it.each(['x', '', 'SyntheticValid123!'])('rejects a password in general edits without any write: %s', async password => {
    const response = await request(app).put('/api/admin/users/11').set('Authorization', admin).send({ password, name: 'Edited' });
    expect(response.status).toBe(400); expect(updateUser).not.toHaveBeenCalled();
  });
  it('also rejects a password at the service boundary', async () => {
    await expect(service.updateExistingUser(11, { password: 'x' } as never)).rejects.toMatchObject({ status: 400 });
    expect(updateUser).not.toHaveBeenCalled();
  });
  it('requires super-admin authorization on dedicated reset, even with a valid password', async () => {
    const response = await request(app).put('/api/admin/users/11/password').set('Authorization', admin).send({ newPassword: 'SyntheticValid123!' });
    expect(response.status).toBe(403); expect(updateUser).not.toHaveBeenCalled();
  });
  it('also enforces reset authorization for direct controller callers', async () => {
    const { mockRequest, mockResponse } = await import('./helpers/mockHelpers.js');
    const response = mockResponse();
    await controller.updateUserPasswordHandler(mockRequest({ params: { id: '11' }, user: { id: 2, role: 'admin' },
      body: { newPassword: 'SyntheticValid123!' } } as never), response);
    expect(response._status).toBe(403); expect(updateUser).not.toHaveBeenCalled();
  });
  it('authorized dedicated reset clears recovery grants and invalidates an existing synthetic session', async () => {
    const response = await request(app).put('/api/admin/users/11/password').set('Authorization', superAdmin).send({ newPassword: 'SyntheticValid123!' });
    expect(response.status).toBe(200); expect(user.passwordChangedAt).toBeInstanceOf(Date);
    expect(user.resetPasswordToken).toBeNull(); expect(user.resetPasswordTokenExpiry).toBeNull();
    expect((await request(app).get('/api/fixture').set('Authorization', 'Bearer synthetic-user')).status).toBe(401);
    expect((await request(app).get('/api/fixture').set('Authorization', 'Bearer synthetic-user-no-time')).status).toBe(401);
    expect(response.body).not.toHaveProperty('user');
  });
  it.each(['x', '', 'NoSpecial123', 'a'.repeat(129)])('rejects invalid dedicated-reset password: %s', async newPassword => {
    expect((await request(app).put('/api/admin/users/11/password').set('Authorization', superAdmin).send({ newPassword })).status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });
  it('normalizes create input and projects the response', async () => {
    const response = await request(app).post('/api/admin/users').set('Authorization', admin)
      .send({ name: '  Synthetic Local  ', email: ' LOCAL@example.invalid ', password: 'SyntheticValid123!', timezone: '' });
    expect(response.status).toBe(201); expectSafe(response.body.user);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ name: 'Synthetic Local', email: 'local@example.invalid', timezone: 'Asia/Kolkata' }));
  });
  it.each([{ email: 'bad-email' }, { name: ' ' }, { role: 'super_admin' }, { timezone: 'bad/timezone' },
    { phone: '1'.repeat(51) }, { bio: 'x'.repeat(2001) }, { isApproved: true }])('rejects invalid create fields: %j', async invalid => {
    const response = await request(app).post('/api/admin/users').set('Authorization', admin)
      .send({ name: 'Local', email: 'local@example.invalid', password: 'SyntheticValid123!', ...invalid });
    expect(response.status).toBe(400); expect(createUser).not.toHaveBeenCalled();
  });
  it.each(['11junk', '0', '-1', '01', '2147483648', '9007199254740992'])('rejects malformed or unsupported target ID: %s', async id => {
    expect((await request(app).put(`/api/admin/users/${id}`).set('Authorization', admin).send({ name: 'Edited' })).status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });
  it('protects direct controller callers from numeric-prefix target coercion', async () => {
    const { mockRequest, mockResponse } = await import('./helpers/mockHelpers.js');
    const response = mockResponse(); await controller.updateUserHandler(mockRequest({ params: { id: '11junk' }, body: { name: 'Edited' } }), response);
    expect(response._status).toBe(400); expect(updateUser).not.toHaveBeenCalled();
  });
  it('projects every management response and cannot leak future security columns', async () => {
    for (const path of ['verify', 'approve', 'reject']) {
      const response = await request(app).post(`/api/admin/users/11/${path}`).set('Authorization', admin);
      expect(response.status).toBe(200); expectSafe(response.body.user);
    }
    const edited = await request(app).put('/api/admin/users/11').set('Authorization', admin).send({ name: 'Edited' });
    expect(edited.status).toBe(200); expectSafe(edited.body.user);
    expectSafe((await request(app).get('/api/admin/users').set('Authorization', admin)).body.users[0]);
    const detail = await request(app).get('/api/admin/users/11').set('Authorization', admin);
    expect(detail.status).toBe(200); expectSafe(detail.body.user);
  });
});
