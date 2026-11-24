import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { ToolContext } from './toolRegistry.js';

export const adCampaignQuerySchema = z.object({
  campaignId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict();

export async function executeQueryAdCampaigns(input: unknown, context: ToolContext) {
  const args = adCampaignQuerySchema.parse(input);
  const userId = Number(context.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('An authenticated user is required.');
  const { db } = await import('../../models/db.js');
  const whereId = args.campaignId ? sql`AND id = ${args.campaignId}` : sql``;
  const whereName = args.query ? sql`AND name ILIKE ${`%${args.query}%`}` : sql``;
  const result = await db.execute(sql`
    SELECT id, name, ad_platform, local_status, provider_status, budget_type,
      budget_amount, currency, start_date, end_date
    FROM performance_ad_campaigns
    WHERE user_id = ${userId} ${whereId} ${whereName}
    ORDER BY created_at DESC, id DESC LIMIT ${args.limit + 1} OFFSET ${args.offset}
  `);
  const campaigns = result.rows.slice(0, args.limit).map((row: Record<string, unknown>) => ({
    campaignId: row.id, name: row.name, platform: row.ad_platform,
    localStatus: row.local_status, lastRecordedProviderStatus: row.provider_status,
    budget: { amountMajor: row.budget_amount, currency: row.currency, budgetType: row.budget_type },
    startDate: row.start_date, endDate: row.end_date,
  }));
  return { success: true, toolName: 'query_ad_campaigns', output: {
    campaigns, hasMore: result.rows.length > args.limit, offset: args.offset,
    scope: 'current_user_saved_paid_campaigns', providerVerified: false,
    message: 'Saved paid campaigns only. Provider status is last recorded, not a live verification. Select an exact campaign and platform before requesting changes.',
  } };
}

export const queryAdCampaignsTool = createTool({
  id: 'query_ad_campaigns',
  description: 'Read-only lookup of owned saved paid campaigns by exact ID or name, with pagination. Returns last recorded statuses, not live provider verification. Use to resolve the exact campaign before any change; never infer a stop target from an ambiguous name.',
  inputSchema: adCampaignQuerySchema,
  execute: async (input, { mastra }: any) => executeQueryAdCampaigns(input, mastra?.__toolContext),
});
