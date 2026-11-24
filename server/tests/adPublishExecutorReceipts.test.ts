import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CampaignPublishPreflightError } from '../services/ads/CampaignPublishReview.js';

const queue = jest.fn<any>();
const getReview = jest.fn<any>();
const getSettings = jest.fn<any>();
jest.unstable_mockModule('../services/ads/AutonomousAdsService.js', () => ({ autonomousAdsService: {
  queueExistingCampaignPlatform: queue, getPublishReview: getReview, getSettings,
} }));
const { executePublishAds, prepareAdCampaignReview } = await import('../mastra/tools/executors/adsExecutor.js');
const revision = 'a'.repeat(64);
const context = { userId: 7, threadId: 8, widgetId: 'review-widget' };

describe('ad publication receipt replay', () => {
  beforeEach(() => { jest.resetAllMocks(); });
  it('requires a server-issued review revision before queueing', async () => {
    const result = await executePublishAds({ campaign_id: '17', platforms: ['meta'] }, context as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('approve its current revision');
    expect(queue).not.toHaveBeenCalled();
  });
  it('prepares only the requested campaign and returns its revision and validation errors without queueing', async () => {
    const review = { campaignId: 17, revision, validationErrors: ['Missing landing page'],
      platformErrors: { meta: ['Missing Page'] }, snapshot: { campaignId: 17, platforms: ['meta'] } };
    getReview.mockResolvedValue(review);
    await expect(prepareAdCampaignReview({ campaign_id: '17', platforms: ['meta'] }, context as any)).resolves.toEqual(review);
    expect(getReview).toHaveBeenCalledWith(7, 17);
    expect(queue).not.toHaveBeenCalled();
  });
  it('rejects a mismatched saved review', async () => {
    getReview.mockResolvedValue({ campaignId: 18, snapshot: { campaignId: 18, platforms: ['meta'] } });
    await expect(prepareAdCampaignReview({ campaign_id: '17', platforms: ['meta'] }, context as any)).rejects.toThrow('does not match');
    expect(queue).not.toHaveBeenCalled();
  });
  it('does not fall back to asset-based creation for a malformed explicit campaign ID', async () => {
    await expect(prepareAdCampaignReview({ campaign_id: '17oops', asset_ids: [88], platforms: ['meta'] }, context as any)).rejects.toThrow('valid saved campaign ID');
    expect(getReview).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });
  it('returns completed receipts without consulting changed draft settings or gates', async () => {
    queue.mockResolvedValue({ status: 'active', actionId: 4, replayed: true });
    getReview.mockRejectedValue(new Error('Draft changed since launch'));
    getSettings.mockResolvedValue({ liveProviderMutationsEnabled: false });
    const result = await executePublishAds({ campaign_id: '19', review_revision: revision, platforms: ['meta', 'google'] }, context as any);
    expect(result.output).toEqual(expect.objectContaining({ status: 'active', pending: false }));
    expect(getReview).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledWith(7, 19, 'meta', 'agent:8:widget:review-widget:campaign:19:meta', revision);
  });
  it('does not label a created-but-inactive receipt queued', async () => {
    queue.mockResolvedValue({ status: 'provider_created', actionId: 4, replayed: true });
    const result = await executePublishAds({ campaign_id: '19', review_revision: revision, platforms: ['google'] }, context as any);
    expect(result.output).toEqual(expect.objectContaining({ status: 'provider_created', pending: false }));
  });
  it('keeps a healthy platform queued when the other is gated', async () => {
    queue.mockImplementation(async (_user: number, _id: number, platform: string) => {
      if (platform === 'google') throw new CampaignPublishPreflightError('Google launch disabled', 'gated');
      return { status: 'queued', actionId: 4 };
    });
    const result = await executePublishAds({ campaign_id: '19', review_revision: revision, platforms: ['meta', 'google'] }, context as any);
    expect(result.output).toEqual(expect.objectContaining({ status: 'partial_success', pending: true,
      platforms: { meta: { status: 'queued', actionId: 4 }, google: { status: 'gated', error: 'Google launch disabled' } } }));
  });
  it('reports all-gated as gated, never publication success', async () => {
    queue.mockRejectedValue(new CampaignPublishPreflightError('Disabled', 'gated'));
    const result = await executePublishAds({ campaign_id: '19', review_revision: revision, platforms: ['meta'] }, context as any);
    expect(result.success).toBe(false);
    expect(result.output).toEqual(expect.objectContaining({ status: 'gated', pending: false }));
  });
});
