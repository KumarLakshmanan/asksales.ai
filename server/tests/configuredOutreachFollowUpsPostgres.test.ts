import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (query: SQL) => database.execute(query) } }));
jest.unstable_mockModule('../queues/index.js', () => ({ queueRegistry: {}, QUEUE_NAMES: {} }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: jest.fn() }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
const errors = jest.fn();
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: errors } }));
const { cronService } = await import('../services/cronService.js');
const { getConfiguredFollowUpDeliveryBinding } = await import('../services/outreach/ConfiguredFollowUpDeliveryService.js');
const reader = cronService as unknown as {
  getPendingFollowUpsForChannel: (userId: number, steps: Array<{ id: string; delayMinutes: number; enabled: boolean }>, channel: 'email' | 'sms') => Promise<Array<{ messageId: number; useSavedFollowUpSettings?: boolean }>>;
};
const periods = [{ id: '1', delayMinutes: 5, enabled: true }];

suite('saved platform follow-ups against isolated PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname))
      throw new Error('Explicit local QA database required');
    client = new Client({ connectionString });
    await client.connect();
    await client.query('SET search_path TO pg_temp, pg_catalog');
    database = drizzle(client);
    // TEMP-only resolution prevents an incomplete fixture from reading app data.
    await client.query(`
      CREATE TEMP TABLE outreach_conversations(id integer PRIMARY KEY,user_id integer,lead_id integer,channel text,external_thread_id text,integration_provider text,provider_account_id text,automation_mode text,session_ended_at timestamp);
      CREATE TEMP TABLE outreach_messages(id integer PRIMARY KEY,conversation_id integer,user_id integer,direction text,message_kind text,
        follow_up_origin_message_id integer,follow_up_cancelled_at timestamp,metadata jsonb,status text,sent_at timestamp,
        created_at timestamp DEFAULT NOW(),subject text,content text,follow_up_step integer,rfc_message_id text,provider_message_id text,external_message_id text,provider_account_id text);
      CREATE TEMP TABLE sent_messages(id integer PRIMARY KEY,user_id integer,lead_id integer,channel text,is_reply boolean DEFAULT false,
        follow_up_step integer,status text,sent_at timestamp,updated_at timestamp,subject text,message text,message_id text,gmail_message_id text,gmail_thread_id text);
      INSERT INTO outreach_conversations(id,user_id,lead_id,channel) VALUES
        (1,7,101,'email'),(2,7,102,'email'),(3,7,103,'email'),(4,7,104,'sms'),(5,7,105,'sms'),(6,8,106,'email');
      INSERT INTO outreach_messages(id,conversation_id,user_id,direction,message_kind,metadata,status,sent_at,content,subject,external_message_id) VALUES
        (11,1,7,'outbound','outreach','{}','sent',NOW()-INTERVAL '3 hours','Legacy outreach','Hello','receipt-11'),
        (12,2,7,'outbound','outreach','{"outreachCreation":{"version":1,"followUps":[{"delayMinutes":5}]}}','sent',NOW()-INTERVAL '3 hours','Separate steps','Hello','receipt-12'),
        (13,3,7,'outbound','outreach','{"outreachCreation":{"version":1,"followUpSource":"channel_settings","followUps":[]}}','sent',NOW()-INTERVAL '3 hours','Saved settings','Hello','receipt-13'),
        (14,4,7,'outbound','outreach','{"outreachCreation":{"version":1,"followUpSource":"channel_settings","followUps":[]}}','sent',NOW()-INTERVAL '3 hours','Saved SMS settings',NULL,'receipt-14'),
        (15,5,7,'outbound','outreach','{"outreachCreation":{"version":1,"followUps":[{"delayMinutes":5}]}}','sent',NOW()-INTERVAL '3 hours','Separate SMS steps',NULL,'receipt-15'),
        (16,6,8,'outbound','outreach','{"outreachCreation":{"version":1,"followUpSource":"channel_settings","followUps":[]}}','sent',NOW()-INTERVAL '3 hours','Foreign settings','Hello','receipt-16');
      INSERT INTO sent_messages(id,user_id,lead_id,channel,status,sent_at,message,message_id) VALUES
        (114,7,104,'sms','sent',NOW()-INTERVAL '3 hours','Saved SMS settings','receipt-14'),
        (115,7,105,'sms','sent',NOW()-INTERVAL '3 hours','Separate SMS steps','receipt-15');
      UPDATE outreach_messages SET provider_account_id = 'original-email', metadata = jsonb_set(metadata, '{outreachCreation,delivery}',
        '{"channel":"email","leadId":103,"senderId":3,"recipientEmail":"original@example.test"}') WHERE id = 13;
      UPDATE outreach_messages SET provider_account_id = 'original-sms', metadata = jsonb_set(metadata, '{outreachCreation,delivery}',
        '{"channel":"sms","leadId":104,"phone":"919876543210"}') WHERE id = 14;
      UPDATE outreach_conversations SET provider_account_id = 'replacement-account';
    `);
  });
  afterAll(async () => { await client?.end(); });

  it('includes configured Email origins and excludes separately scheduled and foreign messages', async () => {
    const pending = await reader.getPendingFollowUpsForChannel(7, periods, 'email');
    expect(errors).not.toHaveBeenCalled();
    expect(pending.map(row => row.messageId)).toEqual([11, 13]);
    expect(pending.find(row => row.messageId === 13)?.useSavedFollowUpSettings).toBe(true);
    expect(pending.find(row => row.messageId === 11)?.useSavedFollowUpSettings).toBe(false);
  });
  it('includes the configured SMS receipt without duplicating separately scheduled steps', async () => {
    const pending = await reader.getPendingFollowUpsForChannel(7, periods, 'sms');
    expect(errors).not.toHaveBeenCalled();
    expect(pending.map(row => row.messageId)).toEqual([114]);
    expect(pending[0].useSavedFollowUpSettings).toBe(true);
  });
  it('keeps the original Email sender and SMS account when the conversation account changes', async () => {
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'email', 13, 103, 'original@example.test'))
      .resolves.toEqual({ senderId: 3, providerAccountId: 'original-email' });
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'sms', 114, 104, '919876543210'))
      .resolves.toEqual({ providerAccountId: 'original-sms' });
  });
  it('blocks changed recipients, foreign ownership and missing original messages', async () => {
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'email', 13, 103, 'changed@example.test')).rejects.toThrow('recipient');
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'sms', 114, 104, '919999999999')).rejects.toThrow('recipient');
    await expect(getConfiguredFollowUpDeliveryBinding(8, 'email', 13, 103, 'original@example.test')).rejects.toThrow('unavailable');
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'sms', 999, 104, '919876543210')).rejects.toThrow('unavailable');
  });
  it('stops an already queued SMS follow-up when a reply arrives before delivery', async () => {
    await client.query("INSERT INTO outreach_messages(id,conversation_id,user_id,direction,message_kind,content) VALUES(18,4,7,'inbound','reply','SMS reply')");
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'sms', 114, 104, '919876543210')).rejects.toThrow('Follow-up stopped');
    await client.query('DELETE FROM outreach_messages WHERE id = 18');
  });
  it('stops delivery after a human takes ownership of the conversation', async () => {
    await client.query("UPDATE outreach_conversations SET automation_mode = 'human_owned' WHERE id IN (3,4)");
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'email', 13, 103, 'original@example.test')).rejects.toThrow('Follow-up stopped');
    await expect(getConfiguredFollowUpDeliveryBinding(7, 'sms', 114, 104, '919876543210')).rejects.toThrow('Follow-up stopped');
    await client.query('UPDATE outreach_conversations SET automation_mode = NULL WHERE id IN (3,4)');
  });
  it('stops the configured Email follow-ups after an inbound reply', async () => {
    await client.query("INSERT INTO outreach_messages(id,conversation_id,user_id,direction,message_kind,content) VALUES(17,3,7,'inbound','reply','Replied')");
    const pending = await reader.getPendingFollowUpsForChannel(7, periods, 'email');
    expect(pending.map(row => row.messageId)).toEqual([11]);
  });
});
