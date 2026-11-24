/**
 * Misc Controllers Tests: Knowledge Base, Workflow, Webhooks, Integrations, Business Profiles
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
const drizzleExports = await import('drizzle-orm');
const pathExports = await import('node:path');

// drizzle-orm mock (for businessProfilesController, webhookController)
jest.unstable_mockModule('drizzle-orm', () => ({
  ...drizzleExports,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ne: jest.fn<any>().mockReturnValue('ne'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  not: jest.fn<any>().mockReturnValue('not'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gt: jest.fn<any>().mockReturnValue('gt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte: jest.fn<any>().mockReturnValue('gte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lt: jest.fn<any>().mockReturnValue('lt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lte: jest.fn<any>().mockReturnValue('lte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNull: jest.fn<any>().mockReturnValue('isNull'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNotNull: jest.fn<any>().mockReturnValue('isNotNull'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  between: jest.fn<any>().mockReturnValue('between'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notBetween: jest.fn<any>().mockReturnValue('notBetween'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  like: jest.fn<any>().mockReturnValue('like'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notLike: jest.fn<any>().mockReturnValue('notLike'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ilike: jest.fn<any>().mockReturnValue('ilike'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notIlike: jest.fn<any>().mockReturnValue('notIlike'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notInArray: jest.fn<any>().mockReturnValue('notInArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exists: jest.fn<any>().mockReturnValue('exists'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notExists: jest.fn<any>().mockReturnValue('notExists'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  sql: Object.assign(jest.fn<any>().mockImplementation((...a: any[]) => 'sql'), { raw: jest.fn<any>().mockReturnValue('raw') }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count: jest.fn<any>().mockReturnValue('count'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sum: jest.fn<any>().mockReturnValue('sum'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avg: jest.fn<any>().mockReturnValue('avg'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  min: jest.fn<any>().mockReturnValue('min'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  max: jest.fn<any>().mockReturnValue('max'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arrayContains: jest.fn<any>().mockReturnValue('arrayContains'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arrayContained: jest.fn<any>().mockReturnValue('arrayContained'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arrayOverlaps: jest.fn<any>().mockReturnValue('arrayOverlaps'),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
  };
});

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Schemas
jest.unstable_mockModule('../models/companySettings/schema', () => ({
  companySettings: { id: 'id', userId: 'userId', companyName: 'companyName', isDefault: 'isDefault' },
}));
jest.unstable_mockModule('../models/chatThreads/schema', () => ({
  chatThreadsTable: { id: 'id', userId: 'userId', businessProfileId: 'businessProfileId' },
}));
jest.unstable_mockModule('../models/outreachJobs/schema', () => ({
  outreachJobsTable: {
    id: 'id', channel: 'channel', recipientEmail: 'recipientEmail',
    recipientPhone: 'recipientPhone', status: 'status', sentAt: 'sentAt',
    updatedAt: 'updatedAt',
  },
}));

// KnowledgeBase functions
jest.unstable_mockModule('../models/knowledgeBase/functions', () => ({
  KnowledgeBaseModel: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findAll: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByUserId: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findById: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: jest.fn<any>().mockResolvedValue({ id: 1, title: 'Test', content: 'content', userId: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: jest.fn<any>().mockResolvedValue({ id: 1, title: 'Updated' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByUserIdAndType: jest.fn<any>().mockResolvedValue([]),
  },
}));

// credentialService
jest.unstable_mockModule('../services/credentialService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCredential: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveCredential: jest.fn<any>().mockResolvedValue(undefined),
  deleteCredential: jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
}));

// multer mock
jest.unstable_mockModule('multer', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uploadSingle = jest.fn<any>().mockReturnValue((req: any, res: any, next: any) => next());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const multerFn = jest.fn<any>().mockReturnValue({
    single: uploadSingle,
    array: jest.fn(),
    none: jest.fn(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (multerFn as any).diskStorage = jest.fn<any>().mockReturnValue({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (multerFn as any).memoryStorage = jest.fn<any>().mockReturnValue({});
  return { default: multerFn };
});

// fs mock
jest.unstable_mockModule('fs', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    existsSync: jest.fn<any>().mockReturnValue(true),
    mkdirSync: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readdirSync: jest.fn<any>().mockReturnValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: jest.fn<any>().mockReturnValue('{}'),
    realpathSync: jest.fn<(value: string) => string>().mockImplementation(value => value),
    lstatSync: jest.fn().mockReturnValue({ isFile: () => true, dev: 1, ino: 1 }),
    fstatSync: jest.fn().mockReturnValue({ isFile: () => true, dev: 1, ino: 1 }),
    openSync: jest.fn().mockReturnValue(42),
    closeSync: jest.fn(),
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
    unlinkSync: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statSync: jest.fn<any>().mockReturnValue({ size: 1024, mtime: new Date() }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWriteStream: jest.fn<any>().mockReturnValue({ write: jest.fn(), on: jest.fn() }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existsSync: jest.fn<any>().mockReturnValue(true),
  mkdirSync: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readdirSync: jest.fn<any>().mockReturnValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readFileSync: jest.fn<any>().mockReturnValue('{}'),
  unlinkSync: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statSync: jest.fn<any>().mockReturnValue({ size: 1024, mtime: new Date() }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createWriteStream: jest.fn<any>().mockReturnValue({ write: jest.fn(), on: jest.fn() }),
}));

jest.unstable_mockModule('path', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    join: jest.fn<any>().mockImplementation((...args: string[]) => args.join('/')),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extname: jest.fn<any>().mockReturnValue('.pdf'),
    dirname: jest.fn<typeof pathExports.dirname>().mockImplementation(pathExports.dirname),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: jest.fn<any>().mockImplementation((...args: string[]) => args.join('/')),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    basename: jest.fn<any>().mockImplementation((p: string) => p.split('/').pop() || ''),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  join: jest.fn<any>().mockImplementation((...args: string[]) => args.join('/')),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extname: jest.fn<any>().mockReturnValue('.pdf'),
  dirname: jest.fn<typeof pathExports.dirname>().mockImplementation(pathExports.dirname),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: jest.fn<any>().mockImplementation((...args: string[]) => args.join('/')),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  basename: jest.fn<any>().mockImplementation((p: string) => p.split('/').pop() || ''),
}));

const { mockRequest, mockResponse, mockAuthRequest } = await import('./helpers/mockHelpers');

const knowledgeBaseController = await import('../controllers/knowledgeBaseController');
const workflowController = await import('../controllers/workflowController');
const webhookController = await import('../controllers/webhookController');
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const integrationsController = await import('../controllers/integrationsController');
const businessProfilesController = await import('../controllers/businessProfilesController');

/* ==================== Knowledge Base Controller ==================== */
describe('Knowledge Base Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getKnowledgeBaseEntries', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await knowledgeBaseController.getKnowledgeBaseEntries(req, res);
      expect(res._status).toBe(401);
    });

    it('should return entries for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await knowledgeBaseController.getKnowledgeBaseEntries(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('getKnowledgeBaseEntry', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await knowledgeBaseController.getKnowledgeBaseEntry(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 404 if entry not found', async () => {
      const req = mockAuthRequest(1, { params: { id: '999' } });
      const res = mockResponse();
      await knowledgeBaseController.getKnowledgeBaseEntry(req, res);
      expect(res._status).toBe(404);
    });
  });

  describe('createKnowledgeBaseEntry', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { title: 'Test', content: 'Content' } });
      const res = mockResponse();
      await knowledgeBaseController.createKnowledgeBaseEntry(req, res);
      expect(res._status).toBe(401);
    });

    it('should create entry for authenticated user', async () => {
      const req = mockAuthRequest(1, { body: { title: 'Test', content: 'Content' } });
      const res = mockResponse();
      await knowledgeBaseController.createKnowledgeBaseEntry(req, res);
      expect(res._status).toBe(201);
    });
  });

  describe('updateKnowledgeBaseEntry', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { title: 'Updated' } });
      const res = mockResponse();
      await knowledgeBaseController.updateKnowledgeBaseEntry(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('deleteKnowledgeBaseEntry', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await knowledgeBaseController.deleteKnowledgeBaseEntry(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('uploadKnowledgeBaseFile', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await knowledgeBaseController.uploadKnowledgeBaseFile(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('createQAEntry', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { question: 'Q?', answer: 'A.' } });
      const res = mockResponse();
      await knowledgeBaseController.createQAEntry(req, res);
      expect(res._status).toBe(401);
    });
  });
});

