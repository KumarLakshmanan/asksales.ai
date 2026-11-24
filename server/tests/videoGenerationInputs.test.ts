import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';

const resolveApprovedBrandLogoUrl = jest.fn<any>();
const downloadByUrl = jest.fn<any>();
const resolveSelection = jest.fn<any>();
const googleGenerate = jest.fn<any>();

jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/content/BrandMediaComposer.js', () => ({ resolveApprovedBrandLogoUrl }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: { getInstance: () => ({ downloadByUrl }) } }));
jest.unstable_mockModule('../services/media/VideoReviewPolicy.js', () => ({ assertValidVideoReview: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../services/media/MediaProviderRegistry.js', () => ({
  resolveMediaProviderSelection: resolveSelection,
  resolveImageAuthenticationFallback: jest.fn(),
  getImageModelCapabilities: jest.fn(),
}));
jest.unstable_mockModule('../tools/imageGenerationWorker.js', () => ({ ImageGenerationWorker: class {} }));
jest.unstable_mockModule('../tools/openRouterImageGenerationWorker.js', () => ({ OpenRouterImageGenerationWorker: class {} }));
jest.unstable_mockModule('../tools/openRouterVideoGenerationWorker.js', () => ({ OpenRouterVideoGenerationWorker: class {} }));
jest.unstable_mockModule('../tools/videoGenerationWorker.js', () => ({
  VideoGenerationWorker: class { generate = googleGenerate; },
}));

const {
  prepareVideoInputImage, frameSizeForAspectRatio, friendlyVideoProviderError, VideoInputImageError,
} = await import('../services/media/VideoInputImage.js');
const {
  buildVideoBrandPrompt, adaptBrandContextForVideo, brandNamesFromContext, overlayLogoOnVideo, applyBrandLogoToVideo,
} = await import('../services/media/BrandVideoOverlay.js');
const { createVideoGenerationWorker } = await import('../services/media/MediaGenerationWorkerFactory.js');

