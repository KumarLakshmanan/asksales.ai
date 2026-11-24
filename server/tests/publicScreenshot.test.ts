import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Browser } from 'playwright-core';
import { existsSync } from 'node:fs';
import { launchSystemChromium } from '../utils/browserAutomation.js';

const realTransport = await import('../utils/safeRemoteFetch.js');
const fetchPage = jest.fn<typeof realTransport.fetchPublicHttpUrl>();
jest.unstable_mockModule('../utils/safeRemoteFetch.js', () => ({ ...realTransport, fetchPublicHttpUrl: fetchPage }));
const { capturePublicScreenshot } = await import('../utils/publicScreenshot.js');
const configured = process.env.BROWSER_EXECUTABLE_PATH;
const browserSuite = configured && existsSync(configured) ? describe : describe.skip;
let browser: Browser;
let html = '';
let redirect: string | undefined;
browserSuite('untrusted setup screenshots in real isolated Chromium', () => {
  beforeAll(async () => { browser = await launchSystemChromium({ untrustedContent: true }); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(() => {
    jest.clearAllMocks();
    redirect = undefined;
    fetchPage.mockImplementation(async url => {
      await realTransport.assertPublicHttpUrl(url);
      if (url.endsWith('/style.css')) return { response: new Response('body { background: #fff; }', { headers: { 'content-type': 'text/css' } }), finalUrl: url, redirectCount: 0, redirectChain: [] };
      return { response: redirect ? new Response('', { status: 302, headers: { location: redirect } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }), finalUrl: url, redirectCount: 0, redirectChain: [] };
    });
  });
  it('renders public HTML through interception with scripts disabled', async () => {
    html = '<!doctype html><html><head><link rel="stylesheet" href="https://8.8.8.8/style.css"></head><body><h1>Safe public preview</h1><script>location="http://127.0.0.1/private"</script></body></html>';
    const png = await capturePublicScreenshot(browser, 'https://8.8.8.8/fixture');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it('refuses to return a screenshot after a private browser redirect', async () => {
    redirect = 'http://[::ffff:7f00:1]/private';
    await expect(capturePublicScreenshot(browser, 'https://8.8.8.8/redirect')).rejects.toThrow();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it('blocks private iframe navigation before returning an image', async () => {
    html = '<!doctype html><html><body><iframe src="http://127.0.0.1/private"></iframe></body></html>';
    await expect(capturePublicScreenshot(browser, 'https://8.8.8.8/iframe')).rejects.toThrow();
  });
});
