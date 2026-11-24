/**
 * Campaign Analytics Controller Tests
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock drizzle-orm
jest.unstable_mockModule('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  sql: Object.assign(jest.fn<any>().mockImplementation((...a: any[]) => 'sql'), { raw: jest.fn<any>().mockReturnValue('raw') }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count: jest.fn<any>().mockReturnValue('count'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sum: jest.fn<any>().mockReturnValue('sum'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avg: jest.fn<any>().mockReturnValue('avg'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte: jest.fn<any>().mockReturnValue('gte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lte: jest.fn<any>().mockReturnValue('lte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gt: jest.fn<any>().mockReturnValue('gt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lt: jest.fn<any>().mockReturnValue('lt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  between: jest.fn<any>().mockReturnValue('between'),
}));

jest.unstable_mockModule('../models/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createChain = (val: any = []): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {};
    ['from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'innerJoin', 'groupBy',
     // eslint-disable-next-line @typescript-eslint/no-explicit-any
     'having', 'values', 'set', 'returning', 'as'].forEach(m => { c[m] = jest.fn<any>().mockReturnValue(c); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.then = (resolve: any) => Promise.resolve(val).then(resolve);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.catch = (fn: any) => Promise.resolve(val).catch(fn);
    return c;
  };
  return {
    db: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: jest.fn<any>().mockImplementation(() => createChain([])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert: jest.fn<any>().mockImplementation(() => createChain([{ id: 1 }])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: jest.fn<any>().mockImplementation(() => createChain([{ id: 1 }])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete: jest.fn<any>().mockImplementation(() => createChain([])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: jest.fn<any>().mockResolvedValue({ rows: [] }),
      query: {},
    },
  };
});

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock all schema modules used by campaignAnalyticsController
jest.unstable_mockModule('../models/campaigns/schema', () => ({
  campaignsTable: { id: 'id', userId: 'userId', name: 'name', status: 'status' },
}));
jest.unstable_mockModule('../models/leads/schema', () => ({
  leadsTable: { id: 'id', userId: 'userId', name: 'name' },
}));
jest.unstable_mockModule('../models/sentMessages/schema', () => ({
  sentMessagesTable: { id: 'id', userId: 'userId', channel: 'channel', status: 'status' },
}));
jest.unstable_mockModule('../models/performanceAdCampaigns/schema', () => ({
  performanceAdCampaignsTable: { id: 'id', userId: 'userId', name: 'name', status: 'status', platform: 'platform', adAccountId: 'adAccountId', platformCampaignId: 'platformCampaignId' },
}));
jest.unstable_mockModule('../models/performanceMetrics/schema', () => ({
  performanceMetricsTable: { id: 'id', campaignId: 'campaignId', date: 'date', impressions: 'impressions', clicks: 'clicks', spend: 'spend' },
}));
jest.unstable_mockModule('../models/ads/schema', () => ({
  adsTable: { id: 'id', campaignId: 'campaignId', name: 'name', status: 'status' },
}));
jest.unstable_mockModule('../models/budgetPlans/schema', () => ({
  budgetPlansTable: { id: 'id', campaignId: 'campaignId' },
}));
jest.unstable_mockModule('../services/AnalyticsIngestionService', () => ({
  analyticsIngestionService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ingest: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
// MetricsIngestionService not used by controllers under test

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const campaignAnalyticsController = await import('../controllers/campaignAnalyticsController');

describe('Campaign Analytics Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getCampaignAnalytics', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await campaignAnalyticsController.getCampaignAnalytics(req, res);
      expect(res._status).toBe(401);
    });

    it('should handle valid request', async () => {
      const req = mockAuthRequest(1, { params: { id: '1' } });
      const res = mockResponse();
      await campaignAnalyticsController.getCampaignAnalytics(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  describe('getCampaignPerformanceTrends', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, query: {} });
      const res = mockResponse();
      await campaignAnalyticsController.getCampaignPerformanceTrends(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getTopHooksAndHashtags', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await campaignAnalyticsController.getTopHooksAndHashtags(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('compareCampaigns', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { campaignIds: [1, 2] } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await campaignAnalyticsController.compareCampaigns(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('startAnalyticsPolling', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { campaignId: '1' } });
      const res = mockResponse();
      await campaignAnalyticsController.startAnalyticsPolling(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('stopAnalyticsPolling', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { campaignId: '1' } });
      const res = mockResponse();
      await campaignAnalyticsController.stopAnalyticsPolling(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('fetchMetricsNow', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { campaignId: '1' } });
      const res = mockResponse();
      await campaignAnalyticsController.fetchMetricsNow(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getAdSetMetrics', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { campaignId: '1' }, query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await campaignAnalyticsController.getAdSetMetrics(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getAdsDashboard', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await campaignAnalyticsController.getAdsDashboard(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getCampaignTrends', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await campaignAnalyticsController.getCampaignTrends(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('compareAdCampaigns', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { campaignIds: [1, 2] } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await campaignAnalyticsController.compareAdCampaigns(req as any, res);
      expect(res._status).toBe(401);
    });
  });
});
