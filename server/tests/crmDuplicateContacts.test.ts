import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

// The real service with a fake database: grouping of shared phones and emails,
// and the checks around a person-chosen merge.
const dialect = new PgDialect();
const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>();
const mergeContactRecords = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const lock = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../models/db.js', () => ({
  db: { execute, transaction: (work: (tx: { execute: typeof execute }) => unknown) => work({ execute }) },
}));
jest.unstable_mockModule('../services/CRMContactMergeService.js', () => ({ mergeContactRecords }));
jest.unstable_mockModule('../services/CRMService.js', () => ({ lockCrmContactResolution: lock }));
const { listDuplicateContacts, mergeDuplicateContact, ContactMergeError } = await import('../services/CRMDuplicateContactsService.js');

const scoped = <T>(work: () => Promise<T>) => withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
const text = (call: number) => dialect.sqlToQuery(execute.mock.calls[call][0]).sql;
const contact = (id: number, extra: Record<string, unknown> = {}) => ({
  id, first_name: 'Lakshmanan', last_name: null, email: 'lakshmanan.coder@gmail.com', phone: '916382775774',
  company: null, source: 'import', created_at: '2026-10-29T07:18:34Z', last_activity_at: null, conversations: 0, ...extra,
});

beforeEach(() => { execute.mockReset(); mergeContactRecords.mockClear(); lock.mockClear(); });

describe('possible duplicate contacts', () => {
  it('groups contacts that share a phone or an email into one review item', async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ kind: 'phone', ids: [2, 694, 695] }, { kind: 'email', ids: ['695', '2'] }, { kind: 'email', ids: [693, 696] }] })
      .mockResolvedValueOnce({ rows: [contact(2, { source: 'whatsapp', conversations: 12 }), contact(694), contact(695), contact(693, { phone: null }), contact(696, { phone: null })] });
    const groups = await scoped(() => listDuplicateContacts(9));
    expect(groups.map(group => group.contacts.map(item => item.id))).toEqual([[2, 694, 695], [693, 696]]);
    expect(groups[0]).toMatchObject({ matchedOn: ['email', 'phone'] });
    expect(groups[0].contacts[0]).toMatchObject({ name: 'Lakshmanan', conversations: 12, source: 'whatsapp' });
    expect(text(0)).toContain('deleted_at IS NULL');
  });

  it('returns nothing without a second query when no contacts share an identifier', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(scoped(() => listDuplicateContacts(9))).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('merging a duplicate contact', () => {
  it('merges into the kept contact under the CRM lock and settles its review item', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 2, business_profile_id: 7, lead_id: 144 }, { id: 695, business_profile_id: 7, lead_id: 1512 }] })
      .mockResolvedValue({ rows: [] });
    await expect(scoped(() => mergeDuplicateContact(9, 695, 2))).resolves.toEqual({ contactId: 2 });
    expect(lock).toHaveBeenCalled();
    expect(mergeContactRecords).toHaveBeenCalledWith(expect.anything(), 9, expect.objectContaining({ id: 695, lead_id: 1512 }), 2, false,
      expect.objectContaining({ identifierType: 'manual' }));
    expect(text(1)).toContain("SET status='resolved'");
  });

  it('refuses the same contact twice, and contacts already merged or from another business', async () => {
    await expect(scoped(() => mergeDuplicateContact(9, 2, 2))).rejects.toBeInstanceOf(ContactMergeError);
    execute.mockResolvedValueOnce({ rows: [{ id: 2, business_profile_id: 7, lead_id: 144 }] });
    await expect(scoped(() => mergeDuplicateContact(9, 695, 2))).rejects.toMatchObject({ status: 404 });
    expect(mergeContactRecords).not.toHaveBeenCalled();
  });
});
