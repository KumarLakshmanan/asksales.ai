import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const loadPlanningIcp = jest.fn<(id: unknown, owner?: number) => Promise<unknown>>();
const generateBudgetPlan = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const saveBudgetPlan = jest.fn<(plan: unknown) => Promise<number>>();
const emit = jest.fn();
jest.unstable_mockModule('../services/agents/PerformanceMarketingAgent.js', () => ({
  loadPlanningIcp,
  PerformanceMarketingAgent: class { generateBudgetPlan = generateBudgetPlan; saveBudgetPlan = saveBudgetPlan; },
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emit } }));
const { executeCreateBudgetPlan } = await import('../mastra/tools/budgetPlanTool.js');

const context = { userId: 7, threadId: 240, icpProfile: { id: 191 } } as never;

describe('Sarah saves a budget plan from chat', () => {
  beforeEach(() => jest.clearAllMocks());

  it('saves the plan for this campaign and opens the Performance Marketing tab', async () => {
    loadPlanningIcp.mockResolvedValue({ id: 191, userId: 7 });
    generateBudgetPlan.mockResolvedValue({
      icp_id: 191, total_budget: 50000, duration_days: 30, currency: 'INR', daily_budget: 1667,
      channel_allocation: [{ channel: 'Facebook Ads', budget: 50000, percentage: 100, rationale: 'SMB owners', expected_metrics: {} }],
      recommendations: ['Test two audiences first'],
    });
    saveBudgetPlan.mockResolvedValue(12);

    const result = await executeCreateBudgetPlan({ total_budget: 50000, duration_days: 30, currency: 'inr' }, context);

    expect(loadPlanningIcp).toHaveBeenCalledWith(191, 7);
    expect(generateBudgetPlan).toHaveBeenCalledWith({ id: 191, userId: 7 }, 50000, 30, 'INR');
    expect(result).toMatchObject({ success: true, output: { planId: 12, dailyBudget: 1667, launched: false, spent: false } });
    expect(emit).toHaveBeenCalledWith(7, 'budget_plan_saved', { thread_id: 240, icpId: 191, planId: 12 });
    expect(emit).toHaveBeenCalledWith(7, 'open_tab', expect.objectContaining({ thread_id: 240, tabType: 'performancemarketing' }));
  });

  it('asks for a customer profile instead of planning without one', async () => {
    const result = await executeCreateBudgetPlan({ total_budget: 50000 }, { userId: 7, threadId: 240 } as never);
    expect(result).toMatchObject({ success: false });
    expect(generateBudgetPlan).not.toHaveBeenCalled();
  });

  it('rejects a missing or zero budget before any AI call', async () => {
    const result = await executeCreateBudgetPlan({ total_budget: 0 }, context);
    expect(result).toMatchObject({ success: false });
    expect(loadPlanningIcp).not.toHaveBeenCalled();
  });
});
