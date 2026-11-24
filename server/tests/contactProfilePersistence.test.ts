import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const queries: Array<{ sql: string; params: unknown[]; inTransaction: boolean }> = [];
const mutations: Array<{
  table: string;
  updates: Record<string, any>;
  where: string;
  params: unknown[];
  inTransaction: boolean;
}> = [];
let row: Record<string, any> | null;
let insideTransaction = false;
let rejectLeadWrite = false;
const vault = new Map<number, string>();
const reveal = jest.fn<any>(async (_userId: number, vaultRef: number) =>
  vault.has(vaultRef) ? { rawText: vault.get(vaultRef), piiTypes: [], expiresAt: new Date(Date.now() + 100000) } : null,
);
const protect = jest.fn<any>(async ({ rawText }: { rawText: string }) => ({
  redactedText: rawText.includes('@') ? '[EMAIL_1]' : /\d{7}/.test(rawText) ? '[PHONE_1]' : 'My name is [NAME_1]',
  vaultId: 99,
}));
const execute = jest.fn<any>(async (query: SQL) => {
  const rendered = dialect.sqlToQuery(query);
  queries.push({ ...rendered, inTransaction: insideTransaction });
  return { rows: /FROM outreach_conversations oc|FROM leads l/.test(rendered.sql) && row ? [{ ...row }] : [] };
});
const update = jest.fn<any>((table: any) => ({
  set: (updates: Record<string, any>) => ({
    where: (condition: SQL) => {
      const tableName = getTableConfig(table).name;
      const predicate = dialect.sqlToQuery(condition);
      let applied = false;
      const apply = () => {
        if (!applied) {
          mutations.push({
            table: tableName,
            updates,
            where: predicate.sql,
            params: predicate.params,
            inTransaction: insideTransaction,
          });
          if (row && tableName === 'crm_contacts')
            for (const [key, value] of Object.entries(updates)) {
              row[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = value;
            }
          if (row && tableName === 'outreach_conversations' && updates.metadata instanceof SQL) {
            const metadata = dialect.sqlToQuery(updates.metadata);
            if (metadata.sql.includes("- 'contactProfileCorrection'")) delete row.correction;
            else row.correction = JSON.parse(String(metadata.params[0])).contactProfileCorrection;
          }
          applied = true;
        }
        return rejectLeadWrite && tableName === 'leads' ? [] : [{ id: tableName === 'leads' ? 11 : 71 }];
      };
      return { returning: async () => apply(), then: (resolve: (value: unknown) => void) => resolve(apply()) };
    },
  }),
}));
const transaction = jest.fn<any>(async (callback: (tx: any) => Promise<any>) => {
  const previous = row ? { ...row } : null;
  insideTransaction = true;
  try {
    return await callback(mockDb);
  } catch (error) {
    row = previous;
    throw error;
  } finally {
    insideTransaction = false;
  }
});
const mockDb = { execute, update, transaction };
jest.unstable_mockModule('../models/db.js', () => ({ db: mockDb, pgPool: undefined }));
jest.unstable_mockModule('../services/SentimentAnalysisService', () => ({ sentimentAnalysisService: {} }));
jest.unstable_mockModule('../services/AlertService', () => ({ alertService: {} }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  privacyVaultService: { reveal, protectInbound: protect },
  isPrivacyVaultConfigured: () => true,
  restrictedBindingDigest: (_userId: number, purpose: string, value: string) =>
    `keyed:${purpose}:${Buffer.from(value).toString('base64')}`,
}));
// This service only uses name validation from the resolver, not inbound identity
// provisioning. Keep the runtime fixture focused and avoid unrelated imports.
jest.unstable_mockModule('../services/InboundContactResolver.js', () => ({
  isStrongContactName: (value: string) =>
    typeof value === 'string' && value.length > 1 && /\p{L}/u.test(value) && !value.includes('@'),
}));
const { contactProfileService } = await import('../services/agents/orchestration/ContactProfileService.js');

const confirmation = (inboundText: string) =>
  contactProfileService.handleExplicitNameCorrection({
    userId: 991,
    conversationId: 11,
    inboundText,
    profile: null,
  });
const collect = (attribute: string, vaultRef = 1, extra: Record<string, unknown> = {}) =>
  contactProfileService.writeBackCollectedField({
    userId: 991,
    conversationId: 11,
    runId: 9,
    field: {
      key: `customer_${attribute}`,
      type: 'text',
      required: true,
      pii: 'contact',
      prompt: 'Provide profile value',
      profileBinding: {
        attribute,
        read: true,
        writeBack: 'fill_missing_or_verify_correction',
        minimumTrust: 'customer_verified',
      },
    } as any,
    state: { source: 'customer', status: 'collected', vaultRef, ...extra } as any,
  });

