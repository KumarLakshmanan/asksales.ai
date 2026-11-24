import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PaymentEvidenceExecutor } from '../services/insights/SalesEvidence.js';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
const transaction = jest.fn<(work: (tx: PaymentEvidenceExecutor) => Promise<void>) => Promise<void>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({
  requireBusinessScope: () => ({ userId: 7, actorUserId: 7, businessProfileId: 11 }),
}));
const { recordPaymentEvidence } = await import('../services/insights/SalesEvidence.js');
const booking = { id: 4, user_id: 7, business_profile_id: 11, currency: 'INR', payment_id: 'pay_valid', status: 'confirmed' };
const evidence = { bookingId: 4, paymentId: 'manual:receipt-ht05b', amountMinor: 20000, currency: 'INR',
  occurredAt: '2026-10-23T12:00:00.000Z', source: 'manual' as const };
const receipt = { booking_id: 4, kind: 'payment_captured', payment_id: evidence.paymentId, currency: 'INR',
  evidence: 'manual', verified: true, amount_matches: true };

describe('payment evidence caller executor contract', () => {
  beforeEach(() => { execute.mockReset(); transaction.mockReset(); });

  it('uses only the supplied executor for booking validation and ledger writes', async () => {
    const local = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>()
      .mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ booking_id: 4 }] });
    await recordPaymentEvidence(evidence, { execute: local });
    expect(local).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('propagates a ledger failure to the caller without opening an independent transaction', async () => {
    const failure = new Error('synthetic ledger failure');
    const local = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>()
      .mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(failure);
    await expect(recordPaymentEvidence(evidence, { execute: local })).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects another booking winning the source identity after an empty replay lookup', async () => {
    const local = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>()
      .mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ booking_id: 5 }] });
    await expect(recordPaymentEvidence(evidence, { execute: local })).rejects.toThrow('Payment identity belongs to a different booking.');
    expect(local).toHaveBeenCalledTimes(4);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('permits a same-booking replay winner and rejects an unavailable collision identity', async () => {
    const local = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>()
      .mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [receipt] });
    await recordPaymentEvidence(evidence, { execute: local });
    local.mockReset().mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(recordPaymentEvidence(evidence, { execute: local })).rejects.toThrow('Payment identity belongs to a different booking.');
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['kind', 'payment_refunded'], ['payment_id', 'different-payment'], ['currency', 'USD'],
    ['evidence', 'razorpay'], ['verified', false], ['amount_matches', false],
  ])('rejects a different immutable %s in both replay and insert-winner reads', async (field, value) => {
    for (const atWinner of [false, true]) {
      const local = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>()
        .mockResolvedValueOnce({ rows: [booking] });
      if (atWinner) local.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      local.mockResolvedValueOnce({ rows: [{ ...receipt, [String(field)]: value }] });
      await expect(recordPaymentEvidence(evidence, { execute: local }))
        .rejects.toThrow('Payment identity was replayed with different evidence.');
      expect(local).toHaveBeenCalledTimes(atWinner ? 4 : 2);
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
