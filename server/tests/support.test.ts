/**
 * Support Controller Tests
 * Tests: getTickets, getTicket, createTicket, updateTicket,
 *        deleteTicket, addMessage, getMessages, getSupportAnalytics
 */
import * as drizzle from 'drizzle-orm';
import * as privacyVault from '../services/agents/orchestration/PrivacyVaultService.js';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockTicket = {
  id: 1,
  ticketNumber: 'TKT-001',
  subject: 'Test ticket',
  status: 'open',
  priority: 'medium',
  userId: 1,
  leadId: null,
  description: 'A test support ticket',
  createdAt: new Date().toISOString(),
};

jest.unstable_mockModule('../services/SupportService.js', () => ({
  SupportValidationError: class SupportValidationError extends Error {},
  supportService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTickets: jest.fn<any>().mockResolvedValue({ tickets: [mockTicket], total: 1, page: 1, limit: 20 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTicketById: jest.fn<any>().mockResolvedValue(mockTicket),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markTicketRead: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTicketWorkspace: jest.fn<any>().mockResolvedValue(mockTicket),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTicket: jest.fn<any>().mockResolvedValue(mockTicket),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateTicket: jest.fn<any>().mockResolvedValue(mockTicket),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteTicket: jest.fn<any>().mockResolvedValue(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addMessage: jest.fn<any>().mockResolvedValue({ id: 10, ticketId: 1, content: 'Reply text', direction: 'outbound' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMessages: jest.fn<any>().mockResolvedValue([{ id: 10, content: 'test' }]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAnalytics: jest.fn<any>().mockResolvedValue({ totalTickets: 5, openTickets: 2 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoCreateTicketOnNegativeSentiment: jest.fn<any>().mockResolvedValue(mockTicket),
  },
}));

const deliverReply = jest.fn<any>().mockResolvedValue({
  message: { id: 10, ticketId: 1, content: 'Reply text', direction: 'outbound', attachments: [] },
  deliveryActionId: 1,
  replayed: false,
});
jest.unstable_mockModule('../services/SupportReplyDeliveryService.js', () => ({
  SupportReplyDeliveryError: class SupportReplyDeliveryError extends Error {
    statusCode = 502;
  },
  supportReplyDeliveryService: { deliver: deliverReply },
}));

jest.unstable_mockModule('../services/StorageService.js', () => ({
  StorageService: {
    getInstance: () => ({ getFile: jest.fn() }),
  },
}));

jest.unstable_mockModule('../utils/emailTemplates', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getBrandInfo: jest.fn<any>().mockResolvedValue({ name: 'Test Co', logoUrl: '' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderSupportReplyEmail: jest.fn<any>().mockReturnValue('<html>email</html>'),
}));

jest.unstable_mockModule('../models/db', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { execute: jest.fn<any>().mockResolvedValue({ rows: [] }) },
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  ...drizzle,
  sql: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    (strings: TemplateStringsArray, ...values: any[]) => ({ _tag: 'raw' }),
    { raw: jest.fn() }
  ),
  eq: jest.fn(),
  and: jest.fn(),
}));

jest.unstable_mockModule('../services/NotificationService.js', () => ({
  NotificationService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketCreated: jest.fn<any>().mockReturnValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketUpdated: jest.fn<any>().mockReturnValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketResolved: jest.fn<any>().mockReturnValue(undefined),
  },
}));

jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  ...privacyVault,
  privacyVaultService: { reveal: jest.fn() },
}));

// ── Import ─────────────────────────────────────────────────────────────
const { mockRequest, mockResponse, mockAuthRequest } = await import('./helpers/mockHelpers');

const {
  getTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  addMessage,
  getMessages,
  getSupportAnalytics,
} = await import('../controllers/supportController');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { supportService } = await import('../services/SupportService.js') as any;

