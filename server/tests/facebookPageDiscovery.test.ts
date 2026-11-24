import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { discoverFacebookPages } from '../utils/facebookPageDiscovery.js';
import type { MetaTokenInspection } from '../services/integrations/MetaCapabilityRegistry.js';

const inspection: MetaTokenInspection = {
  valid: true,
  grantedScopes: ['pages_show_list', 'pages_messaging'],
  declinedScopes: [],
  providerRequestIds: [],
  granularScopes: [{ scope: 'pages_messaging', targetIds: ['12345'] }],
};

describe('Facebook Page discovery', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('uses the Page token returned by the standard managed Pages list', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: '12345', name: 'Example', access_token: 'page-token', tasks: ['MESSAGING'] }],
    })));
    await expect(discoverFacebookPages({ apiBase: 'https://graph.facebook.com/v25.0', userAccessToken: 'user-token', inspection }))
      .resolves.toEqual([{ id: '12345', name: 'Example', access_token: 'page-token', tasks: ['MESSAGING'] }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves a specifically authorized Page when the list is empty', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '12345', name: 'Selected Page', access_token: 'page-token' })));
    await expect(discoverFacebookPages({ apiBase: 'https://graph.facebook.com/v25.0', userAccessToken: 'user-token', inspection }))
      .resolves.toEqual([{ id: '12345', name: 'Selected Page', access_token: 'page-token' }]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/12345?fields=id,name,access_token,tasks');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer user-token' } });
  });

  it('does not connect a Page without a Page token', async () => {
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '12345', name: 'Selected Page' })));
    await expect(discoverFacebookPages({ apiBase: 'https://graph.facebook.com/v25.0', userAccessToken: 'user-token', inspection }))
      .rejects.toThrow('select your Page');
  });

  it('reports a denied Page-list grant before contacting Graph', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(discoverFacebookPages({ apiBase: 'https://graph.facebook.com/v25.0', userAccessToken: 'user-token', inspection: { ...inspection, grantedScopes: [] } }))
      .rejects.toThrow('did not grant Page access');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('distinguishes a Graph failure from an empty Page list', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 190, message: 'private' } }), { status: 400 }));
    await expect(discoverFacebookPages({ apiBase: 'https://graph.facebook.com/v25.0', userAccessToken: 'user-token', inspection }))
      .rejects.toThrow('could not list your Pages');
  });
});
