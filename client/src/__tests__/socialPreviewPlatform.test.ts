import { describe, expect, it } from 'vitest';
import { socialPreviewPlatform } from '@/lib/social-preview-platform';
describe('saved social post preview channel', () => {
  it('uses the saved channel rather than hard-coding Instagram', () => {
    expect(socialPreviewPlatform(null, 'linkedin')).toBe('linkedin');
    expect(socialPreviewPlatform(null, 'facebook')).toBe('facebook');
    expect(socialPreviewPlatform(null, 'instagram')).toBe('instagram');
  });
  it('preserves an explicit cross-platform preview choice', () => {
    expect(socialPreviewPlatform('twitter', 'linkedin')).toBe('twitter');
  });
  it('provides a supported preview for universal or unknown channels', () => {
    expect(socialPreviewPlatform(null, 'all')).toBe('linkedin');
    expect(socialPreviewPlatform(null, 'unknown')).toBe('linkedin');
  });
});
