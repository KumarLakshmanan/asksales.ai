import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { currentBillingScope, withBillingScope } from '../tenancy/billingContext.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<(query: SQL) => Promise<{ rows: Record<string, unknown>[] }>>();
const executor = { execute };
const transaction = jest.fn<(work: (tx: typeof executor) => Promise<unknown>) => Promise<unknown>>(work => work(executor));
jest.unstable_mockModule('../models/db.js', () => ({ db: { ...executor, transaction } }));
const organizations = await import('../services/billing/organizations.js');
const { billingOrganizationScope } = await import('../middleware/billingOrganizationScope.js');
const dialect = new PgDialect();
const query = (index: number) => dialect.sqlToQuery(execute.mock.calls[index][0]);
const owner = { id: 10, owner_user_id: 1, default_for_user_id: 1, name: 'North', billing_eligibility_at: '2024-01-01T00:00:00Z', role: 'owner' };
function result(rows: Record<string, unknown>[]) { return { rows }; }
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe('organization payment responsibility and authorization', () => {
  beforeEach(() => { execute.mockReset(); transaction.mockClear(); });

  it('uses the business persisted organization instead of its owner’s default wallet', async () => {
    execute.mockResolvedValueOnce(result([{ billing_organization_id: 20 }])).mockResolvedValueOnce(result([{ ...owner, id: 20 }]));
    await expect(withBusinessScope({ userId: 1, businessProfileId: 11 }, () => organizations.resolveBillingOrganization(1))).resolves.toBe(20);
    expect(query(0).sql).toContain('FROM company_settings');
    expect(query(0).params).toEqual([11, 1]);
    expect(execute.mock.calls.some(([statement]) => dialect.sqlToQuery(statement).sql.includes('billing_default_organization'))).toBe(false);
  });

  it('keeps the staff actor distinct from the durable owner',async()=>{
    execute.mockResolvedValueOnce(result([{...owner,role:'member',business_profile_id:11,owner_account:true}]));
    await expect(withBusinessScope({userId:1,actorUserId:2,businessProfileId:11},()=>withBillingScope({organizationId:10,actorUserId:2},()=>organizations.resolveBillingOrganization(1)))).resolves.toBe(10);
    expect(query(0).sql).toContain('business_profile_memberships');expect(query(0).params).toContain(11);
  });

  it('rejects a selected organization after membership is revoked', async () => {
    execute.mockResolvedValue(result([]));
    await expect(withBillingScope({ organizationId: 99, actorUserId: 1 }, () => organizations.resolveBillingOrganization(1)))
      .rejects.toMatchObject({ status: 403, code: 'ORGANIZATION_FORBIDDEN' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not allow an unrelated owner argument to change the current business payer', async () => {
    await expect(withBusinessScope({ userId: 1, businessProfileId: 11 }, () => organizations.resolveBillingOrganization(2)))
      .rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies billing mutations to an ordinary member', async () => {
    execute.mockResolvedValueOnce(result([{ ...owner, role: 'member' }]));
    await expect(organizations.requireBillingRole(2, 10)).rejects.toMatchObject({ code: 'BILLING_ROLE_REQUIRED' });
  });

  it('does not grant invitation management to a billing admin', async () => {
    execute.mockResolvedValueOnce(result([{ id: 10 }])).mockResolvedValueOnce(result([{ ...owner, role: 'billing_admin' }]));
    await expect(organizations.inviteOrganizationMember(2, 10, 'person@example.com', 'member'))
      .rejects.toMatchObject({ code: 'ORGANIZATION_OWNER_REQUIRED' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('requires a verified email to accept an invitation', async () => {
    execute.mockResolvedValueOnce(result([{ organization_id: 10 }])).mockResolvedValueOnce(result([{ id: 10 }]))
      .mockResolvedValueOnce(result([{ email: 'invited@example.com', is_verified: false }]));
    await expect(organizations.acceptOrganizationInvitation(2, 45)).rejects.toMatchObject({ code: 'VERIFIED_EMAIL_REQUIRED' });
    expect(execute.mock.calls.some(([statement]) => dialect.sqlToQuery(statement).sql.includes('UPDATE billing_organization_memberships'))).toBe(false);
  });

  it('requires the signed-in verified email to match the invitation', async () => {
    execute.mockResolvedValueOnce(result([{ organization_id: 10 }])).mockResolvedValueOnce(result([{ id: 10 }]))
      .mockResolvedValueOnce(result([{ email: 'other@example.com', is_verified: true }])).mockResolvedValueOnce(result([]));
    await expect(organizations.acceptOrganizationInvitation(2, 45)).rejects.toMatchObject({ code: 'INVITATION_FORBIDDEN' });
    expect(query(3).params).toContain('other@example.com');
    expect(query(3).sql).toContain("status='invited'");
  });

  it('retains a member who still owns organization resources', async () => {
    execute.mockResolvedValueOnce(result([{ id: 10 }])).mockResolvedValueOnce(result([owner]))
      .mockResolvedValueOnce(result([{ user_id: 2, role: 'member' }])).mockResolvedValueOnce(result([{ id: 15 }]));
    await expect(organizations.removeOrganizationMember(1, 10, 99)).rejects.toMatchObject({ code: 'MEMBER_OWNS_RESOURCES' });
    expect(execute.mock.calls.some(([statement]) => dialect.sqlToQuery(statement).sql.includes("SET status='revoked'"))).toBe(false);
  });

  it('rejects a linked-resource move when any connected resource belongs to another user', async () => {
    execute.mockResolvedValueOnce(result([owner])).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([owner])).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ kind: 'business', id: 11, owner_user_id: 1, organization_id: 10 },
        { kind: 'workspace', id: 22, owner_user_id: 2, organization_id: 10 }]));
    await expect(organizations.assignBillingResources(1, 10, 'business', 11)).rejects.toMatchObject({ code: 'RESOURCE_OWNER_REQUIRED' });
    expect(execute.mock.calls.some(([statement]) => dialect.sqlToQuery(statement).sql.startsWith('UPDATE'))).toBe(false);
  });

  it('moves the whole linked graph using bound PostgreSQL arrays and destination quota checks', async () => {
    execute.mockResolvedValue(result([]))
      .mockResolvedValueOnce(result([{ ...owner, id: 20 }])).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ ...owner, id: 20 }])).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ kind: 'business', id: 11, owner_user_id: 1, organization_id: 10 },
        { kind: 'business', id: 12, owner_user_id: 1, organization_id: 10 },
        { kind: 'workspace', id: 22, owner_user_id: 1, organization_id: 10 }]))
      .mockResolvedValueOnce(result([{ usage: { contacts: 3, businessProfiles: 2, workspaces: 1 } }]));
    await expect(organizations.assignBillingResources(1, 20, 'business', 11)).resolves.toMatchObject({
      organizationId: 20, businessIds: [11, 12], workspaceIds: [22],
    });
    expect(query(7).params).toEqual([[11, 12], [22], 20]);
    expect(query(8).params).toEqual([20, 'contacts', 3]);
    expect(query(12).params).toContainEqual([11, 12]);
    expect(query(13).params).toContainEqual([22]);
  });
});

