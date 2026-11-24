import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
jest.unstable_mockModule('../services/social/OrganicPublishAuthority.js', () => ({
  captureOrganicPublishOrigin: async () => ({ userId: 1, businessProfileId: 1, businessActorUserId: 1, billingOrganizationId: 1, billingActorUserId: 1 }),
  authorizeOrganicPublishOrigin: async () => undefined,
}));

// Every persistence and provider boundary is mocked. No application DB or uploads.
let extrasMode = false;
const query: any = { from: () => query, where: () => query, limit: async () => extrasMode ? [{ id: 1, metadata: extrasMetadata }] : [], then: (resolve: any) => Promise.resolve([]).then(resolve) };
const insert = jest.fn();
let extrasMetadata: Record<string, unknown> = {};
const updateExtras = () => ({ set: (value: any) => ({ where: async () => {
  extrasMetadata = { ...extrasMetadata, youtubePublishExtras: JSON.parse(new PgDialect().sqlToQuery(value.metadata).params[0] as string) };
} }) });
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => query, insert, update: updateExtras }, pgPool: undefined }));
const model: any = {
  claim: jest.fn(), markProviderSucceeded: jest.fn(), markSucceeded: jest.fn(),
  markProviderProcessingFailed: jest.fn(), deferProviderFinalization: jest.fn(),
  claimReconciliation: jest.fn(), releaseReconciliation: jest.fn(), renewLease: jest.fn(), findByIdForUser: jest.fn(),
};
jest.unstable_mockModule('../models/socialPublishAttempts/functions', () => ({ SocialPublishAttemptModel: model }));
const assets: any = { markAsPublishedForUser: jest.fn(), updateForUser: jest.fn() };
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: assets }));
jest.unstable_mockModule('../services/content/ContentBrandContextService', () => ({
  brandContextSnapshot: () => ({}), resolveContentBrandContext: async () => ({ businessProfile: { id: 1 }, brandToolkit: { id: 1 } }),
}));
jest.unstable_mockModule('../services/content/ContentComplianceService', () => ({
  ContentComplianceError: class extends Error {}, validateGeneratedContent: () => undefined,
}));
jest.unstable_mockModule('../services/social/SocialPublishingService', () => ({
  publishToFacebook: jest.fn(), publishToInstagram: jest.fn(), findPublishedOrganicPostCandidate: jest.fn(),
}));
const policy = await import('../services/social/YouTubePublishingService.js');
const publish = jest.fn<any>();
const processing = jest.fn<any>();
const accounts = jest.fn<any>();
const thumbnail = jest.fn<any>();
const playlist = jest.fn<any>();
jest.unstable_mockModule('../services/social/YouTubePublishingService', () => ({
  ...policy, publishToYouTube: publish, getYouTubeVideoProcessingStatus: processing, listYouTubePublishingAccounts: accounts,
  setYouTubeThumbnail: thumbnail, assignYouTubePlaylist: playlist, validateYouTubePublishExtras: jest.fn(),
}));
const { executeOrganicPublishAttempt, prepareOrganicPublishAttempt, isPublishingAccountAvailable } = await import('../services/social/OrganicPublishingService.js');
const { youtubePublishingOptionsSchema } = await import('../utils/youtubePublishingOptions.js');

