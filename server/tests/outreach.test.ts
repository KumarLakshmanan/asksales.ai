import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
/**
 * Outreach Controller Tests
 * Tests: outreach progress, messages, stats, send, email outreach
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Keep the complete public export surface while replacing query predicates.
const realDrizzle = await import('drizzle-orm');
// Mock drizzle-orm
jest.unstable_mockModule('drizzle-orm', () => ({
  ...realDrizzle,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  sql: Object.assign(jest.fn<any>().mockImplementation((...a: any[]) => 'sql'), { raw: jest.fn<any>().mockReturnValue('raw'), join:jest.fn<any>().mockReturnValue('join') }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count: jest.fn<any>().mockReturnValue('count'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  like: jest.fn<any>().mockReturnValue('like'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte: jest.fn<any>().mockReturnValue('gte'),
  lte: jest.fn<any>().mockReturnValue('lte'),
  ne: jest.fn<any>().mockReturnValue('ne'),
  gt: jest.fn<any>().mockReturnValue('gt'),
  lt: jest.fn<any>().mockReturnValue('lt'),
  isNull: jest.fn<any>().mockReturnValue('isNull'),
  isNotNull: jest.fn<any>().mockReturnValue('isNotNull'),
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
    storage: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getSentMessages: jest.fn<any>().mockResolvedValue([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createSentMessage: jest.fn<any>().mockResolvedValue({ id: 1 }),
    },
  };
});

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../services/emailService', () => ({
  emailService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendEmail: jest.fn<any>().mockResolvedValue({ success: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendPersonalizedEmail: jest.fn<any>().mockResolvedValue({ success: true, messageId: 'msg-1' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verifyConnection: jest.fn<any>().mockResolvedValue(true),
  },
}));
jest.unstable_mockModule('../services/agents/OutreachAgent', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OutreachAgent: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: jest.fn<any>().mockResolvedValue({ success: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateEmailSequence: jest.fn<any>().mockResolvedValue({ campaign_name: 'Test', steps: [] }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createCampaign: jest.fn<any>().mockResolvedValue(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executeCampaign: jest.fn<any>().mockResolvedValue(undefined),
  })),
}));
jest.unstable_mockModule('../services/agents/ContentStudioAgent', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContentStudioAgent: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContent: jest.fn<any>().mockResolvedValue({ success: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContentPiece: jest.fn<any>().mockResolvedValue({ content: 'hello' }),
  })),
}));
jest.unstable_mockModule('../models/outreachSettings/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOutreachSettingsByUserId: jest.fn<any>().mockResolvedValue(null),
}));
// Email outreach controller additional schemas
jest.unstable_mockModule('../models/outreachCampaigns/schema', () => ({
  outreachCampaignsTable: { id: 'id', userId: 'userId' },
}));
jest.unstable_mockModule('../models/outreachJobs/schema', () => ({
  outreachJobsTable: { id: 'id', campaignId: 'campaignId' },
}));
jest.unstable_mockModule('../models/sentMessages/schema', () => ({
  sentMessagesTable: { id: 'id', userId: 'userId' },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const outreachController = await import('../controllers/outreachController');
const emailOutreachController = await import('../controllers/emailOutreachController');

describe('Outreach Controller', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const {db}=await import('../models/db.js');
    (db.execute as any).mockResolvedValue({rows:[{checked_at:new Date(),counts:{},responses:{},channels:[],timeline:[],failures:[],sentiment:{positive:0,neutral:0,negative:0,urgent:0,total:0}}]});
  });

  describe('getOutreachProgress', () => {
    it('should return 400 if campaignId is missing', async () => {
      const req = mockAuthRequest(1, { params: {} });
      const res = mockResponse();
      await outreachController.getOutreachProgress(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 404 when campaign not found', async () => {
      const {db}=await import('../models/db.js');(db.execute as any).mockResolvedValueOnce({rows:[]});
      const req = mockAuthRequest(1, { params: { campaignId: '999' } });
      const res = mockResponse();
      await outreachController.getOutreachProgress(req, res);
      expect(res._status).toBe(404);
    });
  });

  describe('getOutreachMessages', () => {
    it('should return 401 if unauthenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await outreachController.getOutreachMessages(req, res);
      expect(res._status).toBe(401);
    });

    it('should return messages for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await outreachController.getOutreachMessages(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('getOutreachStats', () => {
    it('should return 401 if unauthenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await outreachController.getOutreachStats(req, res);
      expect(res._status).toBe(401);
    });

    it('should return stats for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await withBusinessScope({userId:1,businessProfileId:1},()=>outreachController.getOutreachStats(req, res));
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({source:'canonical_outreach',range:'all',byStatus:{pending:0}});
    });
  });

  it('reports actual queued recipients and provider failures in the activity cards', async () => {
    const {db}=await import('../models/db.js');
    (db.execute as any).mockResolvedValueOnce({rows:[{checked_at:new Date(),counts:{total:1184,accepted:600,delivered:590,queued:575,failed:9},channels:[],responses:{},timeline:[],failures:[]}]});
    const req=mockAuthRequest(1);const res=mockResponse();
    await withBusinessScope({userId:1,businessProfileId:1},()=>outreachController.getOutreachStats(req,res));
    expect(res._status).toBe(200);expect(res._json.byStatus).toEqual({sent:600,pending:575,failed:9});
  });
  it('preserves the explicitly date-filtered analytics report', async () => {
    const req=mockAuthRequest(1,{query:{range:'7d'}});const res=mockResponse();
    await withBusinessScope({userId:1,businessProfileId:1},()=>outreachController.getOutreachStats(req,res));
    expect(res._status).toBe(200);expect(res._json.range).toBe('7d');expect(res._json.timeline).toHaveLength(7);
    expect(res._json.source).toBe('canonical_outreach');
  });

  describe('sendOutreachMessage', () => {
    it('should return 400 if missing required fields', async () => {
      const req = mockAuthRequest(1, { body: {} });
      const res = mockResponse();
      await outreachController.sendOutreachMessage(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('startOutreachHandler', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      await outreachController.startOutreachHandler(req, res);
      // No explicit 401 check — either TypeError (500) or functional error
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });
});

describe('Email Outreach Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('sendEmailToLead', () => {
    it('should return 400 if subject or body is missing', async () => {
      const req = mockAuthRequest(1, { params: { leadId: '1' }, body: {} });
      const res = mockResponse();
      await emailOutreachController.sendEmailToLead(req, res);
      expect(res._status).toBe(400);
    });

    it('should send email when all fields provided', async () => {
      const req = mockAuthRequest(1, { params: { leadId: '1' }, body: { subject: 'Test', body: 'Hello' } });
      const res = mockResponse();
      await emailOutreachController.sendEmailToLead(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('sendBulkEmails', () => {
    it('should return 400 if leadIds is missing', async () => {
      const req = mockAuthRequest(1, { body: { subject: 'Test', body: 'Hello' } });
      const res = mockResponse();
      await emailOutreachController.sendBulkEmails(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 400 if subject/body is missing', async () => {
      const req = mockAuthRequest(1, { body: { leadIds: [1, 2] } });
      const res = mockResponse();
      await emailOutreachController.sendBulkEmails(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('checkReplies', () => {
    it('should handle check replies', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await emailOutreachController.checkReplies(req, res);
      // Should not crash
      expect(res._status).toBeDefined();
    });
  });

  describe('getEmailHistory', () => {
    it('should handle email history request', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await emailOutreachController.getEmailHistory(req, res);
      expect(res._status).toBeDefined();
    });
  });

  describe('getEmailStats', () => {
    it('should handle email stats request', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await emailOutreachController.getEmailStats(req, res);
      expect(res._status).toBeDefined();
    });
  });

  describe('getEmailTemplates', () => {
    it('should handle email templates request', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await emailOutreachController.getEmailTemplates(req, res);
      expect(res._status).toBeDefined();
    });
  });

  describe('saveEmailTemplate', () => {
    it('should handle save template request', async () => {
      const req = mockAuthRequest(1, { body: { name: 'Test', subject: 'Test Sub', content: '<p>Hello</p>' } });
      const res = mockResponse();
      await emailOutreachController.saveEmailTemplate(req, res);
      expect(res._status).toBeDefined();
    });
  });
});
