import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const txExecute = jest.fn<(...args: any[]) => Promise<any>>();
const ackExecute = jest.fn<(...args: any[]) => Promise<any>>();
const transaction = jest.fn(async (callback: any) => {
  let acknowledgment = false;
  let offer = false;
  return callback({ execute: (...args: any[]) => {
    const parsed = new PgDialect().sqlToQuery(args[0] as SQL);
    if (String(parsed.params[0]).startsWith('email-ticket-offer:')) { offer = true; return Promise.resolve({ rows: [] }); }
    if (String(parsed.params[0]).startsWith('email-ticket-ack:')) acknowledgment = true;
    if (offer && (parsed.sql.includes('FROM outreach_conversations conversation') || parsed.sql.includes('tags @>')
      || parsed.sql.includes('SELECT id, name FROM support_teams') || parsed.sql.includes('UPDATE outreach_conversations'))) return execute(...args);
    return acknowledgment ? ackExecute(...args) : txExecute(...args);
  } });
});
const createTicket = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { publish: jest.fn() } }));
jest.unstable_mockModule('../models/outreachConversations/functions.js', () => ({}));
jest.unstable_mockModule('../utils/emailTemplates.js', () => ({
  getBrandInfo: async () => ({ companyName: 'QA', logoUrl: null, primaryColor: '#123456' }),
  renderBrandedEmail: () => '<p>Ticket created</p>',
}));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  privacyVaultService: {}, redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
jest.unstable_mockModule('../services/SupportService.js', () => ({ supportService: { createTicket } }));
const { routeReplyToActiveTicket, recoverPersistedEmailTicketRouting, persistInboundEmailRecords,
  findOriginalMessage, resolveUserId, processInboundEmail } = await import('../services/InboundEmailService.js');
const query = (call: any[]) => new PgDialect().sqlToQuery(call[0] as SQL);
const rows = (...items: any[]) => ({ rows: items });
const route = () => routeReplyToActiveTicket(9, 12, 68, 701, 'Customer reply', '[QA]');

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockReset().mockResolvedValue(rows());
  txExecute.mockReset().mockResolvedValue(rows());
  ackExecute.mockReset().mockImplementation(async (sql: SQL) => {
    const text = new PgDialect().sqlToQuery(sql).sql;
    if (text.includes('FROM support_tickets')) return rows({ ticket_number: 'TKT-QA', subject: 'Help', lead_id: 12, lead_email: 'qa@example.com' });
    if (text.includes('INSERT INTO sent_messages')) return rows({ id: 91 });
    if (text.includes('INSERT INTO support_delivery_outbox')) return rows({ id: 201 });
    return rows();
  });
  createTicket.mockReset().mockResolvedValue({ id: 59, ticketNumber: 'TKT-QA', assignedMemberId: null });
});

