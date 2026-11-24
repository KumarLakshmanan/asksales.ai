import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client, defaults as pgDefaults } from 'pg';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
// @ts-expect-error migrations are JavaScript modules
import { up } from '../migrations/287_social_conversation_sessions.js';
// @ts-expect-error migrations are JavaScript modules
import { up as repairFollowUpTimes } from '../migrations/288_repair_social_follow_up_timestamps.js';

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const localSuite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
const originalDateSerialization = pgDefaults.parseInputDatesAsUTC;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = (database as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const privacyVault = await import('../services/agents/orchestration/PrivacyVaultService.js');
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  ...privacyVault,
  redactPiiWithStableTokens: (value: string) => ({ redactedText: value.replace(/private@example.com/g, '[EMAIL_1]') }),
}));
const { getOrCreateConversation } = await import('../models/outreachConversations/functions.js');
const followUps = await import('../services/socialFollowUpService.js');
const { chatHistorySubAgent } = await import('../services/agents/subagents/ChatHistorySubAgent.js');
const { SentMessageModel } = await import('../models/sentMessages/functions.js');

localSuite('social conversation lifecycle in isolated PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Local QA database required');
    client = new Client({ connectionString }); await client.connect();
    // models/db.ts is mocked here; retain its real UTC driver configuration.
    pgDefaults.parseInputDatesAsUTC = true;
    // Production timestamp-without-time-zone columns store UTC, regardless of
    // the developer machine's local PostgreSQL session timezone.
    await client.query("SET TIME ZONE 'UTC'");
    await client.query('SET search_path TO pg_temp, pg_catalog');
    database = drizzle(client);
    await client.query(`CREATE TEMP TABLE outreach_conversations (
      id SERIAL PRIMARY KEY, business_profile_id INTEGER DEFAULT 10, user_id INTEGER, lead_id INTEGER, crm_contact_id INTEGER,
      channel VARCHAR(50), integration_provider VARCHAR(50), provider_account_id TEXT,
      lead_name TEXT, lead_email TEXT, lead_instagram TEXT, lead_avatar TEXT, lead_company TEXT,
      thread_key UUID DEFAULT gen_random_uuid(), external_thread_id TEXT, subject TEXT,
      status TEXT DEFAULT 'active', automation_mode TEXT DEFAULT 'ai_active',
      last_message_at TIMESTAMP, last_message_by TEXT, last_message_preview TEXT,
      total_messages INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0, metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      CREATE TEMP TABLE outreach_messages (
        id SERIAL PRIMARY KEY, business_profile_id INTEGER DEFAULT 10, conversation_id INTEGER, user_id INTEGER, direction TEXT, content TEXT,
        redacted_content TEXT, subject TEXT, status TEXT, sent_at TIMESTAMP, failed_at TIMESTAMP,
        external_message_id TEXT, provider_message_id TEXT, waba_message_id TEXT,
        phone_number_id TEXT, provider_account_id TEXT, is_automatic BOOLEAN DEFAULT false,
        sequence_step INTEGER, message_kind TEXT DEFAULT 'outreach', follow_up_origin_message_id INTEGER,
        follow_up_step INTEGER, error_message TEXT, metadata JSONB, manual_review_required BOOLEAN DEFAULT false,provider_call_state TEXT DEFAULT 'not_started',
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      CREATE UNIQUE INDEX follow_up_step_uq ON outreach_messages(follow_up_origin_message_id,follow_up_step)
        WHERE message_kind='follow_up' AND follow_up_origin_message_id IS NOT NULL AND follow_up_step IS NOT NULL;
      CREATE TEMP TABLE social_follow_up_schedules (
        id SERIAL PRIMARY KEY, business_profile_id INTEGER DEFAULT 10, conversation_id INTEGER UNIQUE, user_id INTEGER, channel TEXT, anchor_message_id INTEGER,
        steps JSONB, next_step INTEGER, next_run_at TIMESTAMP, status TEXT, delivery_message_id INTEGER,
        cancelled_at TIMESTAMP, cancellation_reason TEXT, version INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      CREATE TEMP TABLE outreach_settings (user_id INTEGER, enable_auto_follow_up BOOLEAN, channel_follow_ups JSONB);
      CREATE TEMP TABLE ai_agent_configs (tools_enabled JSONB);
      CREATE TEMP TABLE support_agent_templates (tools_enabled JSONB);
      INSERT INTO ai_agent_configs VALUES ('[]');`);
    await up(client);
    const channels = Object.fromEntries(['whatsapp', 'instagram', 'facebook'].map(channel => [channel, {
      enabled: true, followUps: [{ id: 1, enabled: true, delayMinutes: 1 }],
    }]));
    await client.query('INSERT INTO outreach_settings VALUES (1,true,$1)', [JSON.stringify(channels)]);
  });
  afterAll(async () => { await client?.end(); pgDefaults.parseInputDatesAsUTC = originalDateSerialization; });

  it.each(['whatsapp', 'instagram', 'facebook'])('%s: follows up on a support reply, retains the closed chat, and starts a clean session', async channel => {
    const data = { userId: 1, leadId: 20, channel, providerAccountId: `${channel}-account`, leadName: 'Customer', externalThreadId: 'recipient' };
    const first = await getOrCreateConversation(data);
    await client.query(`UPDATE outreach_conversations SET crm_contact_id=123,
      metadata='{"oldConsent":true,"previousPlaybookNode":"checkout","pendingBooking":{"rooms":2}}'::jsonb WHERE id=$1`, [first.id]);
    const anchor = await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status,message_kind,sent_at)
      VALUES ($1,1,'outbound','How can I help?','sent','reply',NOW()-INTERVAL '5 minutes') RETURNING id`, [first.id]);
    expect(await followUps.activateSocialFollowUpForAnchor(anchor.rows[0].id)).toBe(true);
    const scheduledDelay = await client.query(`SELECT EXTRACT(EPOCH FROM (schedule.next_run_at - anchor.sent_at))::int AS seconds
      FROM social_follow_up_schedules schedule JOIN outreach_messages anchor ON anchor.id=schedule.anchor_message_id
      WHERE schedule.conversation_id=$1`, [first.id]);
    expect(scheduledDelay.rows[0].seconds).toBe(60);
    const [due] = await followUps.getDueSocialFollowUps(1, channel as 'whatsapp');
    expect(due.conversationId).toBe(first.id);
    expect(due.isSupportReply).toBe(true);
    const messageId = await followUps.reserveSocialFollowUp({ scheduleId: due.scheduleId, scheduleVersion: due.scheduleVersion,
      anchorMessageId: due.anchorMessageId, userId: 1, step: 1, content: 'Still need help?' });
    expect(messageId).toBeTruthy();
    const queued = await withBusinessScope({userId:1,businessProfileId:10},()=>SentMessageModel.findRecentFollowUpsByUser(1, channel));
    expect(queued[0]).toMatchObject({ id: messageId, status: 'queued', followUpStep: 1 });
    expect(await followUps.claimSocialFollowUpDelivery(due.scheduleId, messageId!, 1)).toBe(true);
    await followUps.completeSocialFollowUpDelivery(due.scheduleId, messageId!, 'provider-message');
    const receipt = (await client.query('SELECT waba_message_id,phone_number_id,provider_account_id FROM outreach_messages WHERE id=$1', [messageId])).rows[0];
    expect(receipt.provider_account_id).toBe(`${channel}-account`);
    if (channel === 'whatsapp') expect(receipt).toMatchObject({ waba_message_id: 'provider-message', phone_number_id: 'whatsapp-account' });
    const next = await getOrCreateConversation(data);
    expect(next.id).not.toBe(first.id);
    expect(next.automationMode).toBe('ai_active');
    expect(next.crmContactId).toBe(123);
    expect(next.sessionEndedAt).toBeNull();
    expect(next.metadata).toBeNull(); // No old consent, pending action or playbook position is carried forward.
    expect((await getOrCreateConversation(data)).id).toBe(next.id);
    const retained = await client.query('SELECT status,session_ended_at FROM outreach_conversations WHERE id=$1', [first.id]);
    expect(retained.rows[0].status).toBe('closed');
    expect(retained.rows[0].session_ended_at).not.toBeNull();
    expect((await withBusinessScope({userId:1,businessProfileId:10},()=>SentMessageModel.findRecentFollowUpsByUser(1, channel)))[0]).toMatchObject({ id: messageId, status: 'sent' });
    expect(await followUps.activateSocialFollowUpForAnchor(messageId!)).toBe(false);
    const ctx = { userId: 1, conversationId: next.id } as Parameters<typeof chatHistorySubAgent.execute>[2];
    const listed = await chatHistorySubAgent.execute('get_customer_chat_history', {}, ctx);
    expect(listed.toolResults?.[0].result.conversations.some((row: { id: number }) => row.id === first.id)).toBe(true);
    const history = await chatHistorySubAgent.execute('get_customer_chat_history', { conversation_id: first.id }, ctx);
    expect(history.toolResults?.[0].result.messages.map((row: { content: string }) => row.content)).toContain('Still need help?');
    expect((await client.query('SELECT COUNT(*)::int AS count FROM outreach_messages WHERE conversation_id=$1', [next.id])).rows[0].count).toBe(0);
  });

  it('keeps the active session when a reply arrives before completion', async () => {
    const data = { userId: 1, leadId: 30, channel: 'whatsapp', providerAccountId: 'wa' };
    const session = await getOrCreateConversation(data);
    const anchor = await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status,message_kind,sent_at)
      VALUES ($1,1,'outbound','Question','sent','reply',NOW()-INTERVAL '5 minutes') RETURNING id`, [session.id]);
    await followUps.activateSocialFollowUpForAnchor(anchor.rows[0].id);
    const [due] = await followUps.getDueSocialFollowUps(1, 'whatsapp');
    const id = await followUps.reserveSocialFollowUp({ scheduleId: due.scheduleId, scheduleVersion: due.scheduleVersion,
      anchorMessageId: due.anchorMessageId, userId: 1, step: 1, content: 'Checking in' });
    await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status) VALUES ($1,1,'inbound','Yes','delivered')`, [session.id]);
    await followUps.cancelSocialFollowUpsForConversation(session.id, 'reply_received');
    expect(await followUps.claimSocialFollowUpDelivery(due.scheduleId, id!, 1)).toBe(false);
    expect((await getOrCreateConversation(data)).id).toBe(session.id);
    expect((await withBusinessScope({userId:1,businessProfileId:10},()=>SentMessageModel.findRecentFollowUpsByUser(1, 'whatsapp')))[0].status).toBe('cancelled');
  });

  it('isolates account sessions and does not let the history tool read another customer or tenant', async () => {
    const a = await getOrCreateConversation({ userId: 1, leadId: 99, channel: 'instagram', providerAccountId: 'a' });
    const b = await getOrCreateConversation({ userId: 1, leadId: 99, channel: 'instagram', providerAccountId: 'b' });
    expect(a.id).not.toBe(b.id);
    const other = await getOrCreateConversation({ userId: 2, leadId: 99, channel: 'instagram', providerAccountId: 'a' });
    const ctx = { userId: 1, conversationId: a.id } as Parameters<typeof chatHistorySubAgent.execute>[2];
    const result = await chatHistorySubAgent.execute('get_customer_chat_history', { conversation_id: other.id }, ctx);
    expect(result.toolResults?.[0].result.messages).toEqual([]);
    const unrelated = await chatHistorySubAgent.execute('get_customer_chat_history', { conversation_id: 1 }, ctx);
    expect(unrelated.toolResults?.[0].result.messages).toEqual([]);
    await client.query("UPDATE outreach_conversations SET automation_mode='opted_out' WHERE id=$1", [a.id]);
    expect((await getOrCreateConversation({ userId: 1, leadId: 99, channel: 'instagram', providerAccountId: 'a' })).automationMode).toBe('opted_out');
    await client.query("UPDATE outreach_conversations SET status='closed',session_ended_at=NOW() WHERE id=$1", [a.id]);
    expect((await getOrCreateConversation({ userId: 1, leadId: 99, channel: 'instagram', providerAccountId: 'a' })).automationMode).toBe('opted_out');
  });

  it('paginates retained CRM-linked cross-channel history without exposing drafts or unrelated customers', async () => {
    const current = await getOrCreateConversation({ userId: 1, leadId: 201, channel: 'whatsapp', providerAccountId: 'history-current' });
    const previous = await getOrCreateConversation({ userId: 1, leadId: 202, channel: 'instagram', providerAccountId: 'history-previous' });
    const unrelated = await getOrCreateConversation({ userId: 1, leadId: 203, channel: 'instagram', providerAccountId: 'history-unrelated' });
    await client.query('UPDATE outreach_conversations SET crm_contact_id=555 WHERE id=ANY($1::int[])', [[current.id, previous.id]]);
    await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status)
      SELECT $1,1,'inbound','Earlier message '||i||' private@example.com','received' FROM generate_series(1,35) i`, [previous.id]);
    await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status) VALUES
      ($1,1,'outbound','Unsent internal draft','draft'),($1,1,'outbound','Failed delivery','failed'),
      ($2,1,'inbound','Other customer secret','received')`, [previous.id, unrelated.id]);
    const ctx = { userId: 1, conversationId: current.id };
    const listed = (await chatHistorySubAgent.execute('get_customer_chat_history', {}, ctx)).toolResults![0].result;
    expect(listed.conversations.map((row: { id: number }) => row.id)).toContain(previous.id);
    expect(listed.conversations.map((row: { id: number }) => row.id)).not.toContain(current.id);
    expect(listed.conversations.map((row: { id: number }) => row.id)).not.toContain(unrelated.id);
    const page = (await chatHistorySubAgent.execute('get_customer_chat_history', { conversation_id: previous.id }, ctx)).toolResults![0].result;
    expect(page.messages).toHaveLength(30);
    expect(JSON.stringify(page)).not.toMatch(/Unsent internal draft|Failed delivery|private@example.com|Other customer secret/);
    expect(page.messages[0].content).toBe('Earlier message 6 [EMAIL_1]');
    const older = (await chatHistorySubAgent.execute('get_customer_chat_history', { conversation_id: previous.id, before_id: page.next_before_id }, ctx)).toolResults![0].result;
    expect(older.messages).toHaveLength(5);
    expect(older.messages[0].content).toBe('Earlier message 1 [EMAIL_1]');
    expect(older.next_before_id).toBeNull();
  });

  it('keeps a multi-step session open until the final success and displays delivery failures', async () => {
    await client.query(`UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{facebook,followUps}',
      '[{"id":1,"enabled":true,"delayMinutes":1},{"id":2,"enabled":true,"delayMinutes":2}]') WHERE user_id=1`);
    const data = { userId: 1, leadId: 80, channel: 'facebook', providerAccountId: 'page' };
    const session = await getOrCreateConversation(data);
    const anchor = await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status,message_kind,sent_at)
      VALUES ($1,1,'outbound','Question','sent','reply',NOW()-INTERVAL '5 minutes') RETURNING id`, [session.id]);
    await followUps.activateSocialFollowUpForAnchor(anchor.rows[0].id);
    const first = (await followUps.getDueSocialFollowUps(1, 'facebook')).find(item => item.conversationId === session.id)!;
    const firstId = await followUps.reserveSocialFollowUp({ scheduleId: first.scheduleId, scheduleVersion: first.scheduleVersion,
      anchorMessageId: first.anchorMessageId, userId: 1, step: 1, content: 'First check-in' });
    await followUps.claimSocialFollowUpDelivery(first.scheduleId, firstId!, 1);
    await followUps.completeSocialFollowUpDelivery(first.scheduleId, firstId!, 'first');
    expect((await getOrCreateConversation(data)).id).toBe(session.id);
    // Replaying completion/scheduling for the same agent message cannot reset step 2.
    await followUps.activateSocialFollowUpForAnchor(anchor.rows[0].id);
    const second = (await followUps.getDueSocialFollowUps(1, 'facebook')).find(item => item.conversationId === session.id)!;
    expect(second.nextStep).toBe(2);
    const secondId = await followUps.reserveSocialFollowUp({ scheduleId: second.scheduleId, scheduleVersion: second.scheduleVersion,
      anchorMessageId: second.anchorMessageId, userId: 1, step: 2, content: 'Final check-in' });
    await followUps.failSocialFollowUpDelivery(second.scheduleId, secondId!, 'delivery_uncertain');
    expect((await getOrCreateConversation(data)).id).toBe(session.id);
    const logs = await withBusinessScope({userId:1,businessProfileId:10},()=>SentMessageModel.findRecentFollowUpsByUser(1, 'facebook'));
    expect(logs[0]).toMatchObject({ id: secondId, status: 'failed', deliveryStatus: 'uncertain', followUpStep: 2 });
  });
  it('repairs an existing active schedule to the configured UTC anchor offset', async () => {
    const session = await getOrCreateConversation({ userId: 1, leadId: 101, channel: 'whatsapp', providerAccountId: 'repair-test' });
    const anchor = await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status,message_kind,sent_at)
      VALUES ($1,1,'outbound','Question','sent','reply',$2::timestamp) RETURNING id`,
    [session.id, '2026-09-22 06:50:54']);
    await client.query(`INSERT INTO social_follow_up_schedules(conversation_id,user_id,channel,anchor_message_id,steps,next_step,next_run_at,status)
      VALUES ($1,1,'whatsapp',$2,$3,1,$4::timestamp,'active')`,
    [session.id, anchor.rows[0].id, JSON.stringify([{ id: 1, delayDays: 1 }]), '2026-09-23 01:20:54']);
    await repairFollowUpTimes(client);
    const result = await client.query(`SELECT EXTRACT(EPOCH FROM (schedule.next_run_at - anchor.sent_at))::int AS seconds
      FROM social_follow_up_schedules schedule JOIN outreach_messages anchor ON anchor.id=schedule.anchor_message_id
      WHERE schedule.conversation_id=$1`, [session.id]);
    expect(result.rows[0].seconds).toBe(86400);
  });
});
