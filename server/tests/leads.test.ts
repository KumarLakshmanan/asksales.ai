/**
 * Lead Controller Tests
 * Tests: getLeads, getLead, createLead, updateLead, deleteLead,
 *        bulkDeleteLeads, bulkUpdateLeads, getLeadStats, exportLeads,
 *        verifyLeads, enrichLeads
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- Mock ALL dependencies ---

// 1. Mock drizzle-orm (stubs for eq, and, etc.). Unlisted exports such as
// getTableColumns keep their real implementation so new imports load.
const actualDrizzle = await import('drizzle-orm');
jest.unstable_mockModule('drizzle-orm', () => ({
  ...actualDrizzle,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  not: jest.fn<any>().mockReturnValue('not'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  like: jest.fn<any>().mockReturnValue('like'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ilike: jest.fn<any>().mockReturnValue('ilike'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte: jest.fn<any>().mockReturnValue('gte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lte: jest.fn<any>().mockReturnValue('lte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gt: jest.fn<any>().mockReturnValue('gt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lt: jest.fn<any>().mockReturnValue('lt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count: jest.fn<any>().mockReturnValue('count'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sum: jest.fn<any>().mockReturnValue('sum'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avg: jest.fn<any>().mockReturnValue('avg'),
  sql: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    jest.fn<any>().mockImplementation((...args: any[]) => 'sql-fragment'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { raw: jest.fn<any>().mockReturnValue('sql-raw') }
  ),
}));

// 2. Mock DB with thenable chain
jest.unstable_mockModule('../models/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createChain = (resolveValue: any = []): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    ['from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'innerJoin',
     'rightJoin', 'fullJoin', 'groupBy', 'having', 'values', 'set', 'returning',
     'onConflictDoUpdate', 'onConflictDoNothing', 'as'].forEach(m => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain[m] = jest.fn<any>().mockReturnValue(chain);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain.then = (resolve: any, reject?: any) => Promise.resolve(resolveValue).then(resolve, reject);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
    return chain;
  };
  return {
    db: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      select: jest.fn<any>().mockImplementation((...args: any[]) => createChain([])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      insert: jest.fn<any>().mockImplementation((...args: any[]) => createChain([{ id: 1, name: 'Test Lead', email: 'lead@test.com', userId: 1, status: 'new', createdAt: new Date() }])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      update: jest.fn<any>().mockImplementation((...args: any[]) => createChain([{ id: 1 }])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      delete: jest.fn<any>().mockImplementation((...args: any[]) => createChain([])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: jest.fn<any>().mockResolvedValue({ rows: [] }),
      query: {},
    },
    storage: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
  };
});

// 3. Mock logger
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// 4. Mock schemas
jest.unstable_mockModule('../models/leads/schema', () => ({
  leadsTable: { id: 'id', userId: 'userId', name: 'name', email: 'email', status: 'status',
    createdAt: 'createdAt', company: 'company', firstName: 'firstName', lastName: 'lastName',
    source: 'source', score: 'score', campaignData: 'campaignData', promptId: 'promptId',
    website: 'website', companyDomain: 'companyDomain', linkedin: 'linkedin' },
  InsertLead: {},
}));
jest.unstable_mockModule('../models/icpData/schema', () => ({
  icpProfilesTable: { id: 'id', userId: 'userId', workflowId: 'workflowId' },
}));

// 5. Mock function modules
jest.unstable_mockModule('../models/leads/functions', () => ({
  LeadModel: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: jest.fn<any>().mockResolvedValue({ id: 1, name: 'Test Lead' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getById: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getByUserId: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateById: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteById: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

// 6. Mock services
jest.unstable_mockModule('../services/ICPGenerationService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ICPGenerationService: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateICP: jest.fn<any>().mockResolvedValue({ success: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scoreLead: jest.fn<any>().mockResolvedValue({ score: 85 }),
  })),
}));
jest.unstable_mockModule('../services/credentialService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getApifyKey: jest.fn<any>().mockResolvedValue('mock-apify-key'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOpenAIKey: jest.fn<any>().mockResolvedValue('mock-openai-key'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCredential: jest.fn<any>().mockResolvedValue(null),
}));
jest.unstable_mockModule('../services/dashboardCache.js', () => ({
  invalidateDashboardCache: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// 7. Mock external packages
jest.unstable_mockModule('json2csv', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: { parse: jest.fn<any>().mockReturnValue('csv-data') },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parse: jest.fn<any>().mockReturnValue('csv-data'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Parser: jest.fn<any>().mockImplementation(() => ({ parse: jest.fn<any>().mockReturnValue('csv-data') })),
}));
jest.unstable_mockModule('apify-client', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ApifyClient: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actor: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      call: jest.fn<any>().mockResolvedValue({ defaultDatasetId: 'ds-1' }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataset: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listItems: jest.fn<any>().mockResolvedValue({ items: [] }),
    }),
  })),
}));
jest.unstable_mockModule('openai', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chat: { completions: { create: jest.fn<any>().mockResolvedValue({ choices: [{ message: { content: '{}' } }] }) } },
  })),
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const leadController = await import('../controllers/leadController');

describe('Lead Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  // --- Functions WITH explicit auth checks (return 401) ---
  describe('GET /api/leads (getLeads)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await leadController.getLeads(req, res);
      expect(res._status).toBe(401);
    });

    it('should proceed for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await leadController.getLeads(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  describe('GET /api/leads/:id (getLead)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await leadController.getLead(req, res);
      expect(res._status).toBe(401);
    });

    it('should proceed for authenticated user', async () => {
      const req = mockAuthRequest(1, { params: { id: '1' } });
      const res = mockResponse();
      await leadController.getLead(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  describe('PUT /api/leads/:id (updateLead)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await leadController.updateLead(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('DELETE /api/leads/:id (deleteLead)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await leadController.deleteLead(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('POST /api/leads/bulk/delete (bulkDeleteLeads)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { ids: [1, 2] } });
      const res = mockResponse();
      await leadController.bulkDeleteLeads(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if no ids provided', async () => {
      const req = mockAuthRequest(1, { body: {} });
      const res = mockResponse();
      await leadController.bulkDeleteLeads(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('POST /api/leads/bulk/update (bulkUpdateLeads)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { ids: [1], updates: {} } });
      const res = mockResponse();
      await leadController.bulkUpdateLeads(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('GET /api/leads/stats (getLeadStats)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await leadController.getLeadStats(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('GET /api/leads/export (exportLeads)', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await leadController.exportLeads(req, res);
      expect(res._status).toBe(401);
    });
  });

  // --- Mutation authentication ---
  describe('POST /api/leads (createLead)', () => {
    it('should reject unauthenticated lead creation', async () => {
      const req = mockRequest({ body: { name: 'New Lead', email: 'lead@test.com' } });
      const res = mockResponse();
      await leadController.createLead(req, res);
      expect(res._status).toBe(401);
    });

    it('should create a lead for authenticated user', async () => {
      const req = mockAuthRequest(1, {
        body: { name: 'New Lead', email: 'newlead@test.com', company: 'TestCo' }
      });
      const res = mockResponse();
      await leadController.createLead(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  // verifyLeads: no explicit auth check
  describe('POST /api/leads/verify (verifyLeads)', () => {
    it('should handle empty verifications', async () => {
      const req = mockAuthRequest(1, { body: { verifications: {}, stats: {} } });
      const res = mockResponse();
      await leadController.verifyLeads(req, res);
      expect(res._status).toBe(200);
    });
  });

  // enrichLeads: checks leadIds but not auth
  describe('POST /api/leads/enrich (enrichLeads)', () => {
    it('should return 400 if no lead IDs provided', async () => {
      const req = mockAuthRequest(1, { body: {} });
      const res = mockResponse();
      await leadController.enrichLeads(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 400 if leadIds is empty array', async () => {
      const req = mockAuthRequest(1, { body: { leadIds: [] } });
      const res = mockResponse();
      await leadController.enrichLeads(req, res);
      expect(res._status).toBe(400);
    });
  });

  // scoreLeadById, enrichLeadById, validateEmailById: go straight to DB without auth check
  describe('POST /api/leads/:id/score (scoreLeadById)', () => {
    it('should return 404 when lead not found', async () => {
      const req = mockAuthRequest(1, { params: { id: '999' }, body: {} });
      const res = mockResponse();
      await leadController.scoreLeadById(req, res);
      // DB returns [] so lead is undefined → 404
      expect(res._status).toBe(404);
    });
  });

  describe('POST /api/leads/:id/enrich (enrichLeadById)', () => {
    it('should return 404 when lead not found', async () => {
      const req = mockAuthRequest(1, { params: { id: '999' } });
      const res = mockResponse();
      await leadController.enrichLeadById(req, res);
      expect(res._status).toBe(404);
    });
  });

  describe('POST /api/leads/:id/validate-email (validateEmailById)', () => {
    it('should return 404 when lead not found', async () => {
      const req = mockAuthRequest(1, { params: { id: '999' } });
      const res = mockResponse();
      await leadController.validateEmailById(req, res);
      expect(res._status).toBe(404);
    });
  });
});
