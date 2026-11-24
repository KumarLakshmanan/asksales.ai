/**
 * ReminderService Tests
 * Tests: REMINDER_TYPES, CRUD for activity/proposal reminders,
 *        getActivityRemindersWithContacts, getDueReminders,
 *        processAndSendDueReminders (cron), markReminderSent
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- Mock ALL dependencies ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecute = jest.fn<any>().mockResolvedValue({ rows: [] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createChain = (resolveValue: any = []): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  ['from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'innerJoin',
   'rightJoin', 'fullJoin', 'groupBy', 'having', 'values', 'set', 'returning',
   'onConflictDoUpdate', 'onConflictDoNothing', 'as', 'for'].forEach(m => {
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
  update: jest.fn<any>().mockImplementation(() => createChain([{ id: 1 }])),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: jest.fn<any>().mockImplementation(() => createChain([])),
  execute: mockExecute,
  transaction: jest.fn<(callback: (executor: unknown) => Promise<unknown>) => Promise<unknown>>(),
};
mockDb.transaction.mockImplementation(callback => callback(mockDb));

jest.unstable_mockModule('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lte: jest.fn<any>().mockReturnValue('lte'),
  inArray: jest.fn<(...args: unknown[]) => string>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  sql: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    jest.fn<any>().mockImplementation((...args: any[]) => 'sql-fragment'),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      raw: jest.fn<any>().mockReturnValue('sql-raw'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      join: jest.fn<any>().mockReturnValue('sql-join'),
    }
  ),
}));

jest.unstable_mockModule('../models/db', () => ({
  db: mockDb,
  storage: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
}));

jest.unstable_mockModule('../models/proposalReminders/schema', () => ({
  proposalRemindersTable: {
    id: 'id', proposalId: 'proposalId', userId: 'userId',
    reminderDueAt: 'reminderDueAt', reminderType: 'reminderType',
    status: 'status', sentAt: 'sentAt', snoozedUntil: 'snoozedUntil',
    metadata: 'metadata', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

jest.unstable_mockModule('../models/crmActivityReminders/schema', () => ({
  crmActivityRemindersTable: {
    id: 'id', userId: 'userId', activityId: 'activityId', contactId: 'contactId',
    reminderDueAt: 'reminderDueAt', reminderType: 'reminderType',
    title: 'title', description: 'description',
    status: 'status', sentAt: 'sentAt', snoozedUntil: 'snoozedUntil',
    metadata: 'metadata', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
jest.unstable_mockModule('../services/ReminderNotificationDeliveryService.js', () => ({
  ReminderNotificationUncertainError: class extends Error {},
  // This suite tests reminder orchestration; actual durable receipts are exercised against PostgreSQL separately.
  deliverReminderNotification: async (_reminder: unknown, _destination: string, send: () => Promise<{ success: boolean; error?: string }>) => {
    const result = await send(); if (!result.success) throw new Error(result.error || 'Delivery failed'); return { skipped: false };
  },
}));
const mockSendAdminEmail = jest.fn<any>().mockResolvedValue({ success: true });
jest.unstable_mockModule('../services/adminEmailService', () => ({
  sendAdminEmail: mockSendAdminEmail,
}));

// Import after mocks
const { reminderService, REMINDER_TYPES } = await import('../services/ReminderService');

describe('ReminderService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockReset().mockResolvedValue({ rows: [] });
    mockDb.select.mockReset().mockImplementation(() => createChain([]));
    mockDb.insert.mockReset().mockImplementation(() => createChain([{ id: 1 }]));
    mockDb.update.mockReset().mockImplementation(() => createChain([{ id: 1 }]));
    mockDb.delete.mockReset().mockImplementation(() => createChain([]));
    mockSendAdminEmail.mockReset().mockResolvedValue({ success: true });
  });

  // ─── REMINDER_TYPES constant ─────────────────────────────────────────

  describe('REMINDER_TYPES', () => {
    it('should contain 9 types (status_change removed)', () => {
      expect(REMINDER_TYPES).toHaveLength(9);
    });

    it('should NOT contain status_change (handled by alerts now)', () => {
      expect(REMINDER_TYPES).not.toContain('status_change');
    });

    it('should contain core reminder types', () => {
      expect(REMINDER_TYPES).toContain('followup');
      expect(REMINDER_TYPES).toContain('meeting');
      expect(REMINDER_TYPES).toContain('call');
      expect(REMINDER_TYPES).toContain('task');
      expect(REMINDER_TYPES).toContain('custom');
    });

    it('should contain pipeline-related types', () => {
      expect(REMINDER_TYPES).toContain('ticket_open');
      expect(REMINDER_TYPES).toContain('ticket_close');
      expect(REMINDER_TYPES).toContain('proposal_sent');
      expect(REMINDER_TYPES).toContain('proposal_expiry');
    });
  });

  // ─── Proposal Reminder CRUD ──────────────────────────────────────────

  describe('createProposalReminder', () => {
    it('should insert a proposal reminder', async () => {
      mockDb.insert.mockImplementationOnce(() => createChain([{ id: 1, proposalId: 10, reminderType: 'expiry' }]));
      const result = await reminderService.createProposalReminder(1, 10, {
        reminderDueAt: new Date('2025-02-01'),
      });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should default reminderType to expiry', async () => {
      mockDb.insert.mockImplementationOnce(() => createChain([{ id: 2, reminderType: 'expiry' }]));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await reminderService.createProposalReminder(1, 10, {
        reminderDueAt: new Date(),
      });
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('getProposalReminders', () => {
    it('should get reminders for userId', async () => {
      const result = await reminderService.getProposalReminders(1);
      expect(mockDb.select).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter by proposalId when provided', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await reminderService.getProposalReminders(1, 10);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('updateProposalReminder', () => {
    it('should update status to snoozed', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([{ id: 1, status: 'snoozed' }]));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await reminderService.updateProposalReminder(1, 1, { status: 'snoozed' });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should return null if not found', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([]));
      const result = await reminderService.updateProposalReminder(1, 999, { status: 'pending' });
      expect(result).toBeNull();
    });
  });

  describe('deleteProposalReminder', () => {
    it('should delete the reminder', async () => {
      await reminderService.deleteProposalReminder(1, 1);
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  // ─── Activity Reminder CRUD ──────────────────────────────────────────

  describe('createActivityReminder', () => {
    it('rejects an unavailable contact before inserting or synchronizing a reminder', async () => {
      await expect(reminderService.createActivityReminder(1, { contactId: 5, reminderDueAt: new Date() })).rejects.toThrow('Contact not found.');
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
    it('should create an activity reminder with all fields', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [{ id: 5 }] }); // Owned contact lock.
      mockDb.insert.mockImplementationOnce(() => createChain([{ id: 1, title: 'Follow up with client' }]));
      const result = await reminderService.createActivityReminder(1, {
        contactId: 5,
        reminderDueAt: new Date('2025-03-01'),
        reminderType: 'followup',
        title: 'Follow up with client',
        description: 'Discuss pricing',
      });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockExecute).toHaveBeenCalledTimes(2); // Contact lock and follow-up synchronization.
    });

    it('should default reminderType to followup', async () => {
      mockDb.insert.mockImplementationOnce(() => createChain([{ id: 2 }]));
      await reminderService.createActivityReminder(1, {
        reminderDueAt: new Date(),
      });
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('getActivityReminders', () => {
    it('should fetch reminders for userId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await reminderService.getActivityReminders(1);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should apply contactId filter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await reminderService.getActivityReminders(1, { contactId: 3 });
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should apply status filter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await reminderService.getActivityReminders(1, { status: 'pending' });
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('updateActivityReminder', () => {
    it('blocks edits to a reminder with an active delivery claim', async () => {
      const current = { id: 1, status: 'pending', sentAt: null, lastSentAt: new Date(), metadata: {} };
      mockDb.select
        .mockImplementationOnce(() => createChain([current]))
        .mockImplementationOnce(() => createChain([current]));
      await expect(reminderService.updateActivityReminder(1, 1, { title: 'Changed' })).rejects.toThrow('currently being delivered');
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.select.mock.results[1].value.for).toHaveBeenCalledWith('update');
    });
    it('should update reminder title', async () => {
      mockDb.select
        .mockImplementationOnce(() => createChain([{ id: 1, metadata: {} }]))
        .mockImplementationOnce(() => createChain([{ id: 1, metadata: {} }]));
      mockDb.update.mockImplementationOnce(() => createChain([{ id: 1, title: 'Updated Title' }]));
      const result = await reminderService.updateActivityReminder(1, 1, { title: 'Updated Title' });
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ id: 1, title: 'Updated Title' });
      expect(mockDb.select.mock.results[1].value.for).toHaveBeenCalledWith('update');
    });

    it('reschedules a sent reminder and clears delivery claims while preserving metadata', async () => {
      const dueAt = new Date('2030-01-02T04:30:00Z');
      const current = { id: 1, metadata: { notifyContact: true }, reminderDueAt: new Date('2020-01-01T00:00:00Z') };
      mockDb.select
        .mockImplementationOnce(() => createChain([current]))
        .mockImplementationOnce(() => createChain([current]));
      const mutation = createChain([{ id: 1, status: 'pending' }]);
      mockDb.update.mockImplementationOnce(() => mutation);
      await reminderService.updateActivityReminder(1, 1, { reminderDueAt: dueAt, metadata: { priority: 'high' } });
      expect(mutation.set).toHaveBeenCalledWith(expect.objectContaining({
        reminderDueAt: dueAt, status: 'pending', sentAt: null, lastSentAt: null, snoozedUntil: null,
        metadata: expect.objectContaining({ notifyContact: true, priority: 'high', notificationGeneration: expect.any(String), retry_count: 0 }),
      }));
    });

    it.each(['pending','snoozed'])('retains notification identity for an identical %s retry', async status => {
      const due = new Date('2030-01-02T04:30:00Z');
      const current = { id: 1, userId: 1, status, reminderDueAt: due, snoozedUntil: status === 'snoozed' ? due : null,
        metadata: { notificationGeneration: 'existing-intent', notificationDeliveries: { 'existing-intent': { internal: { state: 'sent' } } } } };
      mockDb.select.mockImplementationOnce(() => createChain([current])).mockImplementationOnce(() => createChain([current]));
      const mutation = createChain([{id:1,status}]);mockDb.update.mockImplementationOnce(() => mutation);
      await reminderService.updateActivityReminder(1,1,status === 'snoozed' ? {snoozedUntil:due} : {status:'pending'});
      expect(mutation.set).toHaveBeenCalledWith(expect.objectContaining({metadata:expect.objectContaining({notificationGeneration:'existing-intent',notificationDeliveries:current.metadata.notificationDeliveries})}));
    });

    it('should return null when no match', async () => {
      mockDb.update.mockImplementationOnce(() => createChain([]));
      const result = await reminderService.updateActivityReminder(1, 999, { title: 'None' });
      expect(result).toBeNull();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteActivityReminder', () => {
    it('should delete the reminder', async () => {
      mockDb.select
        .mockImplementationOnce(() => createChain([{ id: 5 }]))
        .mockImplementationOnce(() => createChain([{ id: 5 }]));
      mockDb.delete.mockImplementationOnce(() => createChain([{ id: 5 }]));
      const result = await reminderService.deleteActivityReminder(1, 5);
      expect(mockDb.delete).toHaveBeenCalled();
      expect(result).toBe(true);
      expect(mockDb.select.mock.results[1].value.for).toHaveBeenCalledWith('update');
    });
  });

  // ─── getActivityRemindersWithContacts ────────────────────────────────

  describe('getActivityRemindersWithContacts', () => {
    it('should return reminders with contact names via JOIN', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          { id: 1, contactId: 5, contactName: 'John Doe', contactEmail: 'john@test.com', title: 'Follow up', description: null, dueDate: '2025-03-01', reminderType: 'followup', status: 'pending', sentAt: null, snoozedUntil: null, metadata: {}, createdAt: '2025-01-01', priority: 'medium' }
        ]
      });
      const results = await reminderService.getActivityRemindersWithContacts(1);
      expect(mockExecute).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].contactName).toBe('John Doe');
    });

    it('should return empty array when none exist', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      const results = await reminderService.getActivityRemindersWithContacts(1);
      expect(results).toEqual([]);
    });

    it('should apply filters', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      await reminderService.getActivityRemindersWithContacts(1, { contactId: 3, status: 'sent' });
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  // ─── getDueReminders ────────────────────────────────────────────────

  describe('getDueReminders', () => {
    it('should return both proposal and activity reminders', async () => {
      // Two select() calls happen in parallel — mock both
      mockDb.select
        .mockImplementationOnce(() => createChain([{ id: 1, status: 'pending' }]))
        .mockImplementationOnce(() => createChain([{ id: 2, status: 'pending' }]));

      const result = await reminderService.getDueReminders();
      expect(result).toHaveProperty('proposalReminders');
      expect(result).toHaveProperty('activityReminders');
    });

    it('should return empty arrays when no due reminders', async () => {
      mockDb.select
        .mockImplementationOnce(() => createChain([]))
        .mockImplementationOnce(() => createChain([]));

      const result = await reminderService.getDueReminders();
      expect(result.proposalReminders).toEqual([]);
      expect(result.activityReminders).toEqual([]);
    });
  });

  // ─── markReminderSent ────────────────────────────────────────────────

  describe('markReminderSent', () => {
    it('should mark activity reminder as sent', async () => {
      mockDb.select.mockImplementationOnce(() => createChain([{ id: 1, userId: 1 }]));
      await reminderService.markReminderSent('activity', 1);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should mark proposal reminder as sent', async () => {
      await reminderService.markReminderSent('proposal', 1);
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  // ─── processAndSendDueReminders (THE CRON HANDLER) ──────────────────

  describe('processAndSendDueReminders', () => {
    it('should return { processed: 0, errors: 0 } when no due reminders', async () => {
      mockDb.select
        .mockImplementationOnce(() => createChain([]))
        .mockImplementationOnce(() => createChain([]));

      const result = await reminderService.processAndSendDueReminders();
      expect(result).toEqual({ processed: 0, errors: 0 });
      expect(mockSendAdminEmail).not.toHaveBeenCalled();
    });

    it('should send email to user for due activity reminder', async () => {
      const dueReminder = {
        id: 1, userId: 1, contactId: 42,
        title: 'Call John',
        description: 'Discuss pricing', reminderDueAt: new Date('2025-01-01'),
        reminderType: 'followup', status: 'pending',
        metadata: { notifyContact: true },
      };
      // getDueReminders returns: proposal=[], activity=[dueReminder]
      mockDb.select
        .mockImplementationOnce(() => createChain([]))       // proposal
        .mockImplementationOnce(() => createChain([dueReminder])) // activity
        .mockImplementationOnce(() => createChain([dueReminder])); // Delivery-state reload.
      // tryClaimReminder (atomic claim via db.execute UPDATE...RETURNING)
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] });
      // Contact lookup
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'john@test.com', name: 'John' }] });
      // User lookup
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'admin@test.com', name: 'Admin' }] });
      // getBrandInfo uses default mockExecute ({ rows: [] })

      const result = await reminderService.processAndSendDueReminders();
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
      // Should send to both user AND contact
      expect(mockSendAdminEmail).toHaveBeenCalledTimes(2);
      expect(mockDb.update.mock.results.at(-1)?.value.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', sentAt: expect.any(Date) }));
    });

    it('should send email to user for due proposal reminder', async () => {
      const proposalReminder = {
        id: 2, userId: 1, reminderDueAt: new Date('2025-01-01'),
        reminderType: 'expiry', status: 'pending',
      };
      mockDb.select
        .mockImplementationOnce(() => createChain([proposalReminder])) // proposal
        .mockImplementationOnce(() => createChain([]));                // activity
      // tryClaimReminder for proposal reminder
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 2 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'admin@test.com' }] });

      const result = await reminderService.processAndSendDueReminders();
      expect(result.processed).toBe(1);
      expect(mockSendAdminEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@test.com',
          subject: 'Proposal Reminder Due',
        })
      );
    });

    it('should pause a customer follow-up when the proposal conversation already has a reply', async () => {
      const proposalReminder = {
        id: 20, userId: 1, reminderDueAt: new Date('2025-01-01'),
        reminderType: 'customer_followup', status: 'pending', metadata: {},
      };
      mockDb.select
        .mockImplementationOnce(() => createChain([proposalReminder]))
        .mockImplementationOnce(() => createChain([]));
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 20 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{
        email: 'admin@test.com', title: 'Customer plan', recipient_email: 'customer@test.com',
        proposal_status: 'sent', customer_replied: true,
      }] });

      const result = await reminderService.processAndSendDueReminders();

      expect(result).toEqual({ processed: 0, errors: 0 });
      expect(mockSendAdminEmail).not.toHaveBeenCalled();
      const updateChain = mockDb.update.mock.results.at(-1)?.value;
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'paused',
        lastSentAt: null,
        metadata: expect.objectContaining({ pauseReason: 'customer_reply' }),
      }));
    });

    it('should count errors when email sending fails', async () => {
      const dueReminder = {
        id: 3, userId: 1, contactId: null, title: 'Call back',
        description: '', reminderDueAt: new Date(), reminderType: 'call',
        status: 'pending',
      };
      mockDb.select
        .mockImplementationOnce(() => createChain([]))
        .mockImplementationOnce(() => createChain([dueReminder]));
      // tryClaimReminder
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'u@test.com', name: 'U' }] });
      mockSendAdminEmail.mockRejectedValueOnce(new Error('SMTP down'));

      const result = await reminderService.processAndSendDueReminders();
      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
    });

    it('should mark reminder as sent after successful processing', async () => {
      const dueReminder = {
        id: 4, userId: 1, contactId: null, title: 'Task',
        description: '', reminderDueAt: new Date(), reminderType: 'task',
        status: 'pending',
      };
      mockDb.select
        .mockImplementationOnce(() => createChain([]))
        .mockImplementationOnce(() => createChain([dueReminder]))
        .mockImplementationOnce(() => createChain([dueReminder])); // Transactional delivery-state reload.
      // tryClaimReminder
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 4 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'u@test.com', name: 'U' }] });

      await reminderService.processAndSendDueReminders();
      // markReminderSent calls db.update
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should process multiple reminders', async () => {
      const reminders = [
        { id: 5, userId: 1, contactId: null, title: 'R1', description: '', reminderDueAt: new Date(), reminderType: 'task', status: 'pending' },
        { id: 6, userId: 1, contactId: null, title: 'R2', description: '', reminderDueAt: new Date(), reminderType: 'call', status: 'pending' },
      ];
      mockDb.select
        .mockImplementationOnce(() => createChain([]))
        .mockImplementationOnce(() => createChain(reminders));
      // tryClaimReminder + user lookup for reminder 5
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'u@test.com', name: 'U' }] });
      // tryClaimReminder + user lookup for reminder 6
      mockExecute.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 6 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ email: 'u@test.com', name: 'U' }] });

      const result = await reminderService.processAndSendDueReminders();
      expect(result.processed).toBe(2);
    });
  });
});
