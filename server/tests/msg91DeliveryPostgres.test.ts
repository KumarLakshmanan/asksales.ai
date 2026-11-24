import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const localPostgres = process.env.MSG91_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase;
const proxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    const value = database[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (value: string) => ({ redactedText: value.replace(/\+?[0-9]{7,}/g, '[PHONE]') }),
}));
const { processMSG91DeliveryReports } = await import('../services/MSG91DeliveryService.js');
// @ts-expect-error Migrations are JavaScript modules used by the custom runner.
const migration = await import('../migrations/313_msg91_provider_verification.js');
const inProfile = <T>(profile: number, work: () => T) => withBusinessScope({ userId: 9, businessProfileId: profile }, work);
const report = { requestId: 'receipt-42', senderId: 'ABCDEF', telNum: '919876543210', status: '1', deliveryTime: '2026-09-29T06:30:00Z' };

localPostgres('MSG91 delivery receipts in isolated PostgreSQL with business RLS', () => {
  let admin: Pool;
  let fixtures: Pool;
  let runtime: Pool;
  let schema: string;

  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true, quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('MSG91 QA requires local PostgreSQL.');
    const connection = {
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || process.env.DB_DATABASE,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000,
    };
    schema = `msg91_delivery_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixtures = new Pool({ ...connection, max: 1, options: `-c search_path=${schema},pg_catalog` });
    runtime = createBusinessScopedPool(new Pool({ ...connection, max: 3, options: `-c search_path=${schema},pg_catalog` }));
    database = drizzle(runtime);
    await fixtures.query(`
      CREATE TABLE leads (id integer PRIMARY KEY, user_id integer, business_profile_id integer, phone text);
      CREATE TABLE outreach_conversations (id integer PRIMARY KEY, user_id integer, business_profile_id integer, lead_id integer,
        channel text, provider_account_id text, external_thread_id text);
      CREATE TABLE outreach_messages (id integer PRIMARY KEY, user_id integer, business_profile_id integer, conversation_id integer,
        direction text, provider_message_id text, external_message_id text, provider_account_id text, status text,
        delivered_at timestamp, failed_at timestamp, error_message text, updated_at timestamp, metadata jsonb);
      CREATE TABLE sent_messages (id integer PRIMARY KEY, user_id integer, business_profile_id integer, lead_id integer, channel text,
        message_id text, status text, delivery_status text, delivered_at timestamp, updated_at timestamp, campaign_id integer, sequence_step integer);
      CREATE TABLE outreach_jobs (id integer PRIMARY KEY, user_id integer, business_profile_id integer, campaign_id integer,
        lead_id integer, channel text, external_message_id text, metadata jsonb);
      CREATE TABLE webhook_events (id serial PRIMARY KEY, user_id integer, business_profile_id integer, platform text, event_type text,
        payload jsonb, signature_valid boolean, processed boolean, error text, created_at timestamp DEFAULT now());
      CREATE TABLE provider_verification_runs (id serial PRIMARY KEY, platform text CHECK (platform IN ('facebook','instagram','whatsapp','meta_ads','google_ads','youtube','gmail','resend')));
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
    `);
    await migration.up(fixtures);
    for (const table of ['leads', 'outreach_conversations', 'outreach_messages', 'sent_messages', 'outreach_jobs', 'webhook_events']) {
      await fixtures.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY business_isolation ON ${table} FOR ALL
        USING (current_user <> 'salesmarketing_business_runtime' OR (
          business_profile_id = NULLIF(current_setting('app.business_profile_id', true), '')::integer
          AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer))
        WITH CHECK (current_user <> 'salesmarketing_business_runtime' OR (
          business_profile_id = NULLIF(current_setting('app.business_profile_id', true), '')::integer
          AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer));`);
    }
  });

  afterAll(async () => {
    await runtime?.end();
    await fixtures?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await fixtures.query(`TRUNCATE webhook_events, provider_verification_runs, outreach_messages, outreach_conversations, sent_messages, outreach_jobs, leads RESTART IDENTITY;
      INSERT INTO leads VALUES (1,9,101,'9876543210'),(2,9,102,'9876543210'),(3,19,201,'9876543210');
      INSERT INTO outreach_conversations VALUES (1,9,101,1,'sms','ABCDEF','919876543210'),(2,9,102,2,'sms','ABCDEF','919876543210'),(3,19,201,3,'sms','ABCDEF','919876543210');
      INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,provider_message_id,provider_account_id,status)
        VALUES (1,9,101,1,'outbound','receipt-42','ABCDEF','sent'),(2,9,102,2,'outbound','receipt-42','ABCDEF','sent'),(3,19,201,3,'outbound','receipt-42','ABCDEF','sent');
      INSERT INTO sent_messages(id,user_id,business_profile_id,lead_id,channel,message_id,status,delivery_status)
        VALUES (1,9,101,1,'sms','receipt-42','sent','sent'),(2,9,102,2,'sms','receipt-42','sent','sent'),(3,19,201,3,'sms','receipt-42','sent','sent');`);
  });

  it('updates both SMS projections in the callback profile and leaves other businesses untouched', async () => {
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toEqual({ matched: 1, unmatched: 0, duplicates: 0 });
    expect((await fixtures.query('SELECT status FROM outreach_messages ORDER BY id')).rows.map(row => row.status)).toEqual(['delivered', 'sent', 'sent']);
    expect((await fixtures.query('SELECT delivery_status FROM sent_messages ORDER BY id')).rows.map(row => row.delivery_status)).toEqual(['delivered', 'sent', 'sent']);
    const event = (await fixtures.query('SELECT * FROM webhook_events')).rows[0];
    expect(event).toMatchObject({ user_id: 9, business_profile_id: 101, platform: 'msg91', event_type: 'sms_delivery_delivered', processed: true });
    expect(event.payload.phone).toBe('[REDACTED_PII]');
    expect(event.payload.receiptKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await fixtures.query("SELECT to_char(delivered_at,'YYYY-MM-DD HH24:MI:SS') AS delivered FROM outreach_messages WHERE id=1")).rows[0].delivered).toBe('2026-09-29 06:30:00');
  });

  it('deduplicates simultaneous deliveries and preserves delivered status after late failures or sent updates', async () => {
    const repeated = await Promise.all([1, 2].map(() => inProfile(101, () => processMSG91DeliveryReports(9, report))));
    expect(repeated.reduce((total, item) => total + item.duplicates, 0)).toBe(1);
    await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, status: '2', failureReason: 'Delivery failed' }));
    await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, status: '0' }));
    expect((await fixtures.query('SELECT status,error_message,failed_at FROM outreach_messages WHERE id=1')).rows[0]).toMatchObject({ status: 'delivered', error_message: null, failed_at: null });
    expect((await fixtures.query('SELECT delivery_status FROM sent_messages WHERE id=1')).rows[0].delivery_status).toBe('delivered');
    expect((await fixtures.query('SELECT COUNT(*)::integer AS n FROM webhook_events')).rows[0].n).toBe(3);
  });

  it('keeps failures from regressing to sent and allows a later delivered report', async () => {
    await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, status: '2', failureReason: 'Failed for +919876543210' }));
    await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, status: '0' }));
    expect((await fixtures.query('SELECT status,error_message FROM outreach_messages WHERE id=1')).rows[0]).toMatchObject({ status: 'failed', error_message: 'Failed for [PHONE]' });
    await inProfile(101, () => processMSG91DeliveryReports(9, report));
    expect((await fixtures.query('SELECT status,error_message,failed_at FROM outreach_messages WHERE id=1')).rows[0]).toMatchObject({ status: 'delivered', error_message: null, failed_at: null });
  });

  it('requires the exact receipt, recipient, and bound sender before updating inbox messages', async () => {
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, telNum: '919876543211' }))).toMatchObject({ matched: 0, unmatched: 1 });
    // Remove the legacy projection, which has no sender column, to test the stronger inbox binding.
    await fixtures.query('DELETE FROM sent_messages WHERE id=1');
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, senderId: 'OTHERX' }))).toMatchObject({ matched: 0, unmatched: 1 });
    expect((await fixtures.query('SELECT status FROM outreach_messages WHERE id=1')).rows[0].status).toBe('sent');
  });

  it('reprocesses a callback that arrived before its outbound receipt was persisted', async () => {
    const early = { ...report, requestId: 'early-receipt' };
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, early))).toMatchObject({ unmatched: 1 });
    await fixtures.query("UPDATE outreach_messages SET provider_message_id='early-receipt' WHERE id=1");
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, early))).toEqual({ matched: 1, unmatched: 0, duplicates: 0 });
    const events = (await fixtures.query('SELECT processed,error FROM webhook_events')).rows;
    expect(events).toEqual([{ processed: true, error: null }]);
  });

  it('matches the phone used to send the SMS after the CRM contact phone changes', async () => {
    await fixtures.query("DELETE FROM sent_messages WHERE id=1; UPDATE leads SET phone='9876543211' WHERE id=1");
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, telNum: '919876543211' }))).toMatchObject({ matched: 0, unmatched: 1 });
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toMatchObject({ matched: 1, unmatched: 0 });
    expect((await fixtures.query('SELECT status FROM outreach_messages WHERE id=1')).rows[0].status).toBe('delivered');
  });

  it('matches campaign history against the reviewed recipient and sender after contact changes', async () => {
    await fixtures.query(`DELETE FROM outreach_messages WHERE id=1;
      UPDATE leads SET phone='9876543211' WHERE id=1;
      UPDATE sent_messages SET campaign_id=42,sequence_step=1 WHERE id=1;
      INSERT INTO outreach_jobs VALUES (1,9,101,42,1,'sms','receipt-42',
        '{"deliveryReview":{"version":1,"channel":"sms","stepNumber":1,"providerAccountId":"ABCDEF","recipient":"919876543210"}}');`);
    for (const wrong of [{ ...report, telNum: '919876543211' }, { ...report, senderId: 'OTHERX' }]) {
      expect(await inProfile(101, () => processMSG91DeliveryReports(9, wrong))).toMatchObject({ matched: 0, unmatched: 1 });
    }
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toMatchObject({ matched: 1, unmatched: 0 });
    expect((await fixtures.query('SELECT delivery_status FROM sent_messages WHERE id=1')).rows[0].delivery_status).toBe('delivered');
    expect((await fixtures.query('SELECT delivery_status FROM sent_messages WHERE id=2')).rows[0].delivery_status).toBe('sent');
  });

  it('retries campaign callbacks until their reviewed provider receipt is persisted', async () => {
    await fixtures.query(`DELETE FROM outreach_messages WHERE id=1;
      UPDATE sent_messages SET campaign_id=42,sequence_step=1 WHERE id=1;
      INSERT INTO outreach_jobs VALUES (1,9,101,42,1,'sms',NULL,
        '{"deliveryReview":{"version":1,"channel":"sms","stepNumber":1,"providerAccountId":"ABCDEF","recipient":"919876543210"}}');`);
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toMatchObject({ matched: 0, unmatched: 1 });
    await fixtures.query("UPDATE outreach_jobs SET external_message_id='receipt-42' WHERE id=1");
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toEqual({ matched: 1, unmatched: 0, duplicates: 0 });
  });

  it('rejects a campaign receipt snapshot belonging to another business or sequence step', async () => {
    await fixtures.query(`DELETE FROM outreach_messages WHERE id=1;
      UPDATE sent_messages SET campaign_id=42,sequence_step=1 WHERE id=1;
      INSERT INTO outreach_jobs VALUES (1,9,102,42,1,'sms','receipt-42',
        '{"deliveryReview":{"version":1,"channel":"sms","stepNumber":1,"providerAccountId":"ABCDEF","recipient":"919876543210"}}');`);
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toMatchObject({ matched: 0, unmatched: 1 });
    await fixtures.query(`UPDATE outreach_jobs SET business_profile_id=101,metadata=jsonb_set(metadata,'{deliveryReview,stepNumber}','2') WHERE id=1`);
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toMatchObject({ matched: 0, unmatched: 1 });
    expect((await fixtures.query('SELECT delivery_status FROM sent_messages WHERE id=1')).rows[0].delivery_status).toBe('sent');
  });

  it('keeps each message recipient and sender independent of later conversation changes', async () => {
    await fixtures.query(`DELETE FROM sent_messages WHERE id=1;
      UPDATE leads SET phone='9876543211' WHERE id=1;
      UPDATE outreach_conversations SET external_thread_id='919876543211',provider_account_id='OTHERX' WHERE id=1;
      UPDATE outreach_messages SET metadata='{"smsRecipient":"919876543210"}' WHERE id=1`);
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, telNum: '919876543211' }))).toMatchObject({ matched: 0, unmatched: 1 });
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, { ...report, senderId: 'OTHERX' }))).toMatchObject({ matched: 0, unmatched: 1 });
    expect(await inProfile(101, () => processMSG91DeliveryReports(9, report))).toMatchObject({ matched: 1, unmatched: 0 });
    expect((await fixtures.query('SELECT status FROM outreach_messages WHERE id=1')).rows[0].status).toBe('delivered');
  });

  it('validates the entire batch before changing statuses', async () => {
    await expect(inProfile(101, () => processMSG91DeliveryReports(9, [report, { ...report, status: 'unknown' }]))).rejects.toMatchObject({ status: 400 });
    expect((await fixtures.query('SELECT status FROM outreach_messages WHERE id=1')).rows[0].status).toBe('sent');
    expect((await fixtures.query('SELECT id FROM webhook_events')).rows).toEqual([]);
  });

  it('rolls back status updates when the durable receipt cannot be committed', async () => {
    await fixtures.query(`CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
      CREATE TRIGGER reject_event BEFORE INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION reject_event();`);
    try {
      await expect(inProfile(101, () => processMSG91DeliveryReports(9, report))).rejects.toThrow();
      expect((await fixtures.query('SELECT status FROM outreach_messages WHERE id=1')).rows[0].status).toBe('sent');
      expect((await fixtures.query('SELECT delivery_status FROM sent_messages WHERE id=1')).rows[0].delivery_status).toBe('sent');
    } finally { await fixtures.query('DROP TRIGGER reject_event ON webhook_events; DROP FUNCTION reject_event()'); }
  });

  it('rolls the migration back without deleting historical MSG91 verification evidence', async () => {
    await fixtures.query("INSERT INTO provider_verification_runs(platform) VALUES('msg91')");
    await migration.down(fixtures);
    expect((await fixtures.query('SELECT platform FROM provider_verification_runs')).rows).toEqual([{ platform: 'msg91' }]);
    await expect(fixtures.query("INSERT INTO provider_verification_runs(platform) VALUES('msg91')")).rejects.toThrow();
    await migration.up(fixtures);
    await fixtures.query("INSERT INTO provider_verification_runs(platform) VALUES('msg91')");
  });
});
