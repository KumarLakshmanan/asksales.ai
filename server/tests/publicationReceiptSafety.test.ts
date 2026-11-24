import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Actual adapters, synthetic credentials and bounded in-memory media only.
// Every external HTTP boundary is intercepted; no provider calls occur.
const credential = {
  id: 11, accessToken: 'synthetic-token', accountIdentifier: 'fixture-account',
  platform: 'youtube', tokenExpiry: new Date(Date.now() + 86400000),
  grantedScopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'],
  providerApprovalStatus: 'approved', sessionData: {},
};
const query: any = { from: () => query, where: () => query, orderBy: () => query, limit: async () => [credential] };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => query }, pgPool: undefined }));
jest.unstable_mockModule('../models/channelCredentials/functions', () => ({ ChannelCredentialModel: {
  findActiveAccountById: async () => credential, findByUserAndPlatform: async () => credential,
} }));
jest.unstable_mockModule('../utils/metaCredentialSecrets', () => ({ decryptMetaSecret: (value: string) => value, boundMetaPageToken: () => null, encryptMetaSecret: (value: string) => value }));
jest.unstable_mockModule('../utils/metaApiVersion', () => ({ getGraphApiVersion: async () => 'v25.0', getGraphApiBase: () => 'https://graph.example.test/v25.0' }));
const upload = jest.fn<any>();
jest.unstable_mockModule('googleapis', () => ({ google: {
  auth: { OAuth2: class { setCredentials() {} } }, youtube: () => ({ videos: { insert: upload } }),
} }));
jest.unstable_mockModule('../utils/safeRemoteFetch', () => ({
  fetchPublicHttpUrl: async () => ({ response: new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }), finalUrl: 'https://media.example.test/fixture.mp4' }),
  readResponseBuffer: jest.fn(),
}));
const { publishToFacebook, publishToInstagram } = await import('../services/social/SocialPublishingService.js');
const { publishToYouTube } = await import('../services/social/YouTubePublishingService.js');
let fetchSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  upload.mockReset();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected external request blocked by receipt fixture'); });
});
afterEach(() => fetchSpy.mockRestore());

describe('accepted publication requires an authoritative provider receipt', () => {
  it.each([{}, null, { id: '' }, { id: '   ' }, { id: 123 }])('quarantines a Facebook accepted response with invalid receipt %j', async receipt => {
    fetchSpy.mockResolvedValue(Response.json(receipt));
    const result = await publishToFacebook(991, { credentialId: 11, expectedAccountId: 'fixture-account', postType: 'text', message: 'Exact reviewed fixture' });
    expect(result).toMatchObject({ success: false, ambiguous: true, retryable: false });
    expect(result.platformPostId).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('quarantines an Instagram publication without a media receipt after container creation', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ id: 'container-fixture' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({}));
    expect(await publishToInstagram(991, { credentialId: 11, expectedAccountId: 'fixture-account', postType: 'post', imageUrls: ['https://media.example.test/fixture.jpg'], caption: 'Exact reviewed fixture' }))
      .toMatchObject({ success: false, ambiguous: true, retryable: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  it.each([undefined, null, {}, { id: '' }, { id: '   ' }, { id: 123 }])('quarantines a YouTube upload accepted without a video ID %j', async data => {
    upload.mockResolvedValue({ data });
    expect(await publishToYouTube(991, { credentialId: 11, expectedChannelId: 'fixture-account', title: 'Fixture', videoUrl: 'https://media.example.test/fixture.mp4' }))
      .toMatchObject({ success: false, ambiguous: true, retryable: false });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('preserves a known Facebook receipt when its optional permalink check times out', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ id: 'fixture-post' })).mockRejectedValueOnce(new Error('socket timeout'));
    expect(await publishToFacebook(991, { credentialId: 11, expectedAccountId: 'fixture-account', postType: 'text', message: 'Fixture' }))
      .toMatchObject({ success: true, platformPostId: 'fixture-post' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  it('accepts an authoritative Facebook photo post_id without requiring a separate media ID', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ post_id: 'fixture-photo-post' }))
      .mockResolvedValueOnce(Response.json({ permalink_url: 'https://facebook.example.test/fixture-photo-post' }));
    expect(await publishToFacebook(991, { credentialId: 11, postType: 'photo', imageUrl: 'https://media.example.test/fixture.jpg', message: 'Fixture' }))
      .toMatchObject({ success: true, platformPostId: 'fixture-photo-post' });
  });
  it('quarantines a timeout after dispatch and keeps a definitive provider rejection distinct', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('socket timeout'));
    expect(await publishToFacebook(991, { credentialId: 11, postType: 'text', message: 'Fixture' }))
      .toMatchObject({ success: false, ambiguous: true, retryable: false });
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { message: 'Fixture denied', code: 100 } }, { status: 400 }));
    expect(await publishToFacebook(991, { credentialId: 11, postType: 'text', message: 'Fixture' }))
      .toMatchObject({ success: false, ambiguous: false, retryable: false, errorCode: 'META_100' });
  });
});
