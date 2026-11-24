import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const connectionString = process.env.GMAIL_QA_DATABASE_URL;
const localSuite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (...args: Parameters<NodePgDatabase['execute']>) => database.execute(...args),
} }));
const { persistGmailWatch, persistGmailWatchFailure } = await import('../services/GmailWatchService.js');

localSuite('Gmail watch receipts in isolated local PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('An explicit local QA database is required');
    }
    client = new Client({ connectionString });
    await client.connect();
    await client.query('SET search_path TO pg_temp, pg_catalog');
    await client.query(`CREATE TEMP TABLE channel_credentials (
      id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT, is_active BOOLEAN,
      session_data JSONB, updated_at TIMESTAMP
    )`);
    database = drizzle(client);
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client.query(`TRUNCATE channel_credentials;
      INSERT INTO channel_credentials VALUES
        (31,9,'gmail_api',true,'{"lastHistoryId":"100","watchRenewalStatus":"failed","scope":"read"}',NOW()),
        (32,9,'gmail_api',true,'{"lastHistoryId":"200"}',NOW()),
        (33,10,'gmail_api',true,'{"lastHistoryId":"300"}',NOW()),
        (34,9,'gmail_api',false,'{"lastHistoryId":"400"}',NOW())`);
  });
  it('renews only the exact account without advancing past unprocessed mail', async () => {
    await persistGmailWatch(9, 31, '1790412472151', '999');
    const rows = (await client.query('SELECT id,session_data FROM channel_credentials ORDER BY id')).rows;
    expect(rows).toEqual([
      { id: 31, session_data: { lastHistoryId: '100', watchExpiration: '1790412472151', scope: 'read' } },
      { id: 32, session_data: { lastHistoryId: '200' } },
      { id: 33, session_data: { lastHistoryId: '300' } },
      { id: 34, session_data: { lastHistoryId: '400' } },
    ]);
  });
  it('initializes a new mailbox cursor without losing large provider identifiers', async () => {
    await client.query('UPDATE channel_credentials SET session_data=NULL WHERE id=31');
    await persistGmailWatch(9, 31, '1790412472151', '90071992547409931234');
    expect((await client.query('SELECT session_data FROM channel_credentials WHERE id=31')).rows[0].session_data)
      .toEqual({ lastHistoryId: '90071992547409931234', watchExpiration: '1790412472151' });
  });
  it('preserves progress made by a webhook before the renewal write', async () => {
    await client.query(`UPDATE channel_credentials SET session_data='{"lastHistoryId":"1000"}' WHERE id=31`);
    await persistGmailWatch(9, 31, '1790412472151', '999');
    expect((await client.query('SELECT session_data FROM channel_credentials WHERE id=31')).rows[0].session_data.lastHistoryId).toBe('1000');
  });
  it('rejects foreign, disconnected, and missing credentials', async () => {
    for (const id of [33, 34, 99]) await expect(persistGmailWatch(9, id, '1790412472151', '999')).rejects.toThrow('no longer active');
  });
  it('records initial-watch retry without advancing the inbox cursor or reviving inactive accounts', async () => {
    await persistGmailWatchFailure(9,31);await persistGmailWatchFailure(9,34);
    const rows=(await client.query('SELECT id,session_data FROM channel_credentials WHERE id IN (31,34) ORDER BY id')).rows;
    expect(rows[0].session_data).toMatchObject({lastHistoryId:'100',watchRenewalStatus:'failed'});
    expect(rows[0].session_data.watchRenewalRetryAfter).toBeTruthy();
    expect(rows[1].session_data).toEqual({lastHistoryId:'400'});
  });
  it('does not write an incomplete provider receipt', async () => {
    await expect(persistGmailWatch(9, 31, undefined, '999')).rejects.toThrow('incomplete');
    await expect(persistGmailWatch(9, 31, '1790412472151', 'invalid')).rejects.toThrow('incomplete');
    expect((await client.query('SELECT session_data FROM channel_credentials WHERE id=31')).rows[0].session_data.watchExpiration).toBeUndefined();
  });
});
