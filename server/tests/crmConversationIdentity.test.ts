import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';
import type { SQL } from 'drizzle-orm';

const contact = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const conditions: SQL[] = [];
const queryRows: unknown[][] = [];
const execute = jest.fn(async (where: SQL) => {
  conditions.push(where);
  return { rows: queryRows.shift() ?? [] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/CRMService.js', () => ({ crmService: { getContactById: contact }, crmVisibleContactsCte: () => undefined }));
jest.unstable_mockModule('../services/AutomationService.js', () => ({ automationService: {} }));
jest.unstable_mockModule('../services/ReminderService.js', () => ({ reminderService: {} }));
jest.unstable_mockModule('../services/AlertService.js', () => ({ alertService: {}, ALERT_EVENT_TYPES: [] }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { getContactConversations } = await import('../controllers/crmController.js');

async function invoke(id = '5', userId: number | null = 9) {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  await withBusinessScope({ userId: 9, businessProfileId: 101 }, () => getContactConversations({ user: userId ? { id: userId } : undefined, params: { id }, query: {} } as unknown as Request, response as unknown as Response));
  return response;
}
const compiled = (index = 0) => new PgDialect().sqlToQuery(conditions[index]);

describe('CRM conversation identity scope', () => {
  beforeEach(() => { jest.clearAllMocks(); conditions.length = 0; queryRows.length = 0; });

  it('includes canonical contact links across channel leads with only unlinked legacy fallback', async () => {
    contact.mockResolvedValue({ id: 5, leadId: 77 });
    queryRows.push([{ id: 20, leadId: 99, crmContactId: 5 }], [{ count: 1 }], [], [{ count: 0 }], [{ id: 200, conversationId: 20 }]);
    const response = await invoke();
    expect(compiled().sql).toContain('conversation.crm_contact_id=');
    expect(compiled().sql).toContain('conversation.crm_contact_id IS NULL');
    expect(compiled().sql).toContain('OR');
    expect(compiled().params).toEqual(expect.arrayContaining([9, 101, 5, 77]));
    expect(compiled(4).params).toEqual(expect.arrayContaining([101, [20]]));
    expect(compiled(4).sql).toContain('COALESCE(message.redacted_content,message.content)');
    expect(compiled(2).params).toEqual(expect.arrayContaining([9, 101, 77]));
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, conversations: [expect.objectContaining({ id: 20, messages: [{ id: 200, conversationId: 20 }] })], sentMessages: [] }));
  });

  it('never converts an unlinked CRM-only ID into a lead ID or queries legacy sent messages', async () => {
    contact.mockResolvedValue({ id: 5, leadId: null });
    await invoke();
    expect(compiled().params).toEqual(expect.arrayContaining([9, 101, 5]));
    expect(compiled().params).toContain(null);
    expect(compiled(2).params).toContain(null);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('uses the resolved persisted contact even when requested with a virtual reference', async () => {
    contact.mockResolvedValue({ id: 12, leadId: 77 });
    await invoke('-77');
    expect(compiled().params).toEqual(expect.arrayContaining([9, 101, 12, 77]));
  });

  it('supports genuinely virtual lead records without claiming another contact link', async () => {
    contact.mockResolvedValue({ id: -77, lead_id: 77 });
    await invoke('-77');
    expect(compiled().params).toEqual(expect.arrayContaining([9, 101, 77]));
    expect(compiled().sql).toContain('conversation.crm_contact_id IS NULL');
  });

  it.each(['0', '2.5', 'Infinity', '9007199254740992', 'oops'])('rejects invalid reference %s before lookup', async id => {
    expect((await invoke(id)).status).toHaveBeenCalledWith(400);
    expect(contact).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not query conversations for unavailable or foreign contacts', async () => {
    contact.mockResolvedValue(null);
    expect((await invoke()).status).toHaveBeenCalledWith(404);
    expect(execute).not.toHaveBeenCalled();
  });
});
