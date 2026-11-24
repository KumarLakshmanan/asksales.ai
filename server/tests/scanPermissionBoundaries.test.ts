import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { businessPermissions, requireBusinessManager, requireBusinessOwner } from '../middleware/businessPermissions.js';

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}
const scope = { userId: 1, actorUserId: 2, businessProfileId: 11, role: 'member' as const };
const actor = (path: string, method = 'POST') => ({ user: { id: 2 }, originalUrl: path, method } as Request);

describe('reported permission bypasses', () => {
  it.each([
    ['/api/whatsapp/config', 'POST'], ['/api/whatsapp/toggle', 'POST'],
    ['/api/whatsapp/config', 'DELETE'], ['/api/instagram/oauth/disconnect', 'POST'],
    ['/api/meta/oauth/selection', 'POST'], ['/api/youtube/oauth/disconnect', 'POST'],
    ['/api/webhooks/config', 'GET'], ['/api/webhooks/regenerate', 'POST'],
    ['/api/settings/ai-agents/support', 'PUT'], ['/api/settings/ai-agents/active', 'PUT'],
    ['/api/support/ai/playbooks/7/publish', 'POST'], ['/api/support/ai/playbooks/7', 'PUT'],
  ])('denies a member at %s (%s)', (path, method) => {
    const res = response(), next = jest.fn();
    withBusinessScope(scope, () => businessPermissions(actor(path, method), res, next));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it('allows managers to manage connections but reserves AI policy changes to owners', () => {
    const next = jest.fn();
    withBusinessScope({ ...scope, role: 'billing_admin' }, () => {
      requireBusinessManager(actor('/api/any-alias'), response(), next);
      expect(next).toHaveBeenCalledTimes(1);
      const res = response();
      requireBusinessOwner(actor('/api/any-alias'), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
  it('rejects a scope whose actor differs from the authenticated user', () => {
    const res = response(), next = jest.fn();
    withBusinessScope({ ...scope, actorUserId: 3, role: 'billing_admin' }, () => requireBusinessManager(actor('/api/alias'), res, next));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
