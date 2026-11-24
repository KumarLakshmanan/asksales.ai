/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const connectionString = process.env.ASSISTANT_GATE_QA_DATABASE_URL;
const local = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
let schema: string;
let catalog: any;
const provider = jest.fn<() => Promise<string>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (query: SQL) => database.execute(query) } }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({ assistantCatalog: async () => catalog, assistantPlatformReadiness: async () => ({ classifier: true, privacyVault: true }) }));
const { assertCustomerDeliveryReady, withCustomerDeliveryReceipt } = await import('../services/assistants/CustomerDeliveryGate.js');
// @ts-expect-error JavaScript migrations run through the production migration runner.
const migration = await import('../migrations/571_hold_unreviewed_customer_delivery.js');
const uuid = '11111111-1111-4111-8111-111111111111';
const account = 'sales@example.test';
const scope = <T>(work: () => T, businessProfileId = 7) => withBusinessScope({ userId: 9, businessProfileId }, work);
const config = () => ({ ...emptyAssistantDraft(), name: 'Reviewed sales assistant', agentType: 'general_service', replyModel: { provider: 'test', model: 'approved' },
  bindings: [{ channel: 'email', surface: 'private', accountId: account }], knowledge: { mode: 'none', ids: [] }, documents: { mode: 'none', ids: [] }, galleries: { mode: 'none', ids: [] },
  playbooks: { mode: 'none', assignments: [] }, followUps: { mode: 'none', sequences: [] }, tools: { mode: 'none', names: [], approvalRequired: [] } });
