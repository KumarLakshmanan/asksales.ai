import { describe, expect, it } from '@jest/globals';
import { contentOutputSchemas } from '../services/content/ContentComplianceService.js';
import {
  enforceAdPlatformCopyLimits,
  enforceReviewedAdConstraints,
  normalizeGeneratedAds,
} from '../mastra/tools/executors/adsExecutor.js';

const defaults = {
  headline: 'Approved fallback headline',
  primaryText: 'Approved fallback copy',
  description: 'Approved fallback description',
  callToAction: 'book now',
  displayUrl: 'https://example.com',
};

describe('ad provider response normalization', () => {
  it('accepts valid text-only ad copy without a fabricated image prompt', () => {
    expect(contentOutputSchemas.ad.safeParse({ ...defaults }).success).toBe(true);
  });
  it('reserves space for the exact CTA without duplicating it or changing the platform button', () => {
    const cta = 'Ask for a workflow review.';
    const ad = enforceReviewedAdConstraints({ primaryText: `${'Neutral detail. '.repeat(30)}${cta} ${cta}`, callToAction: 'LEARN_MORE' }, { platform: 'google', cta_text: cta });
    expect(ad.primaryText.length).toBeLessThanOrEqual(90);
    expect(ad.primaryText.endsWith(cta)).toBe(true);
    expect(ad.primaryText.split(cta)).toHaveLength(2);
    expect(ad.callToAction).toBe('LEARN_MORE');
  });
  it('rejects an impossible exact CTA instead of silently shortening it', () => {
    expect(() => enforceReviewedAdConstraints({ primaryText: 'Body' }, { platform: 'google', cta_text: 'x'.repeat(91) })).toThrow('exact CTA exceeds');
  });
  it('removes unrequested media prompts including provider aliases', () => {
    const ad = enforceReviewedAdConstraints({ primaryText: 'Body', imagePrompt: 'image', image_prompts: ['image'], videoPrompt: 'video', video_prompts: ['video'] }, { platform: 'meta', auto_generate_image: false, auto_generate_video: false });
    expect(Object.keys(ad).some(key => /(?:image|video).*prompt/i.test(key))).toBe(false);
  });
  it('preserves explicitly requested media prompts', () => {
    expect(enforceReviewedAdConstraints({ imagePrompt: 'image', videoPrompt: 'video' }, { platform: 'meta', include_image_prompt: true, auto_generate_video: true })).toEqual(expect.objectContaining({ imagePrompt: 'image', videoPrompt: 'video' }));
  });
  it('unwraps provider-specific creative objects and normalizes aliases', () => {
    const [ad] = normalizeGeneratedAds({
      meta_ad: {
        title: 'Luxury weekends near Bangalore',
        primary_copy: 'Recharge in nature.',
        body: 'A private weekend retreat.',
        cta: 'Book Now',
      },
    }, defaults);

    expect(ad.headline).toBe('Luxury weekends near Bangalore');
    expect(ad.primaryText).toBe('Recharge in nature.');
    expect(ad.description).toBe('A private weekend retreat.');
    expect(ad.callToAction).toBe('Book Now');
    expect(ad.displayUrl).toBe('https://example.com');
  });

  it('uses the approved review-card copy when a provider returns an empty wrapper', () => {
    const [ad] = normalizeGeneratedAds({ result: {} }, defaults);

    expect(ad).toEqual(expect.objectContaining(defaults));
  });

  it('preserves the reviewed CTA when a repaired provider response omits it', () => {
    const [ad] = normalizeGeneratedAds({
      result: {
        headline: 'Luxury retreat this weekend',
        primary_text: 'Escape Bangalore for a restorative stay.',
        description: 'Reserve your retreat.',
      },
    }, defaults);

    expect(ad.callToAction).toBe('book now');
    expect(ad.displayUrl).toBe('https://example.com');
  });

  it('deterministically enforces Meta copy limits after provider normalization', () => {
    const ad = enforceAdPlatformCopyLimits({
      headline: 'Experience unmatched luxury at an exclusive ORO weekend retreat',
      description: 'A restorative luxury escape from Bangalore for discerning travelers.',
      primaryText: 'Short primary text.',
    }, 'meta');

    expect(ad.headline.length).toBeLessThanOrEqual(40);
    expect(ad.description.length).toBeLessThanOrEqual(30);
    expect(ad.primaryText).toBe('Short primary text.');
  });

  it('deterministically enforces Google headline and description limits', () => {
    const ad = enforceAdPlatformCopyLimits({
      headline: 'Luxury Weekend Retreats in Bangalore',
      description: 'Discover a carefully curated ORO weekend escape for Bangalore professionals who value privacy and comfort.',
      primaryText: 'Discover a carefully curated ORO weekend escape for Bangalore professionals who value privacy and comfort.',
    }, 'google');

    expect(ad.headline.length).toBeLessThanOrEqual(30);
    expect(ad.description.length).toBeLessThanOrEqual(90);
    expect(ad.primaryText.length).toBeLessThanOrEqual(90);
  });
});
