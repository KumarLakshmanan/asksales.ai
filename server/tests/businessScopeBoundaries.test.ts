import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import type { Pool, PoolClient } from 'pg';
import { currentBusinessScope, withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { currentBillingScope } from '../tenancy/billingContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { businessProfileScope } = await import('../middleware/businessProfileScope.js');
const { captureJobBusiness, runBusinessJob } = await import('../tenancy/jobBusinessScope.js');

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}
const north = { userId: 1, businessProfileId: 11 };
const south = { userId: 1, businessProfileId: 22 };

describe('business ownership at request and job boundaries', () => {
  beforeEach(() => { execute.mockReset(); });

  it.each(['0', '-1', '22x', ['11','22'], '9007199254740992'])('rejects malformed selectors before querying: %s', async selector => {
    const req = { user: { id: 1 }, originalUrl: '/api/chat/threads', headers: { 'x-business-profile-id': selector }, query: {} } as unknown as Request;
    const res = response();
    const next = jest.fn();
    await businessProfileScope(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses the owned default for a legacy request, but rejects an unavailable explicit profile', async () => {
    const req = { user: { id: 1 }, originalUrl: '/api/chat/threads', headers: {}, query: {} } as unknown as Request;
    execute.mockResolvedValueOnce({ rows: [{ id: 11, user_id: 1, role: 'owner' }] });
    const next = jest.fn(() => expect(currentBusinessScope()).toMatchObject(north));
    await businessProfileScope(req, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
    execute.mockResolvedValueOnce({ rows: [] });
    req.headers['x-business-profile-id'] = '99';
    const res = response();
    await businessProfileScope(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledTimes(1);
    expect(currentBusinessScope()).toBeUndefined();
  });

  it('rejects a body selector that differs from the request business', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 11, user_id: 1, role: 'owner' }] });
    const req = { user: { id: 1 }, originalUrl: '/api/content/generate', headers: { 'x-business-profile-id': '11' }, query: {}, body: { businessProfileId: 22 } } as unknown as Request;
    const res = response(), next = jest.fn();
    await businessProfileScope(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows account profile management after the selected profile is deleted', async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 11, user_id: 1, role: 'owner' }] });
    const req = { user: { id: 1 }, originalUrl: '/api/settings/business-profiles', headers: { 'x-business-profile-id': '22' }, query: {} } as unknown as Request;
    const next = jest.fn(() => expect(currentBusinessScope()).toMatchObject(north));
    await businessProfileScope(req, response(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('captures an immutable job owner and never follows a changed default', async () => {
    const input = { type: 'generate', userId: 1 };
    execute.mockResolvedValueOnce({rows:[{billing_organization_id:5}]}).mockResolvedValueOnce({rows:[{id:5}]});
    const captured = await withBusinessScope(north, () => captureJobBusiness(input));
    expect(captured).toMatchObject({...north,billingOrganizationId:5,billingActorUserId:1});
    expect(input).not.toHaveProperty('businessProfileId');
    execute.mockResolvedValueOnce({ rows: [{ id: 11, user_id: 1, role: 'owner' }] }).mockResolvedValueOnce({rows:[{id:11,user_id:1,role:'owner'}]}).mockResolvedValueOnce({rows:[{id:5}]}).mockResolvedValueOnce({rows:[{is_approved:true}]});
    await runBusinessJob(captured, async () => expect(currentBusinessScope()).toMatchObject(north));
    await expect(withBusinessScope(south, () => captureJobBusiness(captured))).rejects.toThrow(/origin/);
    await expect(withBusinessScope(north, () => captureJobBusiness({ userId: 2 }))).rejects.toThrow(/account/);
  });

  it('blocks queued work after owner approval is revoked without executing it',async()=>{
    execute.mockResolvedValueOnce({rows:[{id:11,user_id:1,role:'owner'}]})
      .mockResolvedValueOnce({rows:[{id:11,user_id:1,role:'owner'}]})
      .mockResolvedValueOnce({rows:[{id:5}]}).mockResolvedValueOnce({rows:[{is_approved:false}]});
    const work=jest.fn<()=>Promise<void>>();
    await expect(runBusinessJob({...north,billingOrganizationId:5,businessActorUserId:1,billingActorUserId:1},work)).rejects.toMatchObject({status:403,code:'BUSINESS_APPROVAL_REQUIRED'});
    expect(work).not.toHaveBeenCalled();
  });

  it('resolves record ownership only with an explicit originating actor; legacy ownership is not actor authority', async () => {
    await expect(captureJobBusiness({userId:1,threadId:123})).rejects.toMatchObject({code:'JOB_ORIGIN_REQUIRED'});
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ rows: [{ id: 22, user_id: 1 }] })
      .mockResolvedValueOnce({rows:[{billing_organization_id:5}]}).mockResolvedValueOnce({rows:[{id:5}]});
    expect(await captureJobBusiness({ userId: 1, threadId: 123,businessActorUserId:1,billingActorUserId:1 })).toMatchObject(south);
    execute.mockResolvedValueOnce({ rows: [{ id: 11, user_id: 1, role: 'owner' }, { id: 22 }] });
    await expect(captureJobBusiness({ userId: 1,businessActorUserId:1,billingActorUserId:1 })).rejects.toThrow(/unambiguous/);
    execute.mockResolvedValueOnce({ rows: [{ id: 22, user_id: 2 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(captureJobBusiness({ userId: 1, threadId: 456,businessActorUserId:1,billingActorUserId:1 })).rejects.toThrow(/unambiguous/);
  });

  it('allows prepaid cleanup only after a definitive billing denial and keeps both original scopes',async()=>{
    execute.mockResolvedValueOnce({rows:[{id:11,user_id:1,role:'owner'}]}).mockResolvedValueOnce({rows:[]});
    const work=jest.fn<()=>Promise<void>>();
    const cleanup=jest.fn(async()=>{
      expect(currentBusinessScope()).toMatchObject(north);
      expect(currentBillingScope()).toMatchObject({organizationId:5,actorUserId:9});
    });
    await expect(runBusinessJob({...north,billingOrganizationId:5,businessActorUserId:9,billingActorUserId:9},work,cleanup))
      .rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(work).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(currentBusinessScope()).toBeUndefined();
    expect(currentBillingScope()).toBeUndefined();
  });

  it('does not cancel prepaid work after transient membership lookup failures',async()=>{
    execute.mockResolvedValueOnce({rows:[{id:11,user_id:1,role:'owner'}]}).mockRejectedValueOnce(new Error('Database temporarily unavailable'));
    const work=jest.fn<()=>Promise<void>>(),cleanup=jest.fn<()=>Promise<void>>();
    await expect(runBusinessJob({...north,billingOrganizationId:5,businessActorUserId:1,billingActorUserId:1},work,cleanup))
      .rejects.toThrow('Database temporarily unavailable');
    expect(work).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('keeps simultaneous asynchronous businesses separate', async () => {
    await Promise.all([north, south].map(scope => withBusinessScope(scope, async () => {
      await Promise.resolve();
      expect(currentBusinessScope()).toMatchObject(scope);
      expect(Object.isFrozen(currentBusinessScope())).toBe(true);
      withSystemScope('Boundary test inventory', () => expect(currentBusinessScope()).toBeUndefined());
      expect(currentBusinessScope()).toMatchObject(scope);
    })));
    expect(currentBusinessScope()).toBeUndefined();
  });
});

describe('scoped pool connection failures', () => {
  it('destroys the connection when transaction scope setup fails before Drizzle can release it', async () => {
    const query = jest.fn<(text: string) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('scope setup failed'))
      .mockResolvedValueOnce({});
    const release = jest.fn();
    const raw = { connect: async () => ({ query, release }) as unknown as PoolClient } as Pool;
    const pool = createBusinessScopedPool(raw);
    const client = await withBusinessScope(north, () => pool.connect());
    await expect(client.query('BEGIN')).rejects.toThrow('scope setup failed');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith(true);
    client.release();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