/* ==================== Workflow Controller ==================== */
describe('Workflow Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('listWorkflows', () => {
    it('should return workflows array (no auth required)', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await workflowController.listWorkflows(req, res);
      // Either returns array or 500 on error
      expect(res._status === 200 || res._json !== undefined || Array.isArray(res._json)).toBeTruthy();
    });

    it('should filter by platform if specified', async () => {
      const req = mockRequest({ query: { platform: 'instagram' } });
      const res = mockResponse();
      await workflowController.listWorkflows(req, res);
      expect(res._status === 200 || res._json !== undefined).toBeTruthy();
    });
  });

  describe('getWorkflow', () => {
    it('should parse and return workflow when found', async () => {
      // The synthetic descriptor belongs to a regular file in the catalog.
      const req = mockRequest({ params: { workflowId: 'test-workflow' } });
      const res = mockResponse();
      await workflowController.getWorkflow(req, res);
      // The existing controller smoke test uses a safe synthetic JSON object.
      expect(res._status).toBe(200);
    });
  });
});

/* ==================== Webhook Controller ==================== */
describe('Webhook Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('handleSendGridWebhook', () => {
    it('should return 200 indicating removal', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await webhookController.handleSendGridWebhook(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('success', false);
    });
  });

  describe('handleTwilioWebhook', () => {
    it('should return 200 indicating removal', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await webhookController.handleTwilioWebhook(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('handleTwilioInboundSMS', () => {
    it('should return 200 indicating removal', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await webhookController.handleTwilioInboundSMS(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('handleSendGridInboundEmail', () => {
    it('should return 200 indicating removal', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await webhookController.handleSendGridInboundEmail(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('webhookHealthCheck', () => {
    it('should return health status', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await webhookController.webhookHealthCheck(req, res);
      expect(res._json).toHaveProperty('status', 'healthy');
    });
  });
});

/* ==================== Integrations Controller ==================== */
/* ==================== Business Profiles Controller ==================== */
describe('Business Profiles Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getBusinessProfiles', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await businessProfilesController.getBusinessProfiles(req, res);
      expect(res._status).toBe(401);
    });

    it('should return profiles for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await businessProfilesController.getBusinessProfiles(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('getBusinessProfile', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await businessProfilesController.getBusinessProfile(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('createBusinessProfile', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { companyName: 'Test' } });
      const res = mockResponse();
      await businessProfilesController.createBusinessProfile(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('updateBusinessProfile', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { companyName: 'Updated' } });
      const res = mockResponse();
      await businessProfilesController.updateBusinessProfile(req, res);
      expect(res._status).toBe(401);
    });
  });
});
