import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { mockRequest, mockResponse } from './helpers/mockHelpers.js';

type Engine = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; close: () => Promise<void> };
let engine: Engine;
let crmEnabled = true;
const dialect = new PgDialect();
const execute = (query: SQL) => { const c = dialect.sqlToQuery(query); return engine.query(c.sql, c.params); };
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => [{ key: 'crm', enabled: crmEnabled }] }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const handlers = await import('../controllers/legacyCampaignAnalyticsController.js');
const { readLegacyCampaignAnalytics, readLegacyCampaignTrends } = await import('../services/LegacyCampaignAnalyticsService.js');
const modulePath = process.env.SUPPRESSION_QA_PGLITE_MODULE;
const suite = modulePath ? describe : describe.skip;

const app = express(); app.use(express.json());
app.use((req, _res, next) => {
  // Fixture-only identities; no authentication, provider, or production calls.
  if (!req.get('x-fixture-actor')) return next();
  const id = Number(req.get('x-fixture-actor'));
  req.user = { id, email: 'fixture@example.test', role: req.get('x-fixture-role') === 'admin' ? 'admin' : 'user' };
  if (req.get('x-fixture-scope') === 'system') return withSystemScope('Authenticated administrator', next);
  return withBusinessScope({ userId: 1, businessProfileId: Number(req.get('x-fixture-business') || 10), actorUserId: id }, next);
});
app.get('/admin/campaign-analytics', handlers.getCampaignAnalytics);
app.get('/legacy/analytics/:id', handlers.getCampaignAnalytics);
app.get('/legacy/analytics/:id/trends', handlers.getCampaignPerformanceTrends);
app.get('/legacy/analytics/:id/hooks', handlers.getTopHooksAndHashtags);
app.post('/legacy/compare', handlers.compareCampaigns);
const business = (url: string) => request(app).get(url).set('x-fixture-actor', '1');

describe('legacy analytics authorization without a database', () => {
  it('rejects an admin role string without authenticated system scope', async () => {
    const res = mockResponse();
    await handlers.getCampaignAnalytics(mockRequest({ user: { id: 9, email: 'fixture@example.test', role: 'admin' } }), res);
    expect(res._status).toBe(403);
  });
  it.each([handlers.getCampaignAnalytics, handlers.getCampaignPerformanceTrends, handlers.getTopHooksAndHashtags, handlers.compareCampaigns])('requires an authenticated principal', async handler => {
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });
  it('rejects non-administrators in system scope', async () => {
    const res = mockResponse();
    await withSystemScope('Fixture system scope', () => handlers.getCampaignAnalytics(mockRequest({ user: { id: 1, email: 'fixture@example.test', role: 'user' } }), res));
    expect(res._status).toBe(403);
  });
});

