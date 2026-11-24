import { GOOGLE_VIDEO_CAPABILITIES, prepareVideoSettings, validateVideoSettings } from '../../shared/videoSettings.js';

describe('video provider settings', () => {
  it('prepares supported settings for the failed QA input before review', () => {
    const proposed = prepareVideoSettings({ resolution: '480p', duration_seconds: 5, number_of_videos: 4 }, GOOGLE_VIDEO_CAPABILITIES, true);
    expect(proposed).toMatchObject({ resolution: '720p', duration_seconds: 8, number_of_videos: 1 });
    expect(validateVideoSettings(proposed, GOOGLE_VIDEO_CAPABILITIES, true)).toBeUndefined();
  });
  it('keeps the configured provider capabilities instead of assuming Google', () => {
    const capabilities = { resolutions: ['480p', '720p'], durations: [5, 10], aspectRatios: ['1:1', '16:9'], maxOutputs: 1 };
    const values = { resolution: '480p', duration_seconds: 5, aspect_ratio: '1:1' };
    expect(prepareVideoSettings(values, capabilities)).toMatchObject(values);
    expect(validateVideoSettings(values, capabilities)).toBeUndefined();
  });
  it.each([{ resolution: '480p' }, { duration_seconds: 5 }, { aspect_ratio: '1:1' }, { number_of_videos: 4 }])('rejects unsupported reviewed settings: %j', values => {
    expect(validateVideoSettings(values, GOOGLE_VIDEO_CAPABILITIES, true)).toBeDefined();
  });
  it('enforces duration for 1080p before provider execution', () => {
    expect(validateVideoSettings({ resolution: '1080p', duration_seconds: 6 }, GOOGLE_VIDEO_CAPABILITIES, true)).toContain('8-second');
    expect(prepareVideoSettings({ resolution: '1080p', duration_seconds: 6 }, GOOGLE_VIDEO_CAPABILITIES, true).duration_seconds).toBe(8);
  });
});
