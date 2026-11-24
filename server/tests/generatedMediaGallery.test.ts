import { jest } from '@jest/globals';

const createOnce = jest.fn(async (row: Record<string, unknown>, key: string) => ({ asset: { id: 501, ...row, metadata: { generationKey: key } }, created: true }));
const create = jest.fn(async (row: Record<string, unknown>) => ({ id: 777, ...row }));
jest.unstable_mockModule('../models/contentAssets/functions.js', () => ({ ContentAssetModel: { createOnce, create } }));

const {
  buildGalleryMediaRow,
  canonicalMediaUrl,
  createGeneratedAsset,
  generatedMediaKey,
  saveGeneratedMediaToGallery,
} = await import('../services/media/GeneratedMediaGallery.js');
const { mediaForOrganicFormat, normalizeOrganicPostType, validateOrganicMedia } = await import('../services/social/OrganicPublishingService.js');

const post = { id: 41, type: 'social_post', title: 'Spring launch', channel: 'instagram', threadId: 7, businessProfileId: 3, brandToolkitId: 9 };

describe('generated media gallery', () => {
  beforeEach(() => { createOnce.mockClear(); create.mockClear(); });

  it('keys a generation by its stored file, ignoring cache-busting query strings', () => {
    expect(canonicalMediaUrl('/uploads/a.png?t=123#x')).toBe('/uploads/a.png');
    expect(generatedMediaKey('image', '/uploads/a.png?t=1')).toBe(generatedMediaKey('image', '/uploads/a.png?t=2'));
    expect(generatedMediaKey('image', '/uploads/a.png')).not.toBe(generatedMediaKey('image', '/uploads/b.png'));
    expect(generatedMediaKey('image', '/uploads/a.png')).not.toBe(generatedMediaKey('video', '/uploads/a.png'));
  });

  it('builds a visible gallery child for media generated on a social post', () => {
    const row = buildGalleryMediaRow({ userId: 5, kind: 'image', url: '/uploads/a.png', parent: post, prompt: 'sunrise' });
    expect(row).toMatchObject({
      type: 'image', title: 'Image for: Spring launch', imageUrl: '/uploads/a.png', imageUrls: ['/uploads/a.png'],
      parentAssetId: 41, channel: 'instagram', threadId: 7, businessProfileId: 3, brandToolkitId: 9, status: 'draft', userId: 5,
      performance: { prompt: 'sunrise', sourceAssetId: 41 },
    });
    const video = buildGalleryMediaRow({ userId: 5, kind: 'video', url: '/uploads/v.mp4', parent: post });
    expect(video).toMatchObject({ type: 'video', videoUrl: '/uploads/v.mp4', videoUrls: ['/uploads/v.mp4'], imageUrl: null, title: 'Video for: Spring launch' });
    expect(JSON.parse(String(video.content))).toEqual({ videoUrl: '/uploads/v.mp4', mimeType: 'video/mp4' });
  });

  it('saves social-post media to the gallery through the idempotent insert', async () => {
    const result = await saveGeneratedMediaToGallery({ userId: 5, kind: 'image', url: '/uploads/a.png', parent: post });
    expect(result).toEqual({ assetId: 501, created: true });
    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(createOnce.mock.calls[0][1]).toBe(generatedMediaKey('image', '/uploads/a.png'));
    expect(create).not.toHaveBeenCalled();
  });

  it('does not add a second row when the parent already is the gallery item', async () => {
    const result = await saveGeneratedMediaToGallery({ userId: 5, kind: 'video', url: '/uploads/v.mp4', parent: { ...post, id: 60, type: 'video' } });
    expect(result).toEqual({ assetId: 60, created: false });
    expect(createOnce).not.toHaveBeenCalled();
  });

  it('never stores inline base64 previews as gallery items', async () => {
    expect(await saveGeneratedMediaToGallery({ userId: 5, kind: 'image', url: 'data:image/png;base64,AAAA', parent: post })).toBeNull();
    expect(createOnce).not.toHaveBeenCalled();
  });

  it('uses the idempotent insert for chat-tool images with a durable URL only', async () => {
    await createGeneratedAsset('image', 'https://cdn.example/x.png', { type: 'image', title: 'x', content: '', channel: 'c', status: 'draft', userId: 5 });
    expect(createOnce).toHaveBeenCalledTimes(1);
    await createGeneratedAsset('image', undefined, { type: 'image', title: 'x', content: 'base64', channel: 'c', status: 'draft', userId: 5 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('publishing format media selection', () => {
  const media = { imageUrls: ['https://cdn.example/cover.jpg'], videoUrls: ['https://cdn.example/clip.mp4'] };

  it('publishes only the video for a Reel from a post that also has an image', () => {
    const selected = mediaForOrganicFormat('instagram', 'reel', media);
    expect(selected).toEqual({ imageUrls: [], videoUrls: ['https://cdn.example/clip.mp4'] });
    expect(normalizeOrganicPostType('instagram', 'reel', selected.imageUrls, selected.videoUrls)).toBe('reel');
    expect(() => validateOrganicMedia({ platform: 'instagram', postType: 'reel', ...selected })).not.toThrow();
  });

  it('keeps every item for a carousel and still rejects a Reel with two videos', () => {
    expect(mediaForOrganicFormat('instagram', 'carousel', media)).toBe(media);
    const twoVideos = { imageUrls: ['https://cdn.example/cover.jpg'], videoUrls: ['https://cdn.example/a.mp4', 'https://cdn.example/b.mp4'] };
    expect(() => validateOrganicMedia({ platform: 'instagram', postType: 'reel', ...mediaForOrganicFormat('instagram', 'reel', twoVideos) })).toThrow();
  });

  it('selects the video for YouTube and Facebook video', () => {
    expect(mediaForOrganicFormat('youtube', 'short', media).imageUrls).toEqual([]);
    expect(mediaForOrganicFormat('facebook', 'video', media).imageUrls).toEqual([]);
    expect(mediaForOrganicFormat('facebook', 'photo', media)).toBe(media);
  });
});
