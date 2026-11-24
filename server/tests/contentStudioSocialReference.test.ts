import { contentStudioSocialSchema } from '../middleware/schemas.js';

describe('contentStudioSocialSchema reference image', () => {
  it('accepts a supported reference image for social companion generation', () => {
    const parsed = contentStudioSocialSchema.parse({
      prompt: 'Create a product launch post',
      platform: 'instagram',
      referenceImage: {
        base64Data: 'cmVmZXJlbmNl',
        mimeType: 'image/png',
      },
    });

    expect(parsed.referenceImage).toEqual({ base64Data: 'cmVmZXJlbmNl', mimeType: 'image/png' });
  });

  it('rejects unsupported reference-image formats', () => {
    expect(() => contentStudioSocialSchema.parse({
      prompt: 'Create a product launch post',
      platform: 'instagram',
      referenceImage: {
        base64Data: 'c3Zn',
        mimeType: 'image/svg+xml',
      },
    })).toThrow();
  });
});