describe('atomic inbound email record persistence', () => {
  const input = { userId: 9, leadId: 12, conversationId: 68, provider: 'gmail' as const,
    externalId: 'provider-message', body: 'Redacted message', subject: 'Support', leadName: 'QA', senderId: 3 };
  const authorized = () => txExecute.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows({ id: 68 }));

  it('commits legacy receipt, native message and both counters in one provider-locked transaction', async () => {
    authorized().mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ id: 91 })).mockResolvedValueOnce(rows({ id: 701 }));
    expect(await persistInboundEmailRecords(input)).toEqual({
      inboundMsg: { id: 701 }, exactSentMessageId: 91, duplicate: false, recovered: false, recordCrmReply: true,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(query(txExecute.mock.calls[0]).params).toEqual(['inbound-email:9:gmail:provider-message']);
    expect(query(txExecute.mock.calls[0]).sql).toContain('pg_advisory_xact_lock');
    expect(txExecute.mock.calls.filter((call) => query(call).sql.includes('INSERT INTO sent_messages'))).toHaveLength(1);
    expect(txExecute.mock.calls.filter((call) => query(call).sql.includes('INSERT INTO outreach_messages'))).toHaveLength(1);
    expect(query(txExecute.mock.calls[6]).sql).toContain('total_messages = COALESCE(total_messages, 0) + 1');
    expect(query(txExecute.mock.calls[7]).sql).toContain('replied_emails = COALESCE(replied_emails, 0) + 1');
  });

  it('repairs the sent-only crash gap without adding a legacy row or incrementing lead engagement again', async () => {
    authorized().mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows({ id: 91, lead_id: 12 }))
      .mockResolvedValueOnce(rows({ id: 701 }));
    expect(await persistInboundEmailRecords(input)).toEqual({
      inboundMsg: { id: 701 }, exactSentMessageId: 91, duplicate: true, recovered: true, recordCrmReply: true,
    });
    expect(txExecute.mock.calls.some((call) => query(call).sql.includes('INSERT INTO sent_messages'))).toBe(false);
    expect(txExecute.mock.calls.some((call) => query(call).sql.includes('UPDATE leads'))).toBe(false);
    expect(query(txExecute.mock.calls[4]).sql).toContain('INSERT INTO outreach_messages');
  });

  it('reuses both saved rows on duplicate delivery without changing message counters', async () => {
    authorized().mockResolvedValueOnce(rows({ id: 701, conversation_id: 68, metadata: { inboundEmailReceipt: { version: 1 } } }))
      .mockResolvedValueOnce(rows({ id: 91, lead_id: 12 }));
    expect(await persistInboundEmailRecords(input)).toEqual({
      inboundMsg: { id: 701 }, exactSentMessageId: 91, duplicate: true, recovered: false, recordCrmReply: true,
    });
    expect(txExecute.mock.calls.some((call) => /INSERT|UPDATE outreach|UPDATE leads/.test(query(call).sql))).toBe(false);
  });

  it('does not recount CRM replies for pre-receipt legacy native messages', async () => {
    authorized().mockResolvedValueOnce(rows({ id: 701, conversation_id: 68, metadata: {} }))
      .mockResolvedValueOnce(rows({ id: 91, lead_id: 12 }));
    expect((await persistInboundEmailRecords(input)).recordCrmReply).toBe(false);
  });

  it('rejects a cross-conversation provider collision without copying it', async () => {
    authorized().mockResolvedValueOnce(rows({ id: 701, conversation_id: 100 }));
    await expect(persistInboundEmailRecords(input)).rejects.toThrow('another conversation');
    expect(txExecute.mock.calls.some((call) => query(call).sql.includes('INSERT'))).toBe(false);
  });

  it('rejects a wrong-lead legacy receipt instead of using it to authorize new messages', async () => {
    authorized().mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows({ id: 91, lead_id: 900 }));
    await expect(persistInboundEmailRecords(input)).rejects.toThrow('another lead');
  });

  it('propagates native persistence failure out of the transaction before counters change', async () => {
    authorized().mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ id: 91 })).mockRejectedValueOnce(new Error('native insert failed'));
    await expect(persistInboundEmailRecords(input)).rejects.toThrow('native insert failed');
    expect(txExecute.mock.calls.some((call) => query(call).sql.includes('UPDATE leads'))).toBe(false);
    expect(txExecute.mock.calls.some((call) => query(call).sql.includes('UPDATE outreach_conversations'))).toBe(false);
  });
});

