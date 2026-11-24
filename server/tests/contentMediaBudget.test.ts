/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const root = '..';
const complete = jest.fn<any>();
const createAsset = jest.fn<any>();
const generateImage = jest.fn<any>();
const dispatch = jest.fn<any>();
jest.unstable_mockModule(root + '/models/db', () => ({ db: {} }));
jest.unstable_mockModule(root + '/models/companySettings/functions', () => ({ getCompanySettingsByUserId: async () => null }));
jest.unstable_mockModule(root + '/mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: complete }));
jest.unstable_mockModule(root + '/mastra/tools/queueBridge.js', () => ({ shouldUseQueue: () => false, dispatchAndWait: jest.fn() }));
jest.unstable_mockModule(root + '/models/contentAssets/functions', () => ({ ContentAssetModel: { create: createAsset } }));
jest.unstable_mockModule(root + '/services/agents/WebSocketEmitter', () => ({ webSocketEmitter: { emit: jest.fn(), emitProgressStep: jest.fn() } }));
jest.unstable_mockModule(root + '/services/media/MediaGenerationWorkerFactory', () => ({
  createImageGenerationWorker: () => ({ generateFromText: generateImage }), createVideoGenerationWorker: jest.fn(),
}));
jest.unstable_mockModule(root + '/queues/JobDispatcher.js', () => ({ jobDispatcher: { dispatch } }));
const { executeGenerateSocialMediaPost } = await import(root + '/mastra/tools/executors/contentExecutor.js');
const context: any = {
  userId: 7, threadId: 42, brandContextPrompt: 'Approved synthetic brand.',
  brandToolkit: { id: 12, name: 'Synthetic brand', voiceDonts: [], logoVisibility: false },
  brandContextSnapshot: {
    businessProfile: { id: 9, userId: 7, restrictions: '', website: 'https://business.example.test' },
    brandToolkit: { id: 12, userId: 7, voiceDonts: [], logoVisibility: false },
    provenance: { userId: 7, businessProfile: { id: 9, version: 1 }, brandToolkit: { id: 12, version: 1 } },
  },
};
const input: any = { platform: 'linkedin', topic: 'Synthetic workflow overview',
  auto_generate_image: true, include_image_prompt: true, image_count: 1,
  auto_generate_video: true, include_video_prompt: true, video_count: 1,
};
beforeEach(() => {
  jest.clearAllMocks();
  let id = 501;
  createAsset.mockImplementation(async (data: any) => ({ ...data, id: id++ }));
  generateImage.mockResolvedValue({ success: true, imageUrl: '/uploads/synthetic.png', mimeType: 'image/png' });
  dispatch.mockImplementation(async (_tool: any, _payload: any, options: any) => ({ jobId: options.jobId }));
});
describe('reviewed content media execution budgets', () => {
  it('keeps both provider paths disabled when media is not requested', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ caption: 'A synthetic workflow overview.',
      imagePrompts: ['Unrequested image'], videoPrompts: ['Unrequested video'] }) });
    const result = await executeGenerateSocialMediaPost({ ...input, auto_generate_image: false, auto_generate_video: false,
      include_image_prompt: false, include_video_prompt: false }, context);
    expect(result.success).toBe(true); expect(generateImage).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
  it('executes only the reviewed count from valid candidate arrays', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ caption: 'A synthetic workflow overview.',
      imagePrompts: ['Image one', 'Image two'], videoPrompts: ['Video one', 'Video two'] }) });
    const result = await executeGenerateSocialMediaPost(input, context);
    expect(result.success).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.output?.generatedImages).toHaveLength(1);
    expect(result.output?.videoJobIds).toHaveLength(1);
  });
  it('rejects oversized model prompt arrays before any generation or asset write', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({
      caption: 'A synthetic workflow overview.', hashtags: [], keywords: [],
      imagePrompts: Array.from({ length: 9 }, (_, i) => `Synthetic image ${i}`),
      videoPrompts: Array.from({ length: 7 }, (_, i) => `Synthetic video ${i}`),
    }) });
    const result = await executeGenerateSocialMediaPost(input, context);
    expect(result.success).toBe(false);
    expect(generateImage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('preserves a saved post while exposing its requested image failure', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ caption: 'A synthetic workflow overview.', imagePrompts: ['Synthetic requested image'] }) });
    generateImage.mockRejectedValue(new Error('SYNTHETIC_IMAGE_PROVIDER_UNAVAILABLE'));
    const result = await executeGenerateSocialMediaPost({ ...input, auto_generate_video: false, include_video_prompt: false }, context);
    expect(result.success).toBe(true);
    expect(result.output?.generatedImages).toEqual([]);
    expect(result.output?.warnings).toHaveLength(1);
    expect(result.output?.imageStatus).toBe('failed');
    expect(result.output?.status).toBe('partial_success');
    expect(result.output?.retrySafe).toBe(false);
    expect(result.output?.message).not.toContain('1 image(s)');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_IMAGE_PROVIDER_UNAVAILABLE');
  });
});
