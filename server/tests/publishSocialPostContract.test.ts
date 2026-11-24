import { publishSocialPostInputSchema } from '../mastra/tools/contentTools.js';

describe('publish_social_post multi-target contract', () => {
  it('accepts independently reviewed Facebook and Instagram targets', () => {
    const parsed = publishSocialPostInputSchema.parse({
      content_asset_id: 41,
      targets: [
        { platform: 'instagram', credentialId: 11, caption: 'Instagram copy', postType: 'reel', instagramOptions: { coverUrl: 'https://cdn.example/cover.jpg', thumbOffset: 1.5 } },
        { platform: 'facebook', credentialId: 20, caption: 'Facebook copy', postType: 'video', title: 'Launch video' },
      ],
    });
    expect(parsed.targets).toHaveLength(2);
    expect(parsed.targets?.[0].postType).toBe('reel');
    expect(parsed.targets?.[1].postType).toBe('video');
  });

  it('keeps the legacy single-platform request compatible', () => {
    expect(publishSocialPostInputSchema.parse({ content_asset_id: 41, platform: 'facebook', post_type: 'photo' }).platform).toBe('facebook');
  });

  it('requires either a legacy platform or reviewed targets', () => {
    expect(() => publishSocialPostInputSchema.parse({ content_asset_id: 41 })).toThrow('Choose a platform or at least one reviewed target.');
  });
});
