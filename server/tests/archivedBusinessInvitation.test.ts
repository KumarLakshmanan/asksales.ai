/** Audit-only archived-invitation contract reproduction, synthetic DB adapter. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
const root = '..';
const dialect = new PgDialect();
const profile = { id: 501, userId: 101, archivedAt: new Date('2026-10-22T00:00:00Z') };
let status = 'invited', preference: number | null = null;
const queries: string[] = [];
const execute = jest.fn(async (query: any) => {
  const text = dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ');
  queries.push(text);
  if (text.includes('SELECT m.id,m.business_profile_id')) return { rows: text.includes('p.archived_at IS NULL') ? [] : [{
    id: 901, business_profile_id: 501, email: 'staff@example.test', role: 'member', business_profile_name: 'Archived business',
  }] };
  if (text.includes('SELECT business_profile_id FROM business_profile_memberships')) return { rows: [{ business_profile_id: 501 }] };
  if (text.includes('SELECT p.id FROM company_settings')) return { rows: [] };
  if (text.includes('SELECT id FROM company_settings')) return { rows: [{ id: 501 }] };
  if (text.includes('SELECT m.*,u.is_verified')) return { rows: [{
    id: 901, business_profile_id: 501, email: 'staff@example.test', role: 'member', user_id: null, status, is_verified: true,
  }] };
  if (text.includes('UPDATE business_profile_memberships SET user_id')) { status = 'active'; return { rows: [] }; }
  if (text.includes('INSERT INTO business_profile_membership_audit')) return { rows: [] };
  if (text.includes('INSERT INTO business_profile_preferences')) { preference = 501; return { rows: [] }; }
  throw new Error(`Unexpected archived-invitation fixture query: ${text}`);
});
const db = {
  execute,
  transaction: async (callback: any) => callback(db),
  select: () => ({ from: () => ({ where: (query: any) => ({ orderBy: async () => {
    const text = dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ');
    queries.push(text);
    return text.includes('archived_at IS NULL') ? [] : [profile];
  } }) }) }),
};
jest.unstable_mockModule(`${root}/models/db.js`, () => ({ db }));
const { listBusinessInvitations, acceptBusinessInvitation } = await import('../services/businessProfileStaff.ts');
describe('archived invitations cannot be consumed', () => {
  beforeEach(() => { status = 'invited'; preference = null; queries.length = 0; jest.clearAllMocks(); });
  it('omits archived profiles from invitation inventory', async () => {
    expect((await listBusinessInvitations(202)).invitations).toEqual([]);
    expect(queries[0]).toContain('p.archived_at IS NULL');
  });
  it('rejects acceptance before changing membership or preferences', async () => {
    await expect(acceptBusinessInvitation(202,901)).rejects.toMatchObject({status:409,code:'BUSINESS_PROFILE_UNAVAILABLE'});
    expect(status).toBe('invited'); expect(preference).toBeNull();
    expect(queries.some(q=>q.includes('UPDATE business_profile_memberships'))).toBe(false);
  });
});
