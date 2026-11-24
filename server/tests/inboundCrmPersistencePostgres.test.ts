import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as baseIt, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration.js';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import type { ReconcileInboundContactInput } from '../services/InboundContactResolver.js';

// Opt-in only: this suite creates and drops its own randomly named local schema.
// Never expose application tables through search_path, including on failures.
const runPostgres = process.env.SUPPORT_CRM_LOCAL_QA === '1' ? describe : describe.skip;
// These service-level fixtures bypass HTTP middleware; enter the same verified
// business context explicitly for every ordinary and parameterized test body.
const scopedTestHandler: ProxyHandler<(...args: any[]) => unknown> = {
  apply(fn, receiver, [name, body, timeout]) {
    return Reflect.apply(fn, receiver, [name, (...args: any[]) => withBusinessScope({ userId: 991, businessProfileId: 1 }, () => body(...args)), timeout]);
  },
};
const scopedTest = (target: (...args: any[]) => unknown) => new Proxy(target, scopedTestHandler);
const it = new Proxy<typeof baseIt>(baseIt, {
  apply: scopedTestHandler.apply,
  get(target, key) {
    if (key === 'each') return (...table: any[]) => scopedTest(Reflect.apply(target.each, target, table));
    return Reflect.get(target, key);
  },
});
jest.setTimeout(30000);
let fixtureDb: NodePgDatabase;
const databaseProxy = new Proxy(
  {} as NodePgDatabase,
  {
    get(_target, key) {
      const value = fixtureDb[key as keyof typeof fixtureDb];
      return typeof value === 'function' ? value.bind(fixtureDb) : value;
    },
  },
);
jest.unstable_mockModule('../models/db', () => ({ db: databaseProxy, pgPool: undefined }));
jest.unstable_mockModule('../services/SentimentAnalysisService', () => ({ sentimentAnalysisService: {} }));
jest.unstable_mockModule('../services/AlertService', () => ({ alertService: { fireEvent: jest.fn<any>().mockResolvedValue(undefined) } }));
const { crmService } = await import('../services/CRMService.js');
const { mergeContactByPhone } = await import('../services/CRMContactMergeService.js');
const { inboundContactResolver } = await import('../services/InboundContactResolver.js');
const { restrictedBindingDigest, encryptRestrictedPayload, privacyVaultService } =
  await import('../services/agents/orchestration/PrivacyVaultService.js');
const { processInboundSMS, normalizeInboundSMSPayload } =
  await import('../services/smsService.js');
const { contactProfileService } = await import('../services/agents/orchestration/ContactProfileService.js');
const { leadsTable } = await import('../models/leads/schema');
const { crmContactsTable } = await import('../models/crmContacts/schema');
const { crmActivitiesTable } = await import('../models/crmActivities/schema');
const { crmContactChannelIdentitiesTable } = await import('../models/crmContactChannelIdentities/schema');
const { outreachConversationsTable, outreachMessagesTable } = await import('../models/outreachConversations/schema');
const { supportPrivacyVaultTable } = await import('../models/supportOrchestration/schema');
const { crmActivityRemindersTable } = await import('../models/crmActivityReminders/schema');
const { supportTicketsTable } = await import('../models/supportTickets/schema');
const { crmAlertLogsTable } = await import('../models/crmAlertLogs/schema');
const { crmAutomationLogsTable } = await import('../models/crmAutomationLogs/schema');
const { crmContactImportsTable } = await import('../models/crmContactImports/schema');
const { crmContactImportDetailsTable } = await import('../models/crmContactImportDetails/schema');
const { proposalsTable } = await import('../models/proposals/schema');
const { LeadModel } = await import('../models/leads/functions');
// @ts-expect-error Database migrations are JavaScript modules executed by the migration runner.
const { up: installMergeRedirects } = await import('../migrations/309_crm_contact_merge_redirects.js');
// @ts-expect-error Application migration owns the internal phone lookup keys.
const {up: installPhoneLookups}=await import('../migrations/581_contact_import_phone_lookup_indexes.js');
// @ts-expect-error Application migration owns the contact alias lookup indexes.
const {up: installLeadAliasIndexes}=await import('../migrations/582_crm_contact_lead_alias_indexes.js');

