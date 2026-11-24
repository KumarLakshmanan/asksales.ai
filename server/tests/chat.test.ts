/**
 * Chat Controller Tests
 * Note: chatController uses (req as any).user.id WITHOUT null check — TypeError → 500
 */
import * as drizzle from 'drizzle-orm';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock drizzle-orm (chat controller imports sql, eq, and)
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
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNull: jest.fn<any>().mockReturnValue('isNull'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lt: jest.fn<any>().mockReturnValue('lt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gt: jest.fn<any>().mockReturnValue('gt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte: jest.fn<any>().mockReturnValue('gte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lte: jest.fn<any>().mockReturnValue('lte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ne: jest.fn<any>().mockReturnValue('ne'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  not: jest.fn<any>().mockReturnValue('not'),
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
    storage: {},
  };
});

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../models/chatMessages/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChatMessagesByUserId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChatMessagesByThreadId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  softDeleteChatMessagesByUserId: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../models/chatThreads/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChatThreadById: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createChatThread: jest.fn<any>().mockResolvedValue({ id: 1, title: 'Test Thread', userId: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateChatThread: jest.fn<any>().mockResolvedValue({ id: 1, title: 'Updated' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteChatThread: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  softDeleteChatThread: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChatThreadsByUserId: jest.fn<any>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../models/chatTabConfigs/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveChatTabConfig: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChatTabConfigs: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteChatTabConfig: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateActiveTab: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replaceChatTabConfigs: jest.fn<any>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../models/workflowSessions/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createWorkflowSession: jest.fn<any>().mockResolvedValue({ id: 'wf-123' }),
}));
jest.unstable_mockModule('../services/ICPGenerationService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ICPGenerationService: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateICP: jest.fn<any>().mockResolvedValue({ success: true }),
  })),
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({
  webSocketEmitter: { emit: jest.fn(), emitProgress: jest.fn() },
}));
jest.unstable_mockModule('../models/leadInputs/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLatestLeadInputsByThreadId: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLatestLeadInputsForUIByThreadId: jest.fn<any>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../models/scrapingDetails/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLatestScrapingDetailsByThreadId: jest.fn<any>().mockResolvedValue([]),
}));
// chatController also imports these
jest.unstable_mockModule('../models/chatThreads/schema', () => ({
  chatThreadsTable: { id: 'id', userId: 'userId', title: 'title', createdAt: 'createdAt' },
}));
jest.unstable_mockModule('../models/chatMessages/schema', () => ({
  chatMessagesTable: { id: 'id', threadId: 'threadId', role: 'role', content: 'content' },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const chatController = await import('../controllers/chatController');
const { db } = await import('../models/db');

describe('Chat Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  // chatController uses (req as any).user.id WITHOUT optional chaining
  // Unauthenticated calls throw TypeError → caught → 500

  describe('getChatMessagesHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await chatController.getChatMessagesHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should return messages for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await chatController.getChatMessagesHandler(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('clearChatHistoryHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await chatController.clearChatHistoryHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getChatThreadsHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await chatController.getChatThreadsHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should return threads for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await chatController.getChatThreadsHandler(req, res);
      expect(res._status).toBe(200);
    });

    it('rejects an invalid or unowned business profile filter', async () => {
      const invalid = mockResponse();
      await chatController.getChatThreadsHandler(mockAuthRequest(1, { query: { businessProfileId: 'abc' } }), invalid);
      expect(invalid._status).toBe(400);

      const unowned = mockResponse();
      await chatController.getChatThreadsHandler(mockAuthRequest(1, { query: { businessProfileId: '42' } }), unowned);
      expect(unowned._status).toBe(404);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('createChatThreadHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: { title: 'New Thread' } });
      const res = mockResponse();
      await chatController.createChatThreadHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should create thread for authenticated user', async () => {
      const req = mockAuthRequest(1, { body: { title: 'New Thread' } });
      const res = mockResponse();
      await chatController.createChatThreadHandler(req, res);
      expect(res._status).not.toBeGreaterThanOrEqual(400);
    });
  });

  describe('getChatThreadHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await chatController.getChatThreadHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('recovers only a stale running snapshot from the durable workflow status', () => {
      const stale = chatController.recoverStaleThreadWorkflowSnapshot({
        id: 207,
        metadata: {
          workflowOutcome: 'running',
          workflowRun: { status: 'running', updatedAt: '2026-09-18T10:00:00.000Z', completedAt: '2026-09-18T09:00:00.000Z' },
          runContext: { runId: 'run-207' },
        },
      }, {
        id: 'run-207', threadId: 207, status: 'awaiting_approval',
        updatedAt: new Date('2026-09-18T10:00:30.000Z'), completedAt: null,
      }, Date.parse('2026-09-18T10:04:00.000Z'));

      expect(stale.metadata).toMatchObject({
        workflowOutcome: 'awaiting_approval',
        workflowRun: { status: 'awaiting_approval', completedAt: null },
      });

      const fresh = chatController.recoverStaleThreadWorkflowSnapshot({
        id: 207,
        metadata: { workflowOutcome: 'running', workflowRun: { status: 'running', updatedAt: '2026-09-18T10:03:30.000Z' } },
      }, {
        id: 'run-207', threadId: 207, status: 'awaiting_approval',
        updatedAt: new Date('2026-09-18T10:00:30.000Z'), completedAt: null,
      }, Date.parse('2026-09-18T10:04:00.000Z'));
      expect(fresh.metadata?.workflowOutcome).toBe('running');
    });
  });

  describe('updateChatThreadHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { title: 'Updated' } });
      const res = mockResponse();
      await chatController.updateChatThreadHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('deleteChatThreadHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await chatController.deleteChatThreadHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getChatThreadMessagesHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ params: { id: '1' }, query: {} });
      const res = mockResponse();
      await chatController.getChatThreadMessagesHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('saveChatTabConfigHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: { threadId: 1, tabs: [] } });
      const res = mockResponse();
      await chatController.saveChatTabConfigHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getChatTabConfigsHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ params: { threadId: '1' } });
      const res = mockResponse();
      await chatController.getChatTabConfigsHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('deleteChatTabConfigHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await chatController.deleteChatTabConfigHandler(req, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getLatestLeadInputsHandler', () => {
    it('should return 401 if unauthenticated', async () => {
      const req = mockRequest({ params: { threadId: '1' } });
      const res = mockResponse();
      await chatController.getLatestLeadInputsHandler(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 200 for authenticated user', async () => {
      const { getChatThreadById } = await import('../models/chatThreads/functions');
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      (getChatThreadById as jest.Mock).mockResolvedValueOnce({ id: 1, userId: 1 } as any);

      const req = mockAuthRequest(1, { params: { threadId: '1' } });
      const res = mockResponse();
      await chatController.getLatestLeadInputsHandler(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('getLatestScrapingDetailsHandler', () => {
    it('should return 401 if unauthenticated', async () => {
      const req = mockRequest({ params: { threadId: '1' } });
      const res = mockResponse();
      await chatController.getLatestScrapingDetailsHandler(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 200 for authenticated user', async () => {
      const { getChatThreadById } = await import('../models/chatThreads/functions');
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      (getChatThreadById as jest.Mock).mockResolvedValueOnce({ id: 1, userId: 1 } as any);

      const req = mockAuthRequest(1, { params: { threadId: '1' } });
      const res = mockResponse();
      await chatController.getLatestScrapingDetailsHandler(req, res);
      expect(res._status).toBe(200);
    });
  });
});
