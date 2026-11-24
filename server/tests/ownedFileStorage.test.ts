/** Regression; both storage backend and filesystem are mocked, so no objects/files are written. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const upload = jest.fn(async () => { throw Object.assign(new Error('File storage limit reached'), { code: 'PLAN_LIMIT_EXCEEDED', status: 403 }); });
const uploadBase64 = jest.fn(async () => { throw Object.assign(new Error('File storage limit reached'), { code: 'PLAN_LIMIT_EXCEEDED', status: 403 }); });
const mkdir = jest.fn(async () => undefined);
const writeFile = jest.fn(async () => undefined);
jest.unstable_mockModule('../services/StorageService.js', () => ({
  StorageService: { getInstance: () => ({ upload, uploadBase64 }) },
}));
jest.unstable_mockModule('fs/promises', () => ({ default: { mkdir, writeFile } }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
const { saveBase64File, saveBufferFile } = await import('../utils/fileStorage.js');

describe('owned storage failures remain failures', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it.each(['quota', 'backend'])('never writes an untracked image after %s failure', async kind => {
    uploadBase64.mockRejectedValueOnce(Object.assign(new Error(kind), { code: kind === 'quota' ? 'PLAN_LIMIT_EXCEEDED' : 'STORAGE_UNAVAILABLE' }));
    await expect(saveBase64File(Buffer.from('synthetic').toString('base64'), 'image/png', 'images', 'test', 901)).rejects.toThrow(kind);
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('propagates owned buffer quota rejection', async () => {
    await expect(saveBufferFile(Buffer.from('synthetic'), 'test.png', 'images', 'test', 901)).rejects.toMatchObject({code:'PLAN_LIMIT_EXCEEDED'});
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('keeps unowned temporary buffer support', async () => {
    const result=await saveBufferFile(Buffer.from('temporary'), 'test.png', 'images', 'test');
    expect(result.url).toMatch(/^\/uploads\/images\/test-/);
    expect(upload).not.toHaveBeenCalled(); expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
