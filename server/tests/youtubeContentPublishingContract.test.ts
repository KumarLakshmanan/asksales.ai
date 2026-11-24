import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const asset = { id: 1, userId: 1, title: 'Fixture video', content: '{"caption":"Reviewed description"}', status: 'draft' };
const query: any = { from: () => query, where: () => query, limit: async () => [asset] };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => query }, pgPool: undefined }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: { findByIdForUser: async () => asset } }));
jest.unstable_mockModule('../models/socialPublishAttempts/functions', () => ({ SocialPublishAttemptModel: { findByKey: async () => null } }));
const prepare = jest.fn<(...args: [unknown, unknown, unknown[], unknown?, unknown?]) => Promise<unknown>>();
const execute = jest.fn<any>();
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService', () => ({ prepareOrganicPublishBatch: prepare, updateEditableContentAsset: jest.fn() }));
jest.unstable_mockModule('../services/social/OrganicPublishingService', () => ({
  OrganicPublishingError: class extends Error {}, executeOrganicPublishAttempt: execute,
}));
jest.unstable_mockModule('../mastra/tools/queueBridge', () => ({ dispatchAndWait: jest.fn(), shouldUseQueue: () => false }));
jest.unstable_mockModule('../mastra/utils/providerCompletion', () => ({ createCompletionWithProviderFallback: jest.fn() }));
const { publishContentAsset } = await import('../controllers/contentAssetController.js');
const { executePublishSocialPost } = await import('../mastra/tools/executors/contentExecutor.js');

const youtubeOptions = { madeForKids: false, containsSyntheticMedia: true, categoryId: '28', defaultLanguage: 'en', license: 'youtube' };
const target = { platform: 'youtube', credentialId: 7, title: 'Reviewed video', postType: 'short', privacyStatus: 'private', youtubeOptions };
const pending = { id: 99, status: 'pending', providerPostId: null };
function response() { const res: any = { statusCode: 200 }; res.status = (value: number) => { res.statusCode = value; return res; }; res.json = (value: any) => { res.body = value; return res; }; return res; }

beforeEach(() => {
  jest.clearAllMocks();
  prepare.mockResolvedValue([{ platform: 'youtube', assetId: 1, attempt: pending }]);
  execute.mockResolvedValue({ ...pending, status: 'provider_succeeded', providerPostId: 'MOCK_VIDEO' });
});

describe('YouTube HTTP and chat contract with mocked publishing', () => {
  it.each(['http', 'chat'])('%s schedule carries visibility and options without dispatch', async route => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    if (route === 'http') {
      const res = response();
      await publishContentAsset({ user: { id: 1 }, params: { assetId: '1' }, body: { targets: [target], scheduledFor: at, timezone: 'Asia/Kolkata' }, get: () => 'mock-http' } as any, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ scheduled: true });
    } else {
      const result = await executePublishSocialPost({ content_asset_id: 1, targets: [target], scheduled_for: at, timezone: 'Asia/Kolkata' }, { userId: 1, widgetId: 'mock-chat' } as any);
      expect(result).toMatchObject({ success: true, output: { scheduled: true } });
    }
    expect(prepare).toHaveBeenCalledWith(1, 1, [expect.objectContaining({ ...target, scheduledFor: at, timezone: 'Asia/Kolkata' })], expect.any(String), expect.objectContaining({ required: true }));
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['http', 'chat'])('%s immediate upload reports acceptance while processing', async route => {
    if (route === 'http') {
      const res = response();
      await publishContentAsset({ user: { id: 1 }, params: { assetId: '1' }, body: { targets: [target] }, get: () => 'mock-http' } as any, res);
      expect(res.statusCode).toBe(202);
      expect(res.body).toMatchObject({ accepted: true, results: { youtube: { status: 'provider_succeeded', postId: 'MOCK_VIDEO' } } });
    } else {
      const result = await executePublishSocialPost({ content_asset_id: 1, platform: 'youtube', credential_id: 7, title: target.title, post_type: 'short', privacy_status: 'private', youtube_options: youtubeOptions }, { userId: 1, widgetId: 'mock-chat' } as any);
      expect(result.output).toMatchObject({ results: { youtube: { status: 'provider_succeeded', postId: 'MOCK_VIDEO' } } });
    }
    const preparedTargets = prepare.mock.calls[0]?.[2] as unknown[] | undefined;
    expect(preparedTargets?.[0]).toMatchObject(target);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
