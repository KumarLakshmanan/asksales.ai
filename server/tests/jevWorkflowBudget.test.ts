import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const classify = jest.fn<(...args: any[]) => Promise<any>>();
const insert = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { insert } }));
jest.unstable_mockModule('../services/lead-generation/JevLeadSemanticService.js', () => ({
  classifyJevLeadSemanticsBatch: classify, JEV_LEAD_BATCH_SIZE: 4, JEV_LEAD_MAX_BATCHES: 2,
}));
const { WorkflowExecutorService } = await import('../services/WorkflowExecutorService.js');
const executor = WorkflowExecutorService as any;
const context = () => ({ userId: 9, executionId: 'synthetic-budget-test', logs: [], platform: 'google_maps',
  reviewedLeadConstraints: { regions: ['Bengaluru'], industry: 'Technology', subIndustry: 'Observability' },
  semanticLeadClassificationBudget: { remainingBatches: 2, remainingLeads: 8 },
  existingReviewedLeads: [], persistedLeadCount: 0, countedLeadIds: new Set(), providerMetrics: new Map(),
});
const records = () => Array.from({ length: 12 }, (_, index) => ({
  companyName: `Example ${index}`, address: 'Bengaluru', industry: 'Infrastructure monitoring',
}));
beforeEach(() => { jest.resetAllMocks(); classify.mockResolvedValue(new Map()); });
describe('actual workflow semantic classification budget', () => {
  it('bounds calls across repeated incremental saves within the same execution', async () => {
    const ctx = context();
    const first = await executor.persistReviewedLeadRecords(records(), ctx);
    const second = await executor.persistReviewedLeadRecords(records(), ctx);
    expect(first.rejectedCount).toBe(12);
    expect(second.rejectedCount).toBe(12);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls.map(call => call[1].length)).toEqual([4, 4]);
    expect(ctx.semanticLeadClassificationBudget).toEqual({ remainingBatches: 0, remainingLeads: 0 });
    expect(insert).not.toHaveBeenCalled();
  });
  it('does not spend classifier budget on hard geography failures', async () => {
    const ctx = context();
    const result = await executor.persistReviewedLeadRecords(records().map(record => ({ ...record, address: 'Mumbai' })), ctx);
    expect(result.rejectedCount).toBe(12);
    expect(classify).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it('does not classify beyond the remaining reviewed lead limit', async () => {
    const ctx = { ...context(), requestedLeadLimit: 3 };
    await executor.persistReviewedLeadRecords(records(), ctx);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][1]).toHaveLength(3);
    expect(ctx.semanticLeadClassificationBudget.remainingLeads).toBe(5);
  });
});
