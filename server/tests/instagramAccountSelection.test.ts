/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const credentials = {
  findByUserAndPlatform: jest.fn<any>(),
  findActiveAccountById: jest.fn<any>(),
  findActiveAccountByIdentifier: jest.fn<any>(),
};
const findConnection = jest.fn<any>();
const findRoutingConnection = jest.fn<any>();

jest.unstable_mockModule('../models/channelCredentials/functions', () => ({ ChannelCredentialModel: credentials }));
jest.unstable_mockModule('../models/metaPageConnections/functions', () => ({
  findInstagramConnectionForUserAndAccount: findConnection,
  findInstagramConnectionForUserAndRoutingId: findRoutingConnection,
}));

const { resolveInstagramAccountContext, resolveInstagramProviderAccountId } = await import('../services/instagramAccountSelectionService');

describe('Instagram selected account resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findConnection.mockResolvedValue({
      id: 22,
      userId: 42,
      instagramAccountId: 'ig-selected',
      instagramUsername: 'selected_account',
      instagramProfilePicture: 'https://cdn.example/selected.jpg',
      pageId: 'page-selected',
      pageName: 'Selected Page',
    });
  });

  it('uses the publishing default and loads profile/Page metadata for that exact account', async () => {
    credentials.findByUserAndPlatform.mockResolvedValue({
      id: 12,
      userId: 42,
      platform: 'instagram_api',
      accountIdentifier: 'ig-selected',
      accountName: 'selected_account',
      isSelected: true,
    });

    const result = await resolveInstagramAccountContext(42);

    expect(credentials.findByUserAndPlatform).toHaveBeenCalledWith(42, 'instagram_api');
    expect(findConnection).toHaveBeenCalledWith(42, 'ig-selected', undefined);
    expect(result).toEqual(expect.objectContaining({
      credential: expect.objectContaining({ id: 12, accountIdentifier: 'ig-selected' }),
      connection: expect.objectContaining({ instagramAccountId: 'ig-selected', pageId: 'page-selected' }),
    }));
  });

  it('binds webhook work to the receiving account even when it is not the publishing default', async () => {
    credentials.findActiveAccountByIdentifier.mockResolvedValue({
      id: 13,
      userId: 42,
      platform: 'instagram_api',
      accountIdentifier: 'ig-receiving',
      accountName: 'receiving_account',
      isSelected: false,
    });
    findConnection.mockResolvedValue({
      id: 23,
      userId: 42,
      instagramAccountId: 'ig-receiving',
      pageId: 'page-receiving',
    });

    const result = await resolveInstagramAccountContext(42, { accountIdentifier: 'ig-receiving' });

    expect(credentials.findActiveAccountByIdentifier).toHaveBeenCalledWith(42, 'instagram_api', 'ig-receiving');
    expect(credentials.findByUserAndPlatform).not.toHaveBeenCalled();
    expect(findConnection).toHaveBeenCalledWith(42, 'ig-receiving', undefined);
    expect(result?.credential.id).toBe(13);
  });

  it('translates a webhook Page id to the exact receiving Instagram account', async () => {
    findRoutingConnection.mockResolvedValue({
      userId: 42,
      pageId: 'page-receiving',
      instagramAccountId: 'ig-receiving',
    });

    await expect(resolveInstagramProviderAccountId(42, 'page-receiving')).resolves.toBe('ig-receiving');
    expect(findRoutingConnection).toHaveBeenCalledWith(42, 'page-receiving');
  });
});
