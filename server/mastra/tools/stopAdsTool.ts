import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolContext } from './toolRegistry.js';

export const stopAdsSchema = z.object({
  campaignId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  platforms: z.array(z.enum(['meta', 'google'])).min(1).max(2).transform(values => [...new Set(values)]),
}).strict();

export const stopAdsTool = createTool({
  id: 'stop_ads',
  description: 'Request an explicit stop review for an exact saved paid campaign and selected platforms. Resolve ambiguous campaign names with query_ad_campaigns first. This tool creates a review only; it does not pause providers or cancel launches until the client confirms.',
  inputSchema: stopAdsSchema,
  execute: async input => ({ success: true, toolName: 'stop_ads', requiresApproval: true,
    output: { args: input, message: 'Review the exact campaign and platforms before confirming the stop. No stop has executed.' } }),
});

export async function executeStopAds(input: unknown, context: ToolContext) {
  const args = stopAdsSchema.parse(input);
  if (!context.widgetId) throw new Error('A durable, explicitly submitted stop review is required.');
  const { autonomousAdsService } = await import('../../services/ads/AutonomousAdsService.js');
  const result = await autonomousAdsService.queueCampaignStop(Number(context.userId), args.campaignId, args.platforms,
    `thread:${context.threadId}:stop-widget:${context.widgetId}`);
  const pending = result.platforms.some(receipt => ['queued', 'running', 'processing', 'gated', 'pending'].includes(receipt.status));
  const paused = result.platforms.every(receipt => receipt.providerPauseConfirmed);
  return { success: pending || paused, toolName: 'stop_ads', output: {
    ...result, status: pending ? 'queued' : paused ? 'succeeded' : 'failed',
    message: paused ? 'The selected platforms have provider-confirmed pause receipts.'
      : 'The stop request is recorded. Selected pending launch jobs were cancelled; provider pause is not yet confirmed. Check each platform outcome before assuming spend has stopped.',
  }, ...(!pending && !paused ? { error: 'A selected platform stop requires attention. Review its receipt before retrying.' } : {}) };
}
