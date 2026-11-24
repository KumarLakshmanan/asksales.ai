import { describe, expect, it } from '@jest/globals';
import { buildBrandReferencePrompt, primaryBrandLogoUrl } from '../services/content/BrandMediaComposer.js';

describe('BrandMediaComposer', () => {
  it('instructs media providers to analyze and integrate the approved logo before generation', () => {
    const imagePrompt = buildBrandReferencePrompt('Create a launch ad.', 'image');
    const videoPrompt = buildBrandReferencePrompt('Create a launch film.', 'video');

    expect(imagePrompt).toContain('final attached input image is the approved brand logo asset');
    expect(videoPrompt).toContain('attached visual reference is the approved brand logo asset');
    expect(imagePrompt).toContain('Analyze the supplied logo before generating');
    expect(imagePrompt).toContain('integrate the approved logo naturally and legibly');
    expect(imagePrompt).toContain('Preserve the exact spelling and wording in the supplied mark');
    expect(imagePrompt).toContain('do not prepend or append initials, descriptors, taglines, or other text');
    expect(videoPrompt).toContain('no logo overlay or post-generation compositor will be applied');
    expect(imagePrompt).not.toContain('bottom-right');
  });

  it('keeps long logo-reference prompts within the media provider limit', () => {
    const longPrompt = 'Approved brand and business context. '.repeat(300);

    const imagePrompt = buildBrandReferencePrompt(longPrompt, 'image');
    const videoPrompt = buildBrandReferencePrompt(longPrompt, 'video');

    expect(imagePrompt.length).toBeLessThanOrEqual(4_000);
    expect(videoPrompt.length).toBeLessThanOrEqual(4_000);
    expect(imagePrompt).toContain('final attached input image is the approved brand logo asset');
    expect(videoPrompt).toContain('attached visual reference is the approved brand logo asset');
    expect(videoPrompt).toContain('no logo overlay or post-generation compositor will be applied');
  });

  it('uses the explicit primary logo before legacy logo history', () => {
    expect(primaryBrandLogoUrl({
      logoUrl: '/uploads/current-logo.png',
      logoUrls: ['/uploads/old-logo.png', '/uploads/current-logo.png'],
    })).toBe('/uploads/current-logo.png');
    expect(primaryBrandLogoUrl({ logoUrls: ['', '/uploads/fallback-logo.png'] }))
      .toBe('/uploads/fallback-logo.png');
  });
});
