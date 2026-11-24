import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
// @ts-expect-error migrations are JavaScript modules
import { up } from '../migrations/247_bind_meta_conversations_to_accounts.js';
// @ts-expect-error migrations are JavaScript modules
import { up as installSessions } from '../migrations/287_social_conversation_sessions.js';

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const localSuite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = (database as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { resolveMetaSendAccount } = await import('../services/outreach/MetaSendAccount.js');
const { getOrCreateConversation, getConversationByLeadAndChannel } = await import('../models/outreachConversations/functions.js');

localSuite('Meta conversations in isolated local PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit local QA database required');
    client = new Client({ connectionString }); await client.connect();
    await client.query('SET search_path TO pg_temp, pg_catalog');
    database = drizzle(client);
    await client.query(`CREATE TEMP TABLE outreach_conversations (
      id SERIAL PRIMARY KEY, user_id INTEGER, lead_id INTEGER, crm_contact_id INTEGER,
      channel VARCHAR(50), integration_provider VARCHAR(50), lead_name TEXT, lead_email TEXT,
      lead_instagram TEXT, lead_avatar TEXT, lead_company TEXT, thread_key UUID DEFAULT gen_random_uuid(),
      external_thread_id TEXT, subject TEXT, status TEXT DEFAULT 'active', automation_mode TEXT DEFAULT 'ai_active',
      last_message_at TIMESTAMP, last_message_by TEXT, last_message_preview TEXT, total_messages INTEGER DEFAULT 0,
      unread_count INTEGER DEFAULT 0, metadata JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      CREATE UNIQUE INDEX outreach_conversations_single_channel_uq ON outreach_conversations(user_id, lead_id, channel)
        WHERE channel NOT IN ('email','gmail','facebook','instagram');
      CREATE TEMP TABLE channel_credentials (user_id INTEGER, platform TEXT, account_identifier TEXT, is_active BOOLEAN);
      CREATE TEMP TABLE ai_agent_configs (tools_enabled JSONB);
      CREATE TEMP TABLE support_agent_templates (tools_enabled JSONB);
      INSERT INTO channel_credentials VALUES (1,'facebook_api','page-a',true),(1,'facebook_api','page-b',true),(2,'facebook_api','foreign',true);
      CREATE TEMP TABLE outreach_messages (id SERIAL, conversation_id INTEGER, provider_account_id TEXT);
      INSERT INTO outreach_conversations(user_id, lead_id, channel) VALUES (1,1,'facebook'),(1,2,'facebook');
      INSERT INTO outreach_messages(conversation_id, provider_account_id) VALUES (1,'page-a'),(1,'page-a'),(2,'page-a'),(2,'page-b');`);
    await up(client);
    await installSessions(client);
  });
  afterAll(async () => { await client?.end(); });
  it('backfills only unambiguous historical identity without merging messages', async () => {
    const result = await client.query('SELECT id, provider_account_id FROM outreach_conversations ORDER BY id');
    expect(result.rows).toEqual([{id:1,provider_account_id:'page-a'},{id:2,provider_account_id:null}]);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM outreach_messages')).rows[0].count).toBe(4);
  });
  it('keeps the same contact separate across two receiving Pages and tenants', async () => {
    const a = await getOrCreateConversation({userId:1,leadId:3,channel:'facebook',providerAccountId:'page-a',externalThreadId:'psid-a'});
    const b = await getOrCreateConversation({userId:1,leadId:3,channel:'facebook',providerAccountId:'page-b',externalThreadId:'psid-b'});
    const foreign = await getOrCreateConversation({userId:2,leadId:3,channel:'facebook',providerAccountId:'page-a',externalThreadId:'foreign'});
    expect(new Set([a.id,b.id,foreign.id]).size).toBe(3);
    expect((await getConversationByLeadAndChannel(1,3,'facebook','page-a'))?.externalThreadId).toBe('psid-a');
    expect((await getConversationByLeadAndChannel(1,3,'facebook','page-b'))?.externalThreadId).toBe('psid-b');
    expect(await getConversationByLeadAndChannel(1,3,'facebook')).toBeUndefined();
  });
  it('resolves the saved sending identity and rejects substitution, disconnection, and foreign accounts', async () => {
    expect(await resolveMetaSendAccount(1,'facebook',{conversationId:1})).toBe('page-a');
    await expect(resolveMetaSendAccount(1,'facebook',{conversationId:1,providerAccountId:'page-b'})).rejects.toThrow('does not match');
    await expect(resolveMetaSendAccount(1,'facebook',{providerAccountId:'foreign'})).rejects.toThrow('no longer available');
    await expect(resolveMetaSendAccount(1,'facebook',{})).rejects.toThrow('explicit');
    await expect(resolveMetaSendAccount(1,'facebook',{conversationId:2})).rejects.toThrow('unambiguous');
    await client.query("UPDATE channel_credentials SET is_active=false WHERE account_identifier='page-a'");
    await expect(resolveMetaSendAccount(1,'facebook',{conversationId:1})).rejects.toThrow('same account');
    await client.query("UPDATE channel_credentials SET is_active=true WHERE account_identifier='page-a'");
  });
  it('reuses only the exact account under concurrent Instagram creation', async () => {
    const results = await Promise.all(Array.from({length:4}, () => getOrCreateConversation({userId:1,leadId:4,channel:'instagram',providerAccountId:'ig-a',externalThreadId:'igsid-a'})));
    expect(new Set(results.map(row=>row.id)).size).toBe(1);
    const second = await getOrCreateConversation({userId:1,leadId:4,channel:'instagram',providerAccountId:'ig-b',externalThreadId:'igsid-b'});
    expect(second.id).not.toBe(results[0].id);
  });
});
