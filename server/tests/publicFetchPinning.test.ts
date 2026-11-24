/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const lookup = jest.fn<any>();
const connections: any[] = [];
let peer = '';
jest.unstable_mockModule('node:dns/promises', () => ({ lookup }));
jest.unstable_mockModule('undici', () => ({
  Agent: class {
    constructor(public options: any) { connections.push(options); }
    close = async () => undefined;
    destroy = async () => undefined;
  },
  buildConnector: (options: any) => (_connection: any, callback: any) => {
    options.lookup('rebind.example.test', { all: true }, (_error: any, addresses: any[]) => {
      callback(null, { remoteAddress: peer || addresses[0].address, destroy: jest.fn() });
    });
  },
}));
const { fetchPublicHttpUrl } = await import('../utils/safeRemoteFetch.js');
beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  connections.length = 0;
  peer = '';
});
afterEach(() => { jest.restoreAllMocks(); });

describe('DNS-pinned outbound HTTP', () => {
  it('connects with the approved answer and never resolves the hostname again', async () => {
    lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
      await new Promise<void>((resolve, reject) => init.dispatcher.options.connect({}, (err: any) => err ? reject(err) : resolve()));
      return new Response('public content');
    });
    const { response } = await fetchPublicHttpUrl('https://rebind.example.test/page');
    expect(await response.text()).toBe('public content');
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects a private peer even if a connector violates its DNS pin', async () => {
    peer = '127.0.0.1';
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
      await new Promise<void>((resolve, reject) => init.dispatcher.options.connect({}, (err: any) => err ? reject(err) : resolve()));
      return new Response('unreachable');
    });
    await expect(fetchPublicHttpUrl('https://rebind.example.test/page')).rejects.toThrow('approved public address');
  });
  it('revalidates redirects before another HTTP request', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://[::ffff:7f00:1]/secret' } }));
    await expect(fetchPublicHttpUrl('https://public.example.test/')).rejects.toThrow('Private network');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not forward bearer credentials to another origin', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://other.example.test/' } }))
      .mockResolvedValueOnce(new Response('safe'));
    const result = await fetchPublicHttpUrl('https://public.example.test/', { headers: { Authorization: 'Bearer fixture', Cookie: 'fixture=x' } });
    await result.response.text();
    const second = fetch.mock.calls[1][1] as any;
    expect(second.headers.has('authorization')).toBe(false);
    expect(second.headers.has('cookie')).toBe(false);
  });
});
