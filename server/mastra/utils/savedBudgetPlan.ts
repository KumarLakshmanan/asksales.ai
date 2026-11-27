import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';

export interface SavedBudgetPlan {
  total_budget: number | string;
  duration_days: number | string;
  currency: string;
  daily_budget?: number | string | null;
  channel_allocation?: unknown;
  created_at?: string | Date | null;
}

/**
 * The newest budget plan the user saved from the Performance Marketing tab
 * for this campaign's ICP. The tab and Sarah read the same plan, so the chat
 * does not ask for a budget the user already gave in the tab.
 */
export async function loadLatestBudgetPlan(userId: number, icpId: number | null | undefined): Promise<SavedBudgetPlan | null> {
  if (!Number.isInteger(icpId) || !userId) return null;
  try {
    const { db } = await import('../../models/db.js');
    const result = await db.execute(sql`
      SELECT pbp.total_budget, pbp.duration_days, pbp.currency, pbp.daily_budget, pbp.channel_allocation, pbp.created_at
      FROM performance_budget_plans pbp
      JOIN icp_profiles ip ON ip.id = pbp.icp_id
      WHERE pbp.icp_id = ${icpId} AND ip.user_id = ${userId}
      ORDER BY pbp.created_at DESC
      LIMIT 1
    `);
    return (result.rows[0] as unknown as SavedBudgetPlan | undefined) ?? null;
  } catch (err) {
    logger.warn({ err, icpId }, '[savedBudgetPlan] Could not load the saved budget plan');
    return null;
  }
}

function channelSummary(allocation: unknown): string {
  const rows = Array.isArray(allocation) ? allocation : [];
  return rows
    .map((row) => {
      const channel = typeof row?.channel === 'string' ? row.channel : '';
      const percentage = Number(row?.percentage);
      return channel ? `${channel}${Number.isFinite(percentage) ? ` ${percentage}%` : ''}` : '';
    })
    .filter(Boolean)
    .join(', ');
}

/** Prompt text for a saved plan. Planning numbers only: never a spend approval. */
export function describeSavedBudgetPlan(plan: SavedBudgetPlan | null): string {
  if (!plan) return '';
  const total = Number(plan.total_budget);
  const days = Number(plan.duration_days);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(days) || days <= 0) return '';
  const currency = String(plan.currency || '').toUpperCase() || 'USD';
  const channels = channelSummary(plan.channel_allocation);
  const savedDaily = Number(plan.daily_budget);
  const daily = Number.isFinite(savedDaily) && savedDaily > 0 ? savedDaily : total / days;
  const money = (value: number) => `${currency} ${Math.round(value).toLocaleString('en-US')}`;
  return [
    '\n\nSAVED BUDGET PLAN (from the Performance Marketing tab):',
    `- Total ${money(total)} over ${days} days, about ${money(daily)} per day${channels ? `; split: ${channels}` : ''}.`,
    '- When a budget is needed, propose this plan ("You saved a plan of ... per day. Use it?") instead of asking for a budget from scratch. Do not ask again if the user already answered.',
    '- It is a proposal, not the explicit budget for the publish checklist: the user must still confirm the exact daily budget and currency before any ad review is prepared.',
  ].join('\n');
}
