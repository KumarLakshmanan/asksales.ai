import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Requires the real shared helper from Tenant 7b54373d to be integrated.
// Provider/StorageService boundaries are mocked; the Content agent, image
// worker, fileStorage helper and disposable filesystem bytes are real.
const paired = process.env.STUDIO_TENANT_STORAGE_QA === '1' ? describe : describe.skip;
const uploadBase64 = jest.fn<any>();
let worker: unknown;
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: { getInstance: () => ({ uploadBase64 }) } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: {} }));
jest.unstable_mockModule('../services/media/MediaGenerationWorkerFactory', () => ({ createImageGenerationWorker: () => worker, createVideoGenerationWorker: jest.fn() }));
jest.unstable_mockModule('../services/adminCredentialsService.js', () => ({
  getAdminOpenRouterKey: async () => ({ id: 0, apiKey: 'synthetic-no-network', config: {} }), updateAdminCredentialUsage: async () => {},
}));
jest.unstable_mockModule('../services/insights/PricingService.js', () => ({ assertMediaPrice: async () => {} }));
jest.unstable_mockModule('../models/geminiUsages/functions.js', () => ({ createGeminiUsage: async () => ({ id: 1 }) }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({ getImageMarginPercentage: async () => 0 }));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({ getRechargeRate: async () => 1, getUsageRate: async () => 1 }));
jest.unstable_mockModule('../utils/currency.js', () => ({ getUsdToInrRate: () => 1, meteredCreditsFromUsd: (usd: number, rate: number) => (usd > 0 ? Math.max(1, Math.ceil(usd * 1 * rate - 1e-9)) : 0) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/content/BrandMediaComposer.js', () => ({ loadApprovedBrandLogoReference: async () => null, buildBrandReferencePrompt: (value: string) => value }));
const { OpenRouterImageGenerationWorker } = await import('../tools/openRouterImageGenerationWorker.js');
const { ContentStudioAgent } = await import('../services/agents/ContentStudioAgent');

paired('Content producer with Tenant-owned tracked storage enforcement', () => {
  let root: string;
  let files: typeof import('../utils/fileStorage.js');
  let originalImages: string;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const agent = new ContentStudioAgent();
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-tenant-producer-'));
    files = await import('../utils/fileStorage.js');
    originalImages = files.UPLOAD_PATHS.images;
    files.UPLOAD_PATHS.images = path.join(root, 'fallback');
  });
  beforeEach(async () => {
    await rm(path.join(root, 'objects'), { recursive: true, force: true });
    await rm(path.join(root, 'fallback'), { recursive: true, force: true });
    uploadBase64.mockReset();
    uploadBase64.mockImplementation(async (data: string) => {
      await mkdir(path.join(root, 'objects'), { recursive: true });
      await writeFile(path.join(root, 'objects', 'image.png'), Buffer.from(data, 'base64'));
      return { storageKey: '7/image/image.png', fileName: 'image.png', url: '/synthetic-content/7/image/image.png' };
    });
    worker = new OpenRouterImageGenerationWorker(7, undefined, 'synthetic/image');
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64'), media_type: 'image/png' }], usage: { cost: 0 } }), { status: 200 }));
  });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { if (files) files.UPLOAD_PATHS.images = originalImages; if (root) await rm(root, { recursive: true, force: true }); });

  it('keeps the accepted provider image on the tracked handoff and preserves exact bytes', async () => {
    expect(await agent.generateImage('Synthetic image', undefined, 7)).toMatchObject({ success: true, imageUrl: '/synthetic-content/7/image/image.png' });
    expect(await readFile(path.join(root, 'objects', 'image.png'))).toEqual(bytes);
    expect(uploadBase64).toHaveBeenCalledWith(bytes.toString('base64'), 'image/png', expect.objectContaining({ userId: 7 }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { code: 'PLAN_LIMIT_EXCEEDED', message: 'Synthetic quota rejection' },
    { code: 'STORAGE_UNAVAILABLE', message: 'Synthetic owned backend outage' },
  ])('propagates $code through the real worker and Content agent without another write or submission', async ({ code, message }) => {
    uploadBase64.mockRejectedValueOnce(Object.assign(new Error(message), { code, status: 403 }));
    const result = await agent.generateImage('Synthetic image', undefined, 7);
    expect(result).toMatchObject({ success: false, error: message });
    expect(result.imageUrl).toBeUndefined();
    expect(result.imageData).toBeUndefined();
    expect(await readdir(root, { recursive: true })).toEqual([]);
    expect(uploadBase64).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
