import { afterEach, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { adPerformanceService } from '../services/ads/AdPerformanceService.js';

afterEach(() => { jest.restoreAllMocks(); });
it('preserves the provider evidence timestamp when importing old reporting into new monitoring', async () => {
  const dialect = new PgDialect();
  const observedAt = '2026-10-29T07:55:48.000Z';
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  jest.spyOn(db, 'execute').mockImplementation(async (query: unknown) => {
    const statement = dialect.sqlToQuery(query as never);
    if (statement.sql.includes("AND entity_type = 'campaign'")) return { rows: [{ id: 1, platform_entity_id: 'provider-1', name: 'Saved campaign', status: 'ACTIVE', last_refreshed_at: observedAt, spend: 500, raw_data: { campaign: { objective: 'OUTCOME_AWARENESS', created_time: '2026-09-01T00:00:00Z' }, accountIdentity: { adAccountId: 'owned-account', currency: 'INR' }, dailyInsights: [{ date: '2026-10-28', spend: 100, impressions: 1000, clicks: 5 }] } }] };
    return { rows: [] };
  });
  jest.spyOn(db, 'transaction').mockImplementation(async (...args: unknown[]) => (args[0] as (tx: unknown) => Promise<unknown>)({ execute: async (query: unknown) => {
    const statement = dialect.sqlToQuery(query as never);
    statements.push(statement);
    return { rows: statement.sql.includes('INSERT INTO performance_ad_campaigns') ? [{ id: 13 }] : [] };
  } }));
  await adPerformanceService.importProviderCampaign(9, 'meta', 'provider-1');
  const metric = statements.find(statement => statement.sql.includes('INSERT INTO performance_metrics'))!;
  expect(metric).toBeDefined();
  expect(metric.params.some(value => value instanceof Date && value.toISOString() === observedAt)).toBe(true);
  expect(metric.sql).toContain('updated_at=EXCLUDED.updated_at');
});
