import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// All persistence and Graph API boundaries are local fixtures. No provider sends.
const credential = { id: 11, accessToken: 'fixture-token', accountIdentifier: 'fixture-account', platform: 'facebook_page', sessionData: {} as Record<string, unknown> };
const query: any = { from: () => query, where: () => query, orderBy: () => query, limit: async () => [credential] };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => query }, pgPool: undefined }));
jest.unstable_mockModule('../models/channelCredentials/functions', () => ({ ChannelCredentialModel: { findActiveAccountById: async () => credential, findByUserAndPlatform: async () => credential } }));
jest.unstable_mockModule('../utils/metaCredentialSecrets', () => ({ decryptMetaSecret: (value: string) => value, encryptMetaSecret: (value: string) => value, boundMetaPageToken: () => null }));
jest.unstable_mockModule('../utils/metaApiVersion', () => ({ getGraphApiVersion: async () => 'v25.0', getGraphApiBase: () => 'https://graph.example.test/v25.0' }));
const { publishToFacebook, publishToInstagram } = await import('../services/social/SocialPublishingService.js');
const { instagramPublishingOptionsSchema } = await import('../utils/instagramPublishingOptions.js');

type Request = { path: string; body: Record<string, unknown>; method: string };
let requests: Request[];
let fetchSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  requests = []; credential.sessionData = {};
  let containerIndex = 0;
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/v25.0', '');
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, method, body });
    if (method === 'GET') return Response.json({ status_code: 'FINISHED', permalink: 'https://instagram.example.test/p/fixture', permalink_url: 'https://facebook.example.test/fixture' });
    if (path.endsWith('/media_publish')) return Response.json({ id: 'published-ig' });
    if (path.endsWith('/feed')) return Response.json({ id: 'published-fb' });
    if (path.endsWith('/photos') || path.endsWith('/media')) return Response.json({ id: `container-${++containerIndex}` });
    throw new Error(`Unexpected provider request ${method} ${path}`);
  });
});
afterEach(() => fetchSpy.mockRestore());

