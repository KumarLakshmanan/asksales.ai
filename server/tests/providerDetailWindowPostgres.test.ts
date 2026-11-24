import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Route validation/controller/service/SQL remain real. Unrelated effects and the
// authentication/module/credit authority are isolated synthetic fixture gates.
const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
const blocked = (_req: express.Request, res: express.Response) => res.status(501).json({ error: 'Unrelated fixture action' });
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: pass }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => pass }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ requireCredits: pass }));
jest.unstable_mockModule('../routes/creativeIntelligence.routes.js', () => ({ default: express.Router() }));
jest.unstable_mockModule('../controllers/campaignController.js', () => Object.fromEntries([
  'getCampaigns', 'getCampaign', 'createCampaign', 'updateCampaign', 'archiveCampaign',
  'saveCampaignPlan', 'regenerateCampaignPlan', 'requestAICampaignPlan',
].map(name => [name, blocked])));
jest.unstable_mockModule('../controllers/performanceMarketingController.js', () => Object.fromEntries([
  'generateBudgetPlan', 'generateCampaign', 'getBudgetPlans', 'getCampaigns', 'getCampaignById',
  'getMetaPages', 'getMetaCampaigns', 'getMetaCampaignAdsets', 'getMetaCampaignInsights', 'getMetaAccountInsights',
  'getCachedCampaigns', 'getCachedAdsets', 'refreshPerformanceCache', 'clearPerformanceCache',
  'pauseMetaCampaign', 'resumeMetaCampaign', 'deleteMetaCampaign', 'pauseMetaAdset', 'resumeMetaAdset',
  'deleteMetaAdset', 'pauseMetaAd', 'resumeMetaAd', 'deleteMetaAd', 'ensureMetaCampaignPerformanceCache',
].map(name => [name, blocked])));
const { default: campaignRoutes } = await import('../routes/campaigns.routes.js');
const { adPerformanceService } = await import('../services/ads/AdPerformanceService.js');

const localQA = process.env.PROVIDER_WINDOW_LOCAL_QA === '1' ? describe : describe.skip;
const container = `provider-window-qa-${process.pid}`;
let directory: string;
let socketDirectory: string;
let created = false;
let client: pg.Client;
let database: NodePgDatabase;
const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { user: { id: 9 } });
  withBusinessScope({ userId: 9, actorUserId: 9, businessProfileId: 11 }, next);
});
app.use('/api/campaigns', campaignRoutes);

function raw(points: Array<Record<string, unknown>>) {
  return {
    campaign: { objective: 'OUTCOME_SALES' },
    accountIdentity: { currency: 'USD', adAccountId: '123' },
    reportingWindow: { start: '2026-07-01', end: '2026-10-23' },
    dailyInsights: points,
  };
}
function point(date: string, spend: number, conversions = 1.25) {
  return { date, spend, impressions: spend * 100, clicks: spend, conversions, leads: conversions };
}
async function seed(points: Array<Record<string, unknown>>) {
  await client.query('TRUNCATE campaign_performance_cache');
  for (const [id, type, key, parent] of [[101, 'campaign', '777', null], [102, 'adset', '778', '777']] as const) {
    await client.query(`INSERT INTO campaign_performance_cache
      (id,user_id,platform,ad_account_id,entity_type,platform_entity_id,parent_entity_id,name,status,
       last_refreshed_at,raw_data,spend,impressions,clicks,conversions,conversion_value)
      VALUES($1,9,'meta','123',$2,$3,$4,'Synthetic window fixture','ACTIVE',NOW(),$5::jsonb,90,900,90,9,180)`,
    [id, type, key, parent, JSON.stringify(raw(points))]);
  }
}

