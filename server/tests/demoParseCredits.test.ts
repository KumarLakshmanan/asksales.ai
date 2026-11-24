import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
const deduct = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const refund = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { deductForEvent: deduct, refundDeduction: refund } }));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({ getCreditCost: async () => 0 }));
const { withDemoParseCredits } = await import('../services/agents/demoParseCredits.js');
beforeEach(() => { jest.clearAllMocks(); refund.mockResolvedValue({ success: true }); });
const scope = { userId: 1, actorUserId: 1, businessProfileId: 11 };
describe('demo parser billing and concurrency', () => {
  it('never starts provider work when the atomic precharge fails', async () => {
    deduct.mockResolvedValue({ success: false });
    const provider = jest.fn<() => Promise<unknown>>();
    await expect(withBusinessScope(scope, () => withDemoParseCredits(1, provider))).rejects.toThrow('reserve credits');
    expect(provider).not.toHaveBeenCalled();
    expect(deduct).toHaveBeenCalledWith(expect.objectContaining({ overrideAmount: 10 }));
  });
  it('refunds the original transaction if parsing fails', async () => {
    deduct.mockResolvedValue({ success: true, transactionId: 7 });
    await expect(withBusinessScope(scope, () => withDemoParseCredits(1, async () => { throw new Error('parser rejected input'); }))).rejects.toThrow('parser rejected');
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 7, userId: 1 }));
  });
  it('admits one paid parsing operation per business and releases its lease', async () => {
    deduct.mockResolvedValue({ success: true, transactionId: 8 });
    let started!: () => void, complete!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { complete = resolve; });
    const first = withBusinessScope(scope, () => withDemoParseCredits(1, async () => { started(); await blocked; return 'complete'; }));
    await began;
    await expect(withBusinessScope(scope, () => withDemoParseCredits(1, async () => 'duplicate'))).rejects.toThrow('already in progress');
    complete();
    await expect(first).resolves.toBe('complete');
    await expect(withBusinessScope(scope, () => withDemoParseCredits(1, async () => 'next'))).resolves.toBe('next');
  });
});