const youtubeOptions = { madeForKids: true, containsSyntheticMedia: true, categoryId: '28', defaultLanguage: 'en-US', license: 'creativeCommon' as const };
const snapshot: any = {
  platform: 'youtube', credentialId: 7, providerAccountId: 'UC-reviewed-channel',
  title: 'Reviewed title', caption: 'Reviewed description', tags: ['launch'], privacyStatus: 'unlisted',
  postType: 'short', imageUrls: [], videoUrls: ['https://cdn.example.test/video.mp4'],
  videoMetadata: { durationSeconds: 60, width: 1080, height: 1920, codec: 'h264', container: 'mp4' },
  youtubeOptions, timezone: 'Asia/Kolkata', approvedAt: new Date().toISOString(), approvedBy: 1,
};
const attempt = (status = 'pending', acceptedAt = new Date()): any => ({
  id: 10, assetId: 1, userId: 1, credentialId: 7, platform: 'youtube', status,
  reviewedPayload: snapshot, providerPostId: status === 'provider_succeeded' ? 'MOCK_VIDEO' : null,
  providerSucceededAt: acceptedAt, updatedAt: acceptedAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  extrasMetadata = {};
  extrasMode = false;
  model.claimReconciliation.mockResolvedValue(true);
  model.releaseReconciliation.mockResolvedValue(undefined);
  model.renewLease.mockResolvedValue(true);
  thumbnail.mockReset().mockResolvedValue({});
  playlist.mockReset().mockResolvedValue({});
  accounts.mockResolvedValue([{ platform: 'youtube', credentialId: 7, providerAccountId: 'UC-reviewed-channel', expired: true, readiness: 'ready', isSelected: true }]);
  model.claim.mockResolvedValue(attempt('claimed'));
  model.markProviderSucceeded.mockResolvedValue(attempt('provider_succeeded'));
  model.markSucceeded.mockResolvedValue(attempt('succeeded'));
  model.deferProviderFinalization.mockResolvedValue(attempt('provider_succeeded'));
  model.markProviderProcessingFailed.mockResolvedValue(attempt('failed'));
  assets.markAsPublishedForUser.mockResolvedValue({ id: 1 });
  assets.updateForUser.mockResolvedValue({ id: 1 });
  publish.mockResolvedValue({ success: true, platformPostId: 'MOCK_VIDEO' });
  processing.mockResolvedValue({ processingStatus: 'processing', uploadStatus: 'uploaded', failureReason: null });
});