localQA('provider detail windows against disposable PostgreSQL and mounted routes', () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'provider-window-qa-'));
    socketDirectory = join(directory, 'socket'); mkdirSync(socketDirectory); chmodSync(socketDirectory, 0o777);
    execFileSync('docker', ['run', '--detach', '--name', container, '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw', '--mount', `type=bind,source=${socketDirectory},target=/var/run/postgresql`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=provider_window_qa', 'pgvector/pgvector:pg16'], { stdio: 'pipe' });
    created = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      const logs = execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
        const candidate = new pg.Client({ host: socketDirectory, user: 'postgres', database: 'provider_window_qa' });
        try { await candidate.connect(); client = candidate; break; } catch { await candidate.end(); }
      }
      if (attempt === 39) throw new Error('Disposable provider window PostgreSQL did not start.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    database = drizzle(client);
    await client.query(`SET timezone='UTC';
      CREATE TABLE performance_ad_campaigns(id integer,user_id integer,ad_platform text,platform_campaign_id text,ad_account_id text,updated_at timestamp);
      CREATE TABLE paid_ad_accounts(id integer,user_id integer,platform text,provider_account_id text,is_active boolean);
      INSERT INTO paid_ad_accounts VALUES(7,9,'meta','123',true);
      CREATE TABLE campaign_performance_cache(id integer,user_id integer,platform text,ad_account_id text,entity_type text,
        platform_entity_id text,parent_entity_id text,name text,status text,last_refreshed_at timestamp,raw_data jsonb,
        spend numeric,impressions integer,clicks integer,conversions numeric,conversion_value numeric,reach integer);
      CREATE TABLE users(id integer,email text); INSERT INTO users VALUES(9,'audit@example.test');
      CREATE TABLE ad_settings(user_id integer,currency text); INSERT INTO ad_settings VALUES(9,'USD');
      CREATE TABLE meta_page_connections(user_id integer,is_active boolean,ad_account_currency text,updated_at timestamp);
      CREATE TABLE api_credentials(user_id integer,service_name text,is_active boolean,config jsonb,updated_at timestamp);`);
  }, 30000);
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick',
      'setImmediate', 'clearImmediate', 'queueMicrotask', 'performance', 'hrtime'] });
    jest.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    jest.spyOn(db, 'execute').mockImplementation((query: unknown) => database.execute(query as SQL));
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  afterAll(async () => {
    if (client) await client.end();
    if (created) { execFileSync('docker', ['stop', container], { stdio: 'pipe' }); execFileSync('docker', ['rm', container], { stdio: 'pipe' }); }
    if (directory) rmSync(directory, { recursive: true });
  }, 30000);

  it.each([['7d', '2026-10-17', '2026-10-16'], ['30d', '2026-09-24', '2026-09-23'], ['90d', '2026-07-26', '2026-07-25']])(
    '%s trace and card share inclusive stored daily bounds and deduplication', async (period, start, prior) => {
      const points = [point(prior, 7), point(start, 10), point(start, 10), point('2026-10-23', 20, 2.5), point('2026-10-24', 100)];
      await seed(points);
      const response = await request(app).get(`/api/campaigns/analytics/provider/meta/777?account=7&period=${period}`);
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.campaign.reporting_window).toEqual({ start, end: '2026-10-23' });
      expect(body.providerAggregate.spend).toBe(30);
      expect(body.providerAggregate.conversions).toBe(3.75);
      expect(body.performanceTrace.map((row: { date: string }) => row.date)).toEqual([start, '2026-10-23']);
      expect(body.performanceTrace.reduce((sum: number, row: { spend: number }) => sum + row.spend, 0)).toBe(body.providerAggregate.spend);
      expect(body.units[0].aggregate.spend).toBe(30);
      expect(JSON.parse(body.units[0].measurementWindow)).toEqual(body.campaign.reporting_window);
      const stored = await client.query("SELECT raw_data FROM campaign_performance_cache WHERE entity_type='campaign'");
      expect(stored.rows[0].raw_data.dailyInsights).toEqual(points);
    },
  );

  it('uses the existing 30-day API default when no period was requested', async () => {
    await seed([point('2026-10-23', 20)]);
    const response = await request(app).get('/api/campaigns/analytics/provider/meta/777?account=7');
    expect(response.status).toBe(200);
    expect(response.body.providerAggregate.spend).toBe(20);
    expect(response.body.campaign.reporting_window).toEqual({ start: '2026-09-24', end: '2026-10-23' });
  });

  it('preserves the service cached-snapshot mode for internal callers without a requested window', async () => {
    await seed([point('2026-10-23', 20)]);
    const detail = await withBusinessScope({ userId: 9, actorUserId: 9, businessProfileId: 11 },
      () => adPerformanceService.providerPerformanceDetail(9, 'meta', '777', undefined, 7));
    expect(detail.providerAggregate.spend).toBe(90);
    expect(detail.campaign.reporting_window).toEqual({ start: '2026-07-01', end: '2026-10-23' });
  });
});
