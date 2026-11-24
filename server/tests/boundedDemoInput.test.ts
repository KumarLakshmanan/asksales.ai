import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';
import { extractBoundedPdf, prepareDemoInput } from '../utils/boundedDemoInput.js';
import { normalizeSupportImage } from '../utils/boundedImageNormalization.js';

describe('untrusted demo and image parsing', () => {
  it('rejects unsupported, forged, empty, and oversized input before providers', async () => {
    await expect(prepareDemoInput(Buffer.from('<svg onload=alert(1)>'), 'image/png')).rejects.toThrow('genuine');
    await expect(prepareDemoInput(Buffer.alloc(0), 'application/pdf')).rejects.toThrow('5 MiB');
    await expect(prepareDemoInput(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/jpeg')).rejects.toThrow('5 MiB');
    await expect(extractBoundedPdf(Buffer.from('not a PDF'))).rejects.toThrow('Invalid');
  });
  it('normalizes real screenshots in an isolated image worker', async () => {
    const image = await sharp({ create: { width: 10, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
    const normalized = await normalizeSupportImage(image);
    expect(normalized).toMatchObject({ width: 10, height: 8 });
    expect((await sharp(normalized.normalized).metadata()).format).toBe('jpeg');
    const demo = await prepareDemoInput(image, 'image/png');
    expect(demo.text).toBe('');
    expect((await sharp(demo.image).metadata()).format).toBe('jpeg');
  });
  it('rejects malformed PDFs in the disposable parser process', async () => {
    await expect(extractBoundedPdf(Buffer.from('%PDF-1.7\nmalformed harmless fixture'))).rejects.toThrow('PDF parsing failed');
  });
});
