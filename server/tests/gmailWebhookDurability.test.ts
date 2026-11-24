import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const processInbound = jest.fn<(...args: any[]) => Promise<any>>();
const getClient = jest.fn<(...args: any[]) => Promise<any>>();
const historyList = jest.fn<(...args: any[]) => Promise<any>>();
const messageList = jest.fn<(...args: any[]) => Promise<any>>();
const messageGet = jest.fn<(...args: any[]) => Promise<any>>();
const attachmentGet = jest.fn<(...args: any[]) => Promise<any>>();
const loggerError = jest.fn();
const queueNotification = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../services/GmailMailboxSyncService.js', () => ({ queueGmailNotification: queueNotification }));
jest.unstable_mockModule('../services/GmailCooldownService.js', () => ({ guardGmailClient: (client: unknown) => client }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/InboundEmailService.js', () => ({ processInboundEmail: processInbound }));
jest.unstable_mockModule('../controllers/gmailOAuthController.js', () => ({ getGmailClientForUser: getClient }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ config: { webhookSecret: 'qa-secret' } }) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: loggerError } }));
jest.unstable_mockModule('googleapis', () => ({ google: { gmail: () => ({ users: {
  history: { list: historyList }, messages: { list: messageList, get: messageGet, attachments: { get: attachmentGet } },
} }) } }));
const { handleGmailPubSubWebhook, syncGmailMailboxHistory } = await import('../controllers/gmailWebhookController.js');
const parse = (value: SQL) => new PgDialect().sqlToQuery(value);
const credential = () => ({ id: 31, user_id: 9, business_profile_id: 17, account_identifier: 'owner@example.test', session_data: { lastHistoryId: '100' } });
const mail = (id = 'm1') => ({ data: { id, threadId: 'thread-A', internalDate: '1788840000000', payload: {
  headers: [{ name: 'From', value: 'Customer <qa@example.test>' }, { name: 'To', value: 'owner@example.test' }],
  mimeType: 'text/plain', body: { data: Buffer.from('Support reply').toString('base64') },
} } });
async function run(historyId = '200', token = 'qa-secret') {
  const req: any = { query: { token }, body: { message: { data: Buffer.from(JSON.stringify({ emailAddress: ' Owner@Example.Test ', historyId })).toString('base64') } } };
  const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
  await handleGmailPubSubWebhook(req, res);
  return res.status.mock.calls.at(-1)?.[0];
}
const updates = () => execute.mock.calls.map((call) => parse(call[0])).filter((query) => query.sql.includes('UPDATE channel_credentials'));
beforeEach(() => {
  jest.clearAllMocks();
  queueNotification.mockReset().mockResolvedValue(undefined);
  execute.mockReset().mockImplementation(async (sql: SQL) => ({ rows: parse(sql).sql.includes('SELECT') ? [credential()] : [] }));
  getClient.mockReset().mockResolvedValue({ client: {}, credential: { id: 31 } });
  processInbound.mockReset().mockResolvedValue({ success: true });
  historyList.mockReset().mockResolvedValue({ data: { history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] } });
  messageList.mockReset().mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
  messageGet.mockReset().mockImplementation(async ({ id }: any) => mail(id));
  attachmentGet.mockReset();
});


