/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const credentials = {
  findAllByUserAndPlatform: jest.fn<any>(),
  selectAccount: jest.fn<any>(),
  removeAccount: jest.fn<any>(),
};
jest.unstable_mockModule('../models/channelCredentials/functions', () => ({ ChannelCredentialModel: credentials }));
const findInstagramConnectionForUserAndAccount = jest.fn<any>();
jest.unstable_mockModule('../models/metaPageConnections/functions', () => ({
  findInstagramConnectionForUserAndAccount,
  getMetaAdsCreds: jest.fn(),
}));

const { mockAuthRequest, mockResponse } = await import('./helpers/mockHelpers');
const controller = await import('../controllers/channelAccountController');

describe('multi-account chooser boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findInstagramConnectionForUserAndAccount.mockResolvedValue(null);
    credentials.findAllByUserAndPlatform.mockResolvedValue([{ id: 7, platform: 'youtube', accountIdentifier: 'channel-a', accountName: 'Channel A', isSelected: true, accessToken: 'secret', refreshToken: 'secret', sessionData: { token: 'secret' } }]);
  });

  it('lists only the authenticated tenant accounts and never serializes tokens', async () => {
    const req = mockAuthRequest(42, { params: { platform: 'youtube' } });
    const res = mockResponse();
    await controller.listChannelAccounts(req, res);
    expect(credentials.findAllByUserAndPlatform).toHaveBeenCalledWith(42, 'youtube');
    expect(res._json).toEqual([expect.objectContaining({ id: 7, accountIdentifier: 'channel-a', isSelected: true })]);
    expect(JSON.stringify(res._json)).not.toContain('secret');
  });

  it('marks an Instagram account unavailable for analytics until the token grants insights', async () => {
    credentials.findAllByUserAndPlatform.mockResolvedValue([
      { id: 22, platform: 'instagram_api', accountIdentifier: 'ig-a', accountName: 'Oro Circle', isSelected: true, grantedScopes: ['instagram_basic'], tokenExpiry: new Date(Date.now() + 60_000) },
      { id: 23, platform: 'instagram_api', accountIdentifier: 'ig-b', accountName: 'Ready', isSelected: false, grantedScopes: ['instagram_basic', 'instagram_manage_insights'], tokenExpiry: new Date(Date.now() + 60_000) },
    ]);
    const req = mockAuthRequest(42, { params: { platform: 'instagram_api' } });
    const res = mockResponse();
    await controller.listChannelAccounts(req, res);
    expect(res._json).toEqual([
      expect.objectContaining({ id: 22, analyticsReady: false, analyticsReadinessCode: 'ANALYTICS_PERMISSION_REQUIRED' }),
      expect.objectContaining({ id: 23, analyticsReady: true, analyticsReadinessCode: null }),
    ]);
  });

  it('includes only the owned Instagram display name and HTTPS profile picture', async () => {
    credentials.findAllByUserAndPlatform.mockResolvedValue([
      { id: 41, platform: 'instagram_api', accountIdentifier: 'ig-a', accountName: 'codingfrontend', sessionData: { useInstagramLogin: true }, grantedScopes: ['instagram_business_manage_insights'] },
    ]);
    findInstagramConnectionForUserAndAccount.mockResolvedValue({ pageName: 'Coding Frontend', instagramProfilePicture: 'https://example.com/profile.jpg' });
    const res = mockResponse();
    await controller.listChannelAccounts(mockAuthRequest(42, { params: { platform: 'instagram_api' } }), res);
    expect(findInstagramConnectionForUserAndAccount).toHaveBeenCalledWith(42, 'ig-a');
    expect(res._json[0]).toEqual(expect.objectContaining({ displayName: 'Coding Frontend', profilePictureUrl: 'https://example.com/profile.jpg' }));

    findInstagramConnectionForUserAndAccount.mockResolvedValue({ pageName: 'Coding Frontend', instagramProfilePicture: 'http://example.com/profile.jpg' });
    await controller.listChannelAccounts(mockAuthRequest(42, { params: { platform: 'instagram_api' } }), res);
    expect(res._json[0].profilePictureUrl).toBeNull();
  });

  it('rejects unknown platform selection before querying credentials', async () => {
    const req = mockAuthRequest(42, { params: { platform: 'gmail_api' }, body: { credentialId: 7 } });
    const res = mockResponse();
    await controller.selectChannelAccount(req, res);
    expect(res._status).toBe(404);
    expect(credentials.selectAccount).not.toHaveBeenCalled();
  });

  it('removes only a tenant-owned account and returns a token-safe replacement', async () => {
    credentials.removeAccount.mockResolvedValue({
      removedId: 7,
      removedAccountIdentifier: 'ig-old',
      selected: {
        id: 8,
        platform: 'instagram_api',
        accountIdentifier: 'ig-next',
        accountName: 'Next account',
        isSelected: true,
        accessToken: 'must-not-leak',
        sessionData: { pageAccessToken: 'must-not-leak' },
      },
    });
    const req = mockAuthRequest(42, { params: { platform: 'instagram_api', credentialId: '7' } });
    const res = mockResponse();
    await controller.removeChannelAccount(req, res);
    expect(credentials.removeAccount).toHaveBeenCalledWith(42, 'instagram_api', 7);
    expect(res._json).toEqual({
      removedId: 7,
      removedAccountIdentifier: 'ig-old',
      selected: expect.objectContaining({ id: 8, accountIdentifier: 'ig-next', isSelected: true }),
    });
    expect(JSON.stringify(res._json)).not.toContain('must-not-leak');
  });

  it('does not let one tenant remove another tenant account', async () => {
    credentials.removeAccount.mockResolvedValue(undefined);
    const req = mockAuthRequest(42, { params: { platform: 'instagram_api', credentialId: '99' } });
    const res = mockResponse();
    await controller.removeChannelAccount(req, res);
    expect(credentials.removeAccount).toHaveBeenCalledWith(42, 'instagram_api', 99);
    expect(res._status).toBe(404);
  });

  it('does not silently delete a provider that requires revocation semantics', async () => {
    const req = mockAuthRequest(42, { params: { platform: 'youtube', credentialId: '7' } });
    const res = mockResponse();
    await controller.removeChannelAccount(req, res);
    expect(res._status).toBe(404);
    expect(credentials.removeAccount).not.toHaveBeenCalled();
  });
});
