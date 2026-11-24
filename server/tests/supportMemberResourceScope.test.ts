import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { resolveSupportMemberResourceScope, MemberResourceScopeError } = await import('../services/SupportMemberResourceScope.js');
import { withBusinessScope } from '../tenancy/businessContext.js';
const member = { id: 8, userId: 9, teamId: 3 };
beforeEach(() => { jest.clearAllMocks(); });
describe('member ticket resource scope', () => {
  it('keeps the library in the authenticated business without borrowing another owner profile', async () => {
    expect(await withBusinessScope({ userId: 9, businessProfileId: 17 }, () => resolveSupportMemberResourceScope(member))).toEqual({ ticketId: null, businessProfileId: 17, source: 'workspace' });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['abc', '0', '-1', '1.5', ['1'], 0])('rejects invalid ticket IDs before querying %p', async (id) => {
    await expect(resolveSupportMemberResourceScope(member, id)).rejects.toBeInstanceOf(MemberResourceScopeError);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects tickets outside the active member/team/tenant', async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(resolveSupportMemberResourceScope(member, '2')).rejects.toMatchObject({ status: 403 });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('t.assigned_member_id=m.id OR t.team_id=m.team_id');
    expect(query.sql).toContain('t.deleted_at IS NULL');
    expect(query.sql).toContain('m.is_active=TRUE');
    expect(query.sql).toContain('team.is_active=TRUE');
    expect(query.params).toEqual([8, 2, 9, 3]);
  });
  it('uses only the ticket-linked profile after member/team/tenant authorization', async () => {
    execute.mockResolvedValue({ rows: [{ id: 2, business_profile_id: 17 }] });
    expect(await resolveSupportMemberResourceScope(member, '2')).toEqual({ ticketId: 2, businessProfileId: 17, source: 'ticket' });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('m.user_id=t.user_id');
    expect(query.sql).toContain('SELECT t.id, t.business_profile_id');
  });
  it('keeps tickets without a linked profile global', async () => {
    execute.mockResolvedValue({ rows: [{ id: 2, business_profile_id: null }] });
    expect(await resolveSupportMemberResourceScope(member, '2')).toMatchObject({ businessProfileId: null });
  });
});
