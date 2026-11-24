import { describe, expect, it } from '@jest/globals';
import { adCreativeInputSchema } from '../mastra/tools/adsTools.js';

describe('ad-copy variation review contract', () => {
  it('retains the requested ad-copy count separately from image count', () => {
    expect(adCreativeInputSchema.parse({ platform: 'google', number_of_variations: 3, image_count: 1 }))
      .toMatchObject({ number_of_variations: 3, image_count: 1 });
  });

  it('rejects silently impossible variation counts', () => {
    expect(adCreativeInputSchema.safeParse({ platform: 'google', number_of_variations: 6 }).success).toBe(false);
  });
});
