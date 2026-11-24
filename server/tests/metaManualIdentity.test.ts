import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { verifyMetaManualIdentity } from '../services/metaManualIdentity.js';

const input = { appId: 'app-1', appSecret: 'synthetic-secret', accessToken: 'synthetic-token', platform: 'instagram' as const, pageId: 'page-1', instagramAccountId: 'ig-1' };
const debug = { data: { is_valid: true, app_id: 'app-1', scopes: ['instagram_basic', 'instagram_manage_messages'] } };
const profile = { id: 'page-1', name: 'Provider Page', instagram_business_account: { id: 'ig-1', username: 'verified-name' } };
afterEach(() => { jest.restoreAllMocks(); });
function replies(...bodies: unknown[]) {
  const fetch = jest.spyOn(globalThis, 'fetch');
  bodies.forEach(body => fetch.mockResolvedValueOnce(new Response(JSON.stringify(body))));
  return fetch;
}
describe('manual Meta identity verification', () => {
  it('persists only identities returned by the provider', async () => {
    replies(debug, profile);
    await expect(verifyMetaManualIdentity(input)).resolves.toMatchObject({ pageId: 'page-1', instagramAccountId: 'ig-1', instagramUsername: 'verified-name' });
  });
  it('rejects an otherwise valid token from a different app', async () => {
    const fetch = replies({ data: { ...debug.data, app_id: 'other-app' } });
    await expect(verifyMetaManualIdentity(input)).rejects.toThrow('different Meta app');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...profile, id: 'victim-page' },
    { ...profile, instagram_business_account: { id: 'victim-ig' } },
  ])('rejects an unrelated Page or Instagram account', async body => {
    replies(debug, body);
    await expect(verifyMetaManualIdentity(input)).rejects.toThrow();
  });
  it('rejects a token without the required messaging scopes', async () => {
    replies({ data: { ...debug.data, scopes: ['instagram_basic'] } });
    await expect(verifyMetaManualIdentity(input)).rejects.toThrow('permissions');
  });
});
