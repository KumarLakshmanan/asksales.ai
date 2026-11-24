import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { pathToFileURL } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { dashboardCacheMatchesCrmAccess, dashboardUtcWeekStart, isDashboardReportingCacheCurrent } from '../../shared/dashboardReporting.js';

let crmEnabled = true;
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => [{ key: 'crm', enabled: crmEnabled }] }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ requireBusinessScope: () => ({ userId: 1, businessProfileId: 10 }) }));
const { dashboardReporting } = await import('../services/DashboardReportingService.js');
const { dashboardUsage } = await import('../services/DashboardUsageService.js');
type Engine = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; close: () => Promise<void> };
let engine: Engine;
const dialect = new PgDialect();
const executor = { execute: (query: SQL) => { const c = dialect.sqlToQuery(query); return engine.query(c.sql, c.params); } };
const modulePath = process.env.SUPPRESSION_QA_PGLITE_MODULE;
const suite = modulePath ? describe : describe.skip;

it('invalidates cached stats without the current chart contract', () => {
  expect(isDashboardReportingCacheCurrent({ spendByCurrency: {}, budgetByCurrencyAndType: [] })).toBe(false);
  const current = { reportingVersion: 2, recordedWins: { rate: '0.0', coverage: 'recorded_events_only' }, dailyActivity: [], campaignPerformance: [] };
  expect(isDashboardReportingCacheCurrent(current)).toBe(true);
  expect(dashboardCacheMatchesCrmAccess(current, true)).toBe(true);
  expect(dashboardCacheMatchesCrmAccess(current, false)).toBe(false);
  expect(dashboardCacheMatchesCrmAccess({ ...current, recordedWins: { rate: null, coverage: 'restricted' } }, false)).toBe(true);
  expect(isDashboardReportingCacheCurrent({ reportingVersion: 1, dailyActivity: [] })).toBe(false);
});