beforeEach(() => {
  row = {
    lead_id: 11,
    contact_id: 71,
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'old@example.test',
    phone: '+14155550100',
    company: 'Old Company',
  };
  queries.length = 0;
  mutations.length = 0;
  vault.clear();
  rejectLeadWrite = false;
  jest.clearAllMocks();
});

describe('governed contact profile corrections', () => {
  it.each([
    ['email', 'new@example.test', { email: 'new@example.test' }, 'email address'],
    ['phone', '+1 (415) 555-0199', { phone: '+1 (415) 555-0199' }, 'phone number'],
    ['company', 'Acme Labs', { company: 'Acme Labs' }, 'company'],
    ['firstName', 'Alice', { firstName: 'Alice' }, 'first name'],
    ['lastName', 'Smith', { lastName: 'Smith' }, 'last name'],
    ['fullName', 'My name is Alice Smith', { firstName: 'Alice', lastName: 'Smith' }, 'name'],
  ])(
    'confirms %s using its own parser and preserves unrelated CRM fields',
    async (attribute, value, expected, label) => {
      vault.set(1, value as string);
      expect(await collect(attribute as string)).toBe('conflict');
      expect(row?.correction.attribute).toBe(attribute);
      const response = await confirmation(' Yes ');
      expect(response).toMatchObject({ handled: true, outcome: 'updated' });
      expect(response.replyText).toContain(String(label));
      expect(response.replyText).not.toContain(value);
      const contactWrite = mutations.find((mutation) => mutation.table === 'crm_contacts')!;
      expect(contactWrite.updates).toEqual({ ...(expected as object), updatedAt: expect.any(Date) });
      expect(contactWrite.updates).not.toHaveProperty('leadId');
      expect(row?.correction).toBeUndefined();
      expect(mutations.every((mutation) => mutation.inTransaction)).toBe(true);
      expect(
        queries
          .filter((query) => query.sql.includes('FROM outreach_conversations'))
          .every((query) => query.sql.includes('FOR UPDATE OF oc, l, cc') && query.inTransaction),
      ).toBe(true);
      expect(queries[0].sql).toContain('pg_advisory_xact_lock');
      for (const mutation of mutations.filter((mutation) => ['crm_contacts', 'leads'].includes(mutation.table))) {
        expect(mutation.where).toContain('"user_id" =');
        expect(mutation.where).toContain('"deleted_at" is null');
        expect(mutation.params).toContain(991);
      }
    },
  );

  it.each([
    'Yes, but keep the old email',
    'yes do not change it',
    'No, actually update it',
    'confirm',
    'correct',
    'y',
    'n',
    'Yes please',
    'Yes.',
  ])('leaves mixed/unsupported confirmation %s pending', async (answer) => {
    row!.correction = { attribute: 'email', vaultRef: 1, status: 'pending_owner_or_customer_confirmation' };
    vault.set(1, 'new@example.test');
    expect(await confirmation(answer)).toMatchObject({ handled: true, outcome: 'pending' });
    expect(mutations).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('cancels on exact No without revealing or modifying PII', async () => {
    row!.correction = { attribute: 'phone', vaultRef: 1, status: 'pending_customer_confirmation' };
    expect(await confirmation(' NO ')).toMatchObject({ outcome: 'cancelled' });
    expect(reveal).not.toHaveBeenCalled();
    expect(mutations.map((mutation) => mutation.table)).toEqual(['outreach_conversations']);
    expect(row?.correction).toBeUndefined();
  });

  it('rejects a persisted unknown attribute instead of dynamically writing a CRM column', async () => {
    row!.correction = { attribute: 'assignedTo', vaultRef: 1, status: 'pending_customer_confirmation' };
    expect(await confirmation('Yes')).toMatchObject({ outcome: 'pending' });
    expect(mutations).toHaveLength(0);
    expect(await collect('deletedAt')).toBe('ignored');
  });

  it('requires fresh confirmation when the stored field changed since the correction was proposed', async () => {
    vault.set(1, 'new@example.test');
    await collect('email');
    row!.email = 'changed-by-owner@example.test';
    expect(await confirmation('Yes')).toMatchObject({ outcome: 'pending' });
    expect(mutations.filter((mutation) => mutation.table === 'crm_contacts')).toHaveLength(0);
    expect(await confirmation('Yes')).toMatchObject({ outcome: 'updated' });
  });

  it('does not apply a pending correction to a newly linked canonical CRM contact', async () => {
    vault.set(1, 'new@example.test');
    await collect('email');
    row!.contact_id = 72;
    expect(await confirmation('Yes')).toMatchObject({ outcome: 'pending' });
    expect(mutations.filter((mutation) => mutation.table === 'crm_contacts')).toHaveLength(0);
  });

  it('does not overwrite an unresolved correction with a second collected field', async () => {
    vault.set(1, 'new@example.test');
    vault.set(2, '+14155550199');
    await collect('email');
    const first = row!.correction;
    expect(await collect('phone', 2)).toBe('conflict');
    expect(row!.correction).toEqual(first);
  });

  it('fills missing fields under the same row lock and treats equivalent phone formatting as unchanged', async () => {
    row!.email = null;
    vault.set(1, 'new@example.test');
    expect(await collect('email')).toBe('updated');
    expect(queries.find((query) => query.sql.includes('FROM outreach_conversations'))?.sql).toContain(
      'FOR UPDATE OF oc, l, cc',
    );
    vault.set(2, '+1 (415) 555-0100');
    expect(await collect('phone', 2)).toBe('unchanged');
  });

  it('ignores invalid collected field state and expired correction evidence', async () => {
    vault.set(1, 'new@example.test');
    expect(await collect('email', 1, { status: 'invalid' })).toBe('ignored');
    row!.correction = { attribute: 'email', vaultRef: 9, status: 'pending_customer_confirmation' };
    expect(await confirmation('Yes')).toMatchObject({ outcome: 'pending' });
    expect(mutations).toHaveLength(0);
  });

  it('does not report success if the active lead update stops matching', async () => {
    vault.set(1, 'new@example.test');
    await collect('email');
    rejectLeadWrite = true;
    await expect(confirmation('Yes')).rejects.toThrow('Contact profile changed during update');
    expect(row!.email).toBe('old@example.test');
    expect(row!.correction).toBeDefined();
  });

  it('uses fresh persisted name state rather than an outdated supplied profile snapshot', async () => {
    expect(
      await contactProfileService.handleExplicitNameCorrection({
        userId: 991,
        conversationId: 11,
        inboundText: 'My name is [NAME_1]',
        inboundVaultId: 1,
        profile: null,
      }),
    ).toMatchObject({ outcome: 'pending' });
    expect(row!.correction).toMatchObject({ attribute: 'fullName', contactId: 71, vaultRef: 1 });
    expect(JSON.stringify(row!.correction)).not.toContain('Jane');
  });
});

describe('active canonical CRM profile reads', () => {
  it('returns only protected values from the canonical joined CRM record', async () => {
    const profile = await contactProfileService.loadForConversation(991, 11);
    expect(profile).toMatchObject({ contactId: 71, leadId: 11, fields: { fullName: { value: '[NAME_1]' } } });
    expect(JSON.stringify(profile)).not.toContain('old@example.test');
    const query = queries[0];
    expect(query.sql).toContain('cc.id AS contact_id');
    expect(query.sql).not.toContain('COALESCE(oc.crm_contact_id');
    expect(query.sql).toContain('l.user_id = oc.user_id AND l.deleted_at IS NULL');
    expect(query.sql).toContain('cc.user_id = oc.user_id');
    expect(query.sql).toContain('cc.deleted_at IS NULL');
    expect(query.sql).toContain('NOT EXISTS');
    expect(query.sql).not.toContain('FOR UPDATE');
  });

  it('requires the supplied conversation to belong to the exact lead and never falls back after a missing join', async () => {
    row = null;
    expect(await contactProfileService.loadForLead(991, 22, 11)).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('AND oc.lead_id =');
    expect(queries[0].params).toEqual([11, 991, 22]);
    expect(protect).not.toHaveBeenCalled();
  });

  it('permits lead-only hydration only through one active owned lead/contact candidate', async () => {
    await contactProfileService.loadForLead(991, 11, 0);
    expect(queries[0].sql).toContain('l.deleted_at IS NULL');
    expect(queries[0].sql).toContain('other.deleted_at IS NULL AND other.id <> cc.id');
    expect(queries[0].sql).toContain('cc.user_id = l.user_id');
    expect(queries[0].params).toEqual([11, 991]);
  });

  it('does not mutate or expose a profile when active ownership/identity joins return nothing', async () => {
    row = null;
    vault.set(1, 'new@example.test');
    expect(await collect('email')).toBe('ignored');
    expect(await confirmation('Yes')).toEqual({ handled: false });
    expect(await contactProfileService.loadForConversation(991, 11)).toBeNull();
    expect(mutations).toHaveLength(0);
    expect(protect).not.toHaveBeenCalled();
  });
});