describe('Meta media publishing format contracts', () => {
  it('uses Instagram Login for create, poll, publish and permalink calls', async () => {
    credential.sessionData = { useInstagramLogin: true };
    const result = await publishToInstagram(1, { postType: 'post', imageUrls: ['https://cdn.example.test/photo.jpg'], caption: 'Reviewed caption' });
    expect(result.success).toBe(true);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fetchSpy.mock.calls.every(([url]: [unknown]) => new URL(String(url)).hostname === 'graph.instagram.com')).toBe(true);
  });
  it('uploads every Facebook image as unpublished and attaches all of them to exactly one feed post', async () => {
    const images = ['https://cdn.example.test/a.jpg', 'https://cdn.example.test/b.jpg', 'https://cdn.example.test/c.jpg'];
    const result = await publishToFacebook(1, { credentialId: 11, expectedAccountId: 'fixture-account', postType: 'photo', imageUrls: images, message: 'Reviewed caption' });
    expect(result).toMatchObject({ success: true, platformPostId: 'published-fb' });
    const writes = requests.filter(request => request.method === 'POST');
    expect(writes.map(request => request.path)).toEqual(['/fixture-account/photos', '/fixture-account/photos', '/fixture-account/photos', '/fixture-account/feed']);
    expect(writes.slice(0, 3).map(request => request.body)).toEqual(images.map(url => ({ url, published: false })));
    expect(writes[3].body).toEqual({ message: 'Reviewed caption', attached_media: [{ media_fbid: 'container-1' }, { media_fbid: 'container-2' }, { media_fbid: 'container-3' }] });
    expect(writes.every(request => !('access_token' in request.body))).toBe(true);
  });

  it('never publishes an incomplete Facebook album when one staged photo fails', async () => {
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ path: String(_url), method: init?.method || 'GET', body: JSON.parse(String(init?.body || '{}')) });
      return requests.length === 1 ? Response.json({ id: 'first-photo' }) : Response.json({ error: { message: 'Invalid image', code: 100 } }, { status: 400 });
    });
    const result = await publishToFacebook(1, { postType: 'photo', imageUrls: ['https://cdn.example.test/a.jpg', 'https://cdn.example.test/b.jpg'], message: 'Caption' });
    expect(result).toMatchObject({ success: false, errorCode: 'META_100', retryable: false });
    expect(requests.some(request => request.path.endsWith('/feed'))).toBe(false);
  });

  it('builds and checks image and video children before publishing a single mixed Instagram carousel', async () => {
    const result = await publishToInstagram(1, { postType: 'carousel', imageUrls: ['https://cdn.example.test/photo.jpg'], videoUrls: ['https://cdn.example.test/video.mp4'], caption: 'Reviewed carousel', locationId: '12345', collaborators: ['reviewer'] });
    expect(result).toMatchObject({ success: true, platformPostId: 'published-ig' });
    const writes = requests.filter(request => request.method === 'POST');
    expect(writes.map(request => request.body)).toEqual([
      { image_url: 'https://cdn.example.test/photo.jpg', is_carousel_item: true },
      { media_type: 'VIDEO', video_url: 'https://cdn.example.test/video.mp4', is_carousel_item: true },
      { media_type: 'CAROUSEL', caption: 'Reviewed carousel', children: 'container-1,container-2', location_id: '12345', collaborators: ['reviewer'] },
      { creation_id: 'container-3' },
    ]);
    expect(requests.filter(request => request.method === 'GET').slice(0, 3).map(request => request.path)).toEqual(['/container-1', '/container-2', '/container-3']);
    expect(writes.filter(request => request.path.endsWith('/media_publish'))).toHaveLength(1);
  });

  it('converts Reel thumbnail seconds to milliseconds and preserves explicit share-to-feed false', async () => {
    await publishToInstagram(1, { postType: 'reel', videoUrl: 'https://cdn.example.test/reel.mp4', thumbOffset: 1.234, shareToFeed: false, coverUrl: 'https://cdn.example.test/cover.jpg', locationId: '12345', collaborators: ['reviewer'], caption: 'Reel caption' });
    expect(requests.find(request => request.method === 'POST')?.body).toEqual({ media_type: 'REELS', video_url: 'https://cdn.example.test/reel.mp4', caption: 'Reel caption', share_to_feed: false, location_id: '12345', collaborators: ['reviewer'], cover_url: 'https://cdn.example.test/cover.jpg', thumb_offset: 1234 });
  });

  it('sends accessibility and destination options on Instagram photos', async () => {
    await publishToInstagram(1, { postType: 'post', imageUrls: ['https://cdn.example.test/photo.jpg'], altText: 'A plant by a window', locationId: '12345', collaborators: ['reviewer'], caption: 'Photo caption' });
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ alt_text: 'A plant by a window', location_id: '12345', collaborators: ['reviewer'], caption: 'Photo caption' });
  });

  it('rejects an out-of-bounds media count without a provider call', async () => {
    expect((await publishToInstagram(1, { postType: 'carousel', imageUrls: ['https://cdn.example.test/one.jpg'] })).success).toBe(false);
    expect((await publishToFacebook(1, { postType: 'photo', imageUrls: Array(11).fill('https://cdn.example.test/one.jpg') })).success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([{ coverUrl: 'http://cdn.example.test/photo.jpg' }, { thumbOffset: -1 }, { thumbOffset: Infinity }, { altText: 'x'.repeat(1001) }, { locationId: 'Place Name' }, { collaborators: ['@username'] }, { collaborators: ['a', 'b', 'c', 'd'] }, { shareToFeed: 'false' }, { arbitraryProviderFlag: true }])('rejects malformed Instagram options %j', options => {
    expect(instagramPublishingOptionsSchema.safeParse(options).success).toBe(false);
  });

  it('normalizes valid Instagram options while preserving intentional false and zero', () => {
    expect(instagramPublishingOptionsSchema.parse({ coverUrl: 'https://cdn.example.test/cover.jpg', thumbOffset: 0, altText: '  Window  ', locationId: ' 12345 ', collaborators: [' person.name '], shareToFeed: false })).toEqual({ coverUrl: 'https://cdn.example.test/cover.jpg', thumbOffset: 0, altText: 'Window', locationId: '12345', collaborators: ['person.name'], shareToFeed: false });
  });
});
