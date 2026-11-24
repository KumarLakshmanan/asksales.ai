import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

// @ts-expect-error JavaScript migrations intentionally expose no TypeScript declarations.
import { down, up } from '../migrations/273_allow_admin_credential_deletion.js';

describe('admin API credential deletion schema', () => {
  it('removes the foreign key that conflicts with append-only audit rows', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    });

    await up({ query });

    const sql = statements[0] || '';
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS admin_credential_audit_credential_id_fkey');
    expect(sql).not.toContain('DROP TRIGGER');
  });

  it('restores the original relationship safely on rollback', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    });

    await down({ query });

    const sql = statements[0] || '';
    expect(sql).toContain('SET credential_id = NULL');
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).toContain('CREATE TRIGGER admin_credential_audit_append_only');
  });

  it('models credential IDs as immutable historical values, not foreign keys', () => {
    const schema = readFileSync(new URL('../models/adminApiCredentials/schema.ts', import.meta.url), 'utf8');
    const credentialIdDeclaration = schema.match(/credentialId:\s*integer\('credential_id'\)[^\n]*/)?.[0];

    expect(credentialIdDeclaration).toBe("credentialId: integer('credential_id'),");
  });
});