const sync = () => syncGmailMailboxHistory({ ...credential(), gmail_sync_history_id: '200', gmail_sync_failures: 0 }, async () => {});
describe('Gmail notification acceptance', () => {
  it('acknowledges only after durably queueing the exact account, without calling Gmail', async () => {
    queueNotification.mockImplementation(async () => { expect(getClient).not.toHaveBeenCalled(); });
    expect(await run()).toBe(200);
    expect(queueNotification).toHaveBeenCalledWith({ userId: 9, credentialId: 31, emailAddress: 'owner@example.test' }, '200');
    expect(getClient).not.toHaveBeenCalled(); expect(updates()).toHaveLength(0);
  });
  it('does not acknowledge a failed durable write', async () => {
    queueNotification.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await run()).toBe(500); expect(getClient).not.toHaveBeenCalled();
  });
  it('fails closed on ambiguous mailbox ownership', async () => {
    execute.mockResolvedValueOnce({ rows: [credential(), { ...credential(), id: 32, user_id: 10 }] });
    expect(await run()).toBe(409); expect(queueNotification).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('owner@example.test');
  });
  it('rejects an invalid webhook secret without looking up credentials', async () => {
    expect(await run('200', 'bad')).toBe(401); expect(execute).not.toHaveBeenCalled();
  });
  it('ignores old notifications and rejects malformed history ids', async () => {
    expect(await run('99')).toBe(200); expect(await run('invalid')).toBe(200);
    expect(await run('1'.repeat(41))).toBe(200); expect(queueNotification).not.toHaveBeenCalled();
  });
});
describe('worker-only Gmail history processing', () => {
  it('preserves auto-response headers and detects inline calendar MIME parts before automation', async () => {
    const message = mail();
    message.data.payload.headers.push({ name: 'Auto-Submitted', value: 'auto-generated' });
    messageGet.mockResolvedValueOnce({ data: { ...message.data, payload: { ...message.data.payload,
      mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/calendar', body: { data: Buffer.from('METHOD:CANCEL').toString('base64') } }] } } });
    await sync();
    expect(processInbound).toHaveBeenCalledWith(expect.objectContaining({ containsCalendarEvent: true,
      rawHeaders: expect.objectContaining({ 'auto-submitted': 'auto-generated' }) }));
  });
  it('binds the exact account and processes inbound messages without advancing its own cursor', async () => {
    await sync();
    expect(getClient).toHaveBeenCalledWith(9, { credentialId: 31, accountIdentifier: 'owner@example.test' });
    expect(processInbound).toHaveBeenCalledWith(expect.objectContaining({ receivingUserId: 9, recipientEmails: ['owner@example.test'] }));
    expect(updates()).toHaveLength(0);
  });
  it('propagates credential and processing failures to the durable worker', async () => {
    getClient.mockResolvedValueOnce(null); await expect(sync()).rejects.toThrow('Gmail client unavailable');
    processInbound.mockResolvedValueOnce({ success: false, error: 'database unavailable' });
    await expect(sync()).rejects.toThrow('Inbound message processing failed');
  });
  it('accepts durable duplicate messages', async () => {
    processInbound.mockResolvedValueOnce({ duplicate: true }); await sync();
  });
  it('fetches every history page and deduplicates message ids', async () => {
    historyList.mockResolvedValueOnce({ data: { history: [{ messagesAdded: [{ message: { id: 'm1' } }] }], nextPageToken: 'page2' } })
      .mockResolvedValueOnce({ data: { history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }] } });
    await sync();
    expect(historyList).toHaveBeenLastCalledWith(expect.objectContaining({ pageToken: 'page2', startHistoryId: '100' }));
    expect(processInbound).toHaveBeenCalledTimes(2);
  });
  it('propagates a failed fetch without processing a partial batch', async () => {
    historyList.mockResolvedValueOnce({ data: { history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }] } });
    messageGet.mockResolvedValueOnce(mail()).mockRejectedValueOnce(new Error('network failure'));
    await expect(sync()).rejects.toThrow('network failure'); expect(processInbound).not.toHaveBeenCalled();
  });
  it('traverses every fallback page after history expiry', async () => {
    historyList.mockRejectedValueOnce({ code: 404 });
    messageList.mockResolvedValueOnce({ data: { messages: [{ id: 'm1' }], nextPageToken: 'next' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'm2' }] } });
    await sync(); expect(messageList).toHaveBeenLastCalledWith(expect.objectContaining({ pageToken: 'next' }));
    expect(processInbound).toHaveBeenCalledTimes(2);
  });
});
