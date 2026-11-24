import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real disposable local object backend; the storage governance service is the
// mocked ownership boundary. This does not certify quotas, RLS, S3 or MinIO.
const upload = jest.fn<any>();
const uploadBase64 = jest.fn<any>();
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: {
  getInstance: () => ({ upload, uploadBase64 }),
} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

describe('generated-media storage handoff to disposable object bytes', () => {
  let root: string;
  let storage: typeof import('../services/ObjectStorageService.js').objectStorage;
  let files: typeof import('../utils/fileStorage.js');
  let originalImagesPath: string;
  const originalEnv = Object.fromEntries(['STORAGE_BACKEND', 'LOCAL_STORAGE_PATH', 'LOCAL_STORAGE_URL'].map(key => [key, process.env[key]]));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-object-audit-'));
    process.env.STORAGE_BACKEND = 'local';
    process.env.LOCAL_STORAGE_PATH = path.join(root, 'objects');
    process.env.LOCAL_STORAGE_URL = '/synthetic-objects';
    storage = (await import('../services/ObjectStorageService.js')).objectStorage;
    files = await import('../utils/fileStorage.js');
    originalImagesPath = files.UPLOAD_PATHS.images;
    files.UPLOAD_PATHS.images = path.join(root, 'fallback');
    upload.mockImplementation(async (buffer: Buffer, options: { userId: number; category: string; originalName: string; mimeType: string }) => {
      const storageKey = `${options.userId}/${options.category}/${options.originalName}`;
      return { storageKey, fileName: options.originalName, url: await storage.upload(storageKey, buffer, options.mimeType) };
    });
    uploadBase64.mockImplementation((data: string, _mime: string, options: unknown) => upload(Buffer.from(data, 'base64'), options));
  });
  afterAll(async () => {
    if (files) files.UPLOAD_PATHS.images = originalImagesPath;
    if (root) await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  it('hands buffer bytes, owner, MIME and image category to storage and reloads exact bytes', async () => {
    const saved = await files.saveBufferFile(bytes, 'synthetic.png', 'images', 'generated', 7);
    expect(saved.filePath).toMatch(/^7\/image\/generated-/);
    expect(saved.url).toContain('/synthetic-objects/7/image/');
    expect(await storage.download(saved.filePath)).toEqual(bytes);
    expect(upload).toHaveBeenCalledWith(bytes, expect.objectContaining({ userId: 7, category: 'image', mimeType: 'image/png' }));
  });
  it('hands base64 provider bytes through the same durable storage contract', async () => {
    const saved = await files.saveBase64File(bytes.toString('base64'), 'image/png', 'images', 'generated', 7);
    expect(await storage.download(saved.filePath)).toEqual(bytes);
    expect(uploadBase64).toHaveBeenCalled();
  });
  // Historical rejection-to-disk reproduction is preserved in the audit
  // evidence, not asserted as desired behavior. Tenant owns that correction
  // in 7b54373d; paired producer verification lives in the opt-in suite.
});
