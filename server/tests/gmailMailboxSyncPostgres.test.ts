import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const connectionString = process.env.GMAIL_SYNC_TEST_DATABASE;
const suite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
const enqueue = jest.fn<(...args: unknown[]) => Promise<string>>();
const inbound = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const history = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const message = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const attachments = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const list = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (...args: Parameters<NodePgDatabase['execute']>) => database.execute(...args),
} }));
jest.unstable_mockModule('../queues/index.js', () => ({ QUEUE_NAMES: { GENERAL: 'general' }, queueRegistry: { addJob: enqueue } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/InboundEmailService.js', () => ({ processInboundEmail: inbound }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ config: { webhookSecret: 'qa-secret' } }) }));
jest.unstable_mockModule('../controllers/gmailOAuthController.js', () => ({ getGmailClientForUser: async (_user: number,binding: {credentialId:number;accountIdentifier:string}) => ({ client: {fixtureEmail:binding.accountIdentifier}, credential: { id: binding.credentialId } }) }));
jest.unstable_mockModule('googleapis', () => ({ google: { gmail: (options: any) => ({ users: {
  getProfile: async () => ({data:{emailAddress:options.auth?.fixtureEmail,historyId:'400'}}),
  history: { list: history }, messages: { get: message, list, send, attachments: { get: attachments } }, threads: {},
} }) } }));
const { queueGmailNotification, processGmailMailboxSync, recoverGmailMailboxSync, requestGmailMailboxSync } = await import('../services/GmailMailboxSyncService.js');
const { gmailRequest, guardGmailClient, GmailCooldownError } = await import('../services/GmailCooldownService.js');
const { handleGmailPubSubWebhook } = await import('../controllers/gmailWebhookController.js');
// @ts-expect-error JS migrations intentionally expose no declarations.
const { up, down } = await import('../migrations/326_gmail_mailbox_sync.js');
const binding = { userId: 9, credentialId: 31, emailAddress: 'owner@example.test' };
const state = async () => (await client.query('SELECT * FROM channel_credentials WHERE id=31')).rows[0];
const delivered = { data: { history: [{ messagesAdded: [{ message: { id: 'mail-1' } }] }] } };
const mail = { data: { id: 'mail-1', threadId: 'thread-1', internalDate: '1788840000000', payload: {
  headers: [{ name: 'From', value: 'Customer <customer@example.test>' }],
  mimeType: 'text/plain', body: { data: Buffer.from('Reply').toString('base64') },
} } };
async function notify(historyId = '200') {
  const req = { query: { token: 'qa-secret' }, body: { message: { data: Buffer.from(JSON.stringify({ emailAddress: binding.emailAddress, historyId })).toString('base64') } } };
  const res = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
  await handleGmailPubSubWebhook(req as never, res as never);
  return res.status.mock.calls.at(-1)?.[0];
}
const rateLimit = (retryAt: string) => ({ message: `User-rate limit exceeded. Retry after ${retryAt}`, response: {
  status: 429, data: { error: { code: 429, message: `User-rate limit exceeded. Retry after ${retryAt}` } },
} });

suite('Gmail durable notification queue in isolated local PostgreSQL', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('An explicit local QA database is required');
    client = new Client({ connectionString }); await client.connect();
    await client.query('SET search_path TO pg_temp,pg_catalog');
    await client.query(`CREATE TEMP TABLE channel_credentials (
      id integer PRIMARY KEY,user_id integer,business_profile_id integer,platform text,is_active boolean,
      account_identifier text,session_data jsonb,updated_at timestamptz DEFAULT NOW())`);
    await up(client); await up(client); database = drizzle(client);
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    jest.clearAllMocks(); enqueue.mockReset().mockResolvedValue('sync-job'); inbound.mockReset().mockResolvedValue({ success: true });
    history.mockReset().mockResolvedValue(delivered); message.mockReset().mockResolvedValue(mail);
    send.mockReset().mockResolvedValue({ data: { id: 'sent-id' } }); attachments.mockReset(); list.mockReset();
    await client.query(`TRUNCATE channel_credentials;
      INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,is_active,account_identifier,session_data) VALUES
      (31,9,17,'gmail_api',true,'owner@example.test','{"lastHistoryId":"100","watchExpiration":"preserve"}'),
      (32,9,17,'gmail_api',true,'other@example.test','{"lastHistoryId":"50"}')`);
  });

  it('manually syncs every mailbox using a Gmail API wrapper rather than an OAuth2Client resource', async () => {
    expect(await requestGmailMailboxSync(9)).toBe(2);
    expect((await state()).gmail_sync_history_id).toBe('400');
    expect((await client.query('SELECT gmail_sync_history_id::text FROM channel_credentials WHERE id=32')).rows[0].gmail_sync_history_id).toBe('400');
    expect(history).not.toHaveBeenCalled();
  });

  it('saves and acknowledges notifications without calling Gmail, even when Redis is down', async () => {
    enqueue.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect(await notify()).toBe(200);
    expect((await state()).gmail_sync_history_id).toBe('200');
    expect(history).not.toHaveBeenCalled(); expect(message).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('general', 'gmail-mailbox-sync', expect.objectContaining(binding),
      expect.objectContaining({ jobId: 'gmail-mailbox-sync-31', removeOnComplete: true }));
  });
  it('coalesces duplicate and out-of-order notifications without losing large history identifiers', async () => {
    for (const id of ['90071992547409931234', '200', '90071992547409931234']) await queueGmailNotification(binding, id);
    expect((await state()).gmail_sync_history_id).toBe('90071992547409931234');
    expect(new Set(enqueue.mock.calls.map(call => (call[3] as { jobId: string }).jobId)).size).toBe(1);
  });
  it('acknowledges a durable notification even if the Redis enqueue never finishes', async () => {
    let finish!: (id: string) => void;
    enqueue.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      expect(await notify()).toBe(200);
      expect((await state()).gmail_sync_history_id).toBe('200');
      expect(history).not.toHaveBeenCalled();
    } finally { finish('recovered-job'); await Promise.resolve(); await Promise.resolve(); }
  });
  it('advances the exact cursor only after durable inbound processing, preserving other session fields', async () => {
    await queueGmailNotification(binding, '200');
    inbound.mockImplementationOnce(async () => { expect((await state()).session_data.lastHistoryId).toBe('100'); return { success: true }; });
    await processGmailMailboxSync(binding);
    expect((await state()).session_data).toEqual({ lastHistoryId: '200', watchExpiration: 'preserve' });
    expect((await state()).gmail_sync_history_id).toBeNull();
    expect((await client.query('SELECT session_data FROM channel_credentials WHERE id=32')).rows[0].session_data.lastHistoryId).toBe('50');
  });
  it('keeps the original cursor and schedules recovery after an inbound persistence failure', async () => {
    await queueGmailNotification(binding, '200'); inbound.mockResolvedValueOnce({ success: false });
    await processGmailMailboxSync(binding);
    const row = await state(); expect(row.session_data.lastHistoryId).toBe('100'); expect(row.gmail_sync_history_id).toBe('200');
    expect(row.gmail_sync_lease_token).toBeNull(); expect(row.gmail_sync_due_at.getTime()).toBeGreaterThan(Date.now());
  });
  it('persists a Gmail cooldown and makes no more Gmail calls from another worker during it', async () => {
    const retryAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await queueGmailNotification(binding, '200'); history.mockRejectedValueOnce(rateLimit(retryAt));
    await processGmailMailboxSync(binding); await processGmailMailboxSync(binding);
    const row = await state(); expect(row.gmail_cooldown_until.toISOString()).toBe(retryAt);
    expect(row.gmail_sync_due_at.toISOString()).toBe(retryAt); expect(row.session_data.lastHistoryId).toBe('100');
    expect(history).toHaveBeenCalledTimes(1); expect(await recoverGmailMailboxSync()).toBe(0);
    const queuedBefore = enqueue.mock.calls.length;
    expect(await notify('300')).toBe(200); expect((await state()).gmail_cooldown_until.toISOString()).toBe(retryAt);
    expect(enqueue).toHaveBeenCalledTimes(queuedBefore);
  });
  it('shares the persisted cooldown with outbound sends while allowing a different mailbox', async () => {
    await gmailRequest(binding, async () => { throw rateLimit(new Date(Date.now() + 900_000).toISOString()); }).catch(() => {});
    const { google } = await import('googleapis'); const gmail = guardGmailClient(google.gmail({ version: 'v1' }), binding);
    await expect(gmail.users.messages.send({ userId: 'me', requestBody: { raw: 'fixture' } })).rejects.toBeInstanceOf(GmailCooldownError);
    expect(send).not.toHaveBeenCalled();
    await gmailRequest({ ...binding, credentialId: 32, emailAddress: 'other@example.test' }, async () => 'allowed');
  });
  it('resumes the retained notification after cooldown expiry', async () => {
    await queueGmailNotification(binding, '200'); history.mockRejectedValueOnce(rateLimit(new Date(Date.now() + 900_000).toISOString()));
    await processGmailMailboxSync(binding);
    await client.query("UPDATE channel_credentials SET gmail_cooldown_until=NOW()-INTERVAL '1 second',gmail_sync_due_at=NOW()-INTERVAL '1 second' WHERE id=31");
    expect(await recoverGmailMailboxSync()).toBe(1); await processGmailMailboxSync(binding);
    expect((await state()).session_data.lastHistoryId).toBe('200'); expect(history).toHaveBeenCalledTimes(2);
  });
  it('prevents two workers from syncing the same mailbox simultaneously', async () => {
    await queueGmailNotification(binding, '200'); let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
    history.mockImplementationOnce(async () => { started(); await gate; return delivered; });
    const first = processGmailMailboxSync(binding); await entered; await processGmailMailboxSync(binding);
    expect(history).toHaveBeenCalledTimes(1); release(); await first;
  });
  it('preserves newer notifications received while a worker is processing', async () => {
    await queueGmailNotification(binding, '200');
    inbound.mockImplementationOnce(async () => { await queueGmailNotification(binding, '300'); return { success: true }; });
    await processGmailMailboxSync(binding);
    expect((await state()).session_data.lastHistoryId).toBe('200'); expect((await state()).gmail_sync_history_id).toBe('300');
    await processGmailMailboxSync(binding); expect((await state()).session_data.lastHistoryId).toBe('300');
  });
  it('recovers an abandoned lease without acknowledging unprocessed history', async () => {
    await queueGmailNotification(binding, '200');
    await client.query("UPDATE channel_credentials SET gmail_sync_lease_token='00000000-0000-0000-0000-000000000001',gmail_sync_lease_until=NOW()-INTERVAL '1 second' WHERE id=31");
    expect(await recoverGmailMailboxSync()).toBe(1); await processGmailMailboxSync(binding);
    expect((await state()).session_data.lastHistoryId).toBe('200');
  });
  it('does not let a replaced lease advance the cursor', async () => {
    await queueGmailNotification(binding, '200');
    inbound.mockImplementationOnce(async () => {
      await client.query("UPDATE channel_credentials SET gmail_sync_lease_token='00000000-0000-0000-0000-000000000002' WHERE id=31");
      return { success: true };
    });
    await processGmailMailboxSync(binding);
    expect((await state()).session_data.lastHistoryId).toBe('100'); expect((await state()).gmail_sync_history_id).toBe('200');
  });
  it('never processes a disconnected, foreign-user or wrong-mailbox binding', async () => {
    await queueGmailNotification(binding, '200');
    await processGmailMailboxSync({ ...binding, userId: 10 });
    await processGmailMailboxSync({ ...binding, emailAddress: 'wrong@example.test' });
    await client.query('UPDATE channel_credentials SET is_active=false WHERE id=31'); await processGmailMailboxSync(binding);
    expect(history).not.toHaveBeenCalled(); expect(inbound).not.toHaveBeenCalled();
  });
  it('propagates non-rate-limit errors without setting a mailbox cooldown', async () => {
    await expect(gmailRequest(binding, async () => { throw new Error('network unavailable'); })).rejects.toThrow('network unavailable');
    expect((await state()).gmail_cooldown_until).toBeNull();
  });
  it('never shortens a longer cooldown written by another in-flight request', async () => {
    const later = new Date(Date.now() + 7200_000).toISOString();
    const earlier = new Date(Date.now() + 900_000).toISOString();
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
    const first = gmailRequest(binding, async () => { started(); await gate; throw rateLimit(earlier); }).catch(error => error);
    await entered;
    await gmailRequest(binding, async () => { throw rateLimit(later); }).catch(() => {});
    release(); expect((await first).retryAt).toBe(later);
    expect((await state()).gmail_cooldown_until.toISOString()).toBe(later);
  });
  it('retains the cursor and cooldown when an attachment download is rate-limited', async () => {
    await queueGmailNotification(binding, '200');
    message.mockResolvedValueOnce({ data: { ...mail.data, payload: { ...mail.data.payload, parts: [
      { filename: 'fixture.txt', mimeType: 'text/plain', body: { attachmentId: 'attachment-1', size: 10 } },
    ] } } });
    const retryAt = new Date(Date.now() + 900_000).toISOString();
    attachments.mockRejectedValueOnce(rateLimit(retryAt)); await processGmailMailboxSync(binding);
    expect((await state()).gmail_sync_due_at.toISOString()).toBe(retryAt);
    expect((await state()).session_data.lastHistoryId).toBe('100'); expect(inbound).not.toHaveBeenCalled();
  });
  it('rolls back the migration without touching the existing credential data', async () => {
    await client.query('BEGIN'); try {
      await down(client); expect((await client.query('SELECT session_data FROM channel_credentials WHERE id=31')).rows[0].session_data.lastHistoryId).toBe('100');
    } finally { await client.query('ROLLBACK'); }
  });
});
