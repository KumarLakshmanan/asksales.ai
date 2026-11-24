import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { pathToFileURL } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let crmEnabled = true;
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => [{ key: 'crm', enabled: crmEnabled }] }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ requireBusinessScope: () => ({ userId: 1, businessProfileId: 10 }) }));
const { threadReporting } = await import('../services/ThreadReportingService.js');
type Engine = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; close: () => Promise<void> };
let engine: Engine;
const dialect = new PgDialect();
const executor = { execute: (query: SQL) => { const c = dialect.sqlToQuery(query); return engine.query(c.sql, c.params); } };
const modulePath = process.env.SUPPRESSION_QA_PGLITE_MODULE;
const suite = modulePath ? describe : describe.skip;

suite('complete campaign cohort reporting in isolated PostgreSQL', () => {
  beforeAll(async () => {
    const module = await import(pathToFileURL(modulePath!).href) as { PGlite: new () => Engine };
    engine = new module.PGlite();
    await engine.exec(`CREATE TABLE crm_contacts(id int,user_id int,business_profile_id int,lead_id int,merged_into_contact_id int);
      CREATE TABLE sales_outcome_events(id int,user_id int,business_profile_id int,contact_id int,kind text,occurred_at timestamptz,channel text);
      CREATE TABLE leads(id int,user_id int,business_profile_id int,deleted_at timestamp,campaign_data jsonb,prompt_id int,source text,status text,lead_status text);
      CREATE TABLE icp_profiles(id int,user_id int,business_profile_id int,thread_id int);
      CREATE TABLE sent_messages(id int,user_id int,business_profile_id int,lead_id int,is_reply boolean,status text,delivery_status text,delivered_at timestamp,sent_at timestamp,opened_at timestamp,open_count int,reply_received_at timestamp);
      CREATE TABLE content_assets(id int,user_id int,business_profile_id int,thread_id int);
      INSERT INTO leads SELECT number,1,10,NULL,'{"threadId":42}',NULL,
        CASE WHEN number<=400 THEN 'linkedin' ELSE 'google' END,'new',CASE WHEN number>400 THEN 'custom_qualified' END FROM generate_series(1,500) number;
      INSERT INTO crm_contacts VALUES(1,1,10,1,NULL),(2,1,10,2,1),(3,1,10,3,NULL),(4,1,11,501,NULL);
      INSERT INTO sales_outcome_events VALUES(10,1,10,2,'contact_won','2026-09-15T12:00:00Z','email'),
        (11,1,10,1,'contact_won','2026-09-15T12:00:00Z','whatsapp'),(12,1,10,1,'contact_won','2026-10-01T12:00:00Z','email'),
        (13,1,11,4,'contact_won','2026-09-15T12:00:00Z','email');
      INSERT INTO sent_messages SELECT number,1,10,1,false,'sent',NULL,NULL,'2026-09-15',NULL,0,NULL FROM generate_series(1,500) number;
      UPDATE sent_messages SET status='replied',reply_received_at='2026-09-16' WHERE id=2;
      INSERT INTO sent_messages VALUES(501,1,10,3,false,'pending',NULL,NULL,'2026-09-15',NULL,0,NULL),
        (502,1,10,3,false,'draft',NULL,NULL,'2026-09-15',NULL,0,NULL),
        (503,1,10,3,true,'sent',NULL,NULL,'2026-09-15',NULL,0,NULL),
        (504,1,11,1,false,'sent',NULL,NULL,'2026-09-15',NULL,0,NULL),
        (505,2,10,1,false,'sent',NULL,NULL,'2026-09-15',NULL,0,NULL);
      INSERT INTO content_assets SELECT number,1,10,42 FROM generate_series(1,101) number;
      INSERT INTO content_assets VALUES(102,1,11,42),(103,2,10,42);
      INSERT INTO leads VALUES(501,1,11,NULL,'{"threadId":42}',NULL,'foreign','converted',NULL),
        (502,2,10,NULL,'{"threadId":42}',NULL,'foreign','converted',NULL),
        (503,1,10,now(),' {"threadId":42}',NULL,'retired','converted',NULL);
      ALTER TABLE sent_messages ADD COLUMN channel text DEFAULT 'email';
      ALTER TABLE leads ADD COLUMN legacy_campaign_thread_key text GENERATED ALWAYS AS (
        CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10 THEN campaign_data->>'threadId' END) STORED;
      INSERT INTO icp_profiles VALUES(70,1,10,77),(71,1,11,77),(72,1,10,78);
      INSERT INTO leads VALUES(701,1,10,NULL,NULL,70,'icp','new',NULL),
        (702,1,10,NULL,'{"threadId":77}',70,'both','new',NULL),
        (703,1,10,NULL,'{"threadId":"77"}',NULL,'legacy','new',NULL),
        (704,1,10,NULL,NULL,71,'foreign','new',NULL),
        (705,1,10,NULL,NULL,72,'other','new',NULL),
        (706,1,10,now(),NULL,70,'retired','new',NULL),
        (707,1,10,NULL,'{"threadId":"0000000077"}',NULL,'padded','new',NULL);`);
  });
  afterAll(async () => { await engine?.close(); });

  it('redacts CRM outcomes when the CRM module is unavailable', async () => {
    crmEnabled = false;
    try {
      expect(await threadReporting(1, 42, executor)).toMatchObject({ crmContacts: null, convertedContacts: null });
    } finally { crmEnabled = true; }
  });

  it('counts 500 leads, 502 messages and 101 assets without preview caps or tenant leakage', async () => {
    expect(await threadReporting(1, 42, executor)).toMatchObject({ leads: 500, messages: 502, sent: 500, pending: 1, contentAssets: 101 });
  });
  it('preserves full source and custom lifecycle distributions', async () => {
    expect(await threadReporting(1, 42, executor)).toMatchObject({ bySource: { linkedin: 400, google: 100 }, byStatus: { new: 400, custom_qualified: 100 } });
  });
  it('uses distinct contacted leads and immutable first CRM wins rather than message counts', async () => {
    const summary = await threadReporting(1, 42, executor);
    expect(summary).toMatchObject({ contactedLeads: 1, engagedLeads: 1, convertedContacts: 1, crmContacts: 2 });
    expect(summary.channels).toEqual([{ name: 'email', outreach: 500, replied: 1 }]);
    expect(summary.timeline).toEqual([{ week: '2026-09-14', outreached: 500 }]);
  });
  it('joins ICP and legacy leads once each and keeps tenant and deleted leads out', async () => {
    expect(await threadReporting(1, 77, executor, false)).toMatchObject({ leads: 3, bySource: { icp: 1, both: 1, legacy: 1 } });
  });
  it('returns an empty cohort and rejects an owner mismatch', async () => {
    expect(await threadReporting(1, 99, executor)).toMatchObject({ leads: 0, messages: 0, convertedContacts: 0, byStatus: {}, channels: [], timeline: [] });
    await expect(threadReporting(2, 42, executor)).rejects.toThrow('active business');
  });
});
