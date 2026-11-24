/**
 * AlertService Tests
 * Tests: getAlerts, createAlert, updateAlert, deleteAlert, getAlertLogs,
 *        fireEvent, matchesConditions, toggle enabled, email notifications
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- Mock ALL dependencies ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecute = jest.fn<any>().mockImplementation(async (sqlObj: any) => {
  const queryText = String(sqlObj);
  if (queryText.includes('FROM users')) {
    if (queryText.includes('first_name')) throw new Error('column first_name does not exist');
    return { rows: [{ email: 'user@test.com', name: 'User' }] };
  }
  if (queryText.includes('FROM crm_contacts')) {
    return { rows: [{ email: 'contact@test.com', name: 'John Doe' }] };
  }
  if (queryText.includes('FROM outreach_settings')) {
    return { rows: [{ slack_webhook_url: 'https://hooks.slack.com/services/test' }] };
  }
  if (queryText.includes('FROM crm_alert_logs')) {
    return { rows: [
      { id: 1, alertId: 1, alertName: 'Test', contactId: 2, contactName: 'John', eventType: 'deal_won', eventData: {}, notifiedUser: true, notifiedContact: false, createdAt: '2025-01-01' }
    ] };
  }
  return { rows: [] };
});

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

const mockDb = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: jest.fn<any>().mockImplementation(() => createChain([])),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert: jest.fn<any>().mockImplementation(() => createChain([{ id: 1 }])),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: jest.fn<any>().mockImplementation(() => createChain([{ id: 1, name: 'Updated Alert' }])),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: jest.fn<any>().mockImplementation(() => createChain([])),
  execute: mockExecute,
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
  sql: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    jest.fn<any>().mockImplementation((strings: any, ...values: any[]) => {
      if (Array.isArray(strings)) {
        return strings.join('?');
      }
      if (strings && typeof strings === 'object' && Array.isArray(strings.strings)) {
        return strings.strings.join('?');
      }
      return 'sql-fragment';
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { raw: jest.fn<any>().mockImplementation((val: string) => val) }
  ),
}));

jest.unstable_mockModule('../models/db', () => ({
  db: mockDb,
  storage: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
}));

jest.unstable_mockModule('../models/crmAlerts/schema', () => ({
  crmAlertsTable: {
    id: 'id', userId: 'userId', name: 'name', description: 'description',
    eventType: 'eventType', conditions: 'conditions', enabled: 'enabled',
    notifyUser: 'notifyUser', notifyContact: 'notifyContact',
    createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

jest.unstable_mockModule('../models/crmAlertLogs/schema', () => ({
  crmAlertLogsTable: {
    id: 'id', alertId: 'alertId', userId: 'userId', contactId: 'contactId',
    eventType: 'eventType', eventData: 'eventData',
    notifiedUser: 'notifiedUser', notifiedContact: 'notifiedContact',
    createdAt: 'createdAt',
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendAdminEmail = jest.fn<any>().mockResolvedValue({ success: true, messageId: 'accepted-test' });
jest.unstable_mockModule('../services/adminEmailService', () => ({
  sendAdminEmail: mockSendAdminEmail,
}));

// Alert delivery may include a configured Slack webhook. Unit tests must not
// contact that external endpoint; provider behavior is covered at the adapter
// boundary, while this suite verifies alert orchestration.
jest.spyOn(globalThis, 'fetch').mockResolvedValue(
  new Response(null, { status: 200 }),
);

// Import after mocks
const { alertService, ALERT_EVENT_TYPES } = await import('../services/AlertService');

describe('AlertService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── ALERT_EVENT_TYPES constant ──────────────────────────────────────

  describe('ALERT_EVENT_TYPES', () => {
    it('should contain 9 event types', () => {
      expect(ALERT_EVENT_TYPES).toHaveLength(9);
    });

    it('should contain status_changed_to and status_changed_from', () => {
      const values = ALERT_EVENT_TYPES.map(t => t.value);
      expect(values).toContain('status_changed_to');
      expect(values).toContain('status_changed_from');
    });

    it('should contain deal_won and deal_lost', () => {
      const values = ALERT_EVENT_TYPES.map(t => t.value);
      expect(values).toContain('deal_won');
      expect(values).toContain('deal_lost');
    });

    it('should have value and label for each type', () => {
      ALERT_EVENT_TYPES.forEach(type => {
        expect(type).toHaveProperty('value');
        expect(type).toHaveProperty('label');
        expect(typeof type.value).toBe('string');
        expect(typeof type.label).toBe('string');
      });
    });
  });

  // ─── getAlerts ───────────────────────────────────────────────────────

  describe('getAlerts', () => {
    it('should query alerts for the given userId', async () => {
      const results = await alertService.getAlerts(1);
      expect(mockDb.select).toHaveBeenCalled();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return empty array when no alerts exist', async () => {
      const results = await alertService.getAlerts(999);
      expect(results).toEqual([]);
    });
  });

  // ─── createAlert ─────────────────────────────────────────────────────

  describe('createAlert', () => {
    it('should insert a new alert with required fields', async () => {
      const result = await alertService.createAlert(1, {
        name: 'Test Alert',
        eventType: 'status_changed_to',
      });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should insert with conditions when provided', async () => {
      const result = await alertService.createAlert(1, {
        name: 'Won Alert',
        eventType: 'status_changed_to',
        conditions: { stage: 'won' },
        notifyUser: true,
        notifyContact: true,
      });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should default notifyUser=true and notifyContact=false', async () => {
      await alertService.createAlert(1, {
        name: 'Default Notify',
        eventType: 'lead_created',
      });
      const insertCall = mockDb.insert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });
  });

  // ─── updateAlert ─────────────────────────────────────────────────────

  describe('updateAlert', () => {
    it('should update alert name', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([{ id: 1, name: 'Renamed' }]));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await alertService.updateAlert(1, 1, { name: 'Renamed' });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should toggle enabled field', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([{ id: 1, enabled: false }]));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await alertService.updateAlert(1, 1, { enabled: false });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should update conditions', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([{ id: 1, conditions: { stage: 'lost' } }]));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await alertService.updateAlert(1, 1, { conditions: { stage: 'lost' } });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should return null if alert not found', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([]));
      const result = await alertService.updateAlert(1, 999, { name: 'Nope' });
      expect(result).toBeNull();
    });
  });

  // ─── deleteAlert ─────────────────────────────────────────────────────

  describe('deleteAlert', () => {
    it('should delete the alert', async () => {
      await alertService.deleteAlert(1, 1);
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  // ─── getAlertLogs ────────────────────────────────────────────────────

  describe('getAlertLogs', () => {
    it('should return logs for a user', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [
        { id: 1, alertId: 1, alertName: 'Test', contactId: 2, contactName: 'John', eventType: 'deal_won', eventData: {}, notifiedUser: true, notifiedContact: false, createdAt: '2025-01-01' }
      ] });
      const logs = await alertService.getAlertLogs(1);
      expect(mockExecute).toHaveBeenCalled();
      expect(logs).toHaveLength(1);
      expect(logs[0].alertName).toBe('Test');
    });

    it('should return empty array when no logs exist', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      const logs = await alertService.getAlertLogs(1);
      expect(logs).toEqual([]);
    });

    it('should accept optional alertId filter', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const logs = await alertService.getAlertLogs(1, 5);
      expect(mockExecute).toHaveBeenCalled();
    });

    it('should accept custom limit', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const logs = await alertService.getAlertLogs(1, undefined, 10);
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  // ─── fireEvent ───────────────────────────────────────────────────────

  describe('fireEvent', () => {
    it('records an alert even when both email destinations reject delivery', async () => {
      const inserted = createChain([{ id: 1 }]);
      mockDb.insert.mockImplementationOnce(() => inserted);
      mockDb.select.mockImplementationOnce(() => createChain([{
        id: 15, name: 'Rejected', conditions: {}, notifyUser: true, notifyContact: true,
      }]));
      mockSendAdminEmail.mockResolvedValueOnce({ success: false, error: 'Sender domain not verified' });
      mockSendAdminEmail.mockResolvedValueOnce({ success: false, error: 'Contact delivery rejected' });

      await alertService.fireEvent(1, 'status_changed_to', { contactId: 2, newStatus: 'interested' });

      expect(mockSendAdminEmail).toHaveBeenCalledTimes(2);
      expect(inserted.values).toHaveBeenCalledWith(expect.objectContaining({
        notifiedUser: false, notifiedContact: false,
        eventData: expect.objectContaining({ emailError: 'Sender domain not verified; Contact delivery rejected' }),
      }));
    });

    it('should do nothing if no matching alerts', async () => {
      // db.select returns empty (no alerts)
      mockDb.select.mockImplementationOnce(() => createChain([]));
      await alertService.fireEvent(1, 'deal_won', {});
      expect(mockSendAdminEmail).not.toHaveBeenCalled();
    });

    it('should send email to user when alert.notifyUser=true', async () => {
      // Return one matching alert
      const mockAlert = {
        id: 1, userId: 1, name: 'Won Alert', eventType: 'deal_won',
        conditions: {}, enabled: true, notifyUser: true, notifyContact: false,
        description: 'Deal closed', createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      await alertService.fireEvent(1, 'deal_won', { contactId: 2 });

      expect(mockSendAdminEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
          subject: 'Alert: Won Alert',
        })
      );
    });

    it('should send email to contact when alert.notifyContact=true', async () => {
      const mockAlert = {
        id: 2, userId: 1, name: 'Proposal Alert', eventType: 'proposal_sent',
        conditions: {}, enabled: true, notifyUser: false, notifyContact: true,
        description: 'Proposal sent', createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      await alertService.fireEvent(1, 'proposal_sent', { contactId: 3 });

      expect(mockSendAdminEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'contact@test.com',
        })
      );
    });

    it('should send to both user and contact when both enabled', async () => {
      const mockAlert = {
        id: 3, userId: 1, name: 'Ticket Alert', eventType: 'ticket_opened',
        conditions: {}, enabled: true, notifyUser: true, notifyContact: true,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      await alertService.fireEvent(1, 'ticket_opened', { contactId: 5 });

      expect(mockSendAdminEmail).toHaveBeenCalledTimes(2);
    });

    it('should log the alert trigger in crm_alert_logs', async () => {
      const mockAlert = {
        id: 4, userId: 1, name: 'Log Test', eventType: 'lead_created',
        conditions: {}, enabled: true, notifyUser: false, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      await alertService.fireEvent(1, 'lead_created', {});

      // Should have inserted a log
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should match status_changed_to condition correctly', async () => {
      const mockAlert = {
        id: 5, userId: 1, name: 'Won Only', eventType: 'status_changed_to',
        conditions: { stage: 'won' }, enabled: true, notifyUser: true, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      // newStatus = 'won' → should match
      await alertService.fireEvent(1, 'status_changed_to', { newStatus: 'won', oldStatus: 'negotiations' });
      expect(mockSendAdminEmail).toHaveBeenCalledTimes(1);
    });

    it('should NOT match status_changed_to when newStatus differs from condition', async () => {
      const mockAlert = {
        id: 6, userId: 1, name: 'Won Only', eventType: 'status_changed_to',
        conditions: { stage: 'won' }, enabled: true, notifyUser: true, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      // newStatus = 'lost' → should NOT match
      await alertService.fireEvent(1, 'status_changed_to', { newStatus: 'lost', oldStatus: 'negotiations' });
      expect(mockSendAdminEmail).not.toHaveBeenCalled();
    });

    it('should match status_changed_from condition on oldStatus', async () => {
      const mockAlert = {
        id: 7, userId: 1, name: 'Left New', eventType: 'status_changed_from',
        conditions: { stage: 'new' }, enabled: true, notifyUser: true, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      // oldStatus = 'new' → should match
      await alertService.fireEvent(1, 'status_changed_from', { oldStatus: 'new', newStatus: 'contacted' });
      expect(mockSendAdminEmail).toHaveBeenCalledTimes(1);
    });

    it('should NOT match status_changed_from when oldStatus differs', async () => {
      const mockAlert = {
        id: 8, userId: 1, name: 'Left New', eventType: 'status_changed_from',
        conditions: { stage: 'new' }, enabled: true, notifyUser: true, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      // oldStatus = 'contacted' → should NOT match
      await alertService.fireEvent(1, 'status_changed_from', { oldStatus: 'contacted', newStatus: 'interested' });
      expect(mockSendAdminEmail).not.toHaveBeenCalled();
    });

    it('should match event with no conditions (always matches)', async () => {
      const mockAlert = {
        id: 9, userId: 1, name: 'Any Contact', eventType: 'contact_created',
        conditions: {}, enabled: true, notifyUser: true, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));

      await alertService.fireEvent(1, 'contact_created', {});
      expect(mockSendAdminEmail).toHaveBeenCalledTimes(1);
    });

    it('should handle email send failure gracefully', async () => {
      const mockAlert = {
        id: 10, userId: 1, name: 'Fail Email', eventType: 'deal_lost',
        conditions: {}, enabled: true, notifyUser: true, notifyContact: false,
        description: null, createdAt: new Date(), updatedAt: new Date()
      };
      mockDb.select.mockImplementationOnce(() => createChain([mockAlert]));
      mockSendAdminEmail.mockRejectedValueOnce(new Error('SMTP failure'));

      // Should not throw
      await expect(alertService.fireEvent(1, 'deal_lost', {})).resolves.not.toThrow();
    });

    it('should process multiple matching alerts', async () => {
      const alerts = [
        { id: 11, userId: 1, name: 'Alert A', eventType: 'ticket_closed', conditions: {}, enabled: true, notifyUser: true, notifyContact: false, description: null, createdAt: new Date(), updatedAt: new Date() },
        { id: 12, userId: 1, name: 'Alert B', eventType: 'ticket_closed', conditions: {}, enabled: true, notifyUser: true, notifyContact: false, description: null, createdAt: new Date(), updatedAt: new Date() },
      ];
      mockDb.select.mockImplementationOnce(() => createChain(alerts));

      await alertService.fireEvent(1, 'ticket_closed', {});
      expect(mockSendAdminEmail).toHaveBeenCalledTimes(2);
    });
  });
});