describe('request and asynchronous billing scope boundaries', () => {
  beforeEach(() => { execute.mockReset(); });

  it('rejects a billing selector that differs from the persisted profile payer',async()=>{
    execute.mockResolvedValueOnce(result([{billing_organization_id:10}])).mockResolvedValueOnce(result([owner]));
    const req={user:{id:1},method:'GET',originalUrl:'/api/wallet',headers:{'x-billing-organization-id':'20'}} as unknown as Request;
    const res=response(),next=jest.fn();await withBusinessScope({userId:1,businessProfileId:11},()=>billingOrganizationScope(req,res,next));
    expect(res.status).toHaveBeenCalledWith(409);expect(next).not.toHaveBeenCalled();
  });

  it('prevents a billing selector from retargeting business operations', async () => {
    execute.mockResolvedValueOnce(result([{ billing_organization_id: 10 }])).mockResolvedValueOnce(result([owner]));
    const req = { user: { id: 1 }, originalUrl: '/api/crm/contacts', headers: { 'x-billing-organization-id': '20' } } as unknown as Request;
    const next = jest.fn(() => expect(currentBillingScope()?.organizationId).toBe(10));
    await withBusinessScope({ userId: 1, businessProfileId: 11 }, () => billingOrganizationScope(req, response(), next));
    expect(next).toHaveBeenCalledTimes(1);
    expect(query(0).sql).toContain('FROM company_settings');
  });

  it('allows organization discovery to recover from a revoked browser selection', async () => {
    execute.mockResolvedValueOnce(result([{ id: 10 }]));
    const req = { user: { id: 1 }, method: 'GET', originalUrl: '/api/organizations', headers: { 'x-billing-organization-id': '99' } } as unknown as Request;
    const next = jest.fn(() => expect(currentBillingScope()?.organizationId).toBe(10));
    await billingOrganizationScope(req, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(query(0).sql).toContain('billing_default_organization');
  });

  it.each(['-1', '20x', ['10', '20'], '9007199254740992'])('rejects malformed billing selectors: %s', async selector => {
    const req = { user: { id: 1 }, originalUrl: '/api/subscriptions/current', headers: { 'x-billing-organization-id': selector } } as unknown as Request;
    const res = response(), next = jest.fn();
    await billingOrganizationScope(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps concurrent billing scopes isolated and immutable', async () => {
    await Promise.all([10, 20].map(organizationId => withBillingScope({ organizationId, actorUserId: 1 }, async () => {
      await Promise.resolve();
      expect(currentBillingScope()?.organizationId).toBe(organizationId);
      expect(Object.isFrozen(currentBillingScope())).toBe(true);
    })));
    expect(currentBillingScope()).toBeUndefined();
    expect(() => withBillingScope({ organizationId: 0, actorUserId: 1 }, () => undefined)).toThrow('Invalid billing');
  });
});
