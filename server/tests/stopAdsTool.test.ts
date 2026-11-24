import { beforeEach, expect, it, jest } from '@jest/globals';
const queueCampaignStop = jest.fn<any>();
jest.unstable_mockModule('../services/ads/AutonomousAdsService.js', () => ({ autonomousAdsService: { queueCampaignStop } }));
const { stopAdsTool, executeStopAds } = await import('../mastra/tools/stopAdsTool.js');
beforeEach(() => { queueCampaignStop.mockReset(); });
it('ordinary agent invocation requests approval without queueing', async () => {
  const result = await (stopAdsTool as any).execute({ campaignId: 19, platforms: ['meta'] }, {});
  expect(result.requiresApproval).toBe(true);
  expect(queueCampaignStop).not.toHaveBeenCalled();
});
it('requires a durable submitted widget and uses its stable idempotency identity', async () => {
  await expect(executeStopAds({ campaignId: 19, platforms: ['meta'] }, { userId: 7, threadId: 171 })).rejects.toThrow('durable');
  expect(queueCampaignStop).not.toHaveBeenCalled();
  queueCampaignStop.mockResolvedValue({ campaignId: 19, platforms: [{ platform: 'meta', actionId: 8, status: 'gated', providerPauseConfirmed: false }] });
  const result = await executeStopAds({ campaignId: 19, platforms: ['meta'] }, { userId: 7, threadId: 171, widgetId: 40 });
  expect(queueCampaignStop).toHaveBeenCalledWith(7, 19, ['meta'], 'thread:171:stop-widget:40');
  expect(result.output.status).toBe('queued');
  expect(result.output.message).toContain('not yet confirmed');
});
