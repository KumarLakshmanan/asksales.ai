import { describe, expect, it, jest } from '@jest/globals';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up } from '../migrations/162_harden_support_agent_runtime.js';

describe('Support Agent runtime hardening migration', () => {
  it('stages the privacy, approval, recovery, and truthful audit columns without provider calls', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await up(client as any);
    const sql = statements.join('\n');
    expect(sql).toContain('privacy_vault_id');
    expect(sql).toContain('entity_type');
    expect(sql).toContain('argument_digest');
    expect(sql).toContain('resume_payload');
    expect(sql).toContain('lease_expires_at');
    expect(sql).toContain('delivery_status');
    expect(sql).toContain('provider_message_id');
  });
});
