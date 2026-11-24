import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetCredential = jest.fn<any>();
const mockGetAllCredentials = jest.fn<any>();
const mockLoadVertexServiceAccount = jest.fn<any>();

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential: mockGetCredential,
  getAllActiveAdminCredentials: mockGetAllCredentials,
}));
jest.unstable_mockModule('../utils/vertexAuth.js', () => ({
  loadVertexServiceAccount: mockLoadVertexServiceAccount,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const registry = await import('../services/media/MediaProviderRegistry.js');

describe('media provider registry', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockGetCredential.mockReset();
    mockGetAllCredentials.mockReset();
    mockLoadVertexServiceAccount.mockReset();
    mockGetCredential.mockResolvedValue({ id: 1 });
    mockLoadVertexServiceAccount.mockReturnValue(null);
    mockGetAllCredentials.mockImplementation(async (platform: string) => platform === 'gemini_image' || platform === 'gemini_video'
      ? [{ id: 1, platform, isActive: true, priority: 'normal', apiKey: 'key',
        config: { model: platform === 'gemini_image' ? registry.DEFAULT_IMAGE_SELECTION.model : registry.DEFAULT_VIDEO_SELECTION.model } }]
      : []);
  });

  it('discovers current OpenRouter image and video models with capabilities', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { id: 'older/image-model', name: 'Older image model' },
        {
          id: registry.DEFAULT_OPENROUTER_IMAGE_MODEL,
          name: 'Seedream test',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
          supported_parameters: {
            aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
            resolution: { type: 'enum', values: ['1K', '2K'] },
            input_references: { type: 'boolean' },
            seed: { type: 'range', min: 0, max: 1000 },
          },
        },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { id: 'older/video-model', name: 'Older video model' },
        {
          id: registry.DEFAULT_OPENROUTER_VIDEO_MODEL,
          name: 'Seedance test',
          supported_aspect_ratios: ['16:9', '9:16'],
          supported_durations: [4, 30],
          supported_resolutions: ['720p'],
          supported_frame_images: ['first_frame'],
          generate_audio: true,
          seed: true,
        },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const catalog = await registry.getMediaProviderCatalog();

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://openrouter.ai/api/v1/images/models', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://openrouter.ai/api/v1/videos/models', expect.any(Object));
    expect(catalog.image.find((provider) => provider.id === 'openrouter')?.models[0]).toMatchObject({
      id: registry.DEFAULT_OPENROUTER_IMAGE_MODEL,
      capabilities: { aspectRatios: ['1:1', '16:9'], supportsImageReferences: true },
    });
    expect(catalog.video.find((provider) => provider.id === 'openrouter')?.models[0]).toMatchObject({
      id: registry.DEFAULT_OPENROUTER_VIDEO_MODEL,
      capabilities: { durations: [4, 30], supportsAudio: true },
    });
  });

  it('resolves a higher-priority OpenRouter media integration and rejects cross-provider model IDs', async () => {
    mockGetAllCredentials.mockImplementation(async (platform: string) => platform === 'openrouter'
      ? [{ id: 2, platform, isActive: true, priority: 'high', apiKey: 'key',
        config: { imageModel: registry.DEFAULT_OPENROUTER_IMAGE_MODEL, videoModel: registry.DEFAULT_OPENROUTER_VIDEO_MODEL } }]
      : [{ id: 1, platform, isActive: true, priority: 'low', apiKey: 'key', config: {} }]);

    await expect(registry.resolveMediaProviderSelection('video', 42)).resolves.toEqual({
      provider: 'openrouter',
      model: registry.DEFAULT_OPENROUTER_VIDEO_MODEL,
    });
    await expect(registry.assertValidMediaSelection('image', {
      provider: 'google',
      model: registry.DEFAULT_OPENROUTER_IMAGE_MODEL,
    })).rejects.toThrow('not available from google');
  });

  it('ignores client-level provider and model overrides', async () => {
    await expect(registry.resolveMediaProviderSelection('image', 42, {
      provider: 'openrouter',
      model: registry.DEFAULT_OPENROUTER_IMAGE_MODEL,
    })).resolves.toEqual(registry.DEFAULT_IMAGE_SELECTION);
  });
  it('normalizes a legacy Google image model before it can bypass worker validation', async () => {
    mockGetAllCredentials.mockImplementation(async (platform: string) => platform === 'gemini_image'
      ? [{ id: 12, platform, isActive: true, priority: 'normal', apiKey: 'AQ.qa-key', config: { model: 'gemini-3-pro-image-001' } }]
      : []);
    await expect(registry.resolveMediaProviderSelection('image')).resolves.toEqual(registry.DEFAULT_IMAGE_SELECTION);
  });
  it('only returns an already-active, governed image fallback', async () => {
    mockGetCredential.mockResolvedValue({ id: 28, apiKey: 'qa-key', config: { imageModel: 'approved/image-model' } });
    await expect(registry.resolveImageAuthenticationFallback('google')).resolves.toEqual({ provider: 'openrouter', model: 'approved/image-model' });
    expect(mockGetCredential).toHaveBeenCalledWith('openrouter');
    mockGetCredential.mockResolvedValue(null);
    await expect(registry.resolveImageAuthenticationFallback('google')).resolves.toBeNull();
  });
  it('does not use a general Gemini text model as an image or video model', async () => {
    mockGetAllCredentials.mockImplementation(async (platform: string) => platform === 'gemini'
      ? [{ id: 4, platform, isActive: true, priority: 'high', apiKey: 'key', config: { model: 'gemini-2.5-flash' } }]
      : []);
    await expect(registry.resolveMediaProviderSelection('image')).resolves.toEqual(registry.DEFAULT_IMAGE_SELECTION);
    await expect(registry.resolveMediaProviderSelection('video')).resolves.toEqual(registry.DEFAULT_VIDEO_SELECTION);
  });

  it('can validate an unchanged saved selection without requiring live credentials', async () => {
    mockGetCredential.mockResolvedValue(null);
    await expect(registry.assertValidMediaSelection('image', registry.DEFAULT_IMAGE_SELECTION, {
      requireConfigured: false,
    })).resolves.toEqual(registry.DEFAULT_IMAGE_SELECTION);
    await expect(registry.assertValidMediaSelection('image', {
      provider: 'openrouter', model: 'retired/provider-model',
    }, {
      requireConfigured: false,
      allowUnavailableModel: true,
    })).resolves.toEqual({ provider: 'openrouter', model: 'retired/provider-model' });
  });
});
