import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import type { Request, Response } from 'express';

const rows: unknown[][] = [];
const queries: Array<{ table: string; sql: string; params: unknown[] }> = [];
const select = jest.fn(() => {
  const result = rows.shift() || [];
  let table = '';
  const chain = {
    from: (value: never) => { table = getTableName(value); return chain; },
    where: (value: SQL) => { queries.push({ table, ...new PgDialect().sqlToQuery(value) }); return chain; },
    orderBy: () => chain, limit: () => chain, offset: () => chain,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
  };
  return chain;
});
const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] }));
const claimReviewRequest = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateTicket = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const generateToken = jest.fn<(payload: Record<string, unknown>) => string>(() => 'opaque-test-token');
const verifyToken = jest.fn<(...args: unknown[]) => unknown>();
const isTokenRevoked = jest.fn(async () => false);
const startOrTouch = jest.fn<(userId: number, memberId: number, sessionId: string) => Promise<void>>(async () => undefined);
const deliver = jest.fn();
class ValidationError extends Error {}
jest.unstable_mockModule('../models/db.js', () => ({ db: { select, execute } }));
jest.unstable_mockModule('../utils/jwt.js', () => ({ generateToken, verifyToken, isTokenRevoked }));
jest.unstable_mockModule('bcryptjs', () => ({ default: { compare: async () => true } }));
jest.unstable_mockModule('../utils/authCookies.js', () => ({
  AUTH_COOKIES: { support: 'support_session' }, readAuthCookie: () => undefined,
  setAuthCookie: jest.fn(), clearAuthCookie: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/SupportService.js', () => ({
  SupportValidationError: ValidationError,
  supportService: { updateTicket, claimReviewRequest, enrichTicketQueue: async (_id: number, values: unknown[]) => values },
}));
jest.unstable_mockModule('../services/SupportPresenceService.js', () => ({ supportPresenceService: { startOrTouch } }));
jest.unstable_mockModule('../services/SupportReplyDeliveryService.js', () => ({
  SupportReplyDeliveryError: class extends Error {}, supportReplyDeliveryService: { deliver },
}));
jest.unstable_mockModule('../services/SupportTicketWorkspaceService.js', () => ({ supportTicketWorkspaceService: {} }));
jest.unstable_mockModule('../services/agents/pipeline/HandoffService.js', () => ({ handoffService: {} }));
const controller = await import('../controllers/supportMemberController.js');
const { authenticateSupportMember } = await import('../middleware/supportAuth.js');
const member = { id: 5, userId: 9, teamId: 2, businessProfileId: 17, role: 'lead', name: 'QA Member', email: 'qa@example.invalid', passwordHash: 'test-hash', isActive: true };
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}
function request(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  return { supportMember: member, params: { id: '59' }, body, query, headers: {} } as unknown as Request;
}
async function invoke(method: keyof typeof controller, body = {}, query = {}) {
  const res = response();
  await (controller[method] as (req: Request, res: Response) => unknown)(request(body, query), res as unknown as Response);
  return res;
}

