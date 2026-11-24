import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '../models/db.js';
import { supportService } from '../services/SupportService.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

describe('support ticket conversation identity', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  async function createFromConversation(contactId: number | null) {
    const execute = jest.spyOn(db, 'execute')
      .mockResolvedValueOnce({ rows: [{ id: 68, lead_id: 1184, crm_contact_id: contactId }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });
    let inserted: Record<string, unknown> = {};
    jest.spyOn(db, 'insert').mockImplementation(() => ({
      values: (values: Record<string, unknown>) => {
        inserted = values;
        return { onConflictDoNothing: () => ({ returning: async () => [{ ...values, id: 59 }] }) };
      },
    }) as ReturnType<typeof db.insert>);
    await supportService.createTicket(9, {
      outreachConversationId: 68, subject: 'Support QA', category: 'ai_handoff',
    });
    return { inserted, execute };
  }

  it('rejects a foreign campaign before creating a support ticket', async () => {
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [] });
    const insert = jest.spyOn(db, 'insert');
    await expect(withBusinessScope({ userId: 9, businessProfileId: 101 }, () => supportService.createTicket(9, {
      chatThreadId: 12, subject: 'Campaign support', category: 'ai_handoff',
    }))).rejects.toThrow('Campaign workspace not found.');
    expect(insert).not.toHaveBeenCalled();
  });

  it('persists a real authorized campaign reference without changing the description', async () => {
    jest.spyOn(db, 'execute').mockResolvedValueOnce({ rows: [{ id: 12 }] }).mockResolvedValueOnce({ rows: [{ id: 2 }] });
    let inserted: Record<string, unknown> = {};
    jest.spyOn(db, 'insert').mockImplementation(() => ({ values: (values: Record<string, unknown>) => {
      inserted = values; return { onConflictDoNothing: () => ({ returning: async () => [{ ...values, id: 59 }] }) };
    } }) as ReturnType<typeof db.insert>);
    await withBusinessScope({ userId: 9, businessProfileId: 101 }, () => supportService.createTicket(9, {
      chatThreadId: 12, subject: 'Campaign support', description: 'Customer context', category: 'ai_handoff',
    }));
    expect(inserted.chatThreadId).toBe(12);
    expect(inserted.description).toBe('Customer context');
  });

  it('inherits the authorized CRM contact without asking the model for it', async () => {
    const { inserted, execute } = await createFromConversation(1);
    expect(inserted.contactId).toBe(1);
    expect(inserted.leadId).toBe(1184);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('contact.user_id =');
    expect(query.sql).toContain('contact.deleted_at IS NULL');
    expect(query.sql).toContain('conversation.user_id =');
    expect(query.params).toEqual([9, 68, 9]);
  });

  it('does not manufacture a contact when the tenant-scoped join has no match', async () => {
    const { inserted } = await createFromConversation(null);
    expect(inserted.contactId).toBeNull();
  });

  it('rejects a missing or foreign conversation before creating a ticket', async () => {
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [] });
    const insert = jest.spyOn(db, 'insert');
    await expect(supportService.createTicket(9, {
      outreachConversationId: 68, subject: 'Support QA', category: 'ai_handoff',
    })).rejects.toThrow('Invalid outreach conversation.');
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an explicit contact that differs from the conversation identity', async () => {
    jest.spyOn(db, 'select').mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 2 }] }) }),
    }) as ReturnType<typeof db.select>);
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ id: 68, crm_contact_id: 1 }] });
    const insert = jest.spyOn(db, 'insert');
    await expect(supportService.createTicket(9, {
      contactId: 2, outreachConversationId: 68, subject: 'Support QA', category: 'ai_handoff',
    })).rejects.toThrow('CRM contact does not match');
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an explicit lead that differs from the linked conversation lead', async () => {
    jest.spyOn(db, 'select').mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 2 }] }) }),
    }) as ReturnType<typeof db.select>);
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ id: 68, lead_id: 1184, crm_contact_id: 1 }] });
    const insert = jest.spyOn(db, 'insert');
    await expect(supportService.createTicket(9, {
      leadId: 2, outreachConversationId: 68, subject: 'Support QA', category: 'ai_handoff',
    })).rejects.toThrow('CRM lead does not match');
    expect(insert).not.toHaveBeenCalled();
  });

  it.each(['contact', 'lead'] as const)('requires an active tenant-owned explicit %s', async kind => {
    let condition: SQL | undefined;
    jest.spyOn(db, 'select').mockImplementation(() => ({
      from: () => ({ where: (where: SQL) => { condition = where; return { limit: async () => [] }; } }),
    }) as ReturnType<typeof db.select>);
    const insert = jest.spyOn(db, 'insert');
    await expect(supportService.createTicket(9, {
      ...(kind === 'contact' ? { contactId: 7 } : { leadId: 7 }), subject: 'Support QA', category: 'ai_handoff',
    })).rejects.toThrow(`Invalid CRM ${kind}`);
    const query = new PgDialect().sqlToQuery(condition!);
    expect(query.sql).toContain('"deleted_at" is null');
    expect(query.params).toEqual([7, 9]);
    expect(insert).not.toHaveBeenCalled();
  });
});