suite('legacy campaign reporting scope and conversion evidence', () => {
  beforeAll(async () => {
    const module = await import(pathToFileURL(modulePath!).href) as { PGlite: new () => Engine };
    engine = new module.PGlite();
    await engine.exec(`SET TIME ZONE 'Asia/Kolkata';
      CREATE TABLE campaigns(id int,user_id int,business_profile_id int,name text,status text,budget int,spent int,start_date timestamp,end_date timestamp,created_at timestamp);
      INSERT INTO campaigns VALUES(1,1,10,'Legacy A','active',100,20,'2026-09-01',NULL,'2026-09-01'),
        (2,1,10,'Legacy B','completed',200,30,'2026-09-01',NULL,'2026-09-01'),
        (3,1,11,'Same owner foreign business','active',9999,9999,'2026-09-01',NULL,'2026-09-01'),
        (4,2,20,'Foreign owner','active',8888,8888,'2026-09-01',NULL,'2026-09-01'),
        (5,1,10,'Empty legacy campaign','draft',0,0,'2026-09-01',NULL,'2026-09-01');
      CREATE TABLE leads(id int,user_id int,business_profile_id int,campaign_data jsonb,deleted_at timestamp,created_at timestamp,updated_at timestamp,
        email_status text,phone text,source text,fit_score int,linkedin_follower_count int,twitter_followers int,linkedin text,twitter text,lead_type text);
      INSERT INTO leads VALUES
        (1,1,10,'{"campaignId":1}',NULL,'2026-09-15','2026-09-15','valid','+919900000001','linkedin',80,100,20,'https://example.test/profile',NULL,'profile'),
        (2,1,10,'{"campaignId":"2"}',NULL,'2026-09-15','2026-09-15',NULL,NULL,'google',40,0,0,NULL,NULL,'customer'),
        (3,1,11,'{"campaignId":1}',NULL,'2026-09-15','2026-09-15','valid',NULL,'foreign-business',99,999,0,NULL,NULL,'customer'),
        (4,2,20,'{"campaignId":1}',NULL,'2026-09-15','2026-09-15','valid',NULL,'foreign-owner',99,888,0,NULL,NULL,'customer'),
        (5,1,10,'{"campaignId":1}',now(),'2026-09-15','2026-09-15','valid',NULL,'retired',99,777,0,NULL,NULL,'customer');
      CREATE TABLE crm_contacts(id int,user_id int,business_profile_id int,lead_id int,merged_into_contact_id int);
      INSERT INTO crm_contacts VALUES(1,1,10,1,NULL),(2,1,10,1,1),(3,1,10,2,NULL),(4,1,11,3,NULL),(5,2,20,4,NULL),
        (6,1,10,2,4);
      CREATE TABLE sales_outcome_events(id int,user_id int,business_profile_id int,contact_id int,kind text,occurred_at timestamptz,channel text);
      INSERT INTO sales_outcome_events VALUES
        (10,1,10,1,'contact_won','2026-09-10T12:00:00Z','whatsapp'),(20,1,10,2,'contact_won','2026-09-10T12:00:00Z','email'),
        (30,1,10,1,'contact_won','2026-10-01T12:00:00Z','email'),(40,1,11,4,'contact_won','2026-09-10T12:00:00Z','email'),
        (50,2,20,5,'contact_won','2026-09-10T12:00:00Z','whatsapp'),(60,2,20,1,'contact_won','2026-09-09T12:00:00Z','email');
      CREATE TABLE sent_messages(id int,user_id int,business_profile_id int,lead_id int,campaign_id int,is_reply boolean,status text,delivery_status text,delivered_at timestamp,
        sent_at timestamp,channel text,opened_at timestamp,open_count int,clicked_at timestamp,click_count int,reply_received_at timestamp);
      INSERT INTO sent_messages VALUES
        (1,1,10,1,2,false,'replied',NULL,NULL,'2026-09-15','gmail',NULL,0,NULL,0,'2026-09-16'),
        (2,1,10,2,1,false,'sent',NULL,NULL,'2026-09-15','email',NULL,0,NULL,0,NULL),
        (3,1,10,1,1,true,'sent',NULL,NULL,'2026-09-15','email',NULL,0,NULL,0,NULL),
        (4,1,11,1,1,false,'sent',NULL,NULL,'2026-09-15','email',NULL,0,NULL,0,NULL),
        (5,1,11,3,1,false,'sent',NULL,NULL,'2026-09-15','email',NULL,0,NULL,0,NULL),
        (6,2,20,4,1,false,'sent',NULL,NULL,'2026-09-15','whatsapp',NULL,0,NULL,0,NULL),
        (7,1,10,1,1,false,'draft',NULL,NULL,'2026-09-15','email',NULL,0,NULL,0,NULL);`);
  });
  afterAll(async () => { await engine?.close(); });

  it('scopes a legacy campaign by owner, business and lead linkage, not coincidental outreach campaign IDs', async () => {
    const response = await business('/legacy/analytics/1').expect(200);
    expect(response.body).toMatchObject({ leadsGenerated: 1, totalOutreached: 1, totalSpend: null, rawSpendUnits: 20,
      revenue: { convertedLeads: 1, linkedCrmContacts: 1, recordedWinRate: 100 },
      emailPerformance: { totalSent: 1, replyRate: 100 }, socialMedia: { totalFollowers: 120 },
      reporting: { campaignDomain: 'legacy_campaigns', campaignId: 1, campaignAttribution: false } });
    expect(response.body.channelData).toEqual([{ channel: 'email', outreached: 1, sent: 1, replied: 1, conversions: 0 },
      { channel: 'whatsapp', outreached: 0, sent: 0, replied: 0, conversions: 1 }]);
  });
  it('does not turn sent receipts or customer entity classifications into conversions', async () => {
    const response = await business('/legacy/analytics/2').expect(200);
    expect(response.body.leadsGenerated).toBe(1);
    expect(response.body.revenue.convertedLeads).toBe(0);
    expect(response.body.channelData).toEqual([{ channel: 'email', outreached: 1, sent: 1, replied: 0, conversions: 0 }]);
  });
  it.each(['3','4','999'])('returns the same 404 for inaccessible or absent campaign %s', async id => {
    expect((await business('/legacy/analytics/' + id).expect(404)).body).toEqual({ message: 'Campaign not found' });
  });
  it.each(['1abc','0','2147483648'])('rejects malformed or out-of-range ID %s', async id => {
    await business('/legacy/analytics/' + id).expect(400);
  });
  it('never grants platform scope from an admin role string inside business scope', async () => {
    const response = await business('/legacy/analytics/1').set('x-fixture-role','admin').expect(200);
    expect(response.body.leadsGenerated).toBe(1);
    expect(response.body.reporting.scope).toBe('business');
    await business('/admin/campaign-analytics').set('x-fixture-role','admin').expect(400);
    await expect(withBusinessScope({userId:1,businessProfileId:10}, () => readLegacyCampaignAnalytics({kind:'platform'}))).rejects.toMatchObject({ status:403 });
  });
  it('allows platform aggregates only for an administrator in system scope, preserving merge and event tenant boundaries', async () => {
    const response = await request(app).get('/admin/campaign-analytics').set('x-fixture-actor','9').set('x-fixture-role','admin').set('x-fixture-scope','system').expect(200);
    expect(response.body.leadsGenerated).toBe(4);
    expect(response.body.revenue.convertedLeads).toBe(3);
    expect(response.body.channelData).toEqual([{channel:'email',outreached:3,sent:3,replied:1,conversions:1},{channel:'whatsapp',outreached:1,sent:1,replied:0,conversions:2}]);
    await request(app).get('/admin/campaign-analytics').set('x-fixture-actor','1').set('x-fixture-scope','system').expect(403);
    await request(app).get('/admin/campaign-analytics').expect(401);
  });
  it('returns unavailable outcomes when CRM access is disabled, while retaining receipt evidence', async () => {
    crmEnabled=false;
    try {
      const response=await business('/legacy/analytics/1').expect(200);
      expect(response.body.revenue.convertedLeads).toBeNull();
      expect(response.body.channelData.every((row: {conversions: unknown}) => row.conversions===null)).toBe(true);
      expect(response.body.emailPerformance.totalSent).toBe(1);
    } finally {crmEnabled=true;}
  });
  it('keeps empty-cohort rates and unsupported revenue/sentiment unavailable', async () => {
    const response=await business('/legacy/analytics/5').expect(200);
    expect(response.body).toMatchObject({leadsGenerated:0,emailPerformance:{totalSent:0,openRate:null},roi:null,totalRevenue:null,sentiment:{positive:null}});
  });
  it('uses recorded win dates independently of lead edit/creation dates, and scopes trends/hooks', async () => {
    await engine.exec("UPDATE leads SET updated_at='2026-11-06' WHERE id=1");
    const response=await business('/legacy/analytics/1/trends?period=90d').expect(200);
    expect(response.headers['x-reporting-basis']).toBe('recorded-event-dates-utc');
    const dated = await withBusinessScope({userId:1,businessProfileId:10}, () => readLegacyCampaignTrends({kind:'business',userId:1,businessProfileId:10,campaignId:1},new Date('2026-09-01T00:00:00Z')));
    expect(dated).toEqual([{date:'2026-09-10',leadsCreated:0,leadsContacted:0,leadsEnriched:null,recordedWins:1,basis:'recorded_event_dates_utc'},
      {date:'2026-09-15',leadsCreated:1,leadsContacted:1,leadsEnriched:null,recordedWins:0,basis:'recorded_event_dates_utc'}]);
    await business('/legacy/analytics/3/trends').expect(404);
    await business('/legacy/analytics/3/hooks').expect(404);
    await business('/legacy/analytics/1/trends?period=invalid').expect(400);
  });
  it('compares only a wholly authorized selection with immutable outcomes', async () => {
    const response=await request(app).post('/legacy/compare').set('x-fixture-actor','1').send({campaignIds:[1,2]}).expect(200);
    expect(response.body.campaigns.map((row: {metrics:{convertedLeads:number,totalOutreach:number}}) => [row.metrics.convertedLeads,row.metrics.totalOutreach])).toEqual([[1,1],[0,1]]);
    await request(app).post('/legacy/compare').set('x-fixture-actor','1').send({campaignIds:[1,3]}).expect(404);
    await request(app).post('/legacy/compare').set('x-fixture-actor','1').send({campaignIds:[1,1]}).expect(400);
  });
  it('does not cast malformed or oversized JSON cohort IDs into database integers', async () => {
    await engine.exec(`INSERT INTO leads(id,user_id,business_profile_id,campaign_data,source,created_at)
      VALUES(99,1,10,'{"campaignId":"999999999999999999999999999999999"}','malformed',now());`);
    try {
      expect((await business('/legacy/analytics/1').expect(200)).body.leadsGenerated).toBe(1);
      await request(app).post('/legacy/compare').set('x-fixture-actor','1').send({campaignIds:[1,2]}).expect(200);
    } finally { await engine.exec('DELETE FROM leads WHERE id=99'); }
  });
});
