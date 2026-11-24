import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { businessPermissions } from '../middleware/businessPermissions.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
it.each(['/config', '/refresh', '/disconnect', '/watch', '/unwatch'])('restricts Gmail mutation %s to connection managers', path => {
  const req = { user: { id: 12 }, originalUrl: `/api/gmail/oauth${path}`, method: 'POST' } as Request;
  const res = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res);
  const next = jest.fn();
  withBusinessScope({ userId: 9, actorUserId: 12, businessProfileId: 11, role: 'member' }, () => businessPermissions(req, res as unknown as Response, next));
  expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  withBusinessScope({ userId: 9, actorUserId: 12, businessProfileId: 11, role: 'billing_admin' }, () => businessPermissions(req, res as unknown as Response, next));
  expect(next).toHaveBeenCalledTimes(1);
});
describe('Gmail readable status', () => { it('allows ordinary members to inspect status', () => {
  const next = jest.fn();
  withBusinessScope({ userId: 9, actorUserId: 12, businessProfileId: 11, role: 'member' }, () => businessPermissions({ user: { id: 12 }, originalUrl: '/api/gmail/oauth/status', method: 'GET' } as Request, {} as Response, next));
  expect(next).toHaveBeenCalledTimes(1);
}); });

it.each(['/authorize', '/auth-url'])('restricts Gmail initiation alias %s for members', path => {
  const next = jest.fn(); const res = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res);
  withBusinessScope({ userId: 9, actorUserId: 12, businessProfileId: 11, role: 'member' }, () => businessPermissions({ user: { id: 12 }, originalUrl: `/api/gmail/oauth${path}`, method: 'GET' } as Request, res as unknown as Response, next));
  expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
});
