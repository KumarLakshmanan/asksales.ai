import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<any>();
const reveal = jest.fn<any>();
jest.unstable_mockModule('../models/db', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
jest.unstable_mockModule('../services/SupportService.js', () => ({ supportService: {}, SupportValidationError: class extends Error {} }));
jest.unstable_mockModule('../utils/emailTemplates', () => ({ getBrandInfo: jest.fn(), renderSupportReplyEmail: jest.fn() }));
jest.unstable_mockModule('../services/SupportReplyDeliveryService.js', () => ({ supportReplyDeliveryService: {}, SupportReplyDeliveryError: class extends Error {} }));
jest.unstable_mockModule('../services/SupportTicketWorkspaceService.js', () => ({ supportTicketWorkspaceService: {} }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ privacyVaultService: { reveal } }));
const { revealOwnerTicketMessage } = await import('../controllers/supportController');

function request(overrides = {}) {
  return { user: { id: 7 }, params: { id: '31', messageId: '91', source: 'conversation' }, body: { reason: '  Confirm callback details  ' }, ...overrides } as any;
}
function response() {
  const res: any = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [{ id: 12, conversation_id: 20 }] });
  reveal.mockResolvedValue({ rawText: 'Retained contact', expiresAt: new Date(Date.now() + 60_000) });
});

describe('owner restricted-message reveal authorization', () => {
  it('rejects unauthenticated access before querying any content', async () => {
    const res = response();
    await revealOwnerTicketMessage(request({ user: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(execute).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled();
  });

  it.each([
    { body: { reason: 'short' } },
    { body: { reason: ' '.repeat(10) } },
    { body: { reason: 'x'.repeat(241) } },
    { params: { id: '31', messageId: '91', source: 'ticket' } },
    { params: { id: '0', messageId: '91', source: 'conversation' } },
    { params: { id: '31', messageId: 'NaN', source: 'conversation' } },
  ])('rejects invalid IDs, sources and reasons: %j', async (overrides) => {
    const res = response();
    await revealOwnerTicketMessage(request(overrides), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(execute).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled();
  });

  it.each(['conversation', 'support_chat'])('scopes %s lookup to the requested owner, ticket and message', async (source) => {
    const res = response();
    await revealOwnerTicketMessage(request({ params: { id: '31', messageId: '91', source } }), res);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.params).toEqual([31, 7, 91]);
    expect(query.sql).toContain('ticket.user_id=$2');
    expect(query.sql).toContain('ticket.deleted_at IS NULL');
    expect(query.sql).toContain('vault.user_id=ticket.user_id');
    expect(query.sql).toContain('message.id=$3');
    if (source === 'conversation') {
      expect(query.sql).toContain('message.conversation_id=ticket.outreach_conversation_id');
      expect(query.sql).toContain('message.user_id=ticket.user_id');
      expect(query.sql).toContain('vault.conversation_id=message.conversation_id');
    } else {
      expect(query.sql).toContain('session.ticket_id=ticket.id');
      expect(query.sql).toContain('member.user_id=ticket.user_id');
      expect(query.sql).toContain('message.session_id=session.id');
    }
    expect(reveal).toHaveBeenCalledWith(7, 12, { conversationId: 20, actor: 'user:7', purpose: 'Confirm callback details' });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('never reveals when the tenant/ticket/message lookup returns no retained row', async () => {
    execute.mockResolvedValue({ rows: [] });
    const res = response();
    await revealOwnerTicketMessage(request(), res);
    expect(res.status).toHaveBeenCalledWith(404); expect(reveal).not.toHaveBeenCalled();
  });

  it('bounds revealed content by both the vault expiry and five-minute UI lifetime', async () => {
    const expiry = new Date(Date.now() + 60_000);
    reveal.mockResolvedValue({ rawText: 'Retained contact', expiresAt: expiry });
    const res = response();
    await revealOwnerTicketMessage(request(), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { content: 'Retained contact', revealExpiresAt: expiry.toISOString() } });
    const before = Date.now();
    reveal.mockResolvedValue({ rawText: 'Retained contact', expiresAt: new Date(before + 86_400_000) });
    await revealOwnerTicketMessage(request(), res);
    const until = Date.parse(res.json.mock.calls.at(-1)[0].data.revealExpiresAt);
    expect(until).toBeGreaterThanOrEqual(before + 300_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('does not send expired content or leak internal errors', async () => {
    reveal.mockResolvedValue(null);
    const expired = response(); await revealOwnerTicketMessage(request(), expired);
    expect(expired.status).toHaveBeenCalledWith(410);
    execute.mockRejectedValue(new Error('internal connection details'));
    const failed = response(); await revealOwnerTicketMessage(request(), failed);
    expect(failed.status).toHaveBeenCalledWith(500);
    expect(failed.json).toHaveBeenCalledWith({ error: 'Restricted content could not be revealed.' });
    expect(failed.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
