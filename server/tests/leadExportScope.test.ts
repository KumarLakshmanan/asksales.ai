import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import type { Pool, QueryConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { leadsTable } from '../models/leads/schema.js';
import { LEAD_EXPORT_LIMIT } from '../../shared/leadExport.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { mockAuthRequest, mockRequest, mockResponse } from './helpers/mockHelpers.js';

// Execute the controller's real Drizzle queries against disposable, in-memory
// SQL fixtures. Only PG's count cast and ILIKE spelling need SQLite equivalents.
// This tests filtering/query composition, not PostgreSQL's RLS enforcement.
// Jest's resolver does not yet recognize node:sqlite as a built-in module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const fixture = new DatabaseSync(':memory:');
const columns = getTableConfig(leadsTable).columns;
fixture.exec(`CREATE TABLE leads (${columns.map(column => `"${column.name}"`).join(', ')})`);
// Migration 587's stored thread key, which the thread filter reads.
fixture.exec(`ALTER TABLE leads ADD COLUMN legacy_campaign_thread_key TEXT GENERATED ALWAYS AS (
  CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10 THEN CAST(campaign_data->>'threadId' AS TEXT) END) VIRTUAL`);
const statements: { sql: string; params: unknown[] }[] = [];
const driver = {
  async query(config: QueryConfig & { rowMode?: 'array' }, params: unknown[] = []) {
    statements.push({ sql: config.text, params });
    const statement = fixture.prepare(config.text.replace(/::int\b/g, '').replace(/\bilike\b/gi, 'like').replace(/("leads"\."campaign_data")->>'threadId'/g, "CAST($1->>'threadId' AS TEXT)").replace(/\$\d+/g, '?'));
    statement.setReturnArrays(config.rowMode === 'array');
    return { rows: statement.all(...params as (string | number | null)[]) };
  },
};
const fixtureDb = drizzle(driver as unknown as Pool);
jest.unstable_mockModule('../models/db', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../models/leads/functions', () => ({ LeadModel: {} }));
jest.unstable_mockModule('../services/dashboardCache.js', () => ({ invalidateDashboardCache: jest.fn() }));
jest.unstable_mockModule('../services/ICPGenerationService', () => ({ ICPGenerationService: class { async getICPForThread() { return { id: 88 }; } } }));
jest.unstable_mockModule('../services/credentialService', () => ({ getApifyKey: jest.fn() }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { getLeads, exportLeads } = await import('../controllers/leadController.js');


const insert = fixture.prepare(`INSERT INTO leads
  (id, user_id, business_profile_id, name, email, lead_status, status, source, score, created_at, campaign_data, prompt_id, execution_id, role)
  VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)`);
function seed(id: number, overrides: Record<string, unknown> = {}) {
  const row = { owner: 9, business: 77, name: `QA Lead ${id}`, email: `qa${id}@example.test`, status: 'replied', source: 'inbound_email', score: 80,
    created: '2026-10-27 12:00:00', campaign: '{}', prompt: null, execution: null, role: null, ...overrides };
  insert.run(id, row.owner, row.business, row.name, row.email, row.status, row.source, row.score, row.created, row.campaign, row.prompt, row.execution, row.role);
}
async function exported(query: Record<string, string> = {}, ids?: unknown) {
  const response = mockResponse();
  response.setHeader = jest.fn(() => response);
  await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 42 }, () => exportLeads(mockAuthRequest(42, {
    method: ids === undefined ? 'GET' : 'POST', query: { format: 'csv', ...query }, body: { ids },
  }), response));
  return response;
}
function csvIds(response: ReturnType<typeof mockResponse>) {
  expect(response._status).toBe(200);
  return response._sent.split('\r\n').slice(1).map(row => Number(row.split(',')[0].replaceAll('"', '')));
}

describe('lead export scope', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-27T12:00:00Z') });
    fixture.exec('DELETE FROM leads');
    statements.length = 0;
    for (let id = 1; id <= 31; id++) seed(id);
    seed(101, { owner: 13 });
    seed(102, { business: 78 });
    seed(103, { status: 'qualified', source: 'manual', score: 10, name: 'Other result' });
  });
  afterEach(() => { jest.useRealTimers(); });
  afterAll(() => fixture.close());

  it('exports only the one selected lead, ignoring directory filters and pagination', async () => {
    const result = await exported({ search: 'Other result', page: '2', pageSize: '15' }, [1]);
    expect(csvIds(result)).toEqual([1]);
    expect(result.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
  });
  it('exports the one searched lead with no selection', async () => {
    expect(csvIds(await exported({ search: 'QA Lead 31' }))).toEqual([31]);
  });
  it('finds a role-only exact search in both the directory and filtered CSV', async () => {
    seed(200, { role: 'QA Operations Manager' });
    seed(201, { owner: 13, role: 'QA Operations Manager' });
    seed(202, { business: 78, role: 'QA Operations Manager' });
    const query = { search: 'QA Operations Manager', pageSize: '1' };
    const response = mockResponse();
    await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 42 },
      () => getLeads(mockAuthRequest(42, { query }), response));
    expect(response._status).toBe(200);
    expect(response._json.total).toBe(1);
    expect(response._json.data.map((lead: { id: number }) => lead.id)).toEqual([200]);
    expect(csvIds(await exported(query))).toEqual([200]);
    expect(statements.filter(statement => !/^\s*(begin|commit|rollback)$/i.test(statement.sql)).every(statement => statement.params.includes(9) && statement.params.includes(77))).toBe(true);
  });
  it('combines case-insensitive partial role matching with directory filters across pages', async () => {
    seed(200, { role: 'QA Operations Manager' });
    seed(201, { role: 'Senior Operations Manager' });
    seed(202, { role: 'Operations Manager', status: 'qualified' });
    seed(203, { role: 'Operations Manager', score: 10 });
    seed(204, { role: 'Operations Manager', source: 'manual' });
    seed(205, { role: 'Operations Manager', owner: 13 });
    seed(206, { role: 'Operations Manager', business: 78 });
    const query = { search: 'operations manager', status: 'replied', source: 'email', scoreRange: '75-100', timeFilter: 'today', sortBy: 'name_asc', pageSize: '1' };
    const listedIds: number[] = [];
    for (let page = 1; page <= 2; page++) {
      const response = mockResponse();
      await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 42 },
        () => getLeads(mockAuthRequest(42, { query: { ...query, page: String(page) } }), response));
      expect(response._json.total).toBe(2);
      listedIds.push(...response._json.data.map((lead: { id: number }) => lead.id));
    }
    expect(listedIds).toEqual([200, 201]);
    expect(csvIds(await exported({ ...query, page: '2' }))).toEqual(listedIds);
  });
  it('exports the complete filtered set across all pages in the same order as listing', async () => {
    const query = { status: 'replied', source: 'email', scoreRange: '75-100', search: 'QA Lead', sortBy: 'name_asc', pageSize: '15' };
    const listedIds: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const response = mockResponse();
      await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 42 },
        () => getLeads(mockAuthRequest(42, { query: { ...query, page: String(page) } }), response));
      expect(response._json.total).toBe(31);
      listedIds.push(...response._json.data.map((lead: { id: number }) => lead.id));
    }
    expect(csvIds(await exported({ ...query, page: '2' }))).toEqual(listedIds);
    expect(listedIds).toHaveLength(31);
  });
  it('exports the full business directory across pages with no owner/profile leakage', async () => {
    expect(csvIds(await exported({ page: '2', pageSize: '15' }))).toEqual([103, ...Array.from({ length: 31 }, (_, i) => 31 - i)]);
    expect(statements.filter(statement => !/^\s*(begin|commit|rollback)$/i.test(statement.sql)).every(statement => statement.params.includes(9) && statement.params.includes(77))).toBe(true);
  });
  it('keeps checked records across pages and deduplicates checked IDs', async () => {
    expect(csvIds(await exported({}, [1, 31, 1]))).toEqual([31, 1]);
  });
  it.each([[101], [102], [999]])('rejects a whole selection with an unavailable ID %j', async foreignId => {
    const result = await exported({}, [1, foreignId]);
    expect(result._status).toBe(404);
    expect(result._sent).toBe('');
    expect(result._json.error).toContain('unavailable');
    expect(result.setHeader).not.toHaveBeenCalled();
  });
  it.each([[], ['1'], [0], [-1], [1.5], [2147483648], null].map(ids => [ids]))('rejects malformed selection %j before querying', async ids => {
    const result = await exported({}, ids);
    expect(result._status).toBe(400);
    expect(statements).toEqual([]);
  });
  it('retains CSV escaping and formula neutralization', async () => {
    seed(200, { name: '=SUM(1,2)', email: 'comma,"quote"@example.test' });
    const result = await exported({}, [200]);
    expect(result._sent).toContain('"\'=SUM(1,2)"');
    expect(result._sent).toContain('"comma,""quote""@example.test"');
    expect(result._sent.split('\r\n')[0].replaceAll('"', '')).toBe('id,name,fullName,email,firstName,lastName,phone,company,role,headline,location,platform,linkedinUsername,twitter,website,fitScore,status,createdAt');
  });
  it('applies time filters identically to listing', async () => {
    seed(200, { created: '2020-01-01 12:00:00' });
    const response = mockResponse();
    const query = { timeFilter: 'lastyear', pageSize: '100' };
    await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 42 }, () => getLeads(mockAuthRequest(42, { query }), response));
    const ids = csvIds(await exported(query));
    expect(ids).not.toContain(200);
    expect(ids).toEqual(response._json.data.map((lead: { id: number }) => lead.id));
  });
  it('preserves scoped legacy thread/prompt and execution exports with narrowing filters', async () => {
    seed(200, { campaign: '{"threadId":55}' });
    seed(201, { prompt: 88 });
    seed(202, { execution: 'fixture-execution' });
    seed(203, { business: 78, prompt: 88, execution: 'fixture-execution' });
    expect(csvIds(await exported({ threadId: '55' }))).toEqual([201, 200]);
    expect(csvIds(await exported({ threadId: '55', search: 'QA Lead 200' }))).toEqual([200]);
    expect(csvIds(await exported({ executionId: 'fixture-execution' }))).toEqual([202]);
  });
  it('rejects exports beyond the bound rather than silently truncating', async () => {
    fixture.exec('DELETE FROM leads; BEGIN');
    for (let id = 1; id <= LEAD_EXPORT_LIMIT + 1; id++) seed(id);
    fixture.exec('COMMIT');
    const result = await exported();
    expect(result._status).toBe(422);
    expect(result._sent).toBe('');
    expect(result.setHeader).not.toHaveBeenCalled();
    expect((await exported({}, Array(LEAD_EXPORT_LIMIT + 1).fill(1)))._status).toBe(400);
  });
  it('rejects unauthenticated exports before querying', async () => {
    const response = mockResponse();
    await exportLeads(mockRequest(), response);
    expect(response._status).toBe(401);
    expect(statements).toEqual([]);
  });
});