const deliver = () => scope(async () => {
  await assertCustomerDeliveryReady({ userId: 9, channel: 'email', accountId: account });
  return provider();
});
local('real PostgreSQL assistant assignment and legacy unsent hold', () => {
  beforeAll(async () => {
    if (!/^postgresql:\/\/audit:[^@]*@127\.0\.0\.1:55446\/assistant_gate_qa$/.test(connectionString || ''))
      throw new Error('Only the isolated synthetic assistant gate database is permitted.');
    client = new Client({ connectionString }); await client.connect();
    schema = `assistant_gate_${randomBytes(6).toString('hex')}`;
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    database = drizzle(client);
    await client.query(`CREATE TABLE outreach_assistants(id uuid PRIMARY KEY,user_id int,business_profile_id int,state text,published_revision int);
      CREATE TABLE outreach_assistant_revisions(assistant_id uuid,revision int,configuration jsonb);
      CREATE TABLE outreach_assistant_bindings(id int,user_id int,business_profile_id int,assistant_id uuid,revision int,version int,channel text,surface text,account_id text,enabled boolean);
      CREATE TABLE outreach_jobs(id int,status text,is_dead_letter boolean,error text,metadata jsonb,updated_at timestamptz,external_message_id text);
      CREATE TABLE outreach_messages(id int,direction text,status text,error_message text,metadata jsonb,updated_at timestamptz,provider_call_state text,manual_review_required boolean,provider_message_id text,external_message_id text);
      CREATE TABLE support_delivery_outbox(id int,status text,next_attempt_at timestamptz,lease_expires_at timestamptz,last_error text,updated_at timestamptz,attempt_count int,provider_message_id text,payload jsonb);`);
  });
  beforeEach(async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'true'; delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    provider.mockReset().mockResolvedValue('mock-receipt');
    catalog = { presets: [{ agentType: 'general_service' }], accounts: [{ channel: 'email', surface: 'private', accountId: account, connected: true }],
      models: [{ provider: 'test', model: 'approved', controls: [] }], knowledge: [], documents: [], galleries: [], playbooks: [], templates: [], tools: [] };
    await client.query('TRUNCATE outreach_assistants,outreach_assistant_revisions,outreach_assistant_bindings,outreach_jobs,outreach_messages,support_delivery_outbox');
    await client.query("INSERT INTO outreach_assistants VALUES($1,9,7,'live',3);", [uuid]);
    await client.query('INSERT INTO outreach_assistant_revisions VALUES($1,3,$2::jsonb)', [uuid, JSON.stringify(config())]);
    await client.query("INSERT INTO outreach_assistant_bindings VALUES(4,9,7,$1,3,2,'email','private',$2,true)", [uuid, account]);
  });
  afterAll(async () => {
    delete process.env.SUPPORT_ASSISTANTS_ENABLED;
    if (client) { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); }
  });
  it('allows a valid published assignment and executes only the mock transport', async () => {
    expect(await deliver()).toBe('mock-receipt'); expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong business', 'wrong account', 'wrong channel', 'wrong surface', 'wrong owner', 'disabled', 'paused', 'draft', 'stale revision', 'missing published config'])('blocks %s using persisted SQL data', async reason => {
    if (reason === 'wrong business') await client.query('UPDATE outreach_assistant_bindings SET business_profile_id=8');
    if (reason === 'wrong account') await client.query("UPDATE outreach_assistant_bindings SET account_id='other@example.test'");
    if (reason === 'wrong channel') await client.query("UPDATE outreach_assistant_bindings SET channel='facebook'");
    if (reason === 'wrong surface') await client.query("UPDATE outreach_assistant_bindings SET surface='public_comment'");
    if (reason === 'wrong owner') await client.query('UPDATE outreach_assistant_bindings SET user_id=10');
    if (reason === 'disabled') await client.query('UPDATE outreach_assistant_bindings SET enabled=false');
    if (reason === 'paused') await client.query("UPDATE outreach_assistants SET state='paused'");
    if (reason === 'draft') await client.query("UPDATE outreach_assistants SET state='draft',published_revision=NULL");
    if (reason === 'stale revision') await client.query('UPDATE outreach_assistants SET published_revision=4');
    if (reason === 'missing published config') await client.query('DELETE FROM outreach_assistant_revisions');
    await expect(deliver()).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', deliveryAttempted: false });
    expect(provider).not.toHaveBeenCalled();
  });
  it('checks binding versions after queue admission without borrowing the new assignment', async () => {
    const receipt = await scope(() => assertCustomerDeliveryReady({ userId: 9, channel: 'email', accountId: account }));
    await client.query('UPDATE outreach_assistant_bindings SET version=3');
    await expect(scope(() => withCustomerDeliveryReceipt(receipt, deliver))).rejects.toMatchObject({ reason: 'assignment_changed' });
    expect(provider).not.toHaveBeenCalled();
  });
  it('holds only historical unsent work, preserves receipts/uncertainty and never replays on rollback/setup', async () => {
    await client.query(`INSERT INTO outreach_jobs VALUES
      (1,'pending',false,NULL,'{}',NOW(),NULL),(2,'sent',false,NULL,'{}',NOW(),'confirmed'),
      (3,'pending',false,NULL,'{"providerCallStarted":true}',NOW(),NULL),
      (4,'pending',false,NULL,'{"deliveryReview":{"assistant":{"bindingId":4}}}',NOW(),NULL);
      INSERT INTO outreach_messages VALUES
      (1,'outbound','queued',NULL,'{}',NOW(),'not_started',false,NULL,NULL),
      (2,'outbound','sent',NULL,'{}',NOW(),'confirmed',false,'confirmed',NULL),
      (3,'outbound','sending',NULL,'{}',NOW(),'started',false,NULL,NULL),
      (4,'outbound','manual_review',NULL,'{}',NOW(),'unknown',true,NULL,NULL),
      (5,'inbound','pending',NULL,'{}',NOW(),'not_started',false,NULL,NULL);
      INSERT INTO support_delivery_outbox VALUES
      (1,'pending',NOW(),NULL,NULL,NOW(),0,NULL,'{}'),
      (2,'uncertain',NULL,NULL,NULL,NOW(),1,NULL,'{}'),
      (3,'sent',NULL,NULL,NULL,NOW(),1,'confirmed','{}');`);
    await client.query('BEGIN');
    await migration.up(client); await migration.up(client);
    await client.query('COMMIT');
    expect((await client.query('SELECT id,status FROM outreach_jobs ORDER BY id')).rows).toEqual([
      { id: 1, status: 'setup_required' }, { id: 2, status: 'sent' }, { id: 3, status: 'pending' }, { id: 4, status: 'pending' }]);
    expect((await client.query('SELECT status FROM outreach_messages ORDER BY id')).rows.map(r => r.status)).toEqual(['setup_required','sent','sending','manual_review','pending']);
    expect((await client.query('SELECT status FROM support_delivery_outbox ORDER BY id')).rows.map(r => r.status)).toEqual(['setup_required','uncertain','sent']);
    await migration.down(client);
    await scope(() => assertCustomerDeliveryReady({ userId: 9, channel: 'email', accountId: account }));
    expect((await client.query('SELECT status FROM outreach_jobs WHERE id=1')).rows[0].status).toBe('setup_required');
    expect(provider).not.toHaveBeenCalled();
  });
});
