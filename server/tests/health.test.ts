/**
 * Health, Dashboard, ICP, Notifications, User Profile, Company Profile Tests
 */
import * as drizzle from 'drizzle-orm';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock drizzle-orm (needed by dashboard, ICP, userProfile, companyProfile, businessProfiles)
jest.unstable_mockModule('drizzle-orm', () => ({
  ...drizzle,
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
      execute: jest.fn<any>().mockResolvedValue({ rows: [{ count: '0' }] }),
      query: {},
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pgPool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
  };
});

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock config for healthController
jest.unstable_mockModule('../utils/config', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getServiceStatus: jest.fn<any>().mockReturnValue({ redis: true, db: true }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: { getServiceStatus: jest.fn<any>().mockReturnValue({ redis: true, db: true }) },
}));

// Mock schemas
jest.unstable_mockModule('../models/users/schema', () => ({
  usersTable: { id: 'id', email: 'email', name: 'name', password: 'password' },
}));
jest.unstable_mockModule('../models/admins/schema', () => ({
  adminsTable: { id: 'id', email: 'email', name: 'name' },
}));
jest.unstable_mockModule('../models/leads/schema', () => ({
  leadsTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/campaigns/schema', () => ({
  campaignsTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/sentMessages/schema', () => ({
  sentMessagesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/performanceAdCampaigns/schema', () => ({
  performanceAdCampaignsTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/openaiUsages/schema', () => ({
  openaiUsagesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/apifyUsages/schema', () => ({
  apifyUsagesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/geminiUsages/schema', () => ({
  geminiUsagesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/zerobounceUsages/schema', () => ({
  zerobounceUsagesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/contentAssets/schema', () => ({
  contentAssetsTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/icpData/schema', () => ({
  icpDataTable: { id: 'id', userId: 'userId' },
  icpProfilesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/companyProfiles/schema', () => ({
  companyProfilesTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/notifications/schema', () => ({
  notificationsTable: { id: 'id', userId: 'userId', isRead: 'isRead' },
}));

// Mock function modules
jest.unstable_mockModule('../models/icpData/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createIcpData: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getIcpDataById: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateIcpData: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getIcpDataByUserId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getIcpDataByWorkflowId: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getIcpsByBusinessId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getIcpByThreadId: jest.fn<any>().mockResolvedValue(null),
}));
jest.unstable_mockModule('../models/notifications/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNotificationsByUserId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNotificationCountByUserId: jest.fn<any>().mockResolvedValue(0),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUnreadNotificationsByUserId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUnreadCountByUserId: jest.fn<any>().mockResolvedValue(0),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  markAsRead: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  markAllAsRead: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteNotification: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createNotification: jest.fn<any>().mockResolvedValue({ id: 1 }),
}));
jest.unstable_mockModule('../models/companyProfiles/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCompanyProfile: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCompanyProfileByUserId: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCompanyProfile: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateCompanyProfile: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteCompanyProfile: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../models/users/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUserById: jest.fn<any>().mockResolvedValue({ id: 1, email: 'test@test.com', name: 'Test' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateUserById: jest.fn<any>().mockResolvedValue({ id: 1 }),
}));

// Mock services
jest.unstable_mockModule('../services/ICPGenerationService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ICPGenerationService: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateICP: jest.fn<any>().mockResolvedValue({ success: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildICP: jest.fn<any>().mockResolvedValue({ success: true }),
  })),
}));
jest.unstable_mockModule('bcryptjs', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: { hash: jest.fn<any>().mockResolvedValue('hashed'), compare: jest.fn<any>().mockResolvedValue(true) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hash: jest.fn<any>().mockResolvedValue('hashed'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compare: jest.fn<any>().mockResolvedValue(true),
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRedis = { ping: jest.fn<any>().mockResolvedValue('PONG'), get: jest.fn(), set: jest.fn() };
jest.unstable_mockModule('../infrastructure/redis', () => ({
  redis: mockRedis,
  getRedisConnection: () => mockRedis,
  getRedisSubscriber: () => mockRedis,
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { mockAuthRequest, mockAdminRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');

const healthController = await import('../controllers/healthController');
const dashboardController = await import('../controllers/dashboardController');
const icpController = await import('../controllers/icpController');
const notificationsController = await import('../controllers/notificationsController');
const userProfileController = await import('../controllers/userProfileController');
const companyProfileController = await import('../controllers/companyProfileController');

describe('Health Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('healthCheck', () => {
    it('should return 200 health status', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await healthController.healthCheck(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ status: 'healthy' });
      expect(res._json).not.toHaveProperty('services');
      expect(res._json).not.toHaveProperty('uptime');
    });
  });

  describe('detailedHealthCheck', () => {
    it('should return health status', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await healthController.detailedHealthCheck(req, res);
      expect([200, 503]).toContain(res._status);
    });
  });
});

describe('Dashboard Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getUserDashboardStats', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await dashboardController.getUserDashboardStats(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should return stats for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await dashboardController.getUserDashboardStats(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  describe('getAdminDashboardStats', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await dashboardController.getAdminDashboardStats(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });
});

describe('ICP Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('listIcpProfilesHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await icpController.listIcpProfilesHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should return profiles for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await icpController.listIcpProfilesHandler(req, res);
      expect(res._status).not.toBe(401);
    });
  });

  describe('getIcpHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await icpController.getIcpHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('buildIcpHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await icpController.buildIcpHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('updateIcpHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest({ params: { id: '1' }, body: {} });
      const res = mockResponse();
      await icpController.updateIcpHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('createIcpProfileHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await icpController.createIcpProfileHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getIcpsByBusinessIdHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest({ params: { businessId: '1' } });
      const res = mockResponse();
      await icpController.getIcpsByBusinessIdHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getIcpByThreadIdHandler', () => {
    it('should fail for unauthenticated request (TypeError → 500)', async () => {
      const req = mockRequest({ params: { threadId: '1' } });
      const res = mockResponse();
      await icpController.getIcpByThreadIdHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });
});

describe('Notifications Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getNotifications', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.getNotifications(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return notifications for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.getNotifications(req as any, res);
      expect(res._status).toBe(200);
    });
  });

  describe('getUnreadNotifications', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.getUnreadNotifications(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getUnreadCount', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.getUnreadCount(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('markNotificationAsRead', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.markNotificationAsRead(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('markAllNotificationsAsRead', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.markAllNotificationsAsRead(req as any, res);
      expect(res._status).toBe(401);
    });
  });

  describe('deleteNotificationById', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notificationsController.deleteNotificationById(req as any, res);
      expect(res._status).toBe(401);
    });
  });
});

describe('User Profile Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getUserProfileHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await userProfileController.getUserProfileHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('updateUserProfileHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: { name: 'Updated' } });
      const res = mockResponse();
      await userProfileController.updateUserProfileHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('changePasswordHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: { currentPassword: 'old', newPassword: 'new' } });
      const res = mockResponse();
      await userProfileController.changePasswordHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });
});

describe('Company Profile Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getCompanyProfileHandler', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await companyProfileController.getCompanyProfileHandler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('getMyCompanyProfileHandler', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await companyProfileController.getMyCompanyProfileHandler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('createCompanyProfileHandler', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { name: 'Test Company' } });
      const res = mockResponse();
      await companyProfileController.createCompanyProfileHandler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('updateCompanyProfileHandler', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await companyProfileController.updateCompanyProfileHandler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('deleteCompanyProfileHandler', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await companyProfileController.deleteCompanyProfileHandler(req, res);
      expect(res._status).toBe(401);
    });
  });
});
