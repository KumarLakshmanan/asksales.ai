import { describe, expect, it, vi } from 'vitest';
import { galleryUploadBatches, uploadGalleryFiles } from '../lib/support-media-upload';
const image = (name: string, bytes = 1) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
describe('gallery upload requests', () => {
  it('keeps fifty-image selections within request file-count and byte limits', () => {
    const file = image('fixture.png', 5 * 1024 * 1024);
    const files = Array.from({ length: 50 }, () => file);
    const batches = galleryUploadBatches(files);
    expect(batches.flatMap(batch => batch.files)).toHaveLength(50);
    expect(batches.every(batch => batch.files.length <= 5 && batch.files.reduce((sum, file) => sum + file.size, 0) <= 20 * 1024 * 1024)).toBe(true);
  });
  it('rejects oversized and unsupported images before creating upload requests', () => {
    expect(() => galleryUploadBatches([image('large.png', 5 * 1024 * 1024 + 1)])).toThrow('5 MB');
    expect(() => galleryUploadBatches([new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' })])).toThrow('JPEG');
  });
  it('keeps retry indices and metadata aligned across sequential requests', async () => {
    const files = Array.from({ length: 6 }, (_, index) => image(`${index}.png`));
    const send = vi.fn().mockResolvedValueOnce({ outcomes: [{ index: 4, status: 'uploaded' }] })
      .mockResolvedValueOnce({ outcomes: [{ index: 0, status: 'failed', error: 'retry' }] });
    const result = await uploadGalleryFiles(files, files.map(file => ({ name: file.name })), send);
    expect(result.outcomes?.map(outcome => outcome.index)).toEqual([4, 5]);
    expect(JSON.parse(send.mock.calls[1][0].get('metadata'))).toEqual([{ name: '5.png' }]);
  });
});
