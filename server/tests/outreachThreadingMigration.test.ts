import { describe, expect, it, jest } from '@jest/globals';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up } from '../migrations/149_repair_outreach_threading.js';

describe('outreach threading migration', () => {
  it('preserves email multiplicity and enforces race-safe canonical social channels', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    });

    await up({ query } as never);

    const sql = statements.join('\n');
    expect(sql).toContain('SET conversation_id = ranked.winner_id');
    expect(sql).toContain("WHERE channel NOT IN ('email', 'gmail')");
    expect(sql).toContain('outreach_conversations_single_channel_uq');
    expect(sql).toContain('outreach_conversations_email_thread_key_uq');
    expect(sql).toContain('outreach_conversations_provider_thread_uq');
    expect(sql).toContain('provider_message_id');
    expect(sql).toContain('rfc_message_id');
    expect(sql).toContain('followup_sequences_conversation_id_fkey');
    expect(sql).toContain('SET conversation_id = (');
  });
});
