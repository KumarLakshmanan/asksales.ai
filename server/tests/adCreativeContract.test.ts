import {
  formatAdPlatformCopyConstraints,
  getAdPlatformCopyLimits,
  reviewedAdImagePrompts,
} from '../mastra/tools/executors/adsExecutor.js';
import { adCreativeInputSchema } from '../mastra/tools/adsTools.js';

describe('ad creative platform contract', () => {
  it('retains the selected image style through canonical review validation', () => {
    const input = adCreativeInputSchema.parse({ platform: 'meta', image_style: 'illustration', image_count: 1 });
    expect(input.image_style).toBe('illustration');
    expect(reviewedAdImagePrompts(['A quiet hillscape', 'An unrequested second image'], input.image_count, input.image_style)).toEqual(['A quiet hillscape\nRequested visual style: illustration.']);
  });
  it('creates exactly the reviewed number of single-image requests', () => {
    expect(reviewedAdImagePrompts(['A hillscape'], 4)).toHaveLength(4);
    expect(reviewedAdImagePrompts(['One', 'Two', 'Three'], 1)).toHaveLength(1);
    expect(() => reviewedAdImagePrompts(['One'], 5)).toThrow('between 1 and 4');
  });
  it.each([
    ['meta', { headline: 40, description: 30, primaryText: 2200 }],
    ['google', { headline: 30, description: 90, primaryText: 90 }],
    ['linkedin', { headline: 70, description: 150, primaryText: 600 }],
  ] as const)('uses executor-compatible limits for %s', (platform, expected) => {
    expect(getAdPlatformCopyLimits(platform)).toEqual(expected);
    const constraints = formatAdPlatformCopyConstraints(platform);
    expect(constraints).toContain(`headline: ${expected.headline} characters maximum`);
    expect(constraints).toContain(`description: ${expected.description} characters maximum`);
    expect(constraints).toContain(`primaryText: ${expected.primaryText} characters maximum`);
  });
});
