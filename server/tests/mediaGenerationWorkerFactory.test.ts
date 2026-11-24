import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResolveSelection = jest.fn<any>();
const mockResolveFallback = jest.fn<any>();
const mockCapabilities = jest.fn<any>();
const googleImageGenerate = jest.fn<any>();
const openRouterImageGenerate = jest.fn<any>();
const googleVideoStatus = jest.fn<any>();
const openRouterVideoStatus = jest.fn<any>();

jest.unstable_mockModule('../services/media/MediaProviderRegistry.js', () => ({
  getMediaProviderCatalog: () => [],
  resolveMediaProviderSelection: mockResolveSelection,
  resolveImageAuthenticationFallback: mockResolveFallback,
  getImageModelCapabilities: mockCapabilities,
}));
jest.unstable_mockModule('../tools/imageGenerationWorker.js', () => ({
  ImageGenerationWorker: class {
    generateFromText = googleImageGenerate;
    generateFromImage = jest.fn();
    generateFromMultipleImages = jest.fn();
    generate = jest.fn();
    isConfigured = jest.fn();
    getStatus = jest.fn();
  },
}));
jest.unstable_mockModule('../tools/openRouterImageGenerationWorker.js', () => ({
  OpenRouterImageGenerationWorker: class {
    generateFromText = openRouterImageGenerate;
    generateFromImage = jest.fn();
    generateFromMultipleImages = jest.fn();
    generate = jest.fn();
    isConfigured = jest.fn();
    getStatus = jest.fn();
  },
}));
jest.unstable_mockModule('../tools/videoGenerationWorker.js', () => ({
  VideoGenerationWorker: class {
    checkStatus = googleVideoStatus;
    generateFromText = jest.fn();
    generateFromImage = jest.fn();
    generate = jest.fn();
    startGeneration = jest.fn();
    isConfigured = jest.fn();
    getStatus = jest.fn();
  },
}));
jest.unstable_mockModule('../tools/openRouterVideoGenerationWorker.js', () => ({
  OpenRouterVideoGenerationWorker: class {
    checkStatus = openRouterVideoStatus;
    generateFromText = jest.fn();
    generateFromImage = jest.fn();
    generate = jest.fn();
    startGeneration = jest.fn();
    isConfigured = jest.fn();
    getStatus = jest.fn();
  },
}));

const { createImageGenerationWorker, createVideoGenerationWorker } = await import('../services/media/MediaGenerationWorkerFactory.js');

