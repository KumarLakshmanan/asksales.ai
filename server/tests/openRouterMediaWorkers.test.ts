import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const saveBase64File = jest.fn<any>();
const saveBufferFile = jest.fn<any>();
const getAdminOpenRouterKey = jest.fn<any>();
const updateAdminCredentialUsage = jest.fn<any>();
const createGeminiUsage = jest.fn<any>();
const loadApprovedBrandLogoReference = jest.fn<any>();
const resolveApprovedBrandLogoUrl = jest.fn<any>();
const applyBrandLogoToVideo = jest.fn<any>();

jest.unstable_mockModule('../utils/fileStorage.js', () => ({ saveBase64File, saveBufferFile }));
jest.unstable_mockModule('../utils/geminiMediaPricing.js', () => ({
  getImageDimensionsFromBase64: jest.fn(() => ({ width: 1024, height: 1024 })),
}));
jest.unstable_mockModule('../services/adminCredentialsService.js', () => ({
  getAdminOpenRouterKey,
  updateAdminCredentialUsage,
}));
jest.unstable_mockModule('../models/geminiUsages/functions.js', () => ({ createGeminiUsage }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({
  getImageMarginPercentage: jest.fn(async () => 0),
  getVideoMarginPercentage: jest.fn(async () => 0),
  getAllApiPricing: jest.fn(async () => []),
  getApiPricingByKey: jest.fn(async () => null),
}));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({ getRechargeRate: jest.fn(async () => 1), getUsageRate: jest.fn(async () => 1) }));
jest.unstable_mockModule('../utils/currency.js', () => ({ getUsdToInrRate: jest.fn(() => 80), meteredCreditsFromUsd: (usd: number, rate: number) => (usd > 0 ? Math.max(1, Math.ceil(usd * 80 * rate - 1e-9)) : 0) }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.unstable_mockModule('../services/content/BrandMediaComposer.js', () => ({
  loadApprovedBrandLogoReference,
  resolveApprovedBrandLogoUrl,
  buildBrandReferencePrompt: jest.fn((prompt: string) => `${prompt}\nUSE APPROVED LOGO REFERENCE`),
}));

jest.unstable_mockModule('../services/media/BrandVideoOverlay.js', () => ({ applyBrandLogoToVideo }));

const { OpenRouterImageGenerationWorker } = await import('../tools/openRouterImageGenerationWorker.js');
const { OpenRouterVideoGenerationWorker } = await import('../tools/openRouterVideoGenerationWorker.js');

describe('OpenRouter media workers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAdminOpenRouterKey.mockResolvedValue({
      id: 9,
      apiKey: 'test-openrouter-key',
      config: {},
    });
    updateAdminCredentialUsage.mockResolvedValue(undefined);
    createGeminiUsage.mockResolvedValue(undefined);
    loadApprovedBrandLogoReference.mockResolvedValue(null);
    resolveApprovedBrandLogoUrl.mockResolvedValue(null);
    applyBrandLogoToVideo.mockImplementation(async (buffer: Buffer) => ({ buffer }));
    saveBase64File.mockResolvedValue({ url: '/uploads/generated.png', fileName: 'generated.png' });
    saveBufferFile.mockResolvedValue({ url: '/uploads/generated.mp4', fileName: 'generated.mp4', mediaProbe: { width: 720, height: 1280, durationSeconds: 6, codec: 'h264', container: 'mp4' } });
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('sends image generation options and image references to the OpenRouter images API', async () => {
    loadApprovedBrandLogoReference.mockResolvedValue({
      logoUrl: '/uploads/approved-logo.png', base64Data: 'bG9nbw==', mimeType: 'image/png',
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=', media_type: 'image/png' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.02 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const worker = new OpenRouterImageGenerationWorker(undefined, 5, 'bytedance-seed/seedream-test');

    const result = await worker.generateFromImage('Product hero', 'cmVmZXJlbmNl', 'image/png', {
      aspectRatio: '16:9', imageSize: '2K', seed: 12,
    });

    expect(result).toMatchObject({
      success: true,
      imageUrl: '/uploads/generated.png',
      mimeType: 'image/png',
      brandReference: { logoUrl: '/uploads/approved-logo.png', suppliedToModel: true },
    });
    expect(result.branding).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/images', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: 'bytedance-seed/seedream-test', aspect_ratio: '16:9', resolution: '2K', seed: 12,
    });
    expect(body.input_references).toHaveLength(2);
    expect(body.input_references[1].image_url.url).toBe('data:image/png;base64,bG9nbw==');
    expect(body.prompt).toContain('USE APPROVED LOGO REFERENCE');
    expect(saveBase64File).toHaveBeenCalledWith('aW1hZ2U=', 'image/png', 'images', 'generated', undefined);
    expect(createGeminiUsage).toHaveBeenCalledWith(expect.objectContaining({ service: 'openrouter_image_worker' }));
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('preserves provider MIME %s at the storage handoff', async mimeType => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'c3ludGhldGljLWltYWdl', media_type: mimeType }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await new OpenRouterImageGenerationWorker(undefined, undefined, 'synthetic/image-model').generateFromText('Synthetic image');
    expect(result).toMatchObject({ success: true, mimeType });
    expect(saveBase64File).toHaveBeenCalledWith('c3ludGhldGljLWltYWdl', mimeType, 'images', 'generated', undefined);
  });

  it('submits and completes an asynchronous Seedance-style video job with the real logo overlaid afterwards', async () => {
    loadApprovedBrandLogoReference.mockResolvedValue({
      logoUrl: '/uploads/approved-logo.png', base64Data: 'bG9nbw==', mimeType: 'image/png',
    });
    resolveApprovedBrandLogoUrl.mockResolvedValue('/uploads/approved-logo.png');
    applyBrandLogoToVideo.mockResolvedValue({
      buffer: Buffer.from('branded-video'),
      branding: { logoApplied: true, logoUrl: '/uploads/approved-logo.png', position: 'bottom-right' },
    });
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-1', status: 'pending' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'job-1', status: 'completed', unsigned_urls: ['https://cdn.test/video.mp4'], usage: { cost: 0.25 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(Buffer.from('video-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }));
    const worker = new OpenRouterVideoGenerationWorker(undefined, 5, 'bytedance/seedance-test');

    const started = await worker.generateFromText('Product reveal', {
      aspectRatio: '9:16', resolution: '720p', durationSeconds: 8, generateAudio: true, seed: 44,
    });
    const completed = await worker.generateFromText('Product reveal', {
      durationSeconds: 8, resolution: '720p',
    }, started.operationName);

    const encodedModel = Buffer.from('bytedance/seedance-test').toString('base64url');
    expect(started).toMatchObject({
      success: true,
      status: 'pending',
      operationName: `openrouter/${encodedModel}/job-1`,
    });
    expect(started.brandReference).toBeUndefined();
    expect(completed).toMatchObject({
      success: true,
      status: 'completed',
      videoUrl: '/uploads/generated.mp4',
      branding: { logoApplied: true, logoUrl: '/uploads/approved-logo.png', position: 'bottom-right' },
    });
    // The model never receives the logo (it distorts and misspells it); the
    // approved pixels are composited onto the downloaded video before saving.
    expect(applyBrandLogoToVideo).toHaveBeenCalledWith(Buffer.from('video-bytes'), undefined, undefined);
    expect(saveBufferFile.mock.calls[0][0]).toEqual(Buffer.from('branded-video'));
    const submitBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(submitBody).toMatchObject({
      model: 'bytedance/seedance-test', aspect_ratio: '9:16', resolution: '720p', duration: 8,
      generate_audio: true, seed: 44,
    });
    expect(submitBody.input_references).toBeUndefined();
    expect(submitBody.frame_images).toBeUndefined();
    expect(submitBody.prompt).toBe('Product reveal');
    expect(loadApprovedBrandLogoReference).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/videos/job-1');
    expect(fetchMock.mock.calls[2][0]).toBe('https://cdn.test/video.mp4');
    expect(createGeminiUsage).toHaveBeenCalledWith(expect.objectContaining({ service: 'openrouter_video_worker' }));
  });

  it.each([
    ['reference', 'input_references'],
    ['start_frame', 'frame_images'],
  ] as const)('sends an uploaded image with role %s as %s, never both', async (imageRole, field) => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-2', status: 'pending' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const worker = new OpenRouterVideoGenerationWorker(undefined, 5, 'kwaivgi/kling-test');
    const result = await worker.generateFromImage('A chef plating a dish in a busy kitchen', 'aW1n', 'image/png', { imageRole });
    expect(result.success).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body[field]).toHaveLength(1);
    expect(body[field === 'input_references' ? 'frame_images' : 'input_references']).toBeUndefined();
    expect(JSON.stringify(body[field])).toContain('data:image/png;base64,aW1n');
    expect(body.prompt).toBe('A chef plating a dish in a busy kitchen');
  });

  it('keeps the start of a long request instead of dropping it when the negative prompt is added', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-3', status: 'pending' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const worker = new OpenRouterVideoGenerationWorker(undefined, 5, 'kwaivgi/kling-test');
    await worker.generateFromText(`USER REQUEST ${'x'.repeat(5000)}`, { negativePrompt: 'blurry' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.prompt.startsWith('USER REQUEST')).toBe(true);
    expect(body.prompt.endsWith('Avoid: blurry')).toBe(true);
    expect(body.prompt.length).toBeLessThanOrEqual(4000);
  });

  it('marks a missing OpenRouter video job as terminal so clients stop polling it', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Job missing-job not found' },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    const worker = new OpenRouterVideoGenerationWorker(undefined, 5, 'bytedance/seedance-test');
    const encodedModel = Buffer.from('bytedance/seedance-test').toString('base64url');

    await expect(worker.checkStatus(`openrouter/${encodedModel}/missing-job`)).resolves.toEqual({
      done: true,
      operationName: `openrouter/${encodedModel}/missing-job`,
      error: 'Job missing-job not found',
    });
  });

  it('keeps transient OpenRouter status failures retryable', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Provider temporarily unavailable' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    const worker = new OpenRouterVideoGenerationWorker(undefined, 5, 'bytedance/seedance-test');
    const encodedModel = Buffer.from('bytedance/seedance-test').toString('base64url');

    await expect(worker.checkStatus(`openrouter/${encodedModel}/retry-job`)).resolves.toEqual({
      done: false,
      operationName: `openrouter/${encodedModel}/retry-job`,
      error: 'Provider temporarily unavailable',
    });
  });
});
