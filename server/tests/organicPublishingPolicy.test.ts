import {
  buildReviewedCaption,
  normalizeOrganicPostType,
  OrganicPublishingError,
  validateOrganicMedia,
} from '../services/social/OrganicPublishingService.js';

describe('organic publishing policy', () => {
  it('keeps Facebook capabilities truthful and rejects unsupported formats', () => {
    expect(normalizeOrganicPostType('facebook', 'post', ['https://cdn.example/a.jpg'], []))
      .toBe('photo');
    expect(() => normalizeOrganicPostType('facebook', 'story', ['https://cdn.example/a.jpg'], []))
      .toThrow(OrganicPublishingError);
    expect(() => normalizeOrganicPostType('facebook', 'carousel', ['https://cdn.example/a.jpg'], []))
      .toThrow(OrganicPublishingError);
    expect(() => normalizeOrganicPostType('facebook', 'reel', [], ['https://cdn.example/a.mp4']))
      .toThrow(OrganicPublishingError);
  });

  it('enforces platform media counts and known provider formats', () => {
    expect(() => validateOrganicMedia({
      platform: 'instagram',
      postType: 'carousel',
      imageUrls: ['https://cdn.example/a.jpg'],
      videoUrls: [],
    })).toThrow(OrganicPublishingError);
    expect(() => validateOrganicMedia({
      platform: 'instagram',
      postType: 'post',
      imageUrls: ['https://cdn.example/a.webp'],
      videoUrls: [],
    })).toThrow(OrganicPublishingError);
    expect(() => validateOrganicMedia({
      platform: 'facebook',
      postType: 'video',
      imageUrls: [],
      videoUrls: ['https://cdn.example/a.mp4'],
    })).not.toThrow();
    expect(() => validateOrganicMedia({
      platform: 'instagram',
      postType: 'post',
      imageUrls: ['https://cdn.example/generated-image.bin'],
      videoUrls: [],
    })).not.toThrow();
  });

  it('builds the exact provider caption from reviewed CTA and tags', () => {
    expect(buildReviewedCaption({
      platform: 'instagram',
      caption: 'Launch day',
      callToAction: 'Learn more',
      tags: ['product', 'release'],
      postType: 'post',
    })).toBe('Launch day\n\nLearn more\n\n#product #release');
  });

  it('rejects unsupported Story captions and excessive Instagram hashtags', () => {
    expect(() => buildReviewedCaption({
      platform: 'instagram',
      caption: 'This would be silently dropped',
      postType: 'story',
    })).toThrow(OrganicPublishingError);
    expect(() => buildReviewedCaption({
      platform: 'instagram',
      caption: Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(' '),
      postType: 'post',
    })).toThrow(OrganicPublishingError);
  });

});
