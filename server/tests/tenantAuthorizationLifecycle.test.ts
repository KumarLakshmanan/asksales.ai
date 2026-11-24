/** Regression acceptance tests. No database, network, or provider calls. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope, currentBusinessScope } from '../tenancy/businessContext.ts';

const root = '..';
const dialect = new PgDialect();
const account = {
  id: 101, email: 'unapproved-owner@example.test', isVerified: true,
  isApproved: false, isSetupComplete: true, deletedAt: null, passwordChangedAt: null,
};
const getUserById = jest.fn(async (_id: number) => account);
const execute = jest.fn(async (query: any) => {
  const text = dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ');
  if (text.includes('SELECT p.id,p.user_id')) return { rows: [{ id: 501, user_id: 101, role: 'owner' }] };
  if (text.includes('FROM billing_admin_plan_terms')) return { rows: [] };
  if (text.includes('SELECT billing_eligibility_at')) return { rows: [{ billing_eligibility_at: new Date('2020-01-01T00:00:00Z') }] };
  if (text.includes('FROM subscription_settings')) return { rows: [{ enforced: true, launched_at: new Date('2020-01-01T00:00:00Z'), credential_id: null }] };
  if (text.includes('SELECT id,created_at,is_approved,is_setup_complete,is_verified')) return { rows: [{ id: 101, created_at: new Date('2020-01-01T00:00:00Z'), is_approved: false, is_setup_complete: true, is_verified:true }] };
  if (text.includes('FROM subscription_charges c JOIN billing_subscriptions')) return { rows: [{
    period_start: new Date('2020-01-01T00:00:00Z'), period_end: new Date('2099-01-01T00:00:00Z'),
    failure_at: null, cancel_at_period_end: false, status: 'active', failed_replacement: false,
  }] };
  throw new Error(`Unexpected audit fixture query: ${text}`);
});
jest.unstable_mockModule(`${root}/models/db.js`, () => ({ db: { execute } }));
jest.unstable_mockModule(`${root}/models/users/functions`, () => ({ getUserById }));
jest.unstable_mockModule(`${root}/models/admins/functions`, () => ({ getAdminById: jest.fn() }));
jest.unstable_mockModule(`${root}/utils/jwt`, () => ({
  verifyToken: () => ({ userId: 101, iat: 1700000000, jti: 'synthetic-audit-session' }),
  isTokenRevoked: async () => false,
}));
jest.unstable_mockModule(`${root}/services/SmartThrottlingService`, () => ({
  SmartThrottlingService: { getInstance: () => ({ isAllowed: async () => ({ allowed: true }), recordRequest: async () => undefined }) },
}));
jest.unstable_mockModule(`${root}/utils/logger.js`, () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule(`${root}/utils/authCookies.js`, () => ({
  AUTH_COOKIES: { user: 'audit-user', admin: 'audit-admin' }, readAuthCookie: () => undefined, setAuthCookie: () => undefined,
}));
class BillingOrganizationError extends Error {}
jest.unstable_mockModule(`${root}/services/billing/organizations.js`, () => ({
  BillingOrganizationError, resolveBillingOrganization: async () => 701,
  getBillingOrganization: jest.fn(), requireBillingRole: jest.fn(),
}));
jest.unstable_mockModule(`${root}/services/billing/entitlements.js`, () => ({ getOrganizationEntitlements: jest.fn() }));
jest.unstable_mockModule(`${root}/services/subscriptions/catalog.js`, () => ({ getCatalog: jest.fn() }));
class SubscriptionError extends Error {}
jest.unstable_mockModule(`${root}/services/subscriptions/gateway.js`, () => ({
  SubscriptionError, RazorpaySubscriptionGateway: class { static forCredential: ReturnType<typeof jest.fn> = jest.fn(); }, verifyCharge: jest.fn(),
}));
const { authenticateToken } = await import('../middleware/auth.ts');
const { businessPermissions } = await import('../middleware/businessPermissions.ts');
const { subscriptions } = await import('../services/subscriptions/service.ts');

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe('regression: tenant role and approval boundaries', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it.each([
    ['POST', '/api/whatsapp/manual-credentials'],
    ['POST', '/api/apify/tokens'],
    ['PUT', '/api/apify/tokens/123'],
    ['DELETE', '/api/apify/tokens/123'],
  ])('denies member access to %s %s connection handler', (method, path) => {
    const res = response(), next = jest.fn();
    withBusinessScope({ userId: 101, actorUserId: 202, businessProfileId: 501, role: 'member' }, () =>
      businessPermissions({ user: { id: 202 }, method, originalUrl: path } as Request, res, next));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each([
    ['POST', '/api/facebook/manual-credentials'],
    ['POST', '/api/instagram/manual-credentials'],
    ['POST', '/api/credentials/openai'],
  ])('CONTROL: member is denied corresponding protected route %s %s', (method, path) => {
    const res = response(), next = jest.fn();
    withBusinessScope({ userId: 101, actorUserId: 202, businessProfileId: 501, role: 'member' }, () =>
      businessPermissions({ user: { id: 202 }, method, originalUrl: path } as Request, res, next));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(['owner','billing_admin'] as const)('permits a matching %s connection manager',role=>{
    const actor=role==='owner'?101:202,res=response(),next=jest.fn();
    withBusinessScope({userId:101,actorUserId:actor,businessProfileId:501,role},()=>businessPermissions({user:{id:actor},method:'POST',originalUrl:'/api/apify/tokens'} as Request,res,next));
    expect(next).toHaveBeenCalledTimes(1);expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an actor mismatch even when the request claims the durable owner',()=>{
    const res=response(),next=jest.fn();
    withBusinessScope({userId:101,actorUserId:202,businessProfileId:501,role:'billing_admin'},()=>businessPermissions({user:{id:101},method:'POST',originalUrl:'/api/apify/tokens'} as Request,res,next));
    expect(next).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(403);
  });

  it('denies paid access when approval is revoked', async () => {
    const access = await subscriptions.access(101);
    expect(access).toMatchObject({allowed:false,reason:'approval_required'});
    expect(execute.mock.calls.some(([query]) => dialect.sqlToQuery(query).sql.includes('is_approved'))).toBe(true);
  });

  it('blocks an unapproved owner at the operational HTTP boundary', async () => {
    const req = { user: undefined, headers: { authorization: 'Bearer synthetic-token' }, originalUrl: '/api/leads',
      method: 'GET', query: {}, body: {}, ip: '127.0.0.1' } as unknown as Request;
    const res = response();
    const next = jest.fn(() => expect(currentBusinessScope()).toMatchObject({ userId: 101, businessProfileId: 501, role: 'owner' }));
    await authenticateToken(req, res, next);
    expect(getUserById).toHaveBeenCalledWith(101);
    expect(req.user).toMatchObject({ isApproved: false });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