describe('media generation worker factory', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCapabilities.mockResolvedValue({}); });

  it('maps 4K to the largest size Seedream 5.0 Pro supports and keeps a 4:5 prompt ratio', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'openrouter', model: 'bytedance-seed/seedream-5-0-pro' });
    mockCapabilities.mockResolvedValue({ aspectRatios: ['1:1', '3:4', '4:5', '16:9'], resolutions: ['1K', '2K'] });
    openRouterImageGenerate.mockResolvedValue({ success: true, imageUrl: '/generated.png' });

    const result = await createImageGenerationWorker(7, 11).generateFromText('A 4:5 portrait poster', { imageSize: '4K' });

    expect(openRouterImageGenerate).toHaveBeenCalledWith('A 4:5 portrait poster', expect.objectContaining({ aspectRatio: '4:5', imageSize: '2K' }));
    expect(result.imageSettings).toEqual({ aspectRatio: '4:5', imageSize: '2K', adjustments: ['4K is not supported by this model; using 2K.'] });
  });

  it('maps an unsupported ratio to the nearest shape and drops a size the model does not take', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'google', model: 'gemini-2.5-flash-image' });
    mockCapabilities.mockResolvedValue({ aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'] });
    googleImageGenerate.mockResolvedValue({ success: true, imageUrl: '/generated.png' });

    await createImageGenerationWorker(7, 11).generateFromText('poster', { aspectRatio: '4:5', imageSize: '4K' });

    const config = googleImageGenerate.mock.calls[0][1] as Record<string, unknown>;
    expect(config.aspectRatio).toBe('3:4');
    expect(config).not.toHaveProperty('imageSize');
  });

  it('sends no ratio when none was requested, so the provider keeps its default', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'openrouter', model: 'bytedance-seed/seedream-5-0-pro' });
    mockCapabilities.mockResolvedValue({ aspectRatios: ['1:1', '4:5'], resolutions: ['1K', '2K'] });
    openRouterImageGenerate.mockResolvedValue({ success: true, imageUrl: '/generated.png' });

    await createImageGenerationWorker(7, 11).generateFromText('restyle this photo', { seed: 3 });

    expect(openRouterImageGenerate.mock.calls[0][1]).toEqual({ seed: 3 });
  });

  it('re-maps settings to the fallback model after an authentication failure', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'google', model: 'gemini-2.5-flash-image' });
    mockResolveFallback.mockResolvedValue({ provider: 'openrouter', model: 'bytedance-seed/seedream-5-0-pro' });
    mockCapabilities.mockImplementation(async (selection: { provider: string }) => selection.provider === 'google'
      ? { aspectRatios: ['1:1', '3:4'], resolutions: ['1K'] }
      : { aspectRatios: ['1:1', '4:5'], resolutions: ['1K', '2K'] });
    googleImageGenerate.mockResolvedValue({ success: false, error: 'API key not valid' });
    openRouterImageGenerate.mockResolvedValue({ success: true, imageUrl: '/x.png' });

    const result = await createImageGenerationWorker(7, 11).generateFromText('poster', { aspectRatio: '4:5', imageSize: '4K' });

    expect(googleImageGenerate.mock.calls[0][1]).toMatchObject({ aspectRatio: '3:4', imageSize: '1K' });
    expect(openRouterImageGenerate.mock.calls[0][1]).toMatchObject({ aspectRatio: '4:5', imageSize: '2K' });
    expect(result).toMatchObject({ provider: 'openrouter', imageSettings: { aspectRatio: '4:5', imageSize: '2K' } });
  });

  it('dispatches an explicit OpenRouter image selection and decorates the result', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'openrouter', model: 'bytedance-seed/seedream-test' });
    openRouterImageGenerate.mockResolvedValue({ success: true, imageUrl: '/generated.png' });

    const result = await createImageGenerationWorker(7, 11).generateFromText('launch image', {
      provider: 'openrouter',
      model: 'bytedance-seed/seedream-test',
    });

    expect(openRouterImageGenerate).toHaveBeenCalledWith('launch image', expect.objectContaining({ provider: 'openrouter' }));
    expect(googleImageGenerate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, provider: 'openrouter', model: 'bytedance-seed/seedream-test' });
  });
  it.each(['returned', 'thrown'])('uses one active alternate integration after a %s authentication failure', async failureKind => {
    mockResolveSelection.mockResolvedValue({ provider: 'google', model: 'gemini-2.5-flash-image' });
    mockResolveFallback.mockResolvedValue({ provider: 'openrouter', model: 'bytedance-seed/seedream-test' });
    const error = '{"error":{"code":401,"status":"UNAUTHENTICATED"}}';
    if (failureKind === 'thrown') googleImageGenerate.mockRejectedValue(new Error(error));
    else googleImageGenerate.mockResolvedValue({ success: false, error });
    openRouterImageGenerate.mockResolvedValue({ success: true, imageUrl: '/saved-draft.png' });
    const result = await createImageGenerationWorker(9, 230).generateFromText('illustrative hills', { numberOfImages: 1 });
    expect(result).toMatchObject({ success: true, provider: 'openrouter', fallbackFrom: 'google' });
    expect(googleImageGenerate).toHaveBeenCalledTimes(1);
    expect(openRouterImageGenerate).toHaveBeenCalledTimes(1);
    expect(openRouterImageGenerate).toHaveBeenCalledWith('illustrative hills', expect.objectContaining({ numberOfImages: 1 }));
  });
  it.each(['Content safety policy blocked this image', 'Invalid aspect ratio', 'Provider returned no image'])('does not reroute a non-authentication failure: %s', async error => {
    mockResolveSelection.mockResolvedValue({ provider: 'google', model: 'gemini-2.5-flash-image' });
    googleImageGenerate.mockResolvedValue({ success: false, error });
    await expect(createImageGenerationWorker(9, 230).generateFromText('QA')).resolves.toMatchObject({ success: false, error });
    expect(mockResolveFallback).not.toHaveBeenCalled();
    expect(openRouterImageGenerate).not.toHaveBeenCalled();
  });
  it('preserves the authentication failure when no alternate integration is active', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'google', model: 'gemini-2.5-flash-image' });
    mockResolveFallback.mockResolvedValue(null);
    googleImageGenerate.mockResolvedValue({ success: false, error: 'API key not valid' });
    await expect(createImageGenerationWorker(9, 230).generateFromText('QA')).resolves.toMatchObject({ success: false, error: 'API key not valid', provider: 'google' });
    expect(openRouterImageGenerate).not.toHaveBeenCalled();
  });

  it('routes tagged OpenRouter video operations back to OpenRouter while polling', async () => {
    mockResolveSelection.mockImplementation(async (_kind: string, _userId: number, explicit: { provider?: string }) => ({
      provider: explicit.provider || 'google',
      model: explicit.provider === 'openrouter' ? 'bytedance/seedance-test' : 'veo-test',
    }));
    openRouterVideoStatus.mockResolvedValue({ done: false, operationName: 'openrouter/job-123' });

    const encodedModel = Buffer.from('bytedance/seedance-test').toString('base64url');
    const operationName = `openrouter/${encodedModel}/job-123`;
    const result = await createVideoGenerationWorker(7, 11).checkStatus(operationName);

    expect(mockResolveSelection).not.toHaveBeenCalled();
    expect(openRouterVideoStatus).toHaveBeenCalledWith(operationName, undefined);
    expect(googleVideoStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      done: false,
      operationName: 'openrouter/job-123',
      provider: 'openrouter',
      model: 'bytedance/seedance-test',
    });
  });

  it('coalesces overlapping completed-video status checks to avoid duplicate branding work', async () => {
    let finishStatus!: (value: { done: true; operationName: string; videoUrl: string }) => void;
    openRouterVideoStatus.mockImplementation(() => new Promise((resolve) => { finishStatus = resolve; }));

    const encodedModel = Buffer.from('bytedance/seedance-dedupe-test').toString('base64url');
    const operationName = `openrouter/${encodedModel}/job-dedupe-123`;
    const worker = createVideoGenerationWorker(7, 11);
    const first = worker.checkStatus(operationName, '/logo.png');
    const second = worker.checkStatus(operationName, '/logo.png');

    await Promise.resolve();
    expect(openRouterVideoStatus).toHaveBeenCalledTimes(1);

    finishStatus({ done: true, operationName, videoUrl: '/branded-video.mp4' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ done: true, videoUrl: '/branded-video.mp4' }),
      expect.objectContaining({ done: true, videoUrl: '/branded-video.mp4' }),
    ]);
    expect(openRouterVideoStatus).toHaveBeenCalledTimes(1);
  });
  it('pins a saved Google operation to its original provider after defaults change', async () => {
    mockResolveSelection.mockResolvedValue({ provider: 'openrouter', model: 'another-model' });
    googleVideoStatus.mockResolvedValue({ done: false, operationName: 'operations/saved-google' });
    const result = await createVideoGenerationWorker(7, 11, { provider: 'google', model: 'veo-original' }).checkStatus('operations/saved-google');
    expect(result).toMatchObject({ provider: 'google', model: 'veo-original' });
    expect(googleVideoStatus).toHaveBeenCalledWith('operations/saved-google', undefined);
    expect(openRouterVideoStatus).not.toHaveBeenCalled();
    expect(mockResolveSelection).not.toHaveBeenCalled();
  });
});
