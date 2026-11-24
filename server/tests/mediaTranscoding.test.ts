import { MAX_DURATION_SECONDS, MAX_MEDIA_BYTES, validateMediaForPlatform, withVideoProbeMetadata } from '../services/media/MediaTranscodingService.js';

describe('media publishing preflight', () => {
  const validProbe = { durationSeconds: 15, width: 1080, height: 1920, codec: 'h264', container: 'mov,mp4,m4a,3gp,3g2,mj2' };

  it('accepts a bounded trusted probe for Instagram', () => {
    expect(validateMediaForPlatform(validProbe, 'instagram')).toEqual([]);
  });

  it('rejects unsafe duration and platform-specific limits', () => {
    expect(validateMediaForPlatform({ ...validProbe, durationSeconds: MAX_DURATION_SECONDS + 1 }, 'youtube')).toContain('Media duration is outside the permitted range');
    expect(validateMediaForPlatform({ ...validProbe, durationSeconds: 91 }, 'whatsapp')).toContain('WhatsApp video is limited to 90 seconds by this publishing profile.');
  });

  it('documents the strict upload cap', () => {
    expect(MAX_MEDIA_BYTES).toBe(100 * 1024 * 1024);
  });
  it('binds trusted video probes to each saved URL without overwriting earlier video probes', () => {
    const first = withVideoProbeMetadata('/uploads/first.mp4', validProbe, { note: 'kept' });
    const secondProbe = { ...validProbe, durationSeconds: 8 };
    const metadata = withVideoProbeMetadata('/uploads/second.mp4', secondProbe, first);
    expect(metadata).toEqual(expect.objectContaining({ note: 'kept', mediaProbeUrl: '/uploads/second.mp4', mediaProbes: {
      '/uploads/first.mp4': validProbe, '/uploads/second.mp4': secondProbe,
    } }));
    expect(withVideoProbeMetadata(undefined, validProbe, first)).toBe(first);
  });
});