// ── Tests ──────────────────────────────────────────────────────────────
describe('Support Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  // ── getTickets ──────────────────────────────────────────────────────
  describe('getTickets', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await getTickets(req, res);
      expect(res._status).toBe(401);
    });

    it('should return tickets for authenticated user', async () => {
      supportService.getTickets.mockResolvedValue({ tickets: [mockTicket], total: 1, page: 1, limit: 20 });
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await getTickets(req, res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
      expect(res._json.tickets).toHaveLength(1);
    });

    it('should pass filter params to service', async () => {
      supportService.getTickets.mockResolvedValue({ tickets: [], total: 0 });
      const req = mockAuthRequest(1, { query: { status: 'open', priority: 'high' } });
      const res = mockResponse();
      await getTickets(req, res);
      expect(supportService.getTickets).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'open', priority: 'high' }), { kind: 'owner', id: 1 });
    });

    it('accepts the lightweight pipeline view with the authenticated reader', async () => {
      const res = mockResponse();
      await getTickets(mockAuthRequest(1, { query: { view: 'pipeline', page: '2', limit: '100' } }), res);
      expect(res._status).toBe(200);
      expect(supportService.getTickets).toHaveBeenCalledWith(1, expect.objectContaining({ view: 'pipeline', page: 2, limit: 100 }), { kind: 'owner', id: 1 });
    });

    it('rejects an unsupported view before querying tickets', async () => {
      const res = mockResponse();
      await getTickets(mockAuthRequest(1, { query: { view: 'unscoped' } }), res);
      expect(res._status).toBe(400);
      expect(supportService.getTickets).not.toHaveBeenCalled();
    });
  });

  // ── getTicket ───────────────────────────────────────────────────────
  describe('getTicket', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await getTicket(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 404 if ticket not found', async () => {
      supportService.getTicketById.mockResolvedValue(null);
      const req = mockAuthRequest(1, { params: { id: '9999' } });
      const res = mockResponse();
      await getTicket(req, res);
      expect(res._status).toBe(404);
    });

    it('should return ticket for authenticated user', async () => {
      supportService.getTicketById.mockResolvedValue(mockTicket);
      const req = mockAuthRequest(1, { params: { id: '1' } });
      const res = mockResponse();
      await getTicket(req, res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
      expect(res._json.data.id).toBe(1);
      expect(supportService.markTicketRead).toHaveBeenCalledWith(1, 1, 'owner', 1);
    });
  });

  // ── createTicket ────────────────────────────────────────────────────
  describe('createTicket', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { subject: 'Test' } });
      const res = mockResponse();
      await createTicket(req, res);
      expect(res._status).toBe(401);
    });

    it('should create ticket and return 201', async () => {
      supportService.createTicket.mockResolvedValue(mockTicket);
      const req = mockAuthRequest(1, {
        body: {
          subject: 'Cannot access dashboard',
          description: 'Getting 404 error',
          priority: 'high',
          category: 'technical',
        },
      });
      const res = mockResponse();
      await createTicket(req, res);
      expect(res._status).toBe(201);
      expect(res._json.success).toBe(true);
      expect(res._json.data.ticketNumber).toBe('TKT-001');
    });

    it('should call service with correct userId', async () => {
      supportService.createTicket.mockResolvedValue(mockTicket);
      const req = mockAuthRequest(42, { body: { subject: 'Issue' } });
      const res = mockResponse();
      await createTicket(req, res);
      expect(supportService.createTicket).toHaveBeenCalledWith(42, expect.any(Object));
    });
  });

  // ── updateTicket ────────────────────────────────────────────────────
  describe('updateTicket', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { status: 'closed' } });
      const res = mockResponse();
      await updateTicket(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 404 if ticket not found', async () => {
      supportService.updateTicket.mockResolvedValue(null);
      const req = mockAuthRequest(1, { params: { id: '9999' }, body: { status: 'closed' } });
      const res = mockResponse();
      await updateTicket(req, res);
      expect(res._status).toBe(404);
    });

    it('should update ticket and return 200', async () => {
      supportService.updateTicket.mockResolvedValue({ ...mockTicket, status: 'closed' });
      supportService.getTicketWorkspace.mockResolvedValue({ ...mockTicket, status: 'closed' });
      const req = mockAuthRequest(1, { params: { id: '1' }, body: { status: 'closed' } });
      const res = mockResponse();
      await updateTicket(req, res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
    });
  });

  it('allows an owner to close existing work in a disabled queue without assigning it there again', async () => {
    supportService.getTicketById.mockResolvedValueOnce({ ...mockTicket, teamId: 2 });
    supportService.updateTicket.mockResolvedValueOnce({ ...mockTicket, teamId: 2, status: 'closed' });
    const req = mockAuthRequest(1, { params: { id: '1' }, body: { status: 'closed' } });
    const res = mockResponse();
    await updateTicket(req, res);
    expect(res._status).toBe(200);
    expect(supportService.updateTicket).toHaveBeenCalledWith(1, 1, { status: 'closed' },
      expect.objectContaining({ actorUserId: 1 }));
  });

  // ── deleteTicket ────────────────────────────────────────────────────
  describe('deleteTicket', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await deleteTicket(req, res);
      expect(res._status).toBe(401);
    });

    it('should delete ticket and return 200', async () => {
      supportService.deleteTicket.mockResolvedValue(true);
      const req = mockAuthRequest(1, { params: { id: '1' } });
      const res = mockResponse();
      await deleteTicket(req, res);
      expect(res._status).toBe(200);
    });
  });

  // ── addMessage ──────────────────────────────────────────────────────
  describe('addMessage', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { content: 'Reply text' } });
      const res = mockResponse();
      await addMessage(req, res);
      expect(res._status).toBe(401);
    });

    it('should add message to ticket and return 201', async () => {
      const req = mockAuthRequest(1, {
        params: { id: '1' },
        body: {
          content: 'We have resolved your issue.',
          idempotencyKey: 'reply-test-key-001',
        },
      });
      const res = mockResponse();
      await addMessage(req, res);
      expect(res._status).toBe(201);
      expect(deliverReply).toHaveBeenCalledWith(expect.objectContaining({
        ticket: mockTicket,
        content: 'We have resolved your issue.',
      }));
    });
  });

  // ── getMessages ─────────────────────────────────────────────────────
  describe('getMessages', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await getMessages(req, res);
      expect(res._status).toBe(401);
    });

    it('should return messages for ticket', async () => {
      supportService.getMessages.mockResolvedValue([{ id: 1, content: 'Hello' }]);
      const req = mockAuthRequest(1, { params: { id: '1' }, query: {} });
      const res = mockResponse();
      await getMessages(req, res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
    });
  });

  // ── getSupportAnalytics ─────────────────────────────────────────────
  describe('getSupportAnalytics', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await getSupportAnalytics(req, res);
      expect(res._status).toBe(401);
    });

    it('should return analytics for authenticated user', async () => {
      supportService.getAnalytics.mockResolvedValue({ totalTickets: 5, openTickets: 2 });
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await getSupportAnalytics(req, res);
      expect(res._status).toBe(200);
    });
  });
});
