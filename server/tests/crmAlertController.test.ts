/**
 * CRM Alert Controller Tests  
 * Tests: getAlertEventTypes, getAlerts, createAlert, updateAlert, deleteAlert, getAlertLogs
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- Mock ALL dependencies ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAlerts = jest.fn<any>().mockResolvedValue([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateAlert = jest.fn<any>().mockResolvedValue({ id: 1, name: 'Test Alert' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateAlert = jest.fn<any>().mockResolvedValue({ id: 1, name: 'Updated' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDeleteAlert = jest.fn<any>().mockResolvedValue(true);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAlertLogs = jest.fn<any>().mockResolvedValue([]);

jest.unstable_mockModule('../services/AlertService', () => ({
  alertService: {
    getAlerts: mockGetAlerts,
    createAlert: mockCreateAlert,
    updateAlert: mockUpdateAlert,
    deleteAlert: mockDeleteAlert,
    getAlertLogs: mockGetAlertLogs,
  },
  ALERT_EVENT_TYPES: [
    { value: 'status_changed_to', label: 'Status Changed To' },
    { value: 'deal_won', label: 'Deal Won' },
  ],
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../services/CRMService.js', () => ({
  crmService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContacts: jest.fn<any>().mockResolvedValue({ data: [], total: 0 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContactById: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createContact: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateContact: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteContact: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPipelineData: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatePipelineStatus: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addNote: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getNotes: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getActivityHistory: jest.fn<any>().mockResolvedValue([]),
  },
  PIPELINE_STAGES: ['new', 'contacted', 'interested', 'negotiations', 'demo', 'proposal_sent', 'ticket_open', 'ticket_close', 'won', 'lost'],
}));

jest.unstable_mockModule('../services/AutomationService.js', () => ({
  automationService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAutomations: jest.fn<any>().mockResolvedValue([]),
  },
}));

jest.unstable_mockModule('../services/ReminderService.js', () => ({
  reminderService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getActivityRemindersWithContacts: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createActivityReminder: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateActivityReminder: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteActivityReminder: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createChain = (resolveValue: any = []): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  ['from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'values', 'set', 'returning'].forEach(m => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain[m] = jest.fn<any>().mockReturnValue(chain);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (resolve: any, reject?: any) => Promise.resolve(resolveValue).then(resolve, reject);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.catch = (fn: any) => Promise.resolve(resolveValue).catch(fn);
  return chain;
};

jest.unstable_mockModule('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notInArray: jest.fn<any>().mockReturnValue('notInArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNull: jest.fn<any>().mockReturnValue('isNull'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNotNull: jest.fn<any>().mockReturnValue('isNotNull'),
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
  ne: jest.fn<any>().mockReturnValue('ne'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: Object.assign(jest.fn<any>(), { raw: jest.fn<any>() }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count: jest.fn<any>().mockReturnValue('count'),
}));

jest.unstable_mockModule('../models/db.js', () => ({
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
  },
}));

jest.unstable_mockModule('../models/outreachConversations/schema.js', () => ({
  outreachConversationsTable: { id: 'id' },
  outreachMessagesTable: { id: 'id' },
}));
jest.unstable_mockModule('../models/sentMessages/schema.js', () => ({
  sentMessagesTable: { id: 'id' },
}));
jest.unstable_mockModule('../models/supportTickets/schema.js', () => ({
  supportTicketsTable: { id: 'id' },
}));
jest.unstable_mockModule('../models/supportTicketMessages/schema.js', () => ({
  supportTicketMessagesTable: { id: 'id' },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const controller = await import('../controllers/crmController');

describe('CRM Alert Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  // ─── getAlertEventTypes ──────────────────────────────────────────────

  describe('GET /api/crm/alerts/event-types', () => {
    it('should return alert event types', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await controller.getAlertEventTypes(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.data).toHaveLength(2);
    });
  });

  // ─── getAlerts ───────────────────────────────────────────────────────

  describe('GET /api/crm/alerts', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await controller.getAlerts(req, res);
      expect(res._status).toBe(401);
    });

    it('should return alerts for authenticated user', async () => {
      mockGetAlerts.mockResolvedValueOnce([{ id: 1, name: 'Alert 1' }]);
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await controller.getAlerts(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.data).toHaveLength(1);
    });

    it('should return empty array when no alerts', async () => {
      mockGetAlerts.mockResolvedValueOnce([]);
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await controller.getAlerts(req, res);
      expect(res._json.data).toEqual([]);
    });
  });

  // ─── createAlert ─────────────────────────────────────────────────────

  describe('POST /api/crm/alerts', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { name: 'Test', eventType: 'deal_won' } });
      const res = mockResponse();
      await controller.createAlert(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if name is missing', async () => {
      const req = mockAuthRequest(1, { body: { eventType: 'deal_won' } });
      const res = mockResponse();
      await controller.createAlert(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 400 if eventType is missing', async () => {
      const req = mockAuthRequest(1, { body: { name: 'Test' } });
      const res = mockResponse();
      await controller.createAlert(req, res);
      expect(res._status).toBe(400);
    });

    it('should create alert with valid input', async () => {
      mockCreateAlert.mockResolvedValueOnce({ id: 1, name: 'New Alert', eventType: 'deal_won' });
      const req = mockAuthRequest(1, {
        body: { name: 'New Alert', eventType: 'deal_won', notifyUser: true }
      });
      const res = mockResponse();
      await controller.createAlert(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.data.name).toBe('New Alert');
      expect(mockCreateAlert).toHaveBeenCalledWith(1, expect.objectContaining({
        name: 'New Alert',
        eventType: 'deal_won',
      }));
    });

    it('should pass conditions to service', async () => {
      mockCreateAlert.mockResolvedValueOnce({ id: 2 });
      const req = mockAuthRequest(1, {
        body: { name: 'Won Alert', eventType: 'status_changed_to', conditions: { stage: 'won' } }
      });
      const res = mockResponse();
      await controller.createAlert(req, res);
      expect(mockCreateAlert).toHaveBeenCalledWith(1, expect.objectContaining({
        conditions: { stage: 'won' },
      }));
    });
  });

  // ─── updateAlert ─────────────────────────────────────────────────────

  describe('PUT /api/crm/alerts/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await controller.updateAlert(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 for invalid alert ID', async () => {
      const req = mockAuthRequest(1, { params: { id: 'abc' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await controller.updateAlert(req, res);
      expect(res._status).toBe(400);
    });

    it('should return 404 if alert not found', async () => {
      mockUpdateAlert.mockResolvedValueOnce(null);
      const req = mockAuthRequest(1, { params: { id: '999' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await controller.updateAlert(req, res);
      expect(res._status).toBe(404);
    });

    it('should update alert successfully', async () => {
      mockUpdateAlert.mockResolvedValueOnce({ id: 1, name: 'Updated Alert' });
      const req = mockAuthRequest(1, { params: { id: '1' }, body: { name: 'Updated Alert' } });
      const res = mockResponse();
      await controller.updateAlert(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.data.name).toBe('Updated Alert');
    });

    it('should toggle enabled status', async () => {
      mockUpdateAlert.mockResolvedValueOnce({ id: 1, enabled: false });
      const req = mockAuthRequest(1, { params: { id: '1' }, body: { enabled: false } });
      const res = mockResponse();
      await controller.updateAlert(req, res);
      expect(mockUpdateAlert).toHaveBeenCalledWith(1, 1, { enabled: false });
    });
  });

  // ─── deleteAlert ─────────────────────────────────────────────────────

  describe('DELETE /api/crm/alerts/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await controller.deleteAlert(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 for invalid ID', async () => {
      const req = mockAuthRequest(1, { params: { id: 'nope' } });
      const res = mockResponse();
      await controller.deleteAlert(req, res);
      expect(res._status).toBe(400);
    });

    it('should delete alert successfully', async () => {
      const req = mockAuthRequest(1, { params: { id: '5' } });
      const res = mockResponse();
      await controller.deleteAlert(req, res);
      expect(res._json.success).toBe(true);
      expect(mockDeleteAlert).toHaveBeenCalledWith(1, 5);
    });
  });

  // ─── getAlertLogs ────────────────────────────────────────────────────

  describe('GET /api/crm/alerts/logs', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: {} });
      const res = mockResponse();
      await controller.getAlertLogs(req, res);
      expect(res._status).toBe(401);
    });

    it('should return all logs for user', async () => {
      mockGetAlertLogs.mockResolvedValueOnce([{ id: 1, eventType: 'deal_won' }]);
      const req = mockAuthRequest(1, { params: {} });
      const res = mockResponse();
      await controller.getAlertLogs(req, res);
      expect(res._json.success).toBe(true);
      expect(res._json.data).toHaveLength(1);
    });

    it('should filter by alertId when provided', async () => {
      mockGetAlertLogs.mockResolvedValueOnce([]);
      const req = mockAuthRequest(1, { params: { id: '3' } });
      const res = mockResponse();
      await controller.getAlertLogs(req, res);
      expect(mockGetAlertLogs).toHaveBeenCalledWith(1, 3);
    });
  });
});
