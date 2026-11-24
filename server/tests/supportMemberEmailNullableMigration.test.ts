import { describe, expect, it, jest } from '@jest/globals';

// @ts-expect-error JavaScript migrations intentionally expose no TypeScript declarations.
import { down, up } from '../migrations/274_allow_session_only_support_members.js';

describe('session-only support member migration', () => {
  it('removes the legacy email requirement used by owner Support AI sessions', async () => {
    const query = jest.fn(async (_sql: unknown) => ({ rows: [] }));

    await up({ query });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ALTER COLUMN email DROP NOT NULL'));
  });

  it('refuses rollback while nullable session members remain', async () => {
    const query = jest.fn(async (_sql: unknown) => ({ rows: [] }));

    await down({ query });

    const statement = String(query.mock.calls[0]?.[0] || '');
    expect(statement).toContain('WHERE email IS NULL');
    expect(statement).toContain('ALTER COLUMN email SET NOT NULL');
  });
});
