import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
const values = jest.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const insert = jest.fn(() => ({ values }));
const select = jest.fn(() => ({ from: () => ({ where: async () => [{ id: 5, outreachConversationId: 20 }] }) }));
const reveal = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { select, execute, insert } }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle: jest.fn() } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ privacyVaultService: { reveal } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
const { SupportTicketWorkspaceService } = await import('../services/SupportTicketWorkspaceService.js');
const service = new SupportTicketWorkspaceService();
const inbound = (id: number, extra: Record<string, unknown> = {}) => ({ id, direction: 'inbound', content: `Message ${id}`, created_at: '2026-09-08 03:30:00', ...extra });
function rows(native: unknown[] = [], ticket: unknown[] = [], chat: unknown[] = [], handoff: unknown[] = []) {
  execute.mockResolvedValueOnce({ rows: ticket }).mockResolvedValueOnce({ rows: native })
    .mockResolvedValueOnce({ rows: chat }).mockResolvedValueOnce({ rows: handoff });
}

describe('support ticket unified timeline runtime', () => {
  beforeEach(() => { jest.clearAllMocks(); reveal.mockResolvedValue(null); });

  it('shows one inbound event for an exact persisted email-routing copy', async () => {
    rows([inbound(100, { ticket_routing: { ticketId: 5, ticketMessageId: 200 } })], [inbound(200)]);
    const timeline = await service.getTimeline(9, 5);
    expect(timeline?.events.map(event => event.key)).toEqual(['conversation:100']);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[1][0] as SQL);
    expect(query.sql).toContain("metadata->'supportTicketRouting'");
    expect(query.params).toEqual([9, 20]);
    expect(timeline?.events[0]).not.toHaveProperty('ticket_routing');
  });

  it('does not suppress another ticket identity, internal notes or copies without native evidence', async () => {
    rows([
      inbound(100, { ticket_routing: { ticketId: 6, ticketMessageId: 200 } }),
      inbound(101, { ticket_routing: { ticketId: 5, ticketMessageId: 201 } }),
    ], [inbound(200), inbound(201, { is_internal: true }), inbound(202)]);
    const timeline = await service.getTimeline(9, 5);
    expect(timeline?.events.filter(event => event.source === 'ticket').map(event => event.id)).toEqual([200, 201, 202]);
  });

  it('retains existing delivery-action deduplication', async () => {
    rows([inbound(100, { direction: 'outbound', delivery_action_id: 33 })], [inbound(200, { direction: 'outbound', delivery_action_id: 33 })]);
    expect((await service.getTimeline(9, 5))?.events.map(event => event.key)).toEqual(['conversation:100']);
  });

  it('normalizes raw UTC timestamps and orders numeric IDs within simultaneous sources', async () => {
    rows([inbound(10), inbound(2)]);
    const timeline = await service.getTimeline(9, 5);
    expect(timeline?.events.map(event => event.id)).toEqual([2, 10]);
    expect(timeline?.events.map(event => event.createdAt)).toEqual(['2026-09-08T03:30:00.000Z', '2026-09-08T03:30:00.000Z']);
  });

  it('uses the latest transcript slice for summaries without changing ordinary pagination', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => inbound(index + 1));
    rows(messages);
    const summaryPage = await service.getTimeline(9, 5, { latest: true, limit: 200 });
    expect(summaryPage?.events[0].id).toBe(51);
    expect(summaryPage?.events.at(-1)?.id).toBe(250);
    expect(summaryPage?.total).toBe(250);
    expect(summaryPage?.sourceCursor).toBe('conversation:250');
    rows(messages);
    const normalPage = await service.getTimeline(9, 5, { limit: 50 });
    expect(normalPage?.events[0].id).toBe(1);
    expect(normalPage?.events.at(-1)?.id).toBe(50);
    expect(normalPage?.nextCursor).toBeTruthy();
  });

  it('never exposes restricted native message text through the timeline', async () => {
    rows([inbound(100, { content: 'sensitive-original', privacy_vault_id: 44 })]);
    const timeline = await service.getTimeline(9, 5);
    expect(timeline?.events[0].restricted).toBe(true);
    expect(JSON.stringify(timeline)).not.toContain('sensitive-original');
  });

  it('requires an explicit claimed-agent reveal instead of exposing details through member timeline', async () => {
    rows([inbound(100, { content: 'Phone: [PHONE_1]', privacy_vault_id: 44 })]);
    reveal.mockResolvedValue({ rawText: 'Phone: +91 98765 43210', piiTypes: ['phone'], expiresAt: new Date() });
    const timeline = await service.getTimeline(9, 5, { viewerMemberId: 7 });
    expect(reveal).not.toHaveBeenCalled();
    expect(timeline?.events[0].restricted).toBe(true);
    expect(JSON.stringify(timeline)).not.toContain('+91 98765 43210');
  });

  it('requires explicit time-limited owner reveal instead of returning raw PII in timeline', async () => {
    rows([inbound(100, { content: 'Email: [EMAIL_1]', privacy_vault_id: 44 })]);
    reveal.mockResolvedValue({ rawText: 'Email: guest@example.com', piiTypes: ['email'], expiresAt: new Date() });
    const timeline = await service.getTimeline(9, 5, { viewerOwnerId: 9 });
    expect(reveal).not.toHaveBeenCalled();
    expect(timeline?.events[0].restricted).toBe(true);
    expect(JSON.stringify(timeline)).not.toContain('guest@example.com');
  });
});