it('uses Sunday UTC week boundaries across local midnight', () => {
  expect(dashboardUtcWeekStart(new Date('2026-11-08T00:01:00Z')).toISOString()).toBe('2026-11-08T00:00:00.000Z');
  expect(dashboardUtcWeekStart(new Date('2026-11-08T00:01:00+05:30')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
});

suite('dashboard aggregates in isolated PostgreSQL', () => {
  beforeAll(async () => {
    const module = await import(pathToFileURL(modulePath!).href) as { PGlite: new () => Engine };
    engine = new module.PGlite();
    await engine.exec(`SET TIME ZONE 'Asia/Kolkata';
      CREATE TABLE crm_contacts(id int,user_id int,business_profile_id int,lead_id int,merged_into_contact_id int);
      CREATE TABLE sales_outcome_events(id int,user_id int,business_profile_id int,contact_id int,kind text,occurred_at timestamptz,channel text);
      INSERT INTO crm_contacts VALUES(1,1,10,1,NULL),(2,1,10,1,1),(3,1,10,NULL,NULL),(4,2,10,NULL,NULL);
      INSERT INTO sales_outcome_events VALUES(20,1,10,2,'contact_won','2026-11-06T00:02:00Z','email'),
        (10,1,10,1,'contact_won','2026-11-06T00:02:00Z','whatsapp'),(21,1,10,1,'contact_won','2026-11-06T00:03:00Z','email'),
        (22,2,10,4,'contact_won','2026-11-06T00:02:00Z','whatsapp');
      CREATE TABLE leads(id int,user_id int,business_profile_id int,created_at timestamp,updated_at timestamp,lead_type text);
      CREATE TABLE sent_messages(id int,user_id int,business_profile_id int,lead_id int,campaign_id int,is_reply boolean,status text,delivery_status text,delivered_at timestamp,sent_at timestamp,opened_at timestamp,open_count int,reply_received_at timestamp);
      CREATE TABLE outreach_campaigns(id int,user_id int,business_profile_id int,name text);
      INSERT INTO leads VALUES(1,1,10,'2026-11-06 00:01:00','2026-11-06 00:02:00','customer'),
        (2,1,11,'2026-11-06','2026-11-06','customer'),(3,2,10,'2026-11-06','2026-11-06','customer');
      INSERT INTO outreach_campaigns SELECT number,1,10,'Campaign '||number FROM generate_series(1,11) number;
      INSERT INTO sent_messages SELECT number,1,10,1,number,false,'sent',NULL,NULL,'2026-11-06 00:03:00',NULL,0,NULL FROM generate_series(1,11) number;
      INSERT INTO sent_messages VALUES(20,1,10,1,1,false,'draft',NULL,NULL,'2026-11-06',NULL,0,NULL),
        (21,1,10,1,1,true,'sent',NULL,NULL,'2026-11-06',NULL,0,NULL),
        (22,1,11,2,1,false,'sent',NULL,NULL,'2026-11-06',NULL,0,NULL),
        (23,2,10,3,1,false,'sent',NULL,NULL,'2026-11-06',NULL,0,NULL);
      CREATE TABLE openai_usages(created_at timestamp,provider text,estimated_cost_cents numeric,total_tokens int,prompt_tokens int,completion_tokens int);
      CREATE TABLE apify_usages(created_at timestamp,estimated_cost_cents numeric,compute_units numeric,items_scraped int);
      CREATE TABLE gemini_usages(created_at timestamp,cost_cents numeric,images_generated int,videos_generated int);
      CREATE TABLE zerobounce_usages(created_at timestamp,cost_cents numeric,emails_validated int,valid_emails int,credits_used int);
      INSERT INTO openai_usages SELECT '2026-11-06'::timestamp,'openai',0.25,5,3,2 FROM generate_series(1,5001);
      INSERT INTO openai_usages VALUES('2026-11-06',NULL,0.5,5,3,2),('2026-11-06','openrouter',2,10,6,4),('2026-10-01','openai',99,99,99,99);
      INSERT INTO apify_usages VALUES('2026-11-06',1.25,0.5,10);`);
  });
  afterAll(async () => { await engine?.close(); });

  it('redacts CRM outcomes when the CRM module is unavailable', async () => {
    crmEnabled = false;
    try {
      const result = await dashboardReporting(1, new Date('2026-11-06T23:00:00Z'), executor);
      expect(result.recordedWins).toMatchObject({ total: null, rate: null, coverage: 'restricted' });
    } finally { crmEnabled = true; }
  });

  it('populates seven UTC buckets with scoped outbound evidence and explicitly mutable customer updates', async () => {
    const result = await dashboardReporting(1, new Date('2026-11-06T23:00:00Z'), executor);
    expect(result.dailyActivity).toHaveLength(7);
    expect(result.dailyActivity[0]).toEqual({ date: '2026-10-31', leads: 0, messages: 0, customerUpdates: 0, recordedWins: 0 });
    expect(result.dailyActivity[6]).toEqual({ date: '2026-11-06', leads: 1, messages: 11, customerUpdates: 1, recordedWins: 1 });
    expect(result.reporting.customerUpdates).toBe('mutable_customer_record_updates');
  });
  it('counts recorded first wins once after merges without treating unrecorded customers or edits as wins', async () => {
    let result = await dashboardReporting(1, new Date('2026-11-06T23:00:00Z'), executor);
    expect(result.recordedWins).toMatchObject({ total: 1, crmContacts: 2, thisWeek: 1, rate: '50.0', coverage: 'recorded_events_only' });
    await engine.exec("UPDATE leads SET updated_at='2026-11-07' WHERE id=1");
    result = await dashboardReporting(1, new Date('2026-11-07T23:00:00Z'), executor);
    expect(result.dailyActivity.find(day => day.date === '2026-11-06')?.recordedWins).toBe(1);
    expect(result.dailyActivity.find(day => day.date === '2026-11-07')?.recordedWins).toBe(0);
    await engine.exec("UPDATE leads SET updated_at='2026-11-06 00:02:00' WHERE id=1");
    await engine.exec("INSERT INTO sales_outcome_events VALUES(1,1,10,2,'contact_won','2026-10-01T10:00:00Z','whatsapp')");
    result = await dashboardReporting(1, new Date('2026-11-06T23:00:00Z'), executor);
    expect(result.recordedWins.thisWeek).toBe(0);
    expect(result.recordedWins.total).toBe(1);
    await engine.exec('DELETE FROM sales_outcome_events WHERE id=1');
  });

  it('returns a declared top-ten campaign cohort independent of message previews', async () => {
    const result = await dashboardReporting(1, new Date('2026-11-06T23:00:00Z'), executor);
    expect(result.campaignPerformance).toHaveLength(10);
    expect(result.campaignPerformance.map(c => c.id)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(result.campaignPerformance[0]).toMatchObject({ sent: 1, opened: 0, replied: 0 });
    expect(result.reporting.campaignLimit).toBe(10);
  });
  it('returns zero-valued activity for an empty period and rejects mismatched owners', async () => {
    const result = await dashboardReporting(1, new Date('2026-09-01T12:00:00Z'), executor);
    expect(result.dailyActivity.every(day => day.leads === 0 && day.messages === 0 && day.customerUpdates === 0)).toBe(true);
    await expect(dashboardReporting(2, new Date(), executor)).rejects.toThrow('active business');
  });
  it('aggregates usage beyond 5,000 rows with fractional cost and provider separation', async () => {
    const result = await dashboardUsage(new Date('2026-11-01T00:00:00Z'), executor);
    expect(result.openai).toEqual({ totalCalls: 5002, totalCostCents: 1250.75, totalTokens: 25010, promptTokens: 15006, completionTokens: 10004 });
    expect(result.openrouter.totalCalls).toBe(1);
    expect(result.apify).toEqual({ totalRuns: 1, totalCostCents: 1.25, totalComputeUnits: 0.5, totalItemsScraped: 10 });
    expect(result.gemini.totalRequests).toBe(0);
    expect(result.zerobounce.totalCostCents).toBe(0);
  });
});
