import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

const { invalidateAssistantBinding } = await import('../services/assistants/AssistantService.js');

describe('invalidating an assistant binding', () => {
  it('cancels only follow-ups that never left, so a sent one that failed stays failed', async () => {
    const execute = jest.fn(async (_query: SQL) => ({ rows: [] }));
    await withBusinessScope({ userId: 9, businessProfileId: 7 }, () =>
      invalidateAssistantBinding({ execute } as never, { id: 3, channel: 'whatsapp', account_id: 'phone-1', surface: 'private' }));
    const cancel = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql)
      .find(text => /UPDATE outreach_messages SET status='cancelled'/.test(text))!;
    expect(cancel).toContain("message_kind IN ('reply','follow_up')");
    expect(cancel).toContain('sent_at IS NULL AND COALESCE(external_message_id,provider_message_id,waba_message_id) IS NULL');
  });
});