describe('receiving tenant and sender binding', () => {
  it('requires the same receiving tenant and actual sender in every exact/header/fallback lookup', async () => {
    expect(await findOriginalMessage(9, '<parent@example.test>', 'customer@example.test', 'customer@example.test')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
    for (const call of execute.mock.calls) {
      const lookup = query(call);
      expect(lookup.params).toContain(9);
      expect(lookup.params).toContain('customer@example.test');
      expect(lookup.sql).toContain('l.user_id =');
      expect(lookup.sql).toContain('l.deleted_at IS NULL');
    }
    expect(query(execute.mock.calls[0]).sql).toContain('sm.user_id =');
    expect(query(execute.mock.calls[1]).sql).toContain('oc.user_id =');
  });

  it('rejects ambiguous inbox owners instead of choosing the first To address', async () => {
    execute.mockResolvedValueOnce(rows({ id: 9 }, { id: 10 }));
    expect(await resolveUserId(['owner@example.test', 'another@example.test'])).toBeUndefined();
    expect(query(execute.mock.calls[0]).sql).toContain('SELECT DISTINCT id');
  });

  it('never attempts header lookup before an unaffiliated receiving inbox is rejected', async () => {
    const result = await processInboundEmail({ provider: 'resend', externalMessageId: 'new-message',
      senderEmail: 'customer@example.test', recipientEmails: ['unknown@example.test'],
      inReplyTo: '<foreign-tenant@example.test>', subject: 'Help', body: 'Hello' });
    expect(result.success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query(execute.mock.calls[0]).sql).not.toContain('FROM sent_messages');
  });

  it('does not accept a caller-supplied Gmail credential owner on a Resend event', async () => {
    expect((await processInboundEmail({ provider: 'resend', receivingUserId: 9, externalMessageId: 'new-message',
      senderEmail: 'customer@example.test', subject: 'Help', body: 'Hello' })).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('inbound email ticket routing execution', () => {
  it('uses the exact tenant conversation, persists provenance, and changes counters in the same transaction', async () => {
    txExecute.mockResolvedValueOnce(rows({ metadata: { preserved: true } }))
      .mockResolvedValueOnce(rows({ id: 59, ticket_number: 'TKT-QA' }))
      .mockResolvedValueOnce(rows({ id: 77 }));
    expect(await route()).toBe('routed');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(query(txExecute.mock.calls[0]).params).toEqual([701, 9, 68, 9, 12]);
    const lookup = query(txExecute.mock.calls[1]);
    expect(lookup.sql).toContain('outreach_conversation_id =');
    expect(lookup.sql).toContain('deleted_at IS NULL');
    expect(lookup.sql).toContain('FOR UPDATE');
    expect(lookup.params).toEqual([9, 68]);
    expect(query(txExecute.mock.calls[2]).params).toEqual([59, 9, 'Customer reply']);
    expect(query(txExecute.mock.calls[3]).sql).toContain('total_messages = COALESCE(total_messages, 0) + 1');
    const receipt = query(txExecute.mock.calls[4]);
    expect(receipt.sql).toContain("COALESCE(metadata, '{}'::jsonb) ||");
    expect(JSON.parse(receipt.params[0] as string)).toEqual({ supportTicketRouting: {
      ticketId: 59, ticketMessageId: 77, conversationId: 68, inboundMessageId: 701,
    } });
  });

  it('never reroutes or recounts an already recorded message, even if its original ticket was deleted', async () => {
    txExecute.mockResolvedValueOnce(rows({ metadata: { supportTicketRouting: { ticketId: 59, ticketMessageId: 77 } } }));
    expect(await route()).toBe('routed');
    expect(txExecute).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing, foreign or mismatched inbound message before inspecting tickets', async () => {
    expect(await route()).toBe('blocked');
    expect(txExecute).toHaveBeenCalledTimes(1);
  });

  it('permits normal processing only when there is no eligible ticket', async () => {
    txExecute.mockResolvedValueOnce(rows({ metadata: {} }));
    expect(await route()).toBe('unmatched');
    expect(txExecute).toHaveBeenCalledTimes(3);
    expect(query(txExecute.mock.calls[2]).sql).toContain('supportTicketRoutingCheck');
  });

  it('fails closed if the receipt transaction fails instead of proceeding with another ticket/AI response', async () => {
    txExecute.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(route()).rejects.toThrow('database unavailable');
  });
});

describe('duplicate email local routing recovery', () => {
  const persisted = (metadata: Record<string, unknown>) => rows({
    id: 701, conversation_id: 68, lead_id: 12, content: 'Saved redacted reply', metadata,
  });
  const recover = () => recoverPersistedEmailTicketRouting(9, 'provider-message', 'gmail', '[QA]');

  it('repairs an opted-in message saved before ticket routing, without creating tickets or sending acknowledgments', async () => {
    execute.mockResolvedValueOnce(persisted({ supportTicketRoutingVersion: 1 }));
    txExecute.mockResolvedValueOnce(rows({ metadata: { supportTicketRoutingVersion: 1 } }))
      .mockResolvedValueOnce(rows({ id: 59, ticket_number: 'TKT-QA' })).mockResolvedValueOnce(rows({ id: 77 }));
    expect(await recover()).toBe('routed');
    expect(createTicket).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    const lookup = query(execute.mock.calls[0]);
    expect(lookup.params).toEqual([9, 9, 'gmail', 'provider-message', 'provider-message']);
    expect(lookup.sql).toContain("message.direction = 'inbound'");
  });

  it.each([
    {},
    { supportTicketRoutingVersion: 1, supportTicketRouting: { ticketId: 59 } },
    { supportTicketRoutingVersion: 1, supportTicketRoutingCheck: { status: 'unmatched' } },
  ])('does not replay legacy or already-evaluated processing: %j', async (metadata) => {
    execute.mockResolvedValueOnce(persisted(metadata));
    expect(await recover()).toBe('ignored');
    expect(transaction).not.toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('does not guess between multiple persisted provider matches', async () => {
    execute.mockResolvedValueOnce(rows({ id: 1 }, { id: 2 }));
    expect(await recover()).toBe('blocked');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechecks the receipt under lock when original processing finishes during recovery', async () => {
    execute.mockResolvedValueOnce(persisted({ supportTicketRoutingVersion: 1 }));
    txExecute.mockResolvedValueOnce(rows({ metadata: { supportTicketRouting: { ticketId: 59 } } }));
    expect(await recover()).toBe('routed');
    expect(txExecute).toHaveBeenCalledTimes(1);
  });

  it('rechecks an unmatched decision under lock rather than routing it to a newly created ticket', async () => {
    execute.mockResolvedValueOnce(persisted({ supportTicketRoutingVersion: 1 }));
    txExecute.mockResolvedValueOnce(rows({ metadata: {
      supportTicketRoutingVersion: 1, supportTicketRoutingCheck: { status: 'unmatched' },
    } }));
    expect(await recover()).toBe('unmatched');
    expect(txExecute).toHaveBeenCalledTimes(1);
  });
});
