import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const complete = jest.fn<any>();
const createAsset = jest.fn<any>();
const dispatch = jest.fn<any>();
const videoWorker = jest.fn();
const videoGenerate = jest.fn<any>();
const sourceQuery: any = { from: () => sourceQuery, where: () => sourceQuery, orderBy: () => sourceQuery, limit: async () => [{ id: 3, userId: 7, type: 'image', content: 'data:image/png;base64,aGVsbG8=' }] };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => sourceQuery } }));
jest.unstable_mockModule('../models/companySettings/functions', () => ({ getCompanySettingsByUserId: async () => null }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: complete }));
jest.unstable_mockModule('../mastra/tools/queueBridge.js', () => ({ shouldUseQueue: () => false, dispatchAndWait: async (_tool: unknown, _payload: unknown, _context: unknown, direct: () => Promise<unknown>) => direct() }));
jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({ jobDispatcher: { dispatch } }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: { create: createAsset } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({ webSocketEmitter: { emit: jest.fn(), emitProgressStep: jest.fn() } }));
jest.unstable_mockModule('../services/promptTemplates', () => ({ templateMap: {} }));
jest.unstable_mockModule('../services/media/MediaGenerationWorkerFactory', () => ({ createImageGenerationWorker: jest.fn(), createVideoGenerationWorker: videoWorker }));

const { executeGenerateSocialMediaPost, executeGenerateSocialChatTemplate, executeGenerateVideo, executeGenerateVideoFromImage } = await import('../mastra/tools/executors/contentExecutor.js');
const { executeGenerateAd } = await import('../mastra/tools/executors/adsExecutor.js');
const { queueSavedContentVideos } = await import('../services/media/SavedContentVideoQueueService.js');
const { runDurableVideoJob } = await import('../services/media/DurableVideoJobService.js');
const context: any = {
  userId: 7, threadId: 42, brandContextPrompt: 'Approved neutral brand guidance.',
  brandToolkit: { id: 12, name: 'QA Brand', voiceDonts: [], logoVisibility: false },
  brandContextSnapshot: {
    businessProfile: { id: 9, userId: 7, restrictions: '', website: 'https://aimplifylabs.com' },
    brandToolkit: { id: 12, userId: 7, voiceDonts: [], logoVisibility: false },
    provenance: { userId: 7, businessProfile: { id: 9, version: 2 }, brandToolkit: { id: 12, version: 3 } },
  },
};
const cases = [
  { type: 'social_post', handler: executeGenerateSocialMediaPost, input: { platform: 'linkedin', topic: 'Workflow notes' }, output: { caption: 'A useful workflow note.', hashtags: [], keywords: [] } },
  { type: 'social_dm', handler: executeGenerateSocialChatTemplate, input: { platform: 'linkedin', objective: 'Share workflow notes' }, output: { message: 'Hi {{first_name}}, here is a useful workflow note.' } },
  { type: 'ad_copy', handler: executeGenerateAd, input: { platform: 'meta', description_text: 'A useful workflow note.' }, output: { headline: 'QA Workflow Notes', primaryText: 'Useful workflow information.', description: 'Read the workflow notes.', callToAction: 'LEARN_MORE', displayUrl: 'https://aimplifylabs.com', keywords: [] } },
];
const videoInput = { auto_generate_image: false, include_image_prompt: false, auto_generate_video: true, video_provider: 'openrouter', video_model: 'fixture/video', video_aspect_ratio: '9:16', video_resolution: '720p', video_duration_seconds: 8 };
beforeEach(() => {
  jest.clearAllMocks();
  createAsset.mockImplementation(async (data: Record<string, unknown>) => ({ ...data, id: 501 }));
  dispatch.mockImplementation(async (_tool: string, _payload: unknown, options: { jobId: string }) => ({ jobId: options.jobId }));
  videoWorker.mockReturnValue({ generateFromText: videoGenerate, generateFromImage: videoGenerate });
});

describe('standalone pending video recovery without sleeping or resubmission', () => {
  const pendingCases = [{ handler: executeGenerateVideo, source: false }, { handler: executeGenerateVideoFromImage, source: true }];
  it.each(pendingCases)('persists and queues the same operation (image source: $source)', async ({ handler }) => {
    videoGenerate.mockResolvedValue({ success: true, status: 'pending', operationName: 'operations/saved-fixture', provider: 'google', model: 'veo-original' });
    const result = await handler({ prompt: 'Neutral visual', source_image_id: '3' } as any, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 501, status: 'pending', retrySafe: false, operationName: 'operations/saved-fixture' } });
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', performance: expect.objectContaining({ operationName: 'operations/saved-fixture', provider: 'google', model: 'veo-original' }) }));
    expect(dispatch).toHaveBeenCalledWith('generate_video', expect.objectContaining({ parentAssetId: 501, operationName: 'operations/saved-fixture', provider: 'google', model: 'veo-original' }), expect.anything());
    expect(videoGenerate).toHaveBeenCalledTimes(1);
  });
  it.each(pendingCases)('retains a recoverable saved operation when automatic polling cannot queue (image source: $source)', async ({ handler }) => {
    videoGenerate.mockResolvedValue({ success: true, status: 'pending', operationName: 'operations/saved-fixture', provider: 'google', model: 'veo-original' });
    dispatch.mockRejectedValue(new Error('Mock queue outage'));
    const result = await handler({ prompt: 'Neutral visual', source_image_id: '3' } as any, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 501, status: 'pending', retrySafe: false, warnings: ['Mock queue outage'] } });
    expect(videoGenerate).toHaveBeenCalledTimes(1);
  });
});

