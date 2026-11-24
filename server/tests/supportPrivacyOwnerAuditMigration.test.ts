import { describe, expect, it, jest } from '@jest/globals';

// @ts-expect-error JavaScript migrations intentionally expose no TypeScript declarations.
import { down, up } from '../migrations/275_allow_owner_privacy_access_audits.js';

describe('owner privacy access audit migration', () => {
  it('allows owner audit rows without inventing a support member identity', async () => {
    const query = jest.fn(async (_sql: unknown) => ({ rows: [] }));
    await up({ query });
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).toContain('ALTER COLUMN member_id DROP NOT NULL');
  });

  it('refuses to restore the constraint while owner audit rows exist', async () => {
    const query = jest.fn(async (_sql: unknown) => ({ rows: [] }));
    await down({ query });
    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('member_id IS NULL');
    expect(sql).toContain('ALTER COLUMN member_id SET NOT NULL');
  });
});
