import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

// The real import with a fake transaction: existing leads come back from the
// lookup query, new rows are counted, and every member row is recorded.
type Lead = { id: number; email: string | null; phone: string | null };
let leads: Lead[] = [];
let inserted: Array<Record<string, unknown>> = [];
let members: Array<{ leadId: number; recipientLeadId: number | null }> = [];
const updates: number[] = [];
const dialect = new PgDialect();

const tx = {
  async execute(query: SQL) {
    const { sql, params } = dialect.sqlToQuery(query);
    if (sql.includes('INSERT INTO campaign_lead_imports')) return { rows: [{ id: 77 }] };
    if (sql.includes('phone_lookup_digits AS phone')) {
      const [, , emails, phones] = params as [number, number, string[], string[]];
      return { rows: leads.filter(lead => emails.includes(String(lead.email).toLowerCase()) || phones.includes(String(lead.phone)))
        .map(lead => ({ id: lead.id, email: lead.email?.toLowerCase() ?? null, phone: lead.phone })) };
    }
    if (sql.startsWith('UPDATE leads SET')) { updates.push(Number(params[6])); return { rows: [] }; }
    if (sql.includes('SELECT id,email FROM leads')) {
      const ids = params[0] as number[];
      return { rows: leads.filter(lead => ids.includes(lead.id)).map(lead => ({ id: lead.id, email: lead.email })) };
    }
    if (sql.includes('INSERT INTO campaign_lead_import_members')) {
      members.push({ leadId: Number(params[3]), recipientLeadId: params[4] == null ? null : Number(params[4]) });
      return { rows: [] };
    }
    return { rows: [] };
  },
  insert: () => ({
    values: (records: Array<Record<string, unknown>>) => ({
      returning: async () => records.map(record => {
        inserted.push(record);
        const lead = { id: 1000 + leads.length, email: (record.email as string) ?? null, phone: (record.phone as string) ?? null };
        leads.push(lead);
        return { id: lead.id };
      }),
    }),
  }),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction: (work: (t: typeof tx) => unknown) => work(tx) } }));
jest.unstable_mockModule('../services/CRMService.js', () => ({
  crmService: { syncLeadContact: async (_userId: number, leadId: number) => ({ id: leadId + 5000, leadId }) },
  lockCrmContactResolution: async () => undefined,
}));
jest.unstable_mockModule('../services/CampaignWorkspaceService.js', () => ({ assertOwnedCampaignThread: async () => undefined }));
const { saveCampaignLeadImport } = await import('../services/CampaignLeadImportService.js');

const record = (email: string | null, phone: string | null, extra: Record<string, unknown> = {}) =>
  ({ userId: 9, source: 'import', status: 'new', email, phone, ...extra });
const save = (records: Array<Record<string, unknown>>) => withBusinessScope({ userId: 9, businessProfileId: 7 },
  () => saveCampaignLeadImport(9, { fileName: 'contacts.csv', fingerprint: 'f', records: records as never }));

beforeEach(() => {
  leads = [
    { id: 142, email: 'lakshmanan.coder@gmail.com', phone: '916382775774' },
    { id: 144, email: 'lakshmanan.w3dev@gmail.com', phone: '916382775774' },
  ];
  inserted = []; members = []; updates.length = 0;
});

describe('campaign lead import duplicates', () => {
  it('reuses the existing lead for the same email and phone instead of creating another', async () => {
    const result = await save([
      record('Lakshmanan.Coder@gmail.com ', '+91 63827 75774', { company: 'ORO' }),
      record('lakshmanan.w3dev@gmail.com', '916382775774'),
    ]);
    expect(inserted).toEqual([]);
    expect(members.map(member => member.leadId)).toEqual([142, 144]);
    expect(updates).toEqual([142, 144]);
    expect(result).toMatchObject({ importId: 77, count: 2, matchedExisting: 2, replayed: false });
  });

  it('matches a phone-only row, but not a shared phone with a different email', async () => {
    await save([record(null, '916382775774')]);
    expect(members.map(member => member.leadId)).toEqual([142]);
    members = [];
    await save([record('someone.else@example.test', '916382775774')]);
    expect(members.map(member => member.leadId)).toEqual([1002]);
    expect(inserted).toHaveLength(1);
  });

  it('collapses repeated rows in one file and still creates genuinely new people', async () => {
    const result = await save([
      record('new@example.test', null), record('NEW@example.test', '9876543210'),
      record('other@example.test', null), record(null, null, { name: 'No identifiers' }),
    ]);
    expect(inserted.map(row => row.email ?? row.name)).toEqual(['new@example.test', 'other@example.test', 'No identifiers']);
    expect(members).toHaveLength(3);
    expect(result).toMatchObject({ count: 3, matchedExisting: 0 });
  });
});
