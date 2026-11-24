/**
 * Phase 3.15 / TEST-001: CreditService unit tests.
 * Covers deductForEvent with cost=0 (logged as a free event), insufficient
 * balance, successful deduction, overdraft for completed usage, and the
 * reversal usage row written when a charge is refunded.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const renderSql = (condition: unknown) => new PgDialect().sqlToQuery(condition as SQL).sql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = jest.Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = () => jest.fn<any>() as AnyFn;

const mockGetCreditCost = fn();
const mockGetBalance = fn();

// Drizzle mock builders (transaction scope)
const mockReturning = fn();
const mockTransactionReturning = fn();
const mockWhere = fn().mockReturnValue({ returning: mockReturning });
const mockSet = fn().mockReturnValue({ where: mockWhere });
const mockUpdate = fn().mockReturnValue({ set: mockSet });
const mockValues = fn();
const mockInsert = fn().mockReturnValue({ values: mockValues });
const mockTxSelect = fn();

// Top-level (outside a transaction) builders
const mockTopValues = fn();
const mockTopInsert = fn().mockReturnValue({ values: mockTopValues });
const mockTopSelect = fn();

function defaultValues() {
  mockValues.mockImplementation((values: { type?: string }) => (
    values.type === 'deduction' || values.type === 'refund'
      ? { returning: mockTransactionReturning }
      : Promise.resolve([])
  ));
  mockTopValues.mockImplementation(() => Object.assign(Promise.resolve([]), {
    onConflictDoNothing: fn().mockResolvedValue([]),
  }));
}

jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    insert: mockTopInsert,
    select: mockTopSelect,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: jest.fn<any>().mockImplementation(async (callback: any) => callback({
      update: mockUpdate,
      insert: mockInsert,
      select: mockTxSelect,
    })),
  },
}));

jest.unstable_mockModule('../models/wallets/functions.js', () => ({
  getBalance: mockGetBalance,
  deductCredits: fn(),
  getOrCreateWallet: fn().mockResolvedValue({ id: 3, organizationId: 9, userId: 42 }),
  addCredits: jest.fn(),
}));

jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({
  getCreditCost: mockGetCreditCost,
  getRechargeRate: fn().mockResolvedValue(10),
  getUsageRate: fn().mockResolvedValue(10),
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../services/dashboardCache.js', () => ({
  invalidateDashboardCache: fn().mockResolvedValue(undefined),
}));

const { creditService } = await import('../services/CreditService.js');

const baseOptions = {
  userId: 42,
  eventKey: 'test_event',
  description: 'Test deduction',
  service: 'TestService',
  referenceType: 'test',
  referenceId: 'ref-1',
};

describe('CreditService.deductForEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReturning.mockReset();
    mockTransactionReturning.mockReset();
    mockValues.mockReset();
    mockTopValues.mockReset();
    defaultValues();
  });

  it('logs a free event and does not touch the wallet when the cost is 0', async () => {
    mockGetCreditCost.mockResolvedValue(0);
    mockGetBalance.mockResolvedValue(100);

    const result = await creditService.deductForEvent(baseOptions);

    expect(result.success).toBe(true);
    expect(result.creditsDeducted).toBe(0);
    expect(result.balanceAfter).toBe(100);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockTopValues).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: 'test_event', creditsUsed: '0.00', balanceAfter: '100.00', organizationId: 9,
      metadata: expect.objectContaining({ free: true }),
    }));
  });

  it('still succeeds when logging a free event fails', async () => {
    mockGetCreditCost.mockResolvedValue(0);
    mockGetBalance.mockResolvedValue(100);
    mockTopValues.mockImplementation(() => Promise.reject(new Error('log table unavailable')));

    const result = await creditService.deductForEvent(baseOptions);

    expect(result).toEqual({ success: true, creditsDeducted: 0, balanceAfter: 100 });
  });

  it('returns failure with insufficient balance error when wallet is null', async () => {
    mockGetCreditCost.mockResolvedValue(50);
    mockReturning.mockResolvedValue([]); // Empty returning = no wallet found/updated
    mockGetBalance.mockResolvedValue(10);

    const result = await creditService.deductForEvent(baseOptions);

    expect(result.success).toBe(false);
    expect(result.creditsDeducted).toBe(0);
    expect(result.balanceAfter).toBe(10);
    expect(result.error).toMatch(/Insufficient credits/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('records a linked transaction and event log on successful deduction', async () => {
    mockGetCreditCost.mockResolvedValue(5);
    mockReturning.mockResolvedValue([{ balance: '95' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 1 }]);

    const result = await creditService.deductForEvent({ ...baseOptions, overrideAmount: 5 });

    expect(result.success).toBe(true);
    expect(result.creditsDeducted).toBe(5);
    expect(result.balanceAfter).toBe(95);
    expect(result.transactionId).toBe(1);
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      type: 'deduction',
      amount: '-5.00',
      balanceAfter: '95.00',
      description: 'Test deduction',
      referenceType: 'test',
      referenceId: 'ref-1',
      metadata: expect.objectContaining({
        purchaseCreditsPerInr: 10,
        _event: { key: 'test_event', service: 'TestService', apiProvider: undefined },
      }),
    }));
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      eventKey: 'test_event',
      creditsUsed: '5.00',
      balanceAfter: '95.00',
      walletTransactionId: 1,
    }));
  });

  it('requires the balance to cover the cost, or with overdraft only a positive balance', async () => {
    mockReturning.mockResolvedValue([{ balance: '95' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 1 }]);

    await creditService.deductForEvent({ ...baseOptions, overrideAmount: 5 });
    const guarded = renderSql(mockWhere.mock.calls[0][0]);

    mockWhere.mockClear();
    await creditService.deductForEvent({ ...baseOptions, overrideAmount: 5, allowOverdraft: true });
    const open = renderSql(mockWhere.mock.calls[0][0]);

    expect(guarded).toContain('>=');
    expect(open).not.toContain('>=');
    expect(open).toMatch(/"balance" > 0/);
  });

  it('bills completed usage into a negative balance and marks it as overdraft', async () => {
    mockReturning.mockResolvedValue([{ balance: '-38' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 2 }]);

    const result = await creditService.deductForEvent({ ...baseOptions, overrideAmount: 40, allowOverdraft: true });

    expect(result).toEqual(expect.objectContaining({ success: true, creditsDeducted: 40, balanceAfter: -38 }));
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      type: 'deduction', amount: '-40.00', balanceAfter: '-38.00', metadata: expect.objectContaining({ overdraft: true }),
    }));
  });

  it('uses overrideAmount over the configured event cost', async () => {
    mockGetCreditCost.mockResolvedValue(10);
    mockReturning.mockResolvedValue([{ balance: '90' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 1 }]);

    const result = await creditService.deductForEvent({ ...baseOptions, overrideAmount: 10 });

    expect(result.creditsDeducted).toBe(10);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('returns success=false (does not throw) when getCreditCost throws', async () => {
    mockGetCreditCost.mockRejectedValue(new Error('DB down'));

    const result = await creditService.deductForEvent(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Credit deduction error');
  });
});

describe('CreditService.refundDeduction', () => {
  const original = {
    id: 7, userId: 42, organizationId: 9, type: 'deduction', amount: '-5.00', balanceAfter: '95.00',
    category: 'outreach', referenceType: 'outreach_message', referenceId: 'msg-1', billingBusinessProfileId: 11,
    metadata: { purchaseCreditsPerInr: 12, _event: { key: 'outreach_email', service: 'OutreachService' } },
  };

  function selectReturning(...results: unknown[][]) {
    for (const rows of results) {
      const limit = fn().mockResolvedValue(rows);
      const forUpdate = fn().mockResolvedValue(rows);
      mockTxSelect.mockReturnValueOnce({ from: () => ({ where: () => ({ for: forUpdate, limit }) }) });
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockReturning.mockReset();
    mockTransactionReturning.mockReset();
    mockValues.mockReset();
    mockTopValues.mockReset();
    mockTxSelect.mockReset();
    defaultValues();
  });

  it('refunds the wallet and writes a negative usage row that mirrors the charge', async () => {
    selectReturning([original], []);
    mockReturning.mockResolvedValue([{ balance: '100' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 50 }]);

    const result = await creditService.refundDeduction({ userId: 42, transactionId: 7, description: 'Send failed' });

    expect(result).toEqual({ success: true, creditsRefunded: 5, balanceAfter: 100 });
    expect(mockTopValues).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 9, userId: 42, eventKey: 'outreach_email', service: 'OutreachService',
      creditsUsed: '-5.00', balanceAfter: '100.00', referenceType: 'outreach_message', referenceId: 'msg-1',
      walletTransactionId: 50,
      metadata: expect.objectContaining({ reversal: true, originalTransactionId: 7, refundTransactionId: 50, purchaseCreditsPerInr: 12 }),
    }));
  });

  it('does not write a reversal row for a settlement that refunds nothing', async () => {
    selectReturning([original], []);
    mockReturning.mockResolvedValue([{ balance: '95' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 51 }]);

    const result = await creditService.settleReservation({ userId: 42, transactionId: 7, actualCredits: 5, description: 'Used in full' });

    expect(result.creditsRefunded).toBe(0);
    expect(mockTopValues).not.toHaveBeenCalled();
  });

  it('keeps the refund when the reversal row cannot be written', async () => {
    selectReturning([original], []);
    mockReturning.mockResolvedValue([{ balance: '100' }]);
    mockTransactionReturning.mockResolvedValue([{ id: 52 }]);
    mockTopValues.mockImplementation(() => ({ onConflictDoNothing: fn().mockRejectedValue(new Error('denied')) }));

    const result = await creditService.refundDeduction({ userId: 42, transactionId: 7, description: 'Send failed' });

    expect(result.success).toBe(true);
    expect(result.creditsRefunded).toBe(5);
  });
});