describe('saved content auto-video queue', () => {
  it.each(cases)('saves $type before queueing and never invokes the provider inline', async entry => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...entry.output, videoPrompt: 'A neutral workflow visual.' }) });
    dispatch.mockImplementation(async (_tool: string, _payload: unknown, options: { jobId: string }) => {
      expect(createAsset).toHaveBeenCalled();
      return { jobId: options.jobId };
    });
    const result = await entry.handler({ ...entry.input, ...videoInput } as any, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 501, videoStatus: 'queued', videoJobIds: ['content-video-501-0'] } });
    expect(dispatch).toHaveBeenCalledWith('generate_video', expect.objectContaining({ parentAssetId: 501, assetType: entry.type, userId: 7, provider: 'openrouter', model: 'fixture/video', brandLogoUrl: null, videoConfig: { aspectRatio: '9:16', resolution: '720p', durationSeconds: 8 } }), { jobId: 'content-video-501-0' });
    expect(videoWorker).not.toHaveBeenCalled();
  });
  it.each(cases)('does not queue $type video after failed parent persistence', async entry => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...entry.output, videoPrompt: 'A neutral workflow visual.' }) });
    createAsset.mockRejectedValue(new Error('Mock database outage'));
    const result = await entry.handler({ ...entry.input, ...videoInput } as any, context);
    expect(result.success).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(videoWorker).not.toHaveBeenCalled();
  });
  it.each(cases)('reports queue failure without a false $type video completion receipt', async entry => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...entry.output, videoPrompt: 'A neutral workflow visual.' }) });
    dispatch.mockRejectedValue(new Error('Mock queue outage'));
    const result = await entry.handler({ ...entry.input, ...videoInput } as any, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 501, videoStatus: 'failed', videoJobIds: [], warnings: ['Mock queue outage'] } });
    expect(videoWorker).not.toHaveBeenCalled();
  });
  it('uses stable distinct keys for every prompt and preserves partial queue results', async () => {
    dispatch.mockRejectedValueOnce(new Error('First dispatch unavailable'));
    const result = await queueSavedContentVideos({ parentAssetId: 4, userId: 7, assetType: 'social_post', prompts: ['First', 'Second'] });
    expect(result).toEqual({ status: 'partial_success', jobIds: ['content-video-4-1'], errors: ['First dispatch unavailable'] });
  });
  it('rejects an unsaved parent before touching the queue', async () => {
    await expect(queueSavedContentVideos({ parentAssetId: 0, userId: 7, assetType: 'social_post', prompts: ['First'] })).rejects.toThrow('Save the parent');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('durable provider operation recovery', () => {
  function job() { return { data: {} as Record<string, unknown>, updateData: jest.fn<any>().mockResolvedValue(undefined) }; }
  it('resumes the same pending operation after suspension', async () => {
    const fixture = job();
    const generate = jest.fn<any>().mockResolvedValueOnce({ success: true, status: 'pending', operationName: 'fixture-operation' }).mockResolvedValueOnce({ success: true, videoUrl: 'https://media.example.test/fixture.mp4' });
    await runDurableVideoJob(fixture, generate);
    expect(fixture.data.operationName).toBe('fixture-operation');
    await runDurableVideoJob(fixture, generate);
    expect(generate.mock.calls).toEqual([[undefined], ['fixture-operation']]);
  });
  it('reuses a completed result after attachment failure without another provider request', async () => {
    const fixture = job();
    const result = { success: true, videoUrl: 'https://media.example.test/fixture.mp4' };
    const generate = jest.fn<any>().mockResolvedValue(result);
    expect(await runDurableVideoJob(fixture, generate)).toEqual(result);
    expect(await runDurableVideoJob(fixture, generate)).toEqual(result);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('refuses another provider submission after an ambiguous timeout', async () => {
    const fixture = job();
    const generate = jest.fn<any>().mockRejectedValue(new Error('Mock timeout'));
    await expect(runDurableVideoJob(fixture, generate)).rejects.toThrow('Mock timeout');
    await expect(runDurableVideoJob(fixture, generate)).rejects.toThrow('no duplicate generation');
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('does not call the provider if the durable submission marker cannot be saved', async () => {
    const fixture = job();
    fixture.updateData.mockRejectedValue(new Error('Mock Redis outage'));
    const generate = jest.fn<any>();
    await expect(runDurableVideoJob(fixture, generate)).rejects.toThrow('Mock Redis outage');
    expect(generate).not.toHaveBeenCalled();
  });
});