runPostgres('inbound CRM persistence (isolated local PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const tenant = 991;
  const previousPrivacyKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;

  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true, quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || ''))
      throw new Error('CRM QA requires local PostgreSQL');
    const qaUrl = process.env.SUPPORT_CRM_QA_DATABASE_URL;
    if (qaUrl && !['localhost','127.0.0.1','[::1]'].includes(new URL(qaUrl).hostname)) throw new Error('CRM QA requires local PostgreSQL');
    const config = qaUrl ? { connectionString: qaUrl, connectionTimeoutMillis: 5000 } : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      connectionTimeoutMillis: 5000,
    };
    schema = `support_crm_identity_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 5, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    await pool.query('CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,crm_configuration jsonb,updated_at timestamp DEFAULT now())');
    await pool.query('INSERT INTO company_settings(id,user_id,crm_configuration) VALUES($1,$2,$3)', [1, tenant, DEFAULT_CRM_CONFIGURATION]);
    await pool.query("CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL AS 'SELECT 1'");
    process.env.SUPPORT_PII_ENCRYPTION_KEY = 'isolated-crm-fixture-encryption-key-not-production';
    for (const table of [
      leadsTable,
      crmContactsTable,
      crmActivitiesTable,
      crmContactChannelIdentitiesTable,
      outreachConversationsTable,
      outreachMessagesTable,
      supportPrivacyVaultTable,
      crmActivityRemindersTable, supportTicketsTable, crmAlertLogsTable, crmAutomationLogsTable,
      crmContactImportsTable, crmContactImportDetailsTable, proposalsTable,
    ]) {
      const definition = getTableConfig(table);
      // Real column names/types; external FKs deliberately omitted so no
      // application rows are required. Relevant uniqueness is recreated below.
      const columns = definition.columns.map((column) => {
        const value = column.default;
        const defaultSql =
          value instanceof SQL
            ? new PgDialect().sqlToQuery(value).sql
            : value === undefined
              ? undefined
              : typeof value === 'number' || typeof value === 'boolean'
                ? String(value)
                : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
        return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('ALTER TABLE crm_contacts DROP COLUMN merged_into_contact_id');
    await installMergeRedirects(pool);
    await installPhoneLookups(pool);
    await installLeadAliasIndexes(pool);
    await pool.query(`CREATE UNIQUE INDEX crm_activities_user_idempotency_uq ON crm_activities(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX identity_uq ON crm_contact_channel_identities(business_profile_id,user_id,channel,identifier_fingerprint);
      CREATE UNIQUE INDEX support_privacy_vault_provider_message_uq ON support_privacy_vault(business_profile_id,user_id,channel,provider_message_id);
      CREATE TABLE crm_contact_identity_conflicts(business_profile_id int DEFAULT 1,user_id int,conversation_id int,identifier_type text,identifier_fingerprint text,candidate_contact_ids jsonb,status text,created_at timestamp,updated_at timestamp);
      CREATE UNIQUE INDEX conflict_uq ON crm_contact_identity_conflicts(business_profile_id,user_id,identifier_type,identifier_fingerprint) WHERE status='pending_review';
      CREATE TABLE campaign_crm_contacts(id serial PRIMARY KEY,user_id int,business_profile_id int,contact_id int,thread_id int,UNIQUE(contact_id,thread_id));
      CREATE TABLE followup_sequences(lead_id int,user_id int,completed boolean,replied_at timestamp,updated_at timestamp);
      CREATE TABLE sequence_executions(lead_id int,status text,updated_at timestamp);
      CREATE TABLE proposal_reminders(id serial PRIMARY KEY,user_id int,proposal_id int,reminder_type text,status text,last_sent_at timestamp,snoozed_until timestamp,metadata jsonb DEFAULT '{}'::jsonb,updated_at timestamp DEFAULT NOW())`);
    console.info(`Isolated CRM PostgreSQL fixture: ${schema}`);
  }, 30000);

  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_crm_identity_[a-f0-9]{16}$/.test(schema))
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    if (previousPrivacyKey === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY;
    else process.env.SUPPORT_PII_ENCRYPTION_KEY = previousPrivacyKey;
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE campaign_crm_contacts,leads,crm_contacts,crm_activities,crm_contact_channel_identities,outreach_conversations,outreach_messages,support_privacy_vault,crm_contact_identity_conflicts,followup_sequences,sequence_executions,proposals,proposal_reminders,crm_activity_reminders,support_tickets,crm_alert_logs,crm_automation_logs,crm_contact_imports,crm_contact_import_details RESTART IDENTITY',
    );
  });

  async function leadConversation(id = 11, channel = 'email', userId = tenant) {
    await pool.query("INSERT INTO leads(id,user_id,email,source,status) VALUES($1,$2,$3,'fixture','new')", [
      id,
      userId,
      `customer${id}@example.test`,
    ]);
    await pool.query('INSERT INTO outreach_conversations(id,user_id,lead_id,channel) VALUES($1,$2,$1,$3)', [
      id,
      userId,
      channel,
    ]);
    await pool.query("INSERT INTO outreach_messages(id,conversation_id,direction) VALUES($1,$1,'inbound')", [id]);
  }
  async function contact(id: number, email: string | null, extra = '') {
    await pool.query(
      `INSERT INTO crm_contacts(id,user_id,email,status,pipeline_status,total_replies${extra ? ',phone' : ''}) VALUES($1,$2,$3,'new','new',0${extra ? ',$4' : ''})`,
      extra ? [id, tenant, email, extra] : [id, tenant, email],
    );
  }
  const reconcile = (extra: Partial<ReconcileInboundContactInput> = {}) =>
    inboundContactResolver.reconcile({
      userId: tenant,
      conversationId: 11,
      channel: 'email',
      externalIdentifier: ' Customer11@Example.Test ',
      messageId: 11,
      ...extra,
    });

  it('reuses an exact normalized CRM-only email and atomically records one replay-safe reply', async () => {
    await leadConversation();
    await contact(71, ' CUSTOMER11@example.test ');
    const results = await Promise.all(Array.from({ length: 8 }, () => reconcile()));
    expect(results.every((result) => result?.contactId === 71)).toBe(true);
    expect((await pool.query('SELECT id,lead_id,total_replies,status FROM crm_contacts')).rows).toEqual([
      { id: 71, lead_id: null, total_replies: 1, status: 'replied' },
    ]);
    expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations')).rows[0].crm_contact_id).toBe(71);
    expect((await pool.query('SELECT count(*)::int n FROM crm_activities')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT contact_id,lead_id FROM crm_contact_channel_identities')).rows).toEqual([
      { contact_id: 71, lead_id: 11 },
    ]);
  });

  it('pauses follow-ups for the exact proposal conversation once per inbound receipt', async () => {
    await leadConversation();
    await pool.query("INSERT INTO proposals(id,user_id,outreach_conversation_id,status) VALUES(501,$1,11,'sent'),(502,$1,22,'sent')", [tenant]);
    await pool.query(`INSERT INTO proposal_reminders(user_id,proposal_id,reminder_type,status,metadata)
      VALUES($1,501,'customer_followup','pending','{}'),
        ($1,501,'expiry','pending','{}'),
        ($1,502,'customer_followup','pending','{}')`, [tenant]);

    await reconcile();
    expect((await pool.query('SELECT proposal_id,reminder_type,status FROM proposal_reminders ORDER BY id')).rows).toEqual([
      { proposal_id: 501, reminder_type: 'customer_followup', status: 'paused' },
      { proposal_id: 501, reminder_type: 'expiry', status: 'pending' },
      { proposal_id: 502, reminder_type: 'customer_followup', status: 'pending' },
    ]);
    expect((await pool.query("SELECT metadata->>'pauseReason' AS reason FROM proposal_reminders WHERE proposal_id=501 AND reminder_type='customer_followup'")).rows[0].reason).toBe('customer_reply');

    await pool.query("UPDATE proposal_reminders SET status='pending' WHERE proposal_id=501 AND reminder_type='customer_followup'");
    await reconcile();
    expect((await pool.query("SELECT status FROM proposal_reminders WHERE proposal_id=501 AND reminder_type='customer_followup'")).rows[0].status).toBe('pending');

    await pool.query("INSERT INTO outreach_messages(id,conversation_id,direction) VALUES(13,11,'inbound')");
    await reconcile({ messageId: 13 });
    expect((await pool.query("SELECT status FROM proposal_reminders WHERE proposal_id=501 AND reminder_type='customer_followup'")).rows[0].status).toBe('paused');
  });

  it('persists an MSG91 reply once, protects its raw content, and pauses only the linked proposal', async () => {
    await leadConversation(11, 'sms');
    await pool.query("DELETE FROM outreach_messages; UPDATE leads SET phone='+1 (415) 555-0100' WHERE id=11; UPDATE outreach_conversations SET external_thread_id='+14155550100',provider_account_id='QA-SENDER',total_messages=0,unread_count=0 WHERE id=11");
    await pool.query("INSERT INTO proposals(id,user_id,outreach_conversation_id,status) VALUES(501,$1,11,'sent'),(502,$1,22,'sent')", [tenant]);
    await pool.query(`INSERT INTO proposal_reminders(user_id,proposal_id,reminder_type,status,metadata)
      VALUES($1,501,'customer_followup','pending','{}'),
        ($1,501,'expiry','pending','{}'),
        ($1,502,'customer_followup','pending','{}')`, [tenant]);

    const payload = {
      from: '+1 (415) 555-0100',
      text: 'Please email jane@example.test with the next steps.',
      request_id: 'msg91-inbound-501',
      timestamp: '2026-09-15T10:30:00.000Z',
      account_identifier: 'QA-SENDER',
    };
    expect(normalizeInboundSMSPayload(payload)).toMatchObject({
      sender: '14155550100',
      requestId: 'msg91-inbound-501',
      providerAccountId: 'QA-SENDER',
    });
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => processInboundSMS(tenant, payload)));
    expect(concurrent.filter((result) => !result.duplicate)).toHaveLength(1);
    const first = concurrent.find((result) => !result.duplicate)!;
    expect(first).toMatchObject({ success: true, conversationId: 11, duplicate: false });
    expect((await pool.query("SELECT direction,content,redacted_content,privacy_vault_id,status,message_kind FROM outreach_messages WHERE id=$1", [first.messageId])).rows[0]).toMatchObject({
      direction: 'inbound',
      content: expect.stringMatching(/^Please email \[EMAIL_\d+\] with the next steps\.$/),
      redacted_content: expect.stringMatching(/^Please email \[EMAIL_\d+\] with the next steps\.$/),
      status: 'delivered',
      message_kind: 'reply',
    });
    expect((await pool.query('SELECT count(*)::int n FROM support_privacy_vault')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT total_messages,unread_count,status,last_message_by FROM outreach_conversations WHERE id=11')).rows[0]).toEqual({
      total_messages: 1,
      unread_count: 1,
      status: 'replied',
      last_message_by: 'lead',
    });
    expect((await pool.query('SELECT total_replies FROM crm_contacts')).rows[0].total_replies).toBe(1);
    expect((await pool.query('SELECT proposal_id,reminder_type,status FROM proposal_reminders ORDER BY id')).rows).toEqual([
      { proposal_id: 501, reminder_type: 'customer_followup', status: 'paused' },
      { proposal_id: 501, reminder_type: 'expiry', status: 'pending' },
      { proposal_id: 502, reminder_type: 'customer_followup', status: 'pending' },
    ]);

    await pool.query("UPDATE proposal_reminders SET status='pending' WHERE proposal_id=501 AND reminder_type='customer_followup'");
    const duplicate = await processInboundSMS(tenant, payload);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect((await pool.query('SELECT count(*)::int n FROM outreach_messages')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT total_messages,unread_count FROM outreach_conversations WHERE id=11')).rows[0]).toEqual({ total_messages: 1, unread_count: 1 });
    expect((await pool.query('SELECT total_replies FROM crm_contacts')).rows[0].total_replies).toBe(1);
    expect((await pool.query("SELECT status FROM proposal_reminders WHERE proposal_id=501 AND reminder_type='customer_followup'")).rows[0].status).toBe('pending');

    await expect(processInboundSMS(tenant, { ...payload, text: 'Changed content' })).rejects.toMatchObject({
      code: 'SMS_REQUEST_ID_COLLISION',
      status: 409,
    });
    expect((await pool.query('SELECT content FROM outreach_messages WHERE id=$1', [first.messageId])).rows[0].content).toMatch(/^Please email \[EMAIL_\d+\] with the next steps\.$/);

    await processInboundSMS(tenant, { ...payload, request_id: 'msg91-inbound-502' });
    expect((await pool.query("SELECT status FROM proposal_reminders WHERE proposal_id=501 AND reminder_type='customer_followup'")).rows[0].status).toBe('paused');
  });

  it('rejects an ambiguous SMS sender instead of guessing a customer conversation', async () => {
    await leadConversation(11, 'sms');
    await leadConversation(22, 'sms');
    await pool.query("DELETE FROM outreach_messages; UPDATE leads SET phone='+14155550100'; UPDATE outreach_conversations SET external_thread_id='+14155550100',provider_account_id='QA-SENDER'");
    await expect(processInboundSMS(tenant, {
      sender: '+14155550100',
      message: 'Reply',
      requestId: 'msg91-ambiguous-1',
      providerAccountId: 'QA-SENDER',
    })).rejects.toMatchObject({
      code: 'AMBIGUOUS_SMS_CONVERSATION',
      status: 409,
    });
    expect((await pool.query('SELECT count(*)::int n FROM outreach_messages')).rows[0].n).toBe(0);
  });

  it('reuses exact phone formatting without suffix/fuzzy/name matching', async () => {
    await leadConversation(11, 'whatsapp');
    await contact(71, null, '+1 (415) 555-0100');
    await contact(72, null, '4155550100');
    expect((await reconcile({ channel: 'whatsapp', externalIdentifier: '+14155550100' }))?.contactId).toBe(71);
    expect((await pool.query('SELECT total_replies FROM crm_contacts WHERE id=72')).rows[0].total_replies).toBe(0);
  });

  it('preserves the independent canonical lead and counts distinct messages once each', async () => {
    await leadConversation();
    await leadConversation(22, 'whatsapp');
    await contact(71, null);
    await pool.query('UPDATE crm_contacts SET lead_id=22 WHERE id=71');
    await fixtureDb
      .insert(crmContactChannelIdentitiesTable)
      .values({
        userId: tenant,
        contactId: 71,
        leadId: 22,
        channel: 'gmail',
        identifierType: 'email',
        identifierFingerprint: restrictedBindingDigest(tenant, 'crm-identity:email', 'customer11@example.test'),
      });
    await reconcile();
    await pool.query("INSERT INTO outreach_messages(id,conversation_id,direction) VALUES(33,11,'inbound')");
    await reconcile({ messageId: 33 });
    await reconcile({ messageId: 33 });
    expect((await pool.query('SELECT lead_id,total_replies FROM crm_contacts WHERE id=71')).rows[0]).toEqual({
      lead_id: 22,
      total_replies: 2,
    });
    expect((await pool.query('SELECT lead_id,crm_contact_id FROM outreach_conversations WHERE id=11')).rows[0]).toEqual(
      { lead_id: 11, crm_contact_id: 71 },
    );
  });

  it('deduplicates provider-only receipts without exposing provider message IDs in the activity key', async () => {
    await leadConversation();
    const result = await reconcile({ messageId: undefined, providerMessageId: 'provider-replay-fixture' });
    await reconcile({ messageId: undefined, providerMessageId: 'provider-replay-fixture' });
    expect(
      (await pool.query('SELECT total_replies FROM crm_contacts WHERE id=$1', [result?.contactId])).rows[0]
        .total_replies,
    ).toBe(1);
    const key = (await pool.query('SELECT idempotency_key FROM crm_activities')).rows[0].idempotency_key;
    expect(key).toMatch(/^crm-inbound-reply:[a-f0-9]{64}$/);
    await pool.query("UPDATE outreach_messages SET provider_message_id='provider-replay-fixture' WHERE id=11");
    await reconcile();
    expect(
      (await pool.query('SELECT total_replies FROM crm_contacts WHERE id=$1', [result?.contactId])).rows[0]
        .total_replies,
    ).toBe(1);
  });

  it('queues ambiguous exact matches and never binds the identifier to a guessed candidate', async () => {
    await leadConversation();
    await contact(71, 'customer11@example.test');
    await contact(72, 'Customer11@example.test');
    const result = await reconcile();
    expect([71, 72]).not.toContain(result?.contactId);
    expect(
      (await pool.query('SELECT candidate_contact_ids FROM crm_contact_identity_conflicts')).rows[0]
        .candidate_contact_ids,
    ).toEqual([71, 72]);
    expect((await pool.query('SELECT * FROM crm_contact_channel_identities')).rows).toHaveLength(0);
    expect(
      (await pool.query('SELECT total_replies FROM crm_contacts WHERE id IN(71,72)')).rows.every(
        (row) => row.total_replies === 0,
      ),
    ).toBe(true);
  });

  it('still persists an ambiguous-match review without storing plaintext when privacy keys are unavailable', async () => {
    await leadConversation();
    await contact(71, 'customer11@example.test');
    await contact(72, 'Customer11@example.test');
    const piiKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;
    const secretsKey = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.SUPPORT_PII_ENCRYPTION_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      const result = await reconcile();
      expect([71, 72]).not.toContain(result?.contactId);
      const conflict = (await pool.query('SELECT identifier_fingerprint,candidate_contact_ids FROM crm_contact_identity_conflicts')).rows[0];
      expect(conflict).toEqual({ identifier_fingerprint: 'unavailable:conversation:11', candidate_contact_ids: [71, 72] });
    } finally {
      if (piiKey !== undefined) process.env.SUPPORT_PII_ENCRYPTION_KEY = piiKey;
      if (secretsKey !== undefined) process.env.SECRETS_ENCRYPTION_KEY = secretsKey;
    }
  });

  it('replaces a stale identity slot instead of resurrecting a soft-deleted contact', async () => {
    await leadConversation();
    await contact(71, 'customer11@example.test');
    await pool.query('UPDATE crm_contacts SET deleted_at=NOW() WHERE id=71');
    await fixtureDb
      .insert(crmContactChannelIdentitiesTable)
      .values({
        userId: tenant,
        contactId: 71,
        leadId: 11,
        channel: 'email',
        identifierType: 'email',
        identifierFingerprint: restrictedBindingDigest(tenant, 'crm-identity:email', 'customer11@example.test'),
        encryptedIdentifier: encryptRestrictedPayload(tenant, 'crm-identity:email', 'customer11@example.test'),
      });
    const result = await reconcile();
    expect(result?.contactId).not.toBe(71);
    expect((await pool.query('SELECT contact_id FROM crm_contact_channel_identities')).rows[0].contact_id).toBe(
      result?.contactId,
    );
  });

  it('queues an unverified identity ownership claim without merging or losing the inbound conversation', async () => {
    await leadConversation();
    await contact(71, null);
    await fixtureDb
      .insert(crmContactChannelIdentitiesTable)
      .values({
        userId: tenant,
        contactId: 71,
        leadId: 11,
        channel: 'email',
        identifierType: 'email',
        verificationLevel: 'unverified',
        identifierFingerprint: restrictedBindingDigest(tenant, 'crm-identity:email', 'customer11@example.test'),
      });
    const result = await reconcile();
    expect(result?.contactId).not.toBe(71);
    expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations')).rows[0].crm_contact_id).toBe(
      result?.contactId,
    );
    expect((await pool.query('SELECT contact_id FROM crm_contact_channel_identities')).rows[0].contact_id).toBe(71);
    expect(
      (await pool.query('SELECT candidate_contact_ids FROM crm_contact_identity_conflicts')).rows[0]
        .candidate_contact_ids,
    ).toEqual([71, result?.contactId]);
  });

  it.each(['foreign', 'deleted'])(
    'rejects a %s conversation lead before updating an existing CRM contact',
    async (kind) => {
      await leadConversation();
      await contact(71, 'customer11@example.test');
      await pool.query('UPDATE crm_contacts SET lead_id=11 WHERE id=71');
      await pool.query(kind === 'foreign' ? 'UPDATE leads SET user_id=992' : 'UPDATE leads SET deleted_at=NOW()');
      expect(await reconcile()).toBeNull();
      expect(await crmService.ensureContactForInbound(tenant, 11)).toBeNull();
      expect(await crmService.materializeContactReference(tenant, -11)).toBeNull();
      expect((await pool.query('SELECT total_replies FROM crm_contacts')).rows[0].total_replies).toBe(0);
    },
  );

  it('excludes a foreign tenant exact match and identity even with a forged identity pointer', async () => {
    await leadConversation();
    await contact(71, 'customer11@example.test');
    await pool.query('UPDATE crm_contacts SET user_id=992 WHERE id=71');
    await fixtureDb
      .insert(crmContactChannelIdentitiesTable)
      .values({
        userId: tenant,
        contactId: 71,
        leadId: 11,
        channel: 'email',
        identifierType: 'email',
        identifierFingerprint: restrictedBindingDigest(tenant, 'crm-identity:email', 'customer11@example.test'),
      });
    expect((await reconcile())?.contactId).not.toBe(71);
  });

  it('serializes concurrent inbound creation with virtual-lead materialization', async () => {
    await leadConversation();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? crmService.materializeContactReference(tenant, -11) : reconcile())),
    );
    expect((await pool.query('SELECT count(*)::int n FROM crm_contacts')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT total_replies FROM crm_contacts')).rows[0].total_replies).toBe(1);
  });

  it('preserves canonical CRM-only association through later direct provisioning and materialization', async () => {
    await leadConversation();
    await contact(71, 'customer11@example.test');
    await reconcile();
    expect(await crmService.ensureContactForInbound(tenant, 11, { recordReply: false })).toBe(71);
    expect((await crmService.materializeContactReference(tenant, -11))?.id).toBe(71);
    expect((await crmService.getContactById(tenant, -11))?.id).toBe(71);
    expect((await pool.query('SELECT count(*)::int n FROM crm_contacts')).rows[0].n).toBe(1);
  });

  it('prefers an explicit canonical conversation association over a historical temporary-lead duplicate', async () => {
    await leadConversation();
    await contact(71, 'customer11@example.test');
    await reconcile();
    await contact(72, null);
    await pool.query('UPDATE crm_contacts SET lead_id=11 WHERE id=72');
    expect(await crmService.ensureContactForInbound(tenant, 11, { recordReply: false })).toBe(71);
    expect((await crmService.materializeContactReference(tenant, -11))?.id).toBe(71);
    expect((await pool.query('SELECT total_replies FROM crm_contacts WHERE id=72')).rows[0].total_replies).toBe(0);
  });

  it('serializes two different temporary channel leads resolving the same exact CRM identity', async () => {
    await leadConversation();
    await leadConversation(22, 'gmail');
    await contact(71, 'customer11@example.test');
    const results = await Promise.all([
      reconcile(),
      reconcile({ conversationId: 22, channel: 'gmail', messageId: 22 }),
    ]);
    expect(results.map((result) => result?.contactId)).toEqual([71, 71]);
    expect((await pool.query('SELECT total_replies FROM crm_contacts')).rows[0].total_replies).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM crm_contacts')).rows[0].n).toBe(1);
  });

  it('does not count or change stages in ensure-only mode, including a newly provisioned contact', async () => {
    await leadConversation();
    const result = await reconcile({ recordReply: false });
    expect(result?.contactId).toBeTruthy();
    expect((await pool.query('SELECT status,pipeline_status,total_replies FROM crm_contacts')).rows[0]).toEqual({
      status: 'new',
      pipeline_status: 'new',
      total_replies: 0,
    });
    expect((await pool.query('SELECT status FROM leads')).rows[0].status).toBe('new');
    expect((await pool.query('SELECT * FROM crm_activities')).rows).toHaveLength(0);
  });

  it('rolls back contact creation, receipt and conversation association on identity storage failure', async () => {
    await leadConversation();
    await pool.query(
      "ALTER TABLE crm_contact_channel_identities ADD CONSTRAINT fixture_reject CHECK(channel <> 'email')",
    );
    try {
      await expect(reconcile()).rejects.toThrow();
      expect((await pool.query('SELECT * FROM crm_contacts')).rows).toHaveLength(0);
      expect((await pool.query('SELECT * FROM crm_activities')).rows).toHaveLength(0);
      expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations')).rows[0].crm_contact_id).toBeNull();
    } finally {
      await pool.query('ALTER TABLE crm_contact_channel_identities DROP CONSTRAINT fixture_reject');
    }
  });

  it('rejects an outbound/foreign message receipt and rolls back provisioning', async () => {
    await leadConversation();
    await pool.query("UPDATE outreach_messages SET direction='outbound'");
    await expect(reconcile()).rejects.toThrow('Inbound receipt message');
    expect((await pool.query('SELECT * FROM crm_contacts')).rows).toHaveLength(0);
  });

  describe('actual ContactProfileService transactions with test-only vault evidence', () => {
    let reveal: jest.SpiedFunction<typeof privacyVaultService.reveal>;
    const evidence: NonNullable<Awaited<ReturnType<typeof privacyVaultService.reveal>>> = {
      rawText: 'new-profile@example.test', piiTypes: ['email'], expiresAt: new Date('2099-01-01'),
    };
    const collectEmail = () => contactProfileService.writeBackCollectedField({
      userId: tenant, conversationId: 11, runId: 9,
      field: { key: 'customer.email', type: 'text', required: true, pii: 'contact', prompt: 'Provide your email',
        profileBinding: { attribute: 'email', read: true, writeBack: 'fill_missing_or_verify_correction', minimumTrust: 'customer_verified' } },
      state: { source: 'customer', status: 'collected', vaultRef: 9001 },
    });
    const confirm = () => contactProfileService.handleExplicitNameCorrection({
      userId: tenant, conversationId: 11, inboundText: 'Yes', profile: null,
    });
    beforeEach(async () => {
      await leadConversation();
      await contact(71, 'customer11@example.test');
      await pool.query("UPDATE crm_contacts SET first_name='Jane',last_name='Doe',company='Original Company' WHERE id=71");
      await pool.query("UPDATE leads SET first_name='Jane',last_name='Doe',name='Jane Doe' WHERE id=11");
      await pool.query("UPDATE outreach_conversations SET crm_contact_id=71,lead_name='Jane Doe',lead_email='customer11@example.test' WHERE id=11");
      reveal = jest.spyOn(privacyVaultService, 'reveal').mockResolvedValue(evidence);
    });
    afterEach(() => { reveal?.mockRestore(); });

    it('commits an email correction across canonical CRM, channel lead and conversation without changing names', async () => {
      expect(await collectEmail()).toBe('conflict');
      expect(await confirm()).toMatchObject({ outcome: 'updated' });
      expect((await pool.query('SELECT lead_id,email,first_name,last_name,company FROM crm_contacts WHERE id=71')).rows[0]).toEqual({
        lead_id: null, email: evidence.rawText, first_name: 'Jane', last_name: 'Doe', company: 'Original Company',
      });
      expect((await pool.query('SELECT email,name,first_name,last_name FROM leads WHERE id=11')).rows[0]).toEqual({
        email: evidence.rawText, name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe',
      });
      expect((await pool.query("SELECT lead_id,crm_contact_id,lead_name,lead_email,metadata->'contactProfileCorrection' correction FROM outreach_conversations WHERE id=11")).rows[0]).toEqual({
        lead_id: 11, crm_contact_id: 71, lead_name: 'Jane Doe', lead_email: evidence.rawText, correction: null,
      });
    });

    it.each(['deleted', 'foreign'])('excludes a %s explicit CRM pointer without falling back to another lead contact', async kind => {
      await contact(72, 'fallback@example.test');
      await pool.query('UPDATE crm_contacts SET lead_id=11 WHERE id=72');
      await pool.query(kind === 'deleted' ? 'UPDATE crm_contacts SET deleted_at=NOW() WHERE id=71' : 'UPDATE crm_contacts SET user_id=992 WHERE id=71');
      expect(await contactProfileService.loadForConversation(tenant, 11)).toBeNull();
      expect(await contactProfileService.loadForLead(tenant, 11, 11)).toBeNull();
      expect(await collectEmail()).toBe('ignored');
      expect(await confirm()).toEqual({ handled: false });
      expect((await pool.query('SELECT email FROM crm_contacts WHERE id=72')).rows[0].email).toBe('fallback@example.test');
      expect((await pool.query('SELECT email FROM leads WHERE id=11')).rows[0].email).toBe('customer11@example.test');
    });

    it.each(['deleted', 'foreign'])('excludes an inactive/non-owned %s channel lead even with an active CRM pointer', async kind => {
      await pool.query(kind === 'deleted' ? 'UPDATE leads SET deleted_at=NOW() WHERE id=11' : 'UPDATE leads SET user_id=992 WHERE id=11');
      expect(await contactProfileService.loadForConversation(tenant, 11)).toBeNull();
      expect(await contactProfileService.loadForLead(tenant, 11, 11)).toBeNull();
      expect(await collectEmail()).toBe('ignored');
      expect((await pool.query('SELECT email FROM crm_contacts WHERE id=71')).rows[0].email).toBe('customer11@example.test');
    });

    it('rolls back an already-written canonical CRM field when the channel lead update fails', async () => {
      expect(await collectEmail()).toBe('conflict');
      await pool.query("ALTER TABLE leads ADD CONSTRAINT fixture_profile_reject CHECK(email <> 'new-profile@example.test')");
      try {
        await expect(confirm()).rejects.toThrow();
        expect((await pool.query('SELECT email FROM crm_contacts WHERE id=71')).rows[0].email).toBe('customer11@example.test');
        expect((await pool.query('SELECT email FROM leads WHERE id=11')).rows[0].email).toBe('customer11@example.test');
        const conversation = (await pool.query("SELECT lead_email,metadata->'contactProfileCorrection' correction FROM outreach_conversations WHERE id=11")).rows[0];
        expect(conversation.lead_email).toBe('customer11@example.test');
        expect(conversation.correction).toMatchObject({ attribute: 'email', status: 'pending_owner_or_customer_confirmation' });
      } finally { await pool.query('ALTER TABLE leads DROP CONSTRAINT fixture_profile_reject'); }
    });

    it('holds actual PostgreSQL row locks on CRM, lead and conversation before revealing pending evidence', async () => {
      expect(await collectEmail()).toBe('conflict');
      let markStarted!: () => void;
      let releaseEvidence!: (value: typeof evidence) => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const gate = new Promise<typeof evidence>(resolve => { releaseEvidence = resolve; });
      reveal.mockImplementationOnce(async () => { markStarted(); return gate; });
      const confirmation = confirm();
      await started;
      const contender = await pool.connect();
      try {
        await contender.query("SET lock_timeout='150ms'");
        for (const statement of [
          "UPDATE crm_contacts SET company='Concurrent update' WHERE id=71",
          "UPDATE leads SET company='Concurrent update' WHERE id=11",
          "UPDATE outreach_conversations SET lead_company='Concurrent update' WHERE id=11",
        ]) await expect(contender.query(statement)).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await contender.query('RESET lock_timeout');
        contender.release();
        releaseEvidence(evidence);
      }
      expect(await confirmation).toMatchObject({ outcome: 'updated' });
    });
  });

  describe('phone reconciliation across lead sources', () => {
    let reveal: jest.SpiedFunction<typeof privacyVaultService.reveal>;
    let category: jest.SpiedFunction<typeof LeadModel.resolveBusinessCategory>;
    const phone = '+1 (415) 555-0199';
    const collect = (attribute: 'phone' | 'email', rawText: string) => {
      reveal.mockResolvedValue({ rawText, piiTypes: [attribute], expiresAt: new Date('2099-01-01') });
      return contactProfileService.writeBackCollectedField({
        userId: tenant, conversationId: 11, runId: 9,
        field: { key: `customer.${attribute}`, type: 'text', required: true, pii: 'contact', prompt: 'Provide contact details',
          profileBinding: { attribute, read: true, writeBack: 'fill_missing_or_verify_correction', minimumTrust: 'customer_verified' } },
        state: { source: 'customer', status: 'collected', vaultRef: 9001 },
      });
    };
    beforeEach(() => {
      reveal = jest.spyOn(privacyVaultService, 'reveal');
      category = jest.spyOn(LeadModel, 'resolveBusinessCategory').mockResolvedValue({
        businessCategoryId: null, businessCategoryName: null, businessSubcategoryId: null, businessSubcategoryName: null,
      });
    });
    afterEach(() => { reveal.mockRestore(); category.mockRestore(); });
    const setupSource = async (channel = 'instagram') => {
      await leadConversation(11, channel);
      await pool.query('UPDATE leads SET email=NULL,phone=NULL WHERE id=11');
      await contact(71, null);
      await pool.query("UPDATE crm_contacts SET lead_id=11,first_name='Jane',last_name='Doe',total_replies=2,tags='[\"instagram\"]',notes='Instagram notes' WHERE id=71");
      await pool.query('UPDATE outreach_conversations SET crm_contact_id=71 WHERE id=11');
      await inboundContactResolver.reconcile({ userId: tenant, conversationId: 11, channel,
        externalIdentifier: channel === 'email' ? 'new@example.test' : 'sender-11', recordReply: false });
    };
    const setupTarget = async () => {
      await leadConversation(22, 'whatsapp');
      await contact(72, null, '14155550199');
      await pool.query("UPDATE crm_contacts SET lead_id=22,pipeline_status='won',total_replies=5,tags='[\"whatsapp\"]',notes='WhatsApp notes' WHERE id=72");
      await pool.query('UPDATE outreach_conversations SET crm_contact_id=72 WHERE id=22');
    };

    it('imports phone-only guests without invented email/company and replays idempotently', async () => {
      const rows=[{Name:'Guest one',Phone:'+91 90000 00001'}];
      const mapping={Name:'firstName',Phone:'phone'};
      const first=await crmService.importContactsFromCSV(tenant,rows,mapping,'phone-only.csv');
      expect(first).toMatchObject({totalRecords:1,successCount:1,errorCount:0,skippedCount:0});
      const saved=(await pool.query('SELECT email,company,phone,lead_id FROM crm_contacts WHERE deleted_at IS NULL')).rows;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({email:null,company:null,phone:'+91 90000 00001'});
      expect(saved[0].lead_id).toEqual(expect.any(Number));
      const replay=await crmService.importContactsFromCSV(tenant,rows,mapping,'phone-only.csv');
      expect(replay.importId).toBe(first.importId);
      expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
    });

    it('keeps distinct phone recipients with a shared email separate', async () => {
      const rows=[{Name:'Guest one',Email:'family@example.test',Phone:'+919000000001'},{Name:'Guest two',Email:'family@example.test',Phone:'+919000000002'}];
      const result=await crmService.importContactsFromCSV(tenant,rows,{Name:'firstName',Email:'email',Phone:'phone'},'family-phones.csv');
      expect(result).toMatchObject({successCount:2,duplicateCount:0,errorCount:0});
      expect((await pool.query('SELECT count(DISTINCT lead_id)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(2);
    });

    it('reuses an existing phone contact and records import membership without resetting its history', async () => {
      await setupTarget();
      const result=await crmService.importContactsFromCSV(tenant,[{Name:'Imported name',Phone:phone}],{Name:'firstName',Phone:'phone'},'existing-phone-only.csv');
      expect(result).toMatchObject({successCount:1,errorCount:0});
      expect((await pool.query('SELECT id,pipeline_status,total_replies,notes FROM crm_contacts WHERE deleted_at IS NULL')).rows).toEqual([{id:72,pipeline_status:'won',total_replies:5,notes:'WhatsApp notes'}]);
      expect((await pool.query('SELECT created_contact_id,status FROM crm_contact_import_details')).rows).toEqual([{created_contact_id:72,status:'success'}]);
    });

    it('imports all 575 synthetic phone recipients with durable lead-backed receipts', async () => {
      const rows=Array.from({length:575},(_,i)=>({Name:`Guest ${i+1}`,Phone:`+9190000${String(i).padStart(5,'0')}`}));
      const result=await crmService.importContactsFromCSV(tenant,rows,{Name:'firstName',Phone:'phone'},'575-phones.csv');
      expect(result).toMatchObject({totalRecords:575,successCount:575,errorCount:0,skippedCount:0});
      expect((await pool.query('SELECT count(*)::int n,count(DISTINCT lead_id)::int leads FROM crm_contacts WHERE deleted_at IS NULL')).rows[0]).toEqual({n:575,leads:575});
      expect((await pool.query("SELECT count(DISTINCT created_contact_id)::int n FROM crm_contact_import_details WHERE status='success'")).rows[0].n).toBe(575);
    },180000);

    it('resumes normalized imports in chunks with the same receipts and no duplicate contacts',async()=>{
      const rows=Array.from({length:10},(_,i)=>({Name:`Chunk guest ${i}`,Phone:`+9190000${String(i).padStart(5,'0')}`}));
      const mapping={Name:'firstName',Phone:'phone'};
      const first=await crmService.importContactsFromCSV(tenant,rows,mapping,'chunks.csv',{startIndex:0,batchSize:3,phoneCountry:'IN'});
      expect(first).toMatchObject({totalRecords:10,successCount:3,importStatus:'processing'});
      const replay=await crmService.importContactsFromCSV(tenant,rows,mapping,'chunks.csv',{startIndex:0,batchSize:3,phoneCountry:'IN'});
      expect(replay.importId).toBe(first.importId);expect(replay.successCount).toBe(3);
      for(const startIndex of [3,6,9])await crmService.importContactsFromCSV(tenant,rows,mapping,'chunks.csv',{startIndex,batchSize:3,phoneCountry:'IN'});
      const result=await crmService.getImportStatus(tenant,first.importId);
      expect(result).toMatchObject({successCount:10,processedRecords:10,importStatus:'completed'});
      expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(10);
      expect((await pool.query('SELECT count(*)::int n FROM crm_contact_import_details')).rows[0].n).toBe(10);
    });

    it('reuses an Indian local phone contact for its reviewed +91 identity without resetting history',async()=>{
      await leadConversation(22,'whatsapp');await contact(72,null,'9000000003');
      await pool.query("UPDATE leads SET phone='9000000003' WHERE id=22; UPDATE crm_contacts SET lead_id=22,pipeline_status='won',total_replies=5,notes='Existing history' WHERE id=72");
      const result=await crmService.importContactsFromCSV(tenant,[{Name:'New name',Phone:'+919000000003'}],{Name:'firstName',Phone:'phone'},'normalized.csv',{phoneCountry:'IN',batchSize:250});
      expect(result).toMatchObject({successCount:1,errorCount:0});
      expect((await pool.query('SELECT id,phone,pipeline_status,total_replies,notes FROM crm_contacts WHERE deleted_at IS NULL')).rows).toEqual([{id:72,phone:'9000000003',pipeline_status:'won',total_replies:5,notes:'Existing history'}]);
      expect((await pool.query('SELECT created_contact_id FROM crm_contact_import_details')).rows).toEqual([{created_contact_id:72}]);
    });

    it('requires review when several existing contacts match a normalized Indian phone',async()=>{
      await contact(72,null,'9000000003');await contact(73,null,'919000000003');
      const result=await crmService.importContactsFromCSV(tenant,[{Name:'Guest',Phone:'+919000000003'}],{Name:'firstName',Phone:'phone'},'ambiguous.csv',{phoneCountry:'IN',batchSize:250});
      expect(result).toMatchObject({successCount:0,errorCount:1});
      expect((await pool.query('SELECT id FROM crm_contacts WHERE deleted_at IS NULL ORDER BY id')).rows).toEqual([{id:72},{id:73}]);
      expect((await pool.query('SELECT error_message FROM crm_contact_import_details')).rows[0].error_message).toContain('Several CRM contacts');
    });
    it('retains audience membership when a normalized email-only row reuses an existing contact',async()=>{
      await leadConversation(22,'email');await contact(72,'existing@example.test');
      await pool.query("UPDATE crm_contacts SET lead_id=22,pipeline_status='won',notes='Existing history' WHERE id=72");
      const result=await crmService.importContactsFromCSV(tenant,[{Name:'Incoming',Email:'existing@example.test'}],{Name:'firstName',Email:'email'},'existing-email.csv',{phoneCountry:'none',batchSize:250});
      expect(result).toMatchObject({successCount:1,duplicateCount:0,errorCount:0});
      expect((await pool.query('SELECT id,pipeline_status,notes FROM crm_contacts WHERE deleted_at IS NULL')).rows).toEqual([{id:72,pipeline_status:'won',notes:'Existing history'}]);
      expect((await pool.query('SELECT created_contact_id,status FROM crm_contact_import_details')).rows).toEqual([{created_contact_id:72,status:'success'}]);
    });

    it('does not reuse another business contact with the same phone', async () => {
      await leadConversation(22,'whatsapp');
      await contact(72,null,'919000000003');
      await pool.query("UPDATE leads SET business_profile_id=2,phone='919000000003' WHERE id=22; UPDATE crm_contacts SET business_profile_id=2 WHERE id=72");
      const result=await crmService.importContactsFromCSV(tenant,[{Name:'Own guest',Phone:'+919000000003'}],{Name:'firstName',Phone:'phone'},'business-phone.csv');
      expect(result).toMatchObject({successCount:1,errorCount:0});
      const receipt=(await pool.query('SELECT created_contact_id FROM crm_contact_import_details')).rows[0];
      expect(receipt.created_contact_id).not.toBe(72);
      expect((await pool.query('SELECT business_profile_id FROM crm_contacts WHERE id=$1',[receipt.created_contact_id])).rows[0].business_profile_id).toBe(1);
    });

    it.each(['instagram', 'facebook', 'whatsapp', 'email', 'sms', 'twitter', 'linkedin'])(
      'creates a lead-backed CRM contact for a new %s sender without requiring email or phone', async channel => {
        await leadConversation(11, channel);
        await pool.query('UPDATE leads SET email=NULL,phone=NULL WHERE id=11');
        const result = await inboundContactResolver.reconcile({ userId: tenant, conversationId: 11,
          channel, externalIdentifier: 'sender-11', recordReply: false });
        expect(result?.contactId).toBeGreaterThan(0);
        expect((await pool.query('SELECT lead_id,email,phone FROM crm_contacts')).rows).toEqual([
          { lead_id: 11, email: null, phone: null },
        ]);
      },
    );

    it('saves an Instagram-collected email and phone in both the lead and CRM before any match exists', async () => {
      await setupSource();
      expect(await collect('email', 'jane@example.test')).toBe('updated');
      expect(await collect('phone', phone)).toBe('updated');
      expect((await pool.query('SELECT email,phone FROM leads WHERE id=11')).rows[0]).toEqual({ email: 'jane@example.test', phone });
      expect((await pool.query('SELECT email,phone FROM crm_contacts WHERE id=71')).rows[0]).toEqual({ email: 'jane@example.test', phone });
    });

    it.each(['instagram', 'facebook', 'email', 'sms', 'whatsapp', 'twitter', 'linkedin'])(
      'merges a %s contact into the existing phone contact and keeps both channel conversations', async channel => {
        await setupSource(channel); await setupTarget();
        expect(await collect('phone', phone)).toBe('updated');
        expect((await pool.query('SELECT id,lead_id,crm_contact_id FROM outreach_conversations ORDER BY id')).rows).toEqual([
          { id: 11, lead_id: 11, crm_contact_id: 72 }, { id: 22, lead_id: 22, crm_contact_id: 72 },
        ]);
        expect((await pool.query('SELECT phone FROM leads WHERE id=11')).rows[0].phone).toBe(phone);
        expect((await pool.query('SELECT deleted_at,merged_into_contact_id FROM crm_contacts WHERE id=71')).rows[0]).toEqual({
          deleted_at: expect.any(Date), merged_into_contact_id: 72,
        });
        const target = (await pool.query('SELECT lead_id,pipeline_status,total_replies,tags,notes,first_name FROM crm_contacts WHERE id=72')).rows[0];
        expect(target).toMatchObject({ lead_id: 22, pipeline_status: 'won', total_replies: 7, first_name: 'Jane' });
        expect(target.tags.sort()).toEqual(['instagram', 'whatsapp']);
        expect(target.notes).toContain('Instagram notes');
        expect(target.notes).toContain('WhatsApp notes');
        expect((await pool.query('SELECT DISTINCT contact_id FROM crm_contact_channel_identities')).rows).toEqual([{ contact_id: 72 }]);
        expect(await collect('phone', phone)).toBe('unchanged');
        expect((await pool.query('SELECT total_replies FROM crm_contacts WHERE id=72')).rows[0].total_replies).toBe(7);
        expect((await crmService.materializeContactReference(tenant, -11))?.id).toBe(72);
        expect((await crmService.getContactById(tenant, 71))?.id).toBe(72);
      },
    );

    it('preserves and deduplicates campaign memberships when a phone merge resolves a contact', async () => {
      await pool.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,phone) VALUES
        (71,$1,1,'Source',NULL),(72,$1,1,'Survivor',$2)`, [tenant,phone]);
      await pool.query('INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES($1,1,71,12),($1,1,72,12),($1,1,71,13)', [tenant]);
      const survivor=await fixtureDb.transaction(tx => mergeContactByPhone(tx,tenant,71,phone));
      expect(survivor).toBe(72);
      expect((await pool.query('SELECT contact_id,thread_id FROM campaign_crm_contacts ORDER BY thread_id')).rows).toEqual([{contact_id:72,thread_id:12},{contact_id:72,thread_id:13}]);
      expect((await pool.query('SELECT merged_into_contact_id FROM crm_contacts WHERE id=71')).rows[0].merged_into_contact_id).toBe(72);
    });

    it('moves tickets, activities, reminders, proposals, alerts, automation logs and import receipts atomically', async () => {
      await setupSource(); await setupTarget();
      await pool.query('INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES($1,1,71,12),($1,1,72,12),($1,1,71,13)', [tenant]);
      for (const table of ['crm_activities', 'crm_activity_reminders', 'support_tickets', 'proposals', 'crm_alert_logs', 'crm_automation_logs'])
        await pool.query(`INSERT INTO ${table}(business_profile_id,user_id,contact_id) VALUES(1,$1,71)`, [tenant]);
      await pool.query('INSERT INTO crm_contact_import_details(created_contact_id) VALUES(71)');
      expect(await collect('phone', phone)).toBe('updated');
      for (const table of ['crm_activities', 'crm_activity_reminders', 'support_tickets', 'proposals', 'crm_alert_logs', 'crm_automation_logs'])
        expect((await pool.query(`SELECT DISTINCT contact_id FROM ${table}`)).rows).toEqual([{ contact_id: 72 }]);
      expect((await pool.query('SELECT created_contact_id FROM crm_contact_import_details')).rows).toEqual([{ created_contact_id: 72 }]);
      expect((await pool.query('SELECT contact_id,thread_id FROM campaign_crm_contacts ORDER BY thread_id')).rows).toEqual([{contact_id:72,thread_id:12},{contact_id:72,thread_id:13}]);
      const audit = (await pool.query("SELECT metadata FROM crm_activities WHERE type='contact_merge'")).rows[0].metadata;
      expect(audit).toEqual({ sourceContactId: 71, targetContactId: 72, identifierType: 'phone' });
      expect(JSON.stringify(audit)).not.toContain('415');
    });

    it('serializes concurrent chat collections without double-counting a merge', async () => {
      await setupSource(); await setupTarget();
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => collect('phone', phone)));
      expect(outcomes.filter(value => value === 'updated')).toHaveLength(1);
      expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT total_replies FROM crm_contacts WHERE id=72')).rows[0].total_replies).toBe(7);
    });

    it.each(['foreign user', 'another business', 'deleted'])('does not merge a contact owned by %s', async kind => {
      await setupSource(); await setupTarget();
      if (kind === 'foreign user') await pool.query('UPDATE crm_contacts SET user_id=992 WHERE id=72');
      if (kind === 'another business') await pool.query('UPDATE crm_contacts SET business_profile_id=2 WHERE id=72');
      if (kind === 'deleted') await pool.query('UPDATE crm_contacts SET deleted_at=NOW() WHERE id=72');
      expect(await collect('phone', phone)).toBe('updated');
      expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations WHERE id=11')).rows[0].crm_contact_id).toBe(71);
      expect((await pool.query('SELECT deleted_at,merged_into_contact_id FROM crm_contacts WHERE id=71')).rows[0]).toEqual({ deleted_at: null, merged_into_contact_id: null });
    });

    it('queues ambiguous phone matches for review without choosing a contact', async () => {
      await setupSource(); await setupTarget(); await contact(73, null, '+1 415 555 0199');
      expect(await collect('phone', phone)).toBe('updated');
      expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations WHERE id=11')).rows[0].crm_contact_id).toBe(71);
      expect((await pool.query('SELECT candidate_contact_ids,status FROM crm_contact_identity_conflicts')).rows).toEqual([
        { candidate_contact_ids: [71, 72, 73], status: 'pending_review' },
      ]);
    });

    it('keeps a different existing phone unchanged until the customer confirms the correction', async () => {
      await setupSource(); await setupTarget();
      await pool.query("UPDATE crm_contacts SET phone='14155550100' WHERE id=71");
      expect(await collect('phone', phone)).toBe('conflict');
      expect((await pool.query('SELECT deleted_at FROM crm_contacts WHERE id=71')).rows[0].deleted_at).toBeNull();
      expect(await contactProfileService.handleExplicitNameCorrection({ userId: tenant, conversationId: 11,
        inboundText: 'Yes', profile: null })).toMatchObject({ outcome: 'updated' });
      expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations WHERE id=11')).rows[0].crm_contact_id).toBe(72);
    });

    it('rolls back profile writes and all moved relationships when retiring the duplicate fails', async () => {
      await setupSource(); await setupTarget();
      await pool.query('ALTER TABLE crm_contacts ADD CONSTRAINT fixture_merge_reject CHECK (merged_into_contact_id IS NULL)');
      try {
        await expect(collect('phone', phone)).rejects.toThrow();
        expect((await pool.query('SELECT phone,deleted_at FROM crm_contacts WHERE id=71')).rows[0]).toEqual({ phone: null, deleted_at: null });
        expect((await pool.query('SELECT phone FROM leads WHERE id=11')).rows[0].phone).toBeNull();
        expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations WHERE id=11')).rows[0].crm_contact_id).toBe(71);
        expect((await pool.query('SELECT total_replies FROM crm_contacts WHERE id=72')).rows[0].total_replies).toBe(5);
      } finally { await pool.query('ALTER TABLE crm_contacts DROP CONSTRAINT fixture_merge_reject'); }
    });

    it('merges manual CRM creation and editing through the same shared phone rule', async () => {
      await setupTarget();
      const created = await crmService.createContact(tenant, { name: 'Jane Doe', phone, notes: 'Manual notes' });
      expect(created?.id).toBe(72);
      await contact(71, 'manual@example.test');
      const updated = await crmService.updateContact(tenant, 71, { phone });
      expect(updated?.id).toBe(72);
      expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
      expect((await crmService.materializeContactReference(tenant, 71))?.id).toBe(72);
    });

    it.each(['manual', 'import', 'workflow', 'linkedin', 'twitter'])(
      'reconciles a lead from %s and preserves its reference for later edits', async source => {
        await setupTarget();
        const lead = await LeadModel.create({ userId: tenant, phone, source, name: 'Jane Doe', status: 'new' });
        expect((await crmService.materializeContactReference(tenant, -lead.id))?.id).toBe(72);
        await LeadModel.update(lead.id, { email: 'jane@example.test' });
        expect((await pool.query('SELECT email FROM crm_contacts WHERE id=72')).rows[0].email).toBe('jane@example.test');
        expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
      },
    );

    it('imports different emails sharing an existing phone into one contact and points receipts to the survivor', async () => {
      await setupTarget();
      const result = await crmService.importContactsFromCSV(tenant,
        [{ email: 'jane@example.test', company: 'Acme', phone, ignored: 'skip me' }, { email: 'jane.other@example.test', company: 'Acme', phone, ignored: 'skip me' }],
        { email: 'email', ignored: 'skip', company: 'company', phone: 'phone' }, 'phone-duplicates.csv');
      expect(result.issues.filter(issue => issue.type === 'error')).toEqual([]);
      expect(result).toMatchObject({ successCount: 2, errorCount: 0 });
      expect((await pool.query('SELECT DISTINCT created_contact_id FROM crm_contact_import_details')).rows).toEqual([{ created_contact_id: 72 }]);
      expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
    });

    it('links an imported lead to a matching CRM-only phone contact for outreach', async () => {
      await contact(72, null, '14155550199');
      const result = await crmService.importContactsFromCSV(tenant,
        [{ email: 'phone-only-match@example.test', company: 'Acme', phone }],
        { email: 'email', company: 'company', phone: 'phone' }, 'crm-match.csv');
      expect(result).toMatchObject({ successCount: 1, errorCount: 0 });
      const row = (await pool.query(`SELECT contact.lead_id,lead.email,receipt.created_contact_id
        FROM crm_contacts contact JOIN leads lead ON lead.id=contact.lead_id
        JOIN crm_contact_import_details receipt ON receipt.created_contact_id=contact.id WHERE contact.id=72`)).rows[0];
      expect(row).toMatchObject({ email: 'phone-only-match@example.test', created_contact_id: 72 });
      expect(row.lead_id).toBeGreaterThan(0);
    });

    it('links an updated CRM-only contact to a lead and retains the import receipt on retry', async () => {
      await contact(72, 'updated@example.test');
      await pool.query("UPDATE crm_contacts SET pipeline_status='won',status='won' WHERE id=72");
      const rows = [{ email: 'updated@example.test', company: 'Updated company', website: 'https://example.test', linkedin: 'https://linkedin.com/in/test' }];
      const mapping = { email: 'email', company: 'company', website: 'website', linkedin: 'linkedinUrl' };
      const first = await crmService.importContactsFromCSV(tenant, rows, mapping, 'updated.csv', { updateExisting: true });
      const replay = await crmService.importContactsFromCSV(tenant, rows, mapping, 'updated.csv', { updateExisting: true });
      expect(first).toMatchObject({ successCount: 1, errorCount: 0 });
      expect(replay.importId).toBe(first.importId);
      const row = (await pool.query(`SELECT contact.lead_id,lead.email,lead.website,lead.linkedin_url,lead.status AS lead_status,lead.lead_status AS lead_lifecycle,receipt.created_contact_id,receipt.status
        FROM crm_contacts contact JOIN leads lead ON lead.id=contact.lead_id
        JOIN crm_contact_import_details receipt ON receipt.created_contact_id=contact.id WHERE contact.id=72`)).rows[0];
      expect(row).toMatchObject({ email: 'updated@example.test', website: 'https://example.test', linkedin_url: 'https://linkedin.com/in/test', lead_status: 'converted', lead_lifecycle: 'converted', created_contact_id: 72, status: 'success' });
      expect(row.lead_id).toBeGreaterThan(0);
      expect((await pool.query("SELECT count(*)::int n FROM leads WHERE email='updated@example.test'")).rows[0].n).toBe(1);
    });

    it('reuses an existing lead when updating a CRM-only contact', async () => {
      await contact(72, 'existing-lead@example.test');
      const lead = await LeadModel.create({ userId: tenant, source: 'manual', status: 'new', email: 'existing-lead@example.test', name: 'Existing name', company: 'Old company' });
      const result = await crmService.importContactsFromCSV(tenant,
        [{ email: 'existing-lead@example.test', company: 'Acme', phone, status: 'won' }],
        { email: 'email', company: 'company', phone: 'phone', status: 'status' }, 'existing-lead.csv', { updateExisting: true });
      expect(result).toMatchObject({ successCount: 1, errorCount: 0 });
      expect((await pool.query('SELECT lead_id FROM crm_contacts WHERE id=72')).rows[0].lead_id).toBe(lead.id);
      expect((await pool.query("SELECT count(*)::int n FROM leads WHERE email='existing-lead@example.test'")).rows[0].n).toBe(1);
      expect((await pool.query('SELECT name,company,phone,status,lead_status FROM leads WHERE id=$1', [lead.id])).rows[0]).toEqual({ name: 'Existing name', company: 'Acme', phone, status: 'converted', lead_status: 'converted' });
    });

    it('syncs a surviving lead when an updated CRM-only contact merges by phone', async () => {
      await setupTarget();
      await contact(71, 'merged-import@example.test');
      const result = await crmService.importContactsFromCSV(tenant,
        [{ email: 'merged-import@example.test', company: 'Updated via import', phone }],
        { email: 'email', company: 'company', phone: 'phone' }, 'merged-import.csv', { updateExisting: true });
      expect(result).toMatchObject({ successCount: 1, errorCount: 0 });
      expect((await pool.query('SELECT lead_id FROM crm_contacts WHERE id=72')).rows[0].lead_id).toBe(22);
      expect((await pool.query('SELECT company,phone FROM leads WHERE id=22')).rows[0]).toEqual({ company: 'Updated via import', phone });
      expect((await pool.query('SELECT created_contact_id FROM crm_contact_import_details')).rows[0].created_contact_id).toBe(72);
    });

    it('rolls back reused lead changes when an updated-contact receipt fails', async () => {
      await contact(72, 'reused-failure@example.test');
      const lead = await LeadModel.create({ userId: tenant, source: 'manual', status: 'new', email: 'reused-failure@example.test', company: 'Original' });
      await pool.query("ALTER TABLE crm_contact_import_details ADD CONSTRAINT fixture_reused_receipt_reject CHECK (status='failed')");
      try {
        const result = await crmService.importContactsFromCSV(tenant,
          [{ email: 'reused-failure@example.test', company: 'Changed', phone }],
          { email: 'email', company: 'company', phone: 'phone' }, 'reused-failure.csv', { updateExisting: true });
        expect(result).toMatchObject({ successCount: 0, errorCount: 1 });
        expect((await pool.query('SELECT lead_id FROM crm_contacts WHERE id=72')).rows[0].lead_id).toBeNull();
        expect((await pool.query('SELECT company,phone FROM leads WHERE id=$1', [lead.id])).rows[0]).toEqual({ company: 'Original', phone: null });
      } finally { await pool.query('ALTER TABLE crm_contact_import_details DROP CONSTRAINT fixture_reused_receipt_reject'); }
    });

    it('rolls back a new lead when an updated-contact import receipt fails', async () => {
      await contact(72, 'receipt-failure@example.test');
      await pool.query("ALTER TABLE crm_contact_import_details ADD CONSTRAINT fixture_updated_receipt_reject CHECK (status='failed')");
      try {
        const result = await crmService.importContactsFromCSV(tenant,
          [{ email: 'receipt-failure@example.test', company: 'Acme' }],
          { email: 'email', company: 'company' }, 'receipt-failure.csv', { updateExisting: true });
        expect(result).toMatchObject({ successCount: 0, errorCount: 1 });
        expect((await pool.query('SELECT lead_id FROM crm_contacts WHERE id=72')).rows[0].lead_id).toBeNull();
        expect((await pool.query("SELECT count(*)::int n FROM leads WHERE email='receipt-failure@example.test'")).rows[0].n).toBe(0);
      } finally { await pool.query('ALTER TABLE crm_contact_import_details DROP CONSTRAINT fixture_updated_receipt_reject'); }
    });

    it('matches a previously unconverted manual lead before creating another active contact', async () => {
      await leadConversation(22, 'whatsapp');
      await pool.query("UPDATE leads SET phone='14155550199',source='manual',first_name='Jane' WHERE id=22");
      const created = await crmService.createContact(tenant, { phone });
      expect(created?.leadId).toBe(22);
      expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations WHERE id=22')).rows[0].crm_contact_id).toBe(created.id);
    });

    it('fills missing CRM phone data from an existing generated lead and then merges it', async () => {
      await setupSource(); await setupTarget();
      await pool.query('UPDATE leads SET phone=$1 WHERE id=11', [phone]);
      expect((await crmService.syncLeadContact(tenant, 11))?.id).toBe(72);
    });

    it('preserves source deal value, currency, assignment and scoring when the survivor lacks them', async () => {
      await setupSource(); await setupTarget();
      await pool.query("UPDATE crm_contacts SET deal_value=15000,currency='INR',assigned_to=991,fit_score=92 WHERE id=71");
      await collect('phone', phone);
      expect((await pool.query('SELECT deal_value,currency,assigned_to,fit_score FROM crm_contacts WHERE id=72')).rows[0]).toEqual({
        deal_value: '15000.00', currency: 'INR', assigned_to: 991, fit_score: 92,
      });
    });

    it('rolls back a manual lead edit when CRM reconciliation fails', async () => {
      await setupSource(); await setupTarget();
      await pool.query('ALTER TABLE crm_contacts ADD CONSTRAINT fixture_merge_reject CHECK (merged_into_contact_id IS NULL)');
      try {
        await expect(LeadModel.update(11, { phone })).rejects.toThrow();
        expect((await pool.query('SELECT phone FROM leads WHERE id=11')).rows[0].phone).toBeNull();
        expect((await pool.query('SELECT phone FROM crm_contacts WHERE id=71')).rows[0].phone).toBeNull();
      } finally { await pool.query('ALTER TABLE crm_contacts DROP CONSTRAINT fixture_merge_reject'); }
    });

    it('does not count CSV rows whose import receipts fail to commit', async () => {
      await setupTarget();
      await pool.query("ALTER TABLE crm_contact_import_details ADD CONSTRAINT fixture_receipt_reject CHECK (status='failed')");
      try {
        const result = await crmService.importContactsFromCSV(tenant,
          [{ email: 'jane@example.test', company: 'Acme', phone }],
          { email: 'email', company: 'company', phone: 'phone' }, 'failed-receipt.csv');
        expect(result).toMatchObject({ successCount: 0, errorCount: 1 });
        expect((await pool.query("SELECT count(*)::int n FROM leads WHERE email='jane@example.test'")).rows[0].n).toBe(0);
        expect((await pool.query('SELECT email FROM crm_contacts WHERE id=72')).rows[0].email).toBeNull();
      } finally { await pool.query('ALTER TABLE crm_contact_import_details DROP CONSTRAINT fixture_receipt_reject'); }
    });

    it('merges new manual/channel/import records at the contact limit without a temporary active duplicate', async () => {
      await setupTarget();
      // Equivalent to the immediate active-contact capacity check in migration 302.
      await pool.query(`CREATE FUNCTION fixture_contact_cap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.deleted_at IS NULL AND (SELECT count(*) FROM crm_contacts WHERE deleted_at IS NULL AND id<>NEW.id)>=1
          THEN RAISE EXCEPTION 'fixture contact capacity exceeded'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fixture_contact_cap BEFORE INSERT OR UPDATE OF deleted_at ON crm_contacts
          FOR EACH ROW EXECUTE FUNCTION fixture_contact_cap()`);
      try {
        expect((await crmService.createContact(tenant, { phone }))?.id).toBe(72);
        const lead = await LeadModel.create({ userId: tenant, phone, source: 'manual', status: 'new' });
        expect((await crmService.materializeContactReference(tenant, -lead.id))?.id).toBe(72);
        await leadConversation(11, 'instagram');
        await pool.query('UPDATE leads SET phone=$1 WHERE id=11', [phone]);
        expect((await inboundContactResolver.reconcile({ userId: tenant, conversationId: 11,
          channel: 'instagram', externalIdentifier: 'sender-11', recordReply: false }))?.contactId).toBe(72);
        const imported = await crmService.importContactsFromCSV(tenant,
          [{ email: 'jane@example.test', company: 'Acme', phone }],
          { email: 'email', company: 'company', phone: 'phone' }, 'capacity-phone.csv');
        expect(imported.issues.filter(issue => issue.type === 'error')).toEqual([]);
        expect(imported).toMatchObject({ successCount: 1, errorCount: 0 });
        expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
      } finally {
        await pool.query('DROP TRIGGER fixture_contact_cap ON crm_contacts; DROP FUNCTION fixture_contact_cap()');
      }
    });

    it.each(['virtual lead', 'verified phone identity'])('merges an existing %s at the active contact cap', async kind => {
      if (kind === 'virtual lead') {
        await setupSource();
        await leadConversation(22, 'whatsapp');
        await pool.query("UPDATE leads SET phone='14155550199',status='negotiations' WHERE id=22");
      } else {
        await setupTarget();
        await pool.query('UPDATE crm_contacts SET phone=NULL WHERE id=72');
        await pool.query(`INSERT INTO crm_contact_channel_identities(user_id,contact_id,lead_id,channel,identifier_type,identifier_fingerprint,verification_level)
          VALUES($1,72,22,'whatsapp','phone',$2,'provider')`, [tenant, restrictedBindingDigest(tenant, 'crm-identity:phone', '14155550199')]);
      }
      await pool.query(`CREATE FUNCTION fixture_contact_cap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.deleted_at IS NULL AND (SELECT count(*) FROM crm_contacts WHERE deleted_at IS NULL AND id<>NEW.id)>=1
          THEN RAISE EXCEPTION 'fixture contact capacity exceeded'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fixture_contact_cap BEFORE INSERT OR UPDATE OF deleted_at ON crm_contacts
          FOR EACH ROW EXECUTE FUNCTION fixture_contact_cap()`);
      try {
        if (kind === 'virtual lead') {
          expect(await collect('phone', phone)).toBe('updated');
          const target = (await pool.query('SELECT id,pipeline_status FROM crm_contacts WHERE deleted_at IS NULL')).rows[0];
          expect(target.pipeline_status).toBe('negotiations');
          expect((await pool.query('SELECT crm_contact_id FROM outreach_conversations WHERE id=11')).rows[0].crm_contact_id).toBe(target.id);
        } else expect((await crmService.createContact(tenant, { phone }))?.id).toBe(72);
        expect((await pool.query('SELECT count(*)::int n FROM crm_contacts WHERE deleted_at IS NULL')).rows[0].n).toBe(1);
      } finally {
        await pool.query('DROP TRIGGER fixture_contact_cap ON crm_contacts; DROP FUNCTION fixture_contact_cap()');
      }
    });
  });

});
