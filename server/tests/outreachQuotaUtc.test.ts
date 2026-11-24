import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { pathToFileURL } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Engine = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; close: () => Promise<void> };
let engine: Engine;
let now = '2026-11-06T00:15:00Z';
const dialect = new PgDialect();
const executor = { execute: async (query: SQL) => {
  const compiled = dialect.sqlToQuery(query);
  // Single-session fixture checks quota arithmetic, not advisory lock concurrency.
  if (compiled.sql.includes('pg_advisory_xact_lock')) return { rows: [] };
  return engine.query(compiled.sql.replace(/now\(\)/gi, `'${now}'::timestamptz`), compiled.params);
} };
jest.unstable_mockModule('../models/db.js', () => ({ db: { ...executor, transaction: async (work: (tx: typeof executor) => Promise<unknown>) => work(executor) } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ businessCacheKey: (key: string) => key }));
const { withCreationDailyQuota } = await import('../services/outreach/QuotaService.js');
const modulePath = process.env.SUPPRESSION_QA_PGLITE_MODULE;
const suite = modulePath ? describe : describe.skip;

suite('UTC campaign-start daily quota arithmetic in isolated PostgreSQL', () => {
  beforeAll(async () => {
    const module = await import(pathToFileURL(modulePath!).href) as { PGlite: new () => Engine };
    engine = new module.PGlite();
    await engine.exec(`CREATE TABLE outreach_settings(user_id int,daily_email_limit int);
      INSERT INTO outreach_settings VALUES(1,1);
      CREATE TABLE outreach_conversations(id int,user_id int,channel text);
      CREATE TABLE outreach_messages(id int,conversation_id int,direction text,status text,sent_at timestamp,provider_call_state text,send_claimed_at timestamp,external_message_id text,provider_message_id text,rfc_message_id text);
      CREATE TABLE outreach_jobs(user_id int,channel text,sent_at timestamp,metadata jsonb,external_message_id text);`);
  });
  afterAll(async () => { await engine?.close(); });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])('uses one UTC day with session timezone %s', async timezone => {
    await engine.query("SELECT set_config('TimeZone',$1,false)", [timezone]);
    now = '2026-11-06T00:15:00Z';
    await engine.exec(`TRUNCATE outreach_jobs; INSERT INTO outreach_jobs VALUES(1,'email',NULL,'{"providerCallStarted":true,"providerStartedAt":"2026-11-05T23:55:00Z"}',NULL);`);
    const dispatch = jest.fn(async () => 'claimed');
    expect(await withCreationDailyQuota(1, 'email', dispatch as never)).toBe('claimed');
    expect(dispatch).toHaveBeenCalledTimes(1);

    now = '2026-11-06T23:15:00Z';
    await engine.exec(`TRUNCATE outreach_jobs; INSERT INTO outreach_jobs VALUES(1,'email',NULL,'{"providerCallStarted":true,"providerStartedAt":"2026-11-06T00:05:00Z"}',NULL);`);
    dispatch.mockClear();
    expect(await withCreationDailyQuota(1, 'gmail', dispatch as never)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('counts a projected provider receipt once rather than twice', async () => {
    await engine.exec(`SET TIME ZONE 'UTC'; TRUNCATE outreach_jobs,outreach_messages,outreach_conversations;
      INSERT INTO outreach_conversations VALUES(7,1,'gmail');
      INSERT INTO outreach_messages VALUES(1,7,'outbound','sent','2026-11-06 00:05:00',NULL,NULL,'fixture-receipt',NULL,NULL);
      INSERT INTO outreach_jobs VALUES(1,'email','2026-11-06 00:05:00','{}','fixture-receipt');
      UPDATE outreach_settings SET daily_email_limit=2 WHERE user_id=1;`);
    expect(await withCreationDailyQuota(1, 'email', async () => 'claimed')).toBe('claimed');
  });
});
