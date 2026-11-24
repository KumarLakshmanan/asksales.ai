import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const connectionString = process.env.ADPERF_QA_DATABASE_URL;
const localSuite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = (database as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const { adPerformanceService } = await import('../services/ads/AdPerformanceService.js');
// Exercise persistence with real PostgreSQL, using only connection-local temporary tables.
const service = adPerformanceService as unknown as {
  storeRecommendation: (...args: unknown[]) => Promise<void>;
  consecutiveFailures: (...args: unknown[]) => Promise<number>;
};
const campaign = { id: 1, user_id: 1, objective: 'traffic' };
const target = { platform: 'meta', targetType: 'ad', targetKey: 'ad-a', metricsUpdatedAt: new Date('2026-09-10T10:00:00Z'), aggregate: { impressions: 0, spend: 0 } };
const baseline = { source: 'none', metrics: {}, campaignIds: [] };
const result = { category: 'tracking', state: 'insufficient_data', rationale: 'Insufficient delivery', expectedDirection: 'Collect evidence', suggestedNextStep: 'Wait for delivery', confidence: 0, ruleResults: { enoughVolume: false } };

async function evaluation(id: number, minute: number, state = 'watch', rules: Record<string, unknown> = { failing: true, reportingOnlyHistorical: false }) {
  await client.query(`INSERT INTO ad_performance_evaluations(id,user_id,campaign_id,platform,target_type,target_key,state,rule_results,metrics_updated_at)
    VALUES($1,1,1,'meta','ad','ad-a',$2,$3,'2026-09-10 09:00:00'::timestamp + $4 * INTERVAL '1 minute')`, [id, state, rules, minute]);
}

localSuite('ad recommendation and failing-window persistence', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit local QA database required');
    client = new Client({ connectionString });
    await client.connect();
    await client.query('SET search_path TO pg_temp, pg_catalog');
    await client.query("SET TIME ZONE 'UTC'");
    database = drizzle(client);
    await client.query(`
      CREATE TEMP TABLE performance_ad_campaigns(id INTEGER PRIMARY KEY,user_id INTEGER);
      INSERT INTO performance_ad_campaigns VALUES(1,1),(2,2);
      CREATE TEMP TABLE ad_performance_evaluations(id BIGINT PRIMARY KEY,user_id INTEGER,campaign_id INTEGER,platform TEXT,target_type TEXT,target_key TEXT,state TEXT,rule_results JSONB,metrics_updated_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW());
      CREATE TEMP TABLE performance_metrics(id BIGSERIAL PRIMARY KEY,user_id INTEGER,campaign_id INTEGER,platform TEXT,date DATE,hour INTEGER,impressions INTEGER DEFAULT 0,clicks INTEGER DEFAULT 0,spend NUMERIC DEFAULT 0,conversions NUMERIC DEFAULT 0,conversion_value NUMERIC DEFAULT 0,leads NUMERIC,platform_data JSONB DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TEMP TABLE ad_unit_metrics(id BIGSERIAL PRIMARY KEY,user_id INTEGER,campaign_id INTEGER,platform TEXT,target_type TEXT,target_key TEXT,date DATE,impressions INTEGER DEFAULT 0,clicks INTEGER DEFAULT 0,spend NUMERIC DEFAULT 0,conversions NUMERIC DEFAULT 0,conversion_value NUMERIC DEFAULT 0,provider_payload JSONB DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TEMP TABLE ad_recommendations(id BIGSERIAL PRIMARY KEY,evaluation_id BIGINT,campaign_id INTEGER,user_id INTEGER,platform TEXT,target_type TEXT,target_key TEXT,category TEXT,title TEXT,rationale TEXT,evidence JSONB,expected_direction TEXT,suggested_next_step TEXT,confidence NUMERIC,status TEXT DEFAULT 'open',dismiss_reason TEXT,snoozed_until TIMESTAMPTZ,accepted_evidence JSONB,implemented_at TIMESTAMPTZ,implementation_note TEXT,implementation_baseline JSONB,outcome JSONB,outcome_measured_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(evaluation_id,category));
      CREATE TEMP TABLE ad_recommendation_events(id BIGSERIAL PRIMARY KEY,recommendation_id BIGINT,campaign_id INTEGER,user_id INTEGER,actor_type TEXT,from_status TEXT,to_status TEXT,note TEXT,evidence JSONB DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ DEFAULT NOW());
    `);
  });
  beforeEach(async () => { await client.query('TRUNCATE ad_recommendation_events,ad_recommendations,ad_performance_evaluations,performance_metrics,ad_unit_metrics RESTART IDENTITY'); });
  afterAll(async () => { await client?.end(); });

  it('refreshes one recommendation across evaluations and preserves dismissal', async () => {
    await evaluation(1, 1, result.state);
    await evaluation(2, 2, result.state);
    await evaluation(3, 3, result.state);
    await service.storeRecommendation(campaign, target, 1, result, baseline);
    await service.storeRecommendation(campaign, target, 2, result, baseline);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM ad_recommendations')).rows[0].count).toBe(1);
    await adPerformanceService.recommendationStatus(1, 1, 1, 'dismissed', { dismissReason: 'Intentional brand-only delivery' });
    await service.storeRecommendation(campaign, target, 3, result, baseline);
    expect((await client.query('SELECT status,evaluation_id FROM ad_recommendations')).rows).toEqual([{ status: 'dismissed', evaluation_id: '3' }]);
    await expect(adPerformanceService.recommendationStatus(2, 1, 1, 'accepted')).rejects.toThrow('not found');
  });

  it('supersedes legacy duplicates while retaining separate ad targets', async () => {
    for (let id = 1; id <= 4; id++) await evaluation(id, id, result.state);
    await service.storeRecommendation(campaign, target, 1, result, baseline);
    await client.query(`INSERT INTO ad_recommendations(evaluation_id,campaign_id,user_id,platform,target_type,target_key,category,title,rationale,evidence,expected_direction,suggested_next_step,confidence)
      SELECT 2,campaign_id,user_id,platform,target_type,target_key,category,title,rationale,evidence,expected_direction,suggested_next_step,confidence FROM ad_recommendations`);
    await service.storeRecommendation(campaign, target, 3, result, baseline);
    await service.storeRecommendation(campaign, { ...target, targetKey: 'ad-b' }, 4, result, baseline);
    expect((await client.query("SELECT target_key FROM ad_recommendations WHERE status='open' ORDER BY target_key")).rows).toEqual([{ target_key: 'ad-a' }, { target_key: 'ad-b' }]);
    expect((await client.query("SELECT COUNT(*)::int AS count FROM ad_recommendations WHERE status='superseded'")).rows[0].count).toBe(1);
  });

  it('opens a new issue when a watch becomes a confirmed recommendation', async () => {
    await evaluation(1, 1, 'watch');
    await evaluation(2, 2, 'recommendation');
    const failure = { ...result, category: 'budget', state: 'watch', rationale: 'CPL above target' };
    await service.storeRecommendation(campaign, target, 1, failure, baseline);
    await service.storeRecommendation(campaign, target, 2, { ...failure, state: 'recommendation' }, baseline);
    expect((await client.query('SELECT status FROM ad_recommendations ORDER BY id')).rows).toEqual([{ status: 'superseded' }, { status: 'open' }]);
  });

  it('counts distinct prior measurements, excluding repeated current metrics', async () => {
    await evaluation(1, 10);
    await evaluation(2, 10);
    await evaluation(3, 60);
    expect(await service.consecutiveFailures(1, 1, target)).toBe(1);
    await evaluation(4, 20);
    expect(await service.consecutiveFailures(1, 1, target)).toBe(2);
  });

  it('does not count advisory or historical recommendations as failures', async () => {
    await evaluation(1, 10);
    await evaluation(2, 20, 'recommendation', { failing: false, reportingOnlyHistorical: false });
    expect(await service.consecutiveFailures(1, 1, target)).toBe(0);
    await client.query(`UPDATE ad_performance_evaluations SET rule_results='{"failing":true,"reportingOnlyHistorical":true}' WHERE id=2`);
    expect(await service.consecutiveFailures(1, 1, target)).toBe(0);
    await client.query("UPDATE ad_performance_evaluations SET rule_results='{}' WHERE id=2");
    expect(await service.consecutiveFailures(1, 1, target)).toBe(0);
  });

  it('records accepted, implemented, and snoozed lifecycle evidence', async () => {
    await evaluation(1, 1, result.state);
    await service.storeRecommendation(campaign, target, 1, result, baseline);
    await adPerformanceService.recommendationStatus(1, 1, 1, 'accepted');
    await adPerformanceService.recommendationStatus(1, 1, 1, 'implemented', { implementationNote: 'Replaced the destination form and verified lead tracking.' });
    const implemented = (await client.query('SELECT status,accepted_evidence,implementation_note,implementation_baseline FROM ad_recommendations WHERE id=1')).rows[0];
    expect(implemented.status).toBe('implemented');
    expect(implemented.accepted_evidence).toEqual(expect.objectContaining({ state: result.state }));
    expect(implemented.implementation_note).toContain('verified lead tracking');
    expect(implemented.implementation_baseline).toEqual(expect.objectContaining({ measuredDays: 0 }));
    expect((await client.query('SELECT from_status,to_status FROM ad_recommendation_events ORDER BY id')).rows).toEqual([
      { from_status: 'open', to_status: 'accepted' },
      { from_status: 'accepted', to_status: 'implemented' },
    ]);

    await evaluation(2, 2, result.state);
    await service.storeRecommendation(campaign, { ...target, targetKey: 'ad-b' }, 2, result, baseline);
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const secondId = Number((await client.query("SELECT id FROM ad_recommendations WHERE target_key='ad-b'")).rows[0].id);
    await adPerformanceService.recommendationStatus(1, 1, secondId, 'snoozed', { snoozedUntil: until });
    expect((await client.query('SELECT status FROM ad_recommendations WHERE id=$1', [secondId])).rows[0].status).toBe('snoozed');
  });
});