describe('YouTube durable publishing with fake provider and persistence', () => {
  it('accepts refreshable Google tokens without making other expired accounts eligible', () => {
    const base: any = { platform: 'youtube', expired: true, readiness: 'ready' };
    expect(isPublishingAccountAvailable(base)).toBe(true);
    expect(isPublishingAccountAvailable({ ...base, readiness: 'needs_reconnect' })).toBe(false);
    expect(isPublishingAccountAvailable({ ...base, platform: 'facebook' })).toBe(false);
  });

  it.each([{ madeForKids: 'false' }, { categoryId: 'science' }, { license: 'copyright' }, { publishAt: '2030-01-01' }, { defaultLanguage: 'English' }])('rejects invalid or unsupported options: %j', options => {
    expect(youtubePublishingOptionsSchema.safeParse(options).success).toBe(false);
  });

  it('rejects invalid title and description before a durable attempt is inserted', async () => {
    const asset: any = { id: 1, userId: 1, title: 'Video', status: 'draft', content: '{}', videoUrl: snapshot.videoUrls[0], metadata: { mediaProbe: snapshot.videoMetadata } };
    for (const override of [{ title: 'x'.repeat(101) }, { caption: 'x'.repeat(5001) }, { youtubeOptions: { madeForKids: 'false' } }]) {
      await expect(prepareOrganicPublishAttempt(1, asset, { platform: 'youtube', credentialId: 7, ...override } as any)).rejects.toMatchObject({ status: 422 });
    }
    expect(insert).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('forwards reviewed identity, visibility and options and keeps processing separate from success', async () => {
    const result = await executeOrganicPublishAttempt(attempt(), 1, 'mock-worker');
    expect(publish).toHaveBeenCalledWith(1, expect.objectContaining({ ...youtubeOptions, credentialId: 7, expectedChannelId: 'UC-reviewed-channel', privacyStatus: 'unlisted', postType: 'short' }));
    expect(publish.mock.calls[0][1]).not.toHaveProperty('publishAt');
    expect(result.status).toBe('provider_succeeded');
    expect(assets.markAsPublishedForUser).not.toHaveBeenCalled();
    processing.mockResolvedValue({ processingStatus: 'succeeded', uploadStatus: 'processed', failureReason: null });
    expect((await executeOrganicPublishAttempt(result, 1, 'mock-worker')).status).toBe('succeeded');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // Persistence/options/private-default assertions now execute with a real caller
  // transaction and canonical Storage in linkedInOrganicWorkerPostgres.test.ts.

  it('defers temporary processing errors and terminates checks after 24 hours without reupload', async () => {
    processing.mockRejectedValue(new Error('Google status unavailable'));
    expect((await executeOrganicPublishAttempt(attempt('provider_succeeded'), 1, 'mock-worker')).status).toBe('provider_succeeded');
    expect(model.deferProviderFinalization).toHaveBeenCalledTimes(1);
    const old = attempt('provider_succeeded', new Date(Date.now() - 25 * 60 * 60_000));
    expect((await executeOrganicPublishAttempt(old, 1, 'mock-worker')).status).toBe('failed');
    expect(model.markProviderProcessingFailed).toHaveBeenCalledWith(10, 1, 'YOUTUBE_PROCESSING_TIMEOUT', expect.any(String));
    expect(publish).not.toHaveBeenCalled();
  });
  it('retries thumbnail and playlist setup against the accepted video without uploading again', async () => {
    extrasMode = true;
    const uploaded = { ...attempt('provider_succeeded'), reviewedPayload: { ...snapshot,
      youtubeOptions: { ...youtubeOptions, thumbnailUrl: 'https://cdn.example.test/thumb.jpg', playlistId: 'PLfixture' } } };
    processing.mockResolvedValue({ processingStatus: 'succeeded', uploadStatus: 'processed', failureReason: null });
    model.deferProviderFinalization.mockResolvedValue(uploaded);
    playlist.mockRejectedValueOnce(new Error('temporary playlist outage'));
    expect((await executeOrganicPublishAttempt(uploaded, 1, 'mock-worker')).status).toBe('provider_succeeded');
    expect(model.deferProviderFinalization).toHaveBeenCalledWith(10, 1, expect.stringContaining('Thumbnail or playlist'), 5 * 60_000, 'YOUTUBE_EXTRAS_PENDING');
    expect(assets.markAsPublishedForUser).not.toHaveBeenCalled();
    expect((await executeOrganicPublishAttempt(uploaded, 1, 'mock-worker')).status).toBe('succeeded');
    expect(thumbnail).toHaveBeenCalledWith(1, 7, 'MOCK_VIDEO', 'https://cdn.example.test/thumb.jpg');
    expect(thumbnail).toHaveBeenCalledTimes(1);
    expect(playlist).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });
  it('stops retrying optional setup after three failures while preserving the published receipt', async () => {
    extrasMode = true;
    const uploaded = { ...attempt('provider_succeeded'), reviewedPayload: { ...snapshot,
      youtubeOptions: { ...youtubeOptions, playlistId: 'PLfixture' } } };
    processing.mockResolvedValue({ processingStatus: 'succeeded', uploadStatus: 'processed', failureReason: null });
    model.deferProviderFinalization.mockResolvedValue(uploaded);
    playlist.mockRejectedValue(new Error('Playlist access revoked'));
    expect((await executeOrganicPublishAttempt(uploaded, 1, 'mock-worker')).status).toBe('provider_succeeded');
    expect((await executeOrganicPublishAttempt(uploaded, 1, 'mock-worker')).status).toBe('provider_succeeded');
    expect((await executeOrganicPublishAttempt(uploaded, 1, 'mock-worker')).status).toBe('succeeded');
    expect(model.markSucceeded).toHaveBeenCalledWith(10, 1, { code: 'YOUTUBE_EXTRAS_FAILED', message: expect.stringContaining('Playlist access revoked') });
    expect(assets.markAsPublishedForUser).toHaveBeenCalledWith(1, 1, expect.objectContaining({ publishedPostId: 'MOCK_VIDEO' }));
    expect(publish).not.toHaveBeenCalled();
  });
  it('does not run provider finalization when another worker holds the receipt lease', async () => {
    const uploaded = attempt('provider_succeeded');
    model.claimReconciliation.mockResolvedValue(false);
    model.findByIdForUser.mockResolvedValue(uploaded);
    expect(await executeOrganicPublishAttempt(uploaded, 1, 'mock-worker')).toEqual(uploaded);
    expect(processing).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it('renews an active provider lease during long uploads and clears the heartbeat afterwards', async () => {
    jest.useFakeTimers();
    try {
      let finish!: (result: any) => void;
      publish.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const running = executeOrganicPublishAttempt(attempt(), 1, 'long-upload-worker');
      await jest.advanceTimersByTimeAsync(30_001);
      expect(model.renewLease).toHaveBeenCalledWith(10, 1, 'long-upload-worker');
      finish({ success: true, platformPostId: 'MOCK_VIDEO' });
      await running;
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
