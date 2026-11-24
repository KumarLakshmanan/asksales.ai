import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const upload = jest.fn<any>();
const transcode = jest.fn<any>();
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: { getInstance: () => ({ upload }) } }));
jest.unstable_mockModule('../services/media/MediaTranscodingService.js', () => ({ transcodeMedia: transcode }));
const { saveBufferFile } = await import('../utils/fileStorage.js');

describe('generated video durable storage probe boundary (no providers or disk writes)', () => {
  const probe = { width: 720, height: 1280, durationSeconds: 6, codec: 'h264', container: 'mp4' };
  beforeEach(() => {
    jest.clearAllMocks();
    transcode.mockResolvedValue({ output: Buffer.from('normalized fixture bytes'), probe });
    upload.mockResolvedValue({ storageKey: 'fixture', fileName: 'fixture.mp4', url: '/uploads/fixture.mp4' });
  });
  it('stores the normalized bytes and carries their trusted probe with the result', async () => {
    const source = Buffer.from('provider fixture bytes');
    const result = await saveBufferFile(source, 'provider.webm', 'videos', 'generated', 991);
    expect(transcode).toHaveBeenCalledWith(source, 'youtube');
    expect(upload).toHaveBeenCalledWith(Buffer.from('normalized fixture bytes'), expect.objectContaining({ mimeType: 'video/mp4', metadata: { mediaProbe: probe } }));
    expect(result).toEqual(expect.objectContaining({ url: '/uploads/fixture.mp4', mediaProbe: probe }));
  });
  it('cannot claim storage success for video bytes that failed normalization', async () => {
    transcode.mockRejectedValue(new Error('Invalid media bytes'));
    await expect(saveBufferFile(Buffer.from('bad'), 'bad.mp4', 'videos', 'generated', 991)).rejects.toThrow('Invalid media bytes');
    expect(upload).not.toHaveBeenCalled();
  });
  it('does not transcode unrelated image assets', async () => {
    const bytes = Buffer.from('image fixture');
    await saveBufferFile(bytes, 'image.png', 'images', 'generated', 991);
    expect(transcode).not.toHaveBeenCalled();
    expect(upload.mock.calls[0][0]).toBe(bytes);
  });
});
