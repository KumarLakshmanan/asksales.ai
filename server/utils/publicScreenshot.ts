import type { Browser } from 'playwright-core';
import { assertPublicHttpUrl, fetchPublicHttpUrl, readResponseBuffer } from './safeRemoteFetch.js';

/** Chromium never opens a network connection to page-provided destinations.
 * Every HTTP request, including redirects/frames/assets, is fulfilled by the
 * same DNS-pinned transport as ingestion. Scripts and service workers are off.
 */
export async function capturePublicScreenshot(browser: Browser, url: string): Promise<Buffer> {
  const deadline = AbortSignal.timeout(30_000);
  const headers = { 'User-Agent': 'AskSales-WebsitePreview/1.0' };
  // Resolve redirects in the pinned transport before Chromium sees the page.
  // Browser routing does not reliably re-intercept every redirect hop.
  const initial = await fetchPublicHttpUrl(url, { headers, signal: deadline });
  if (initial.response.status >= 300 && initial.response.status < 400) throw new Error('Unresolved screenshot redirect');
  const initialBody = await readResponseBuffer(initial.response, 4 * 1024 * 1024);
  let initialPending = true;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  let requests = 0;
  let bytes = initialBody.length;
  let active = 0;
  let unsafeNavigation = false;
  try {
    await context.routeWebSocket('**/*', route => route.close());
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        if (++requests > 100 || ++active > 6 || deadline.aborted || !['GET', 'HEAD'].includes(request.method())) {
          throw new Error('Screenshot request budget exceeded');
        }
        const cachedDocument = initialPending && request.url() === initial.finalUrl && request.isNavigationRequest();
        if (cachedDocument) initialPending = false;
        const { response } = cachedDocument ? initial : await fetchPublicHttpUrl(request.url(), {
          method: request.method(),
          headers,
          signal: deadline,
        });
        if (response.status >= 300 && response.status < 400) throw new Error('Unresolved screenshot redirect');
        const body = cachedDocument ? initialBody : await readResponseBuffer(response, 4 * 1024 * 1024);
        if (!cachedDocument) bytes += body.length;
        if (bytes > 20 * 1024 * 1024) throw new Error('Screenshot byte budget exceeded');
        const responseHeaders = Object.fromEntries(response.headers);
        for (const name of ['content-encoding', 'content-length', 'set-cookie', 'refresh']) delete responseHeaders[name];
        await route.fulfill({ status: response.status, headers: responseHeaders, body });
      } catch {
        if (request.isNavigationRequest()) unsafeNavigation = true;
        await route.abort('blockedbyclient').catch(() => undefined);
      } finally {
        active--;
      }
    });
    const page = await context.newPage();
    await page.goto(initial.finalUrl, { waitUntil: 'networkidle', timeout: 25_000 });
    await assertPublicHttpUrl(page.url());
    if (unsafeNavigation || deadline.aborted) throw new Error('Screenshot navigation was blocked');
    // Fixed viewport bounds the bitmap even if a page declares huge dimensions.
    return Buffer.from(await page.screenshot({ fullPage: false, type: 'png', timeout: 5_000 }));
  } finally {
    await context.close();
  }
}
