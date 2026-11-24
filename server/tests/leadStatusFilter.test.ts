import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import type { Pool, QueryConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { leadsTable } from '../models/leads/schema.js';
import { LEAD_STATUSES } from '../../shared/leadStatus.js';
import { bulkUpdateSchema, createLeadSchema, updateLeadSchema } from '../middleware/schemas.js';
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
const statements: { sql: string; params: unknown[] }[] = [];
const driver = {
  async query(config: QueryConfig & { rowMode?: 'array' }, params: unknown[] = []) {
    statements.push({ sql: config.text, params });
    const statement = fixture.prepare(config.text.replace(/::int\b/g, '').replace(/\bilike\b/gi, 'like').replace(/\$\d+/g, '?'));
    statement.setReturnArrays(config.rowMode === 'array');
    return { rows: statement.all(...params as (string | number | null)[]) };
  },
};
const fixtureDb = drizzle(driver as unknown as Pool);
jest.unstable_mockModule('../models/db', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../models/leads/functions', () => ({ LeadModel: {} }));
jest.unstable_mockModule('../services/dashboardCache.js', () => ({ invalidateDashboardCache: jest.fn() }));
jest.unstable_mockModule('../services/ICPGenerationService', () => ({ ICPGenerationService: jest.fn() }));
jest.unstable_mockModule('../services/credentialService', () => ({ getApifyKey: jest.fn() }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { getLeads } = await import('../controllers/leadController.js');

const insert = fixture.prepare(`INSERT INTO leads
  (id, user_id, business_profile_id, name, lead_status, status, source, created_at)
  VALUES (?, ?, 77, ?, ?, ?, ?, '2026-10-09 12:00:00')`);
async function list(query: Record<string, string> = {}) {
  const response = mockResponse();
  // A signed-in staff member accesses the business owner's rows.
  await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 42 },
    () => getLeads(mockAuthRequest(42, { query }), response));
  expect(response._status).toBe(200);
  return response._json;
}

describe('lead status filtering', () => {
  beforeEach(() => {
    fixture.exec('DELETE FROM leads');
    statements.length = 0;
    LEAD_STATUSES.forEach((status, index) => {
      insert.run(index + 1, 9, `Lead ${status}`, status, 'new', 'inbound_email');
      insert.run(index + 101, 13, `Other ${status}`, status, 'new', 'email');
    });
    insert.run(201, 13, 'Private stage', 'private_stage', 'new', 'email');
    insert.run(301, 9, 'Legacy stage', null, 'interested', 'manual');
  });
  afterAll(() => fixture.close());

  it.each(LEAD_STATUSES)('filters %s with Email and search while preserving owner scope', async status => {
    const result = await list({ status, source: 'email', search: 'Lead', pageSize: '1' });
    expect(result.data.map((lead: { name: string }) => lead.name)).toEqual([`Lead ${status}`]);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.statuses).toContain('interested');
    expect(result.statuses).not.toContain('private_stage');
    expect(statements.filter(statement => !/^\s*(begin|commit|rollback)$/i.test(statement.sql)).every(statement => statement.params.includes(9))).toBe(true);
  });

  it('matches the displayed legacy fallback and gives pipeline status precedence', async () => {
    insert.run(302, 9, 'Legacy reply', '', 'replied', 'email');
    insert.run(303, 9, 'Qualified reply', 'qualified', 'replied', 'email');
    insert.run(304, 9, 'Default new', null, '', 'email');
    const replies = await list({ status: 'replied', pageSize: '100' });
    expect(replies.data.map((lead: { name: string }) => lead.name).sort()).toEqual(['Lead replied', 'Legacy reply']);
    expect((await list({ status: 'new', search: 'Default' })).total).toBe(1);
    expect((await list({ status: 'interested' })).data[0].name).toBe('Legacy stage');
  });

  it('paginates filtered replies and discovers statuses independently of an empty result', async () => {
    insert.run(302, 9, 'Second reply', 'replied', 'new', 'email');
    const query = { status: 'replied', pageSize: '1', sortBy: 'name_asc' };
    expect((await list(query)).data[0].name).toBe('Lead replied');
    const second = await list({ ...query, page: '2' });
    expect(second.data[0].name).toBe('Second reply');
    expect(second.total).toBe(2);
    expect(second.totalPages).toBe(2);
    const empty = await list({ status: 'replied', search: 'Missing' });
    expect(empty.data).toEqual([]);
    expect(empty.statuses).toEqual([...LEAD_STATUSES, 'interested'].sort());
    const reset = await list({ source: 'email', search: 'Lead', pageSize: '100' });
    expect(reset.data).toHaveLength(LEAD_STATUSES.length);
  });

  it('rejects unauthenticated listing before querying', async () => {
    const response = mockResponse();
    await getLeads(mockRequest(), response);
    expect(response._status).toBe(401);
    expect(statements).toEqual([]);
  });

  it.each(LEAD_STATUSES)('accepts %s consistently on create, update and bulk update', status => {
    for (const field of ['status', 'leadStatus']) {
      expect(createLeadSchema.safeParse({ name: 'QA lead', [field]: status }).success).toBe(true);
      expect(updateLeadSchema.safeParse({ [field]: status }).success).toBe(true);
      expect(bulkUpdateSchema.safeParse({ ids: [1], updates: { [field]: status } }).success).toBe(true);
      expect(updateLeadSchema.safeParse({ [field]: 'unsupported_state' }).success).toBe(false);
    }
  });
});