async function png(width: number, height: number, color = { r: 20, g: 120, b: 220 }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

function ffmpegAvailable() {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('video input image preparation (provider minimum resolution)', () => {
  it('enlarges and pads the 146×50 logo that failed with HTTP 400 into a 720 px reference', async () => {
    const logo = (await png(146, 50)).toString('base64');
    const prepared = await prepareVideoInputImage({ base64Data: logo, mimeType: 'image/png' }, { role: 'reference' });
    expect(prepared.adjusted).toBe(true);
    expect(prepared.original).toEqual({ width: 146, height: 50 });
    expect(Math.min(prepared.width, prepared.height)).toBeGreaterThanOrEqual(720);
    const meta = await sharp(Buffer.from(prepared.base64Data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([prepared.width, prepared.height]);
    expect(prepared.mimeType).toBe('image/png');
  });

  it('fits a start frame to the requested aspect ratio', async () => {
    const image = (await png(146, 50)).toString('base64');
    const portrait = await prepareVideoInputImage({ base64Data: image, mimeType: 'image/png' }, { role: 'start_frame', aspectRatio: '9:16' });
    expect([portrait.width, portrait.height]).toEqual([720, 1280]);
    const meta = await sharp(Buffer.from(portrait.base64Data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([720, 1280]);
  });

  it('passes a large reference image through unchanged', async () => {
    const image = (await png(1920, 1080)).toString('base64');
    const prepared = await prepareVideoInputImage({ base64Data: image, mimeType: 'image/png' }, { role: 'reference' });
    expect(prepared.adjusted).toBe(false);
    expect(prepared.base64Data).toBe(image);
  });

  it('rejects unusable images with a clear message instead of a provider 400', async () => {
    const tiny = (await png(10, 10)).toString('base64');
    await expect(prepareVideoInputImage({ base64Data: tiny, mimeType: 'image/png' }, { role: 'reference' }))
      .rejects.toThrow(/only 10×10 px/);
    await expect(prepareVideoInputImage({ base64Data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png' }, { role: 'reference' }))
      .rejects.toBeInstanceOf(VideoInputImageError);
  });

  it('computes encoder-safe frame sizes', () => {
    expect(frameSizeForAspectRatio('16:9')).toEqual({ width: 1280, height: 720 });
    expect(frameSizeForAspectRatio('1:1')).toEqual({ width: 720, height: 720 });
    expect(frameSizeForAspectRatio(undefined)).toEqual({ width: 1280, height: 720 });
  });

  it('turns raw provider size rejections into an actionable message', () => {
    expect(friendlyVideoProviderError('HTTP 400: input image resolution is below the minimum of 300 px')).toMatch(/at least 720 px/);
    expect(friendlyVideoProviderError('Quota exceeded')).toBe('Quota exceeded');
  });
});

describe('video brand prompt (logo and brand spelling)', () => {
  const context = `<approved_media_brand_context>
- Business: Todle AI
- Brand: Todle
- Logo handling: the approved logo image is attached to the media-generation request as a visual asset reference. Integrate it naturally.
</approved_media_brand_context>`;

  it('keeps the user request first and tells the model not to draw the logo', () => {
    const prompt = buildVideoBrandPrompt(`Show a teacher using a tablet in class\n\n${adaptBrandContextForVideo(context, true)}`, {
      logoOverlay: true, brandNames: brandNamesFromContext(context), imageRole: 'reference',
    });
    expect(prompt.startsWith('Show a teacher using a tablet in class')).toBe(true);
    expect(prompt).toContain('Do not draw, recreate or animate any logo');
    expect(prompt).toContain('"Todle AI", "Todle"');
    expect(prompt).toContain('letter for letter');
    expect(prompt).toContain('do not simply animate the reference image');
    expect(prompt).not.toContain('attached to the media-generation request');
  });

  it('bounds the prompt to 4,000 characters by trimming trailing context, not the request', () => {
    const prompt = buildVideoBrandPrompt(`REQUEST ${'y'.repeat(6000)}`, { logoOverlay: false, imageRole: 'start_frame' });
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt.startsWith('REQUEST')).toBe(true);
    expect(prompt).toContain('only the opening frame');
  });

  it('extracts brand names and ignores empty fields', () => {
    expect(brandNamesFromContext('- Business: \n- Brand: Todle\n- Business description: x')).toEqual(['Todle']);
  });
});

describe('video provider factory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveSelection.mockResolvedValue({ provider: 'google', model: 'veo-3.1-fast-generate-001' });
    resolveApprovedBrandLogoUrl.mockResolvedValue('/uploads/logo.png');
    googleGenerate.mockResolvedValue({ success: true, status: 'pending', operationName: 'op-1' });
  });

  it('normalizes a small image, keeps the role and adds brand rules before calling the provider', async () => {
    const logo = (await png(146, 50)).toString('base64');
    const worker = createVideoGenerationWorker(7);
    const result = await worker.generate({ prompt: 'A product launch on stage', image: { base64Data: logo, mimeType: 'image/png' }, videoConfig: { aspectRatio: '16:9' } });
    expect(result).toMatchObject({ success: true, provider: 'google' });
    const sent = googleGenerate.mock.calls[0][0] as any;
    expect(sent.videoConfig.imageRole).toBe('reference');
    expect(Math.min(...await sharp(Buffer.from(sent.image.base64Data, 'base64')).metadata().then((m) => [m.width!, m.height!]))).toBeGreaterThanOrEqual(720);
    expect(sent.prompt.startsWith('A product launch on stage')).toBe(true);
    expect(sent.prompt).toContain('approved logo is added to the finished video afterwards');
  });

  it('returns a clear failure for an unusable image without calling the provider', async () => {
    const worker = createVideoGenerationWorker(7);
    const result = await worker.generate({ prompt: 'x', image: { base64Data: (await png(8, 8)).toString('base64'), mimeType: 'image/png' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only 8×8 px/);
    expect(googleGenerate).not.toHaveBeenCalled();
  });

  it('passes polling requests through untouched', async () => {
    const worker = createVideoGenerationWorker(7, undefined, { provider: 'google', model: 'veo-3.1-fast-generate-001' });
    await worker.generate({ prompt: 'raw', operationName: 'projects/p/locations/l/publishers/google/models/m/operations/1' });
    expect((googleGenerate.mock.calls[0][0] as any).prompt).toBe('raw');
  });
});

const describeFfmpeg = ffmpegAvailable() ? describe : describe.skip;
describeFfmpeg('logo overlay on a real video', () => {
  it('composites the approved logo pixels into the bottom-right corner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'overlay-test-'));
    try {
      const source = join(directory, 'source.mp4');
      execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', source]);
      const logo = await png(146, 50, { r: 255, g: 0, b: 0 });
      const output = await overlayLogoOnVideo(readFileSync(source), logo);
      const framePath = join(directory, 'frame.png');
      execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', '-', '-frames:v', '1', framePath], { input: output });
      const { data, info } = await sharp(framePath).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
      const [r, g, b] = pixel(info.width - 60, info.height - 40);
      expect(r).toBeGreaterThan(150); expect(g).toBeLessThan(90); expect(b).toBeLessThan(90);
      expect(pixel(20, 20).every((value) => value < 40)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps the unbranded video when the logo cannot be loaded', async () => {
    resolveApprovedBrandLogoUrl.mockResolvedValue('/uploads/missing.png');
    downloadByUrl.mockResolvedValue(null);
    const video = Buffer.from('video');
    expect(await applyBrandLogoToVideo(video, 7, undefined)).toEqual({ buffer: video });
  });
});
