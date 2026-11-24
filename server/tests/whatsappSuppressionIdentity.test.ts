import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { pathToFileURL } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
const { getSuppressedRecipients } = await import('../services/outreach/RecipientSuppressionService.js');
const modulePath = process.env.SUPPRESSION_QA_PGLITE_MODULE;
const suite = modulePath ? describe : describe.skip;
type Engine = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>; close: () => Promise<void> };
let engine: Engine;
const dialect = new PgDialect();
const executor = { execute: async (query: SQL) => { const compiled = dialect.sqlToQuery(query); return engine.query(compiled.sql, compiled.params); } };
const check = (channel: string, addresses: string[], userId = 1) => getSuppressedRecipients(userId, channel, addresses, executor as never);

// Optional, isolated WASM PostgreSQL fixture: no network database or provider calls.
suite('WhatsApp suppression destination identity', () => {
  beforeAll(async () => {
    const module = await import(pathToFileURL(modulePath!).href) as { PGlite: new () => Engine };
    engine = new module.PGlite();
    await engine.exec(`CREATE TABLE leads(user_id int, phone text, whatsapp text, email text, blacklisted boolean, do_not_contact boolean, email_unsubscribed boolean);
      CREATE TABLE sent_messages(user_id int, channel text, recipient_address text, lead_name text, bounced_at timestamp, status text, delivery_status text);
      INSERT INTO leads VALUES
      (1, '+91 99000 00001', '+91 (99000) 00002', 'a@example.test', true, false, false),
      (1, '+91 99000 00003', '+91 (99000) 00002', 'b@example.test', false, false, false),
      (1, '9900000004', NULL, 'c@example.test', false, true, false),
      (2, '+91 99000 00005', '+91 99000 00006', 'd@example.test', true, false, false),
      (1, '+91 99000 00007', '+91 99000 00008', 'e@example.test', false, false, true),
      (1, '0091 99000 00009', '00919900000010', 'f@example.test', false, true, false);`);
  });
  afterAll(async () => { await engine?.close(); });

  it('blocks both phone aliases even when another unblocked lead shares only WhatsApp', async () => {
    expect(await check('whatsapp', ['+91 99000 00001', '919900000002', '919900000003']))
      .toEqual(new Set(['919900000001', '919900000002']));
  });
  it('keeps SMS normalization and email-only unsubscribe independent of WhatsApp', async () => {
    expect(await check('sms', ['+919900000004', '919900000002'])).toEqual(new Set(['919900000004']));
    expect(await check('whatsapp', ['919900000004', '9900000004', '919900000008'])).toEqual(new Set(['9900000004']));
    expect(await check('email', ['E@EXAMPLE.TEST'])).toEqual(new Set(['e@example.test']));
  });
  it('matches a blocked number saved with a 00 international prefix', async () => {
    expect(await check('whatsapp', ['919900000009', '+91 99000 00010', '0091 99000 00009']))
      .toEqual(new Set(['919900000009', '919900000010']));
  });
  it('does not include a different owner’s blocked aliases', async () => {
    expect(await check('whatsapp', ['919900000005', '919900000006'])).toEqual(new Set());
  });
});
