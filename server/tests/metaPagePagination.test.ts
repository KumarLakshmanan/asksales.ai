import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { collectMetaPages } from '../utils/metaPagePagination.js';
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
describe('Meta consent inventory pagination', () => {
  it('collects every Page and deduplicates overlaps without forwarding URL tokens', async () => {
    const fetch = jest.fn<typeof global.fetch>().mockResolvedValue(new Response(JSON.stringify({data:[{id:'b'},{id:'c'}]}),{status:200}));
    global.fetch = fetch;
    expect(await collectMetaPages({data:[{id:'a'},{id:'b'}],paging:{next:'https://graph.facebook.com/v25.0/me/accounts?after=next&access_token=discard'}},'test-token')).toEqual([{id:'a'},{id:'b'},{id:'c'}]);
    expect(String(fetch.mock.calls[0][0])).not.toContain('access_token');
    expect(fetch.mock.calls[0][1]?.headers).toEqual({Authorization:'Bearer test-token'});
  });
  it('rejects partial inventories and untrusted next links', async () => {
    global.fetch = jest.fn<typeof global.fetch>().mockResolvedValue(new Response('{}',{status:503}));
    await expect(collectMetaPages({data:[{id:'a'}],paging:{next:'https://graph.facebook.com/me/accounts?after=next'}},'test')).rejects.toThrow('could not complete');
    await expect(collectMetaPages({paging:{next:'https://example.com/steal'}},'test')).rejects.toThrow('invalid');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
