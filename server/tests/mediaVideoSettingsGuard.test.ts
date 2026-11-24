import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GOOGLE_VIDEO_CAPABILITIES } from '../../shared/videoSettings.js';

const generate = jest.fn<any>();
const selection = jest.fn<any>();
jest.unstable_mockModule('../services/media/MediaProviderRegistry.js', () => ({
  resolveMediaProviderSelection: selection,
  getImageModelCapabilities: async () => ({}),
  resolveImageAuthenticationFallback: async () => undefined,
  getMediaProviderCatalog: async () => ({ video: [
    { id: 'google', models: [{ id: 'veo-test', capabilities: GOOGLE_VIDEO_CAPABILITIES }] },
    { id: 'openrouter', models: [{ id: 'routed-test', capabilities: { durations: [5, 10], resolutions: ['480p', '720p'], aspectRatios: ['1:1', '16:9'], maxOutputs: 1 } }] },
  ] }),
}));
jest.unstable_mockModule('../tools/videoGenerationWorker.js', () => ({ VideoGenerationWorker: class { generateFromText = generate; generate = generate; } }));
jest.unstable_mockModule('../tools/openRouterVideoGenerationWorker.js', () => ({ OpenRouterVideoGenerationWorker: class { generateFromText = generate; generate = generate; } }));
jest.unstable_mockModule('../tools/imageGenerationWorker.js', () => ({ ImageGenerationWorker: class {} }));
jest.unstable_mockModule('../tools/openRouterImageGenerationWorker.js', () => ({ OpenRouterImageGenerationWorker: class {} }));
const { createVideoGenerationWorker } = await import('../services/media/MediaGenerationWorkerFactory.js');
const { prepareVideoReview } = await import('../services/media/VideoReviewPolicy.js');
beforeEach(() => { jest.clearAllMocks(); selection.mockResolvedValue({ provider: 'google', model: 'veo-test' }); generate.mockResolvedValue({ success: true, videoUrl: '/uploads/qa.mp4' }); });

describe('video settings provider boundary', () => {
  it('resolves saved model and capabilities while preparing an invalid proposal', async () => {
    const review = await prepareVideoReview({ resolution: '480p', duration_seconds: 5 }, 7);
    expect(review).toMatchObject({ provider: 'google', model: 'veo-test', resolution: '720p', duration_seconds: 8 });
    expect(review.video_settings_note).toContain('adjusted');
  });
  it('rejects unsupported settings without invoking a paid provider', async () => {
    await expect(createVideoGenerationWorker(7).generateFromText('QA visual', { resolution: '480p', durationSeconds: 5 })).rejects.toThrow('Unsupported video resolution');
    expect(generate).not.toHaveBeenCalled();
  });
  it('allows settings supported by the configured routed model', async () => {
    selection.mockResolvedValue({ provider: 'openrouter', model: 'routed-test' });
    const result = await createVideoGenerationWorker(7).generateFromText('QA visual', { resolution: '480p', durationSeconds: 5, aspectRatio: '1:1' });
    expect(result.success).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('resumes an existing operation without revalidating it against changed defaults', async () => {
    await createVideoGenerationWorker(7).generateFromText('QA visual', { resolution: '480p', durationSeconds: 5 }, 'existing-operation');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