describe('support member workspace boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks(); rows.length = 0; queries.length = 0;
    verifyToken.mockReturnValue({ supportMemberId: 5, jti: 'test-session', iat: Math.floor(Date.now() / 1000) });
    updateTicket.mockResolvedValue({ id: 59 });
  });

  it('qualifies handoff timestamps when aggregating joined ticket statistics', async () => {
    rows.push([{ teamId: 2 }], [{ total: 1, open: 1 }]);
    const res = await invoke('getSupportMemberStats');
    const statements = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql);
    const metrics = statements.find(query => query.includes('AS avg_claim_minutes'))!;
    expect(metrics).toContain('handoff.accepted_at-handoff.created_at');
    expect(metrics).toContain('handoff.resolved_at-COALESCE(handoff.accepted_at,handoff.created_at)');
    expect(metrics).not.toMatch(/WHERE resolved_at|accepted_at-created_at/);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it.each([
    ['getTicketDetail', {}],
    ['addTicketReply', { content: 'QA reply', isInternal: true }],
    ['getTicketReview', {}],
    ['reassignTicket', { newAssigneeId: 7 }],
  ] as const)('%s scopes ticket lookup before member access or side effects', async (method, body) => {
    const res = await invoke(method, body);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(queries[0].params).toEqual([59, 9]);
    expect(queries[0].sql).toContain('"user_id" =');
    expect(queries[0].sql).toContain('"deleted_at" is null');
    expect(updateTicket).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(['my', 'team', 'unassigned'])('keeps both queue and count scoped to tenant for %s', async scope => {
    rows.push([{ teamId: 2 }], [], [{ count: 0 }]);
    await invoke('getAssignedTickets', {}, { scope });
    const scoped = queries.filter(q => q.table === 'support_tickets');
    expect(scoped).toHaveLength(2);
    for (const query of scoped) {
      expect(query.sql).toContain('"user_id" =');
      expect(query.params).toContain(9);
    }
  });

  it('delegates lifecycle and review closure to the locked service with the current actor/version', async () => {
    updateTicket.mockResolvedValueOnce(null);
    const updated = await invoke('updateTicketStatus', { status: 'resolved', priority: 'urgent', expectedVersion: 4, resumeAi: false });
    expect(updateTicket).toHaveBeenCalledWith(9,59,{status:'resolved',priority:'urgent'}, {actorMemberId:5,expectedVersion:4,resumeAi:false});
    expect(updated.status).toHaveBeenCalledWith(404);
    claimReviewRequest.mockResolvedValueOnce(null);
    const closed = await invoke('closeTicketAndRequestReview', { expectedVersion: 4 });
    expect(claimReviewRequest).toHaveBeenCalledWith(9,59,{actorMemberId:5,expectedVersion:4});
    expect(closed.status).toHaveBeenCalledWith(404);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('keeps both team queues tenant-scoped', async () => {
    rows.push([{ teamId: 2 }], [], []);
    await invoke('getTeamQueue');
    const scoped = queries.filter(q => q.table === 'support_tickets');
    expect(scoped).toHaveLength(2);
    for (const query of scoped) expect(query.params).toContain(9);
  });

  it('keeps aggregated member statistics tenant-scoped', async () => {
    rows.push([{ teamId: 2 }], [{ total: 0 }]);
    await invoke('getSupportMemberStats');
    const scoped = queries.find(q => q.table === 'support_tickets')!;
    expect(scoped.sql).toContain('"user_id" =');
    expect(scoped.params).toContain(9);
  });

  it('reassigns using the shared atomic handoff path with the observed version and team', async () => {
    rows.push([{ id: 59, userId: 9, teamId: 2, version: 4 }], [{ teamId: 2 }], [{ id: 7 }]);
    const res = await invoke('reassignTicket', { newAssigneeId: 7 });
    expect(updateTicket).toHaveBeenCalledWith(9, 59, { assignedMemberId: 7 }, { expectedVersion: 4, expectedTeamId: 2, actorMemberId: 5, requireManage: true });
    expect(queries[2].params).toEqual([7, 2, 9, true]);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('reports a concurrent reassignment conflict without claiming success', async () => {
    rows.push([{ id: 59, userId: 9, teamId: 2, version: 4 }], [{ teamId: 2 }], [{ id: 7 }]);
    updateTicket.mockResolvedValue(null);
    expect((await invoke('reassignTicket', { newAssigneeId: 7 })).status).toHaveBeenCalledWith(409);
  });

  it('does not issue a login session for a missing, inactive or foreign team', async () => {
    rows.push([member], []);
    const res = await invoke('supportMemberLogin', { email: member.email, password: 'test-only' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(queries[1].params).toEqual([2, 9, true]);
    expect(generateToken).not.toHaveBeenCalled();
    expect(startOrTouch).not.toHaveBeenCalled();
  });

  it('accepts a valid login with an active owned team', async () => {
    rows.push([member], [{ id: 2, name: 'QA Team' }]);
    const res = await invoke('supportMemberLogin', { email: member.email, password: 'test-only' });
    expect(generateToken).toHaveBeenCalledWith({ supportMemberId: 5, email: member.email, role: 'lead' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(startOrTouch).toHaveBeenCalledWith(9, 5, 'test-session');
  });

  it('denies an existing member session if its team is deactivated or no longer owned', async () => {
    rows.push([member], []);
    const res = response(); const next = jest.fn();
    const req = request(); req.headers.authorization = 'Bearer opaque-test-token';
    await authenticateSupportMember(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(queries[1].params).toEqual([2, 9, true]);
    expect(next).not.toHaveBeenCalled();
    expect(startOrTouch).not.toHaveBeenCalled();
  });
});
