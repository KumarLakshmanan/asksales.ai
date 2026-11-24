import { describe, expect, it } from '@jest/globals';
import { collectContentManagedReferenceUrls as projectUrls } from '../utils/contentManagedReferences.js';

describe('durable Content media projection', () => {
  it('preserves the ordinary asset media contract', () => {
    const asset = {
      imageUrl: '/uploads/image.png?signature=one',
      videoUrls: ['https://cdn.example.test/video.mp4#preview'],
      content: JSON.stringify({ generatedImage: '/uploads/generated.png', caption: 'https://example.test in copy' }),
    };
    expect([...projectUrls(asset)]).toEqual([
      '/uploads/image.png', 'https://cdn.example.test/video.mp4', '/uploads/generated.png',
    ]);
  });

  it('includes the frozen brand media saved on a complete asset row', () => {
    const asset = {
      content: 'Saved copy',
      brandContextSnapshot: { brandToolkit: {
        logoUrl: '/uploads/logo.png?signature=one',
        logoUrls: ['/uploads/logo.png?signature=two', '/uploads/alternate.png'],
        imageAssets: [{ url: '/uploads/brand.png', originalUrl: '/uploads/original.png', thumbnailUrl: '/uploads/thumb.png' }],
        websiteScreenshotUrl: '/uploads/screenshot.png',
      } },
    };
    expect([...projectUrls(asset)]).toEqual([
      '/uploads/logo.png', '/uploads/alternate.png', '/uploads/brand.png',
      '/uploads/original.png', '/uploads/thumb.png', '/uploads/screenshot.png',
    ]);
  });

  it('includes media and the reviewed YouTube thumbnail from the stored reviewed payload', () => {
    const reviewedPayload = {
      videoUrls: ['/uploads/reviewed.mp4'],
      youtubeOptions: { thumbnailUrl: 'https://cdn.example.test/reviewed-thumbnail.png' },
      brandContextSnapshot: { brandToolkit: { logoUrl: '/uploads/reviewed-logo.png' } },
    };
    expect([...projectUrls(reviewedPayload)]).toEqual([
      '/uploads/reviewed.mp4', 'https://cdn.example.test/reviewed-thumbnail.png', '/uploads/reviewed-logo.png',
    ]);
  });

  it('includes the saved reviewed snapshot independently of current asset media', () => {
    expect(projectUrls({
      imageUrl: '/uploads/current.png',
      metadata: { reviewedPublishSnapshot: {
        imageUrls: ['/uploads/reviewed.png'],
        instagramOptions: { coverUrl: 'https://cdn.example.test/reel-cover.png?signature=one' },
        brandContextSnapshot: { brandToolkit: { logoUrl: '/uploads/historical-logo.png' } },
      } },
    })).toEqual([
      '/uploads/current.png', '/uploads/reviewed.png', 'https://cdn.example.test/reel-cover.png', '/uploads/historical-logo.png',
    ]);
  });

  it('accepts the actual template/version snapshot shape including its thumbnail', () => {
    const snapshot = {
      content: 'Approved template',
      thumbnailUrl: '/uploads/template-thumbnail.png',
      brandContextSnapshot: { brandToolkit: { logoUrl: '/uploads/template-logo.png' } },
    };
    expect(projectUrls(snapshot)).toEqual(['/uploads/template-thumbnail.png', '/uploads/template-logo.png']);
  });

  it('does not adopt arbitrary business, prose, or unrelated metadata URLs', () => {
    expect(projectUrls({
      content: 'See https://example.test for details',
      brandContextSnapshot: {
        businessProfile: { website: 'https://example.test', websiteAnalysis: { screenshotUrl: '/uploads/untyped.png' } },
        brandToolkit: { website: 'https://brand.example.test', sampleContent: { url: '/uploads/untyped-copy.png' } },
      },
      metadata: { url: '/uploads/not-a-media-field.png' },
    })).toEqual([]);
  });

  it.each([null, undefined, false, 42, 'copy', []])('ignores an invalid top-level value: %p', (value) => {
    expect(projectUrls(value)).toEqual([]);
  });

  it('tolerates malformed historical JSON fields and excludes non-media schemes', () => {
    expect(projectUrls({
      content: '{invalid JSON', imageUrls: 5, videoUrls: [null, '/uploads/video.mp4'],
      thumbnailUrl: 'data:image/png;base64,not-managed',
      youtubeOptions: 'invalid', instagramOptions: [],
      brandContextSnapshot: { brandToolkit: {
        logoUrl: 'javascript:alert(1)', logoUrls: ['/uploads/logo.png', null, 7],
        imageAssets: [null, false, { url: 'blob:local-only', originalUrl: '/uploads/original.png' }],
      } },
      metadata: { reviewedPublishSnapshot: false },
    })).toEqual(['/uploads/video.mp4', '/uploads/logo.png', '/uploads/original.png']);
  });

  it('deduplicates shared URLs without changing the input snapshots', () => {
    const source = Object.freeze({
      imageUrl: '/uploads/shared.png?signature=current',
      brandContextSnapshot: Object.freeze({ brandToolkit: Object.freeze({ logoUrl: '/uploads/shared.png#brand' }) }),
      metadata: Object.freeze({ reviewedPublishSnapshot: Object.freeze({ imageUrls: Object.freeze(['/uploads/shared.png?signature=reviewed']) }) }),
    });
    const before = JSON.stringify(source);
    expect(projectUrls(source)).toEqual(['/uploads/shared.png']);
    expect(JSON.stringify(source)).toBe(before);
  });
});
