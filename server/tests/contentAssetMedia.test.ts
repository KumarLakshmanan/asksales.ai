import { describe, expect, it } from '@jest/globals';
import {
  canonicalMediaUrl,
  collectContentAssetMediaUrls,
  findRemovedContentAssetMediaUrls,
} from '../utils/contentAssetMedia.js';

describe('content asset media lifecycle', () => {
  it('collects root and serialized media references without treating copy as a URL', () => {
    const urls = collectContentAssetMediaUrls({
      imageUrl: '/uploads/hero.png?signature=old',
      videoUrls: ['https://cdn.example.com/demo.mp4#preview'],
      content: JSON.stringify({
        generatedImage: '/uploads/generated.png',
        imageUrls: ['/uploads/variant.png'],
        caption: 'https://example.com is mentioned in copy',
      }),
    });

    expect([...urls]).toEqual(expect.arrayContaining([
      '/uploads/hero.png',
      'https://cdn.example.com/demo.mp4',
      '/uploads/generated.png',
      '/uploads/variant.png',
    ]));
    expect(urls).not.toContain('https://example.com is mentioned in copy');
  });

  it('does not treat raw base64 image data as a storage path', () => {
    const jpegBase64 = '/9j/4AAQSkZJRgABAQ' + 'A'.repeat(20000);
    const urls = collectContentAssetMediaUrls({ content: jpegBase64, imageUrl: '/api/uploads/1/image/generated.jpg' });
    expect([...urls]).toEqual(['/api/uploads/1/image/generated.jpg']);
  });

  it('only reports media no longer referenced anywhere on the updated asset', () => {
    const removed = findRemovedContentAssetMediaUrls(
      {
        imageUrl: '/uploads/old.png',
        imageUrls: ['/uploads/old.png', '/uploads/keep.png'],
        videoUrl: '/uploads/old-video.mp4',
      },
      {
        imageUrl: '/uploads/new.png',
        imageUrls: ['/uploads/keep.png', '/uploads/new.png'],
        videoUrl: null,
      },
    );

    expect(removed).toEqual(new Set(['/uploads/old.png', '/uploads/old-video.mp4']));
  });

  it('normalizes query strings and fragments before lifecycle comparison', () => {
    expect(canonicalMediaUrl(' https://cdn.example.com/file.png?v=1#top '))
      .toBe('https://cdn.example.com/file.png');
  });
});
