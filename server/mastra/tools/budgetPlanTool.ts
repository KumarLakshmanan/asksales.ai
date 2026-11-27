import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolContext } from './toolRegistry.js';
import { TAB_TYPES, TAB_LABELS } from '../tabConfig';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
});

export const budgetPlanInputSchema = z.object({
  total_budget: z.number().positive().max(1_000_000_000).describe('Total budget for the whole period, in the given currency'),
  duration_days: z.number().int().min(1).max(365).default(30).describe('Number of days the budget covers'),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform(code => code.toUpperCase()).default('USD').describe('ISO currency code such as INR or USD'),
}).strict();

/**
 * Generate a channel budget plan for this campaign's customer profile and save it
 * so the Performance Marketing tab shows the same plan. A plan only: it never
 * creates, launches or funds an ad campaign.
 */
export async function executeCreateBudgetPlan(input: unknown, context: ToolContext) {
  const toolName = 'create_budget_plan';
  const parsed = budgetPlanInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, toolName, error: 'Give a total budget above zero, a duration in days and a three-letter currency.' };
  const args = parsed.data;
  const userId = Number(context.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return { success: false, toolName, error: 'An authenticated user is required.' };
  const icpId = Number(context.icpProfile?.id);
  if (!Number.isSafeInteger(icpId) || icpId <= 0) {
    return { success: false, toolName, error: 'This campaign needs a customer profile before a budget plan can be saved.' };
  }

  const { PerformanceMarketingAgent, loadPlanningIcp } = await import('../../services/agents/PerformanceMarketingAgent.js');
  const icp = await loadPlanningIcp(icpId, userId);
  if (!icp) return { success: false, toolName, error: "This campaign's customer profile could not be found." };

  const planner = new PerformanceMarketingAgent();
  const plan = await planner.generateBudgetPlan(icp, args.total_budget, args.duration_days, args.currency);
  const planId = await planner.saveBudgetPlan(plan);

  const { webSocketEmitter } = await import('../../services/agents/WebSocketEmitter.js');
  const threadId = Number(context.threadId) || undefined;
  webSocketEmitter.emit(userId, 'budget_plan_saved', { thread_id: threadId, icpId, planId });
  webSocketEmitter.emit(userId, 'open_tab', {
    thread_id: threadId,
    tabType: TAB_TYPES.PERFORMANCE_MARKETING,
    tabLabel: TAB_LABELS[TAB_TYPES.PERFORMANCE_MARKETING],
  });

  return {
    success: true,
    toolName,
    output: {
      planId,
      totalBudget: plan.total_budget,
      durationDays: plan.duration_days,
      currency: plan.currency,
      dailyBudget: plan.daily_budget,
      channels: plan.channel_allocation.map(channel => ({
        channel: channel.channel, budget: channel.budget, percentage: channel.percentage, rationale: channel.rationale,
      })),
      recommendations: plan.recommendations,
      launched: false,
      spent: false,
      message: 'Budget plan saved and shown in the Performance Marketing tab. It is a plan only: no campaign was created, launched or funded.',
    },
  };
}

export const createBudgetPlanTool = createTool({
  id: 'create_budget_plan',
  description: "Create and save a channel budget plan (allocation per channel, daily budget, expected results) for this campaign's customer profile, shown in the Performance Marketing tab. Use when the user asks for a budget plan or asks to save one. It never creates, launches or funds ads and needs no approval.",
  inputSchema: budgetPlanInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => executeCreateBudgetPlan(input, (mastra as any)?.__toolContext),
});
