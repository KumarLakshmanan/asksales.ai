import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type DeductionResult = { success: boolean; creditsDeducted: number; balanceAfter: number };
const mockDeductOnceForResource = jest.fn<(options: Record<string, unknown>) => Promise<DeductionResult>>();
const mockDeductForEvent = jest.fn<(options: Record<string, unknown>) => Promise<DeductionResult>>();

jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: {
    deductOnceForResource: mockDeductOnceForResource,
    deductForEvent: mockDeductForEvent,
  },
}));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({
  getRechargeRate: jest.fn(async () => 10),
  getUsageRate: jest.fn(async () => 10),
}));
jest.unstable_mockModule('../utils/currency.js', () => ({
  getUsdToInrRate: jest.fn(() => 100),
  roundCurrency: jest.fn((value: number) => value),
  usdCentsToInr: jest.fn((value: number) => value),
  meteredCreditsFromInr: jest.fn((inr: number, rate: number) => (inr > 0 ? Math.max(1, Math.ceil(inr * rate)) : 0)),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('Apify billing idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeductOnceForResource.mockResolvedValue({ success: true, creditsDeducted: 20, balanceAfter: 100 });
    mockDeductForEvent.mockResolvedValue({ success: true, creditsDeducted: 20, balanceAfter: 100 });
  });

  it('charges one durable resource keyed by provider run ID', async () => {
    const { deductCreditsForApifyUsage } = await import('../services/CreditDeductionHooks.js');
    await deductCreditsForApifyUsage(1, {
      actorName: 'apify/instagram-hashtag-scraper',
      runId: 'zulRSS2cv5Tv5xH52',
      estimatedCostCents: 2,
      threadId: 178,
    });

    expect(mockDeductOnceForResource).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1,
      referenceType: 'apify_run',
      referenceId: 'zulRSS2cv5Tv5xH52',
      metadata: expect.objectContaining({ runId: 'zulRSS2cv5Tv5xH52', threadId: 178 }),
    }));
    expect(mockDeductForEvent).not.toHaveBeenCalled();
  });

  it('uses ordinary event billing only when no provider run ID exists', async () => {
    const { deductCreditsForApifyUsage } = await import('../services/CreditDeductionHooks.js');
    await deductCreditsForApifyUsage(1, { estimatedCostCents: 2, threadId: 178 });

    expect(mockDeductForEvent).toHaveBeenCalledWith(expect.objectContaining({
      referenceType: 'chat_thread',
      referenceId: '178',
    }));
    expect(mockDeductOnceForResource).not.toHaveBeenCalled();
  });
});
