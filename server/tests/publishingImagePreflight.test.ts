import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';

const actualRemote = await import('../utils/safeRemoteFetch.js');
const remoteFetch = jest.fn<any>();
jest.unstable_mockModule('../utils/safeRemoteFetch', () => ({ ...actualRemote, fetchPublicHttpUrl: remoteFetch }));
let cachedFiles: Array<{ url: string }> = [];
const query: any = { from: () => query, where: () => query, limit: async () => cachedFiles };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => query }, pgPool: undefined }));
const upload = jest.fn<(bytes: Buffer, options: unknown) => Promise<unknown>>();
jest.unstable_mockModule('../services/StorageService', () => ({ StorageService: { getInstance: () => ({ upload }) } }));
const { preflightPublishingImages, validatePublishingImage } = await import('../services/media/PublishingImagePreflight.js');
const image = (format: 'png' | 'jpeg' | 'webp' = 'png', width = 80, height = 100) => sharp({ create: { width, height, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 0.4 } } }).toFormat(format).toBuffer();
const respond = (bytes: Buffer, headers?: Record<string, string>) => remoteFetch.mockResolvedValue({ response: new Response(new Uint8Array(bytes), { headers }), finalUrl: 'https://cdn.example.test/image' });

beforeEach(() => { jest.clearAllMocks(); cachedFiles = []; upload.mockResolvedValue({ url: 'https://cdn.example.test/normalized.jpg' }); });

describe('publishing image preflight with real decoded image bytes', () => {
  it('normalizes transparent PNGs to retained sRGB JPEGs for Instagram and records dimensions', async () => {
    const png = await image(); respond(png);
    const result = await preflightPublishingImages(['https://cdn.example.test/original.png'], 'instagram', 'post', 7);
    expect(result).toMatchObject({ urls: ['https://cdn.example.test/normalized.jpg'], probes: [{ width: 80, height: 100, bytes: png.length, format: 'png' }] });
    expect(upload).toHaveBeenCalledTimes(1);
    const [storedBytes, options] = upload.mock.calls[0];
    const stored = await sharp(storedBytes as Buffer).metadata();
    expect(stored).toMatchObject({ format: 'jpeg', width: 80, height: 100, space: 'srgb', hasAlpha: false });
    expect(options).toMatchObject({ userId: 7, category: 'image', mimeType: 'image/jpeg', metadata: { publishingImageHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });

  it('reuses a previously normalized image without uploading a duplicate', async () => {
    respond(await image()); cachedFiles = [{ url: 'https://cdn.example.test/cached.jpg' }];
    const result = await preflightPublishingImages(['https://cdn.example.test/original.png'], 'instagram', 'post', 7);
    expect(result.urls).toEqual(['https://cdn.example.test/cached.jpg']);
    expect(upload).not.toHaveBeenCalled();
  });

  it('preserves valid JPEG URLs and Facebook PNGs without reupload', async () => {
    respond(await image('jpeg'));
    expect((await preflightPublishingImages(['https://cdn.example.test/photo.jpg'], 'instagram', 'post', 7)).urls).toEqual(['https://cdn.example.test/photo.jpg']);
    respond(await image('png'));
    expect((await preflightPublishingImages(['https://cdn.example.test/photo.png'], 'facebook', 'photo', 7)).urls).toEqual(['https://cdn.example.test/photo.png']);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects portrait feed ratios but allows the same media for Instagram stories', async () => {
    const portrait = await image('jpeg', 90, 160); respond(portrait);
    await expect(preflightPublishingImages(['https://cdn.example.test/portrait.jpg'], 'instagram', 'post', 7)).rejects.toThrow(/aspect ratio/);
    respond(portrait);
    await expect(preflightPublishingImages(['https://cdn.example.test/portrait.jpg'], 'instagram', 'story', 7)).resolves.toMatchObject({ probes: [{ width: 90, height: 160 }] });
  });

  it('validates the displayed aspect ratio after EXIF orientation', async () => {
    const rotated = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#447788' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    respond(rotated);
    await expect(preflightPublishingImages(['https://cdn.example.test/rotated.jpg'], 'instagram', 'post', 7)).rejects.toThrow(/aspect ratio/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects announced oversize data before image decoding', async () => {
    respond(await image('jpeg'), { 'content-length': String(8 * 1024 * 1024 + 1) });
    await expect(preflightPublishingImages(['https://cdn.example.test/large.jpg'], 'instagram', 'post', 7)).rejects.toThrow(/8 MB limit/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('enforces streamed bytes even when the server omits content-length', async () => {
    respond(Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(preflightPublishingImages(['https://cdn.example.test/unbounded.jpg'], 'instagram', 'post', 7)).rejects.toThrow(/8 MB limit/);
  });

  it('rejects corrupt media and actual unsupported formats despite misleading URLs', async () => {
    respond(Buffer.from('<html>not an image</html>'));
    await expect(preflightPublishingImages(['https://cdn.example.test/fake.jpg'], 'instagram', 'post', 7)).rejects.toThrow();
    respond(await image('webp'));
    await expect(preflightPublishingImages(['https://cdn.example.test/fake.jpg'], 'instagram', 'post', 7)).rejects.toThrow(/JPEG or PNG/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('surfaces download and storage errors instead of sending an unusable provider URL', async () => {
    remoteFetch.mockResolvedValue({ response: new Response('', { status: 404 }) });
    await expect(preflightPublishingImages(['https://cdn.example.test/missing.jpg'], 'instagram', 'post', 7)).rejects.toThrow(/HTTP 404/);
    respond(await image()); upload.mockResolvedValue({});
    await expect(preflightPublishingImages(['https://cdn.example.test/photo.png'], 'instagram', 'post', 7)).rejects.toThrow(/could not be stored/);
  });

  it('enforces platform byte and pixel bounds at the validation boundary', () => {
    expect(() => validatePublishingImage({ width: 1000, height: 1000, bytes: 8 * 1024 * 1024 + 1, format: 'jpeg' }, 'instagram', 'post')).toThrow(/file size/);
    expect(() => validatePublishingImage({ width: 1000, height: 1000, bytes: 9 * 1024 * 1024, format: 'jpeg' }, 'facebook', 'photo')).not.toThrow();
    expect(() => validatePublishingImage({ width: 10000, height: 10000, bytes: 1024, format: 'jpeg' }, 'facebook', 'photo')).toThrow(/40 megapixels/);
  });
});
