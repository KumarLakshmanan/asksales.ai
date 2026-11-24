import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type FetchPublicHttpUrl = (
  rawUrl: string,
  init?: RequestInit,
  maxRedirects?: number,
) => Promise<{ response: Response; finalUrl: string; redirectCount: number }>;

const fetchPublicHttpUrl = jest.fn<FetchPublicHttpUrl>();
const assertPublicHttpUrl = jest.fn(async (url: string) => new URL(url));
const launchSystemChromium = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../utils/safeRemoteFetch.js', () => ({ fetchPublicHttpUrl, assertPublicHttpUrl }));
jest.unstable_mockModule('../utils/browserAutomation.js', () => ({ launchSystemChromium }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { WebsiteCrawlerService } = await import('../services/WebsiteCrawlerService.js');

function response(body: string, status = 200, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function fetched(body: string, url: string, status = 200, contentType = 'text/html; charset=utf-8', redirectCount = 0) {
  return { response: response(body, status, contentType), finalUrl: url, redirectCount };
}

describe('AI Visibility audit crawler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('discovers same-origin URLs and extracts audit metadata from real HTML', async () => {
    const homepage = `<!doctype html><html><head>
      <title>Example Company</title>
      <meta name="description" content="Useful company description">
      <meta name="robots" content="noindex, follow">
      <link rel="canonical" href="/canonical-home">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
    </head><body>
      <h1>Example Company</h1><h2>What we do</h2>
      <p>We provide useful software and detailed information for customers around the world.</p>
      <img src="one.jpg" alt="Product"><img src="two.jpg">
      <a href="/pricing#plans">Pricing</a><a href="https://outside.example/docs">External</a>
    </body></html>`;
    const about = '<html><head><title>About Example Company</title></head><body><h1>About us</h1><p>Our company history and team.</p></body></html>';

    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url === 'https://example.com/robots.txt') {
        return fetched('User-agent: *\nDisallow: /private\nSitemap: https://example.com/site-map.xml', url, 200, 'text/plain');
      }
      if (url === 'https://example.com/site-map.xml') {
        return fetched('<urlset><url><loc>https://example.com/about</loc></url><url><loc>https://outside.example/private</loc></url></urlset>', url, 200, 'application/xml');
      }
      if (url === 'https://example.com/about') return fetched(about, url);
      if (url === 'https://example.com/pricing') return fetched(about, url);
      return fetched(homepage, url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 5 }).crawlForAudit('https://example.com');

    expect(result.robots).toEqual(expect.objectContaining({ available: true, sitemaps: ['https://example.com/site-map.xml'], disallow: ['/private'] }));
    expect(result.sitemap).toEqual(expect.objectContaining({ available: true, urls: ['https://example.com/about'] }));
    expect(result.discoveredUrls).toEqual(expect.arrayContaining(['https://example.com/about', 'https://example.com/pricing']));
    expect(result.discoveredUrls).not.toContain('https://outside.example/private');

    const page = result.pages.find((item) => item.url === 'https://example.com');
    expect(page).toEqual(expect.objectContaining({
      crawlStatus: 'completed',
      title: 'Example Company',
      metaDescription: 'Useful company description',
      canonicalUrl: 'https://example.com/canonical-home',
      robotsDirective: 'noindex, follow',
      indexable: false,
      headings: expect.objectContaining({ h1: ['Example Company'], h2: ['What we do'] }),
      imageCount: 2,
      imagesMissingAlt: 1,
      schemaTypes: expect.arrayContaining(['Organization', 'WebSite', 'Thing']),
      jsonLdErrors: [],
      pageType: 'homepage',
    }));
    expect(page?.internalLinks).toContain('https://example.com/pricing');
    expect(page?.externalLinks).toContain('https://outside.example/docs');
    expect(page?.contentHash).toHaveLength(64);
    expect(page?.contentExcerpt).toContain('We provide useful software');
    expect(page?.contentExcerpt?.length).toBeLessThanOrEqual(12_000);
    expect(page?.rawHtml).toContain('<title>Example Company</title>');
  });

  it('classifies blocked, timed-out and non-HTML pages visibly instead of fabricating page data', async () => {
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt')) return fetched('', url, 404, 'text/plain');
      if (url.endsWith('/sitemap.xml')) {
        return fetched('<urlset><url><loc>https://example.com/blocked</loc></url><url><loc>https://example.com/slow</loc></url></urlset>', url, 200, 'application/xml');
      }
      if (url.endsWith('/blocked')) return fetched('Forbidden', url, 403);
      if (url.endsWith('/slow')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return fetched('%PDF', url, 200, 'application/pdf');
    });

    const result = await new WebsiteCrawlerService({ maxPages: 4 }).crawlForAudit('https://example.com');

    expect(result.pages.map((page) => page.crawlStatus)).toEqual(expect.arrayContaining(['uncrawlable', 'blocked', 'timed_out']));
    const blocked = result.pages.find((page) => page.url.endsWith('/blocked'));
    expect(blocked).toEqual(expect.objectContaining({ crawlStatus: 'blocked', statusCode: 403, indexable: false, wordCount: 0 }));
    const timedOut = result.pages.find((page) => page.url.endsWith('/slow'));
    expect(timedOut).toEqual(expect.objectContaining({ crawlStatus: 'timed_out', error: 'Request timed out' }));
    expect(result.pages.every((page) => page.rawHtml === undefined)).toBe(true);
  });

  it('expands sitemap indexes into child sitemaps without crawling them as pages', async () => {
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt')) return fetched('Sitemap: https://example.com/wp-sitemap.xml', url, 200, 'text/plain');
      if (url.endsWith('/wp-sitemap.xml')) {
        return fetched('<sitemapindex><sitemap><loc>https://example.com/wp-sitemap-posts-page-1.xml</loc></sitemap><url><loc>https://example.com/about</loc></url></sitemapindex>', url, 200, 'application/xml');
      }
      if (url.endsWith('/wp-sitemap-posts-page-1.xml')) {
        return fetched('<urlset><url><loc>https://example.com/team?a=1&amp;b=2</loc></url></urlset>', url, 200, 'application/xml');
      }
      if (url.endsWith('/about')) return fetched('<html><head><title>About</title></head><body><h1>About</h1></body></html>', url);
      return fetched('<html><head><title>Home</title></head><body><h1>Home</h1></body></html>', url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 5 }).crawlForAudit('https://example.com');

    expect(result.sitemap).toEqual(expect.objectContaining({ available: true, complete: true, declaredInRobots: true }));
    expect(result.sitemap.urls).toEqual(expect.arrayContaining(['https://example.com/about', 'https://example.com/team?a=1&b=2']));
    expect(result.sitemap.sources?.map((source) => source.kind)).toEqual(['sitemapindex', 'urlset']);
    expect(result.discoveredUrls).not.toContain('https://example.com/wp-sitemap-posts-page-1.xml');
    expect(result.pages.map((page) => page.url)).toEqual(expect.arrayContaining(['https://example.com', 'https://example.com/about']));
    expect(result.pages.map((page) => page.url)).not.toContain('https://example.com/wp-sitemap-posts-page-1.xml');
    expect(fetchPublicHttpUrl.mock.calls.filter(([calledUrl]) => calledUrl === 'https://example.com/wp-sitemap-posts-page-1.xml')).toHaveLength(1);
  });

  it('marks the sitemap inventory incomplete when a child sitemap cannot be read', async () => {
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt')) return fetched('', url, 404, 'text/plain');
      if (url.endsWith('/sitemap.xml')) {
        return fetched('<sitemapindex><sitemap><loc>https://example.com/posts.xml</loc></sitemap></sitemapindex>', url, 200, 'application/xml');
      }
      if (url.endsWith('/posts.xml')) return fetched('', url, 500, 'text/plain');
      return fetched('<html><head><title>Home</title></head><body><h1>Home</h1></body></html>', url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 1 }).crawlForAudit('https://example.com');

    expect(result.sitemap).toEqual(expect.objectContaining({ available: true, complete: false, declaredInRobots: false }));
    expect(result.sitemap.sources).toContainEqual(expect.objectContaining({ url: 'https://example.com/posts.xml', kind: 'unreachable', statusCode: 500 }));
  });

  it('treats apex-to-www redirects as the same site for links and sitemap URLs', async () => {
    const homepage = '<html><head><title>Home</title></head><body><h1>Home</h1><a href="/pricing">Pricing</a><a href="https://www.example.com/about">About</a></body></html>';
    fetchPublicHttpUrl.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/robots.txt')) return fetched('', url, 404, 'text/plain');
      if (url.endsWith('/sitemap.xml')) return fetched('<urlset><url><loc>https://www.example.com/about</loc></url></urlset>', 'https://www.example.com/sitemap.xml', 200, 'application/xml', 1);
      if (init?.method === 'HEAD') return fetched('', url);
      if (url === 'https://example.com') return fetched(homepage, 'https://www.example.com/', 200, 'text/html', 1);
      return fetched('<html><head><title>Page</title></head><body><h1>Page</h1></body></html>', url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 3 }).crawlForAudit('https://example.com');
    const home = result.pages.find((page) => page.url === 'https://example.com');

    expect(result.sitemap.urls).toEqual(['https://www.example.com/about']);
    expect(home?.internalLinks).toEqual(expect.arrayContaining(['https://www.example.com/pricing', 'https://www.example.com/about']));
    expect(home?.externalLinks).toEqual([]);
  });

  it('does not treat HTML shells served at robots.txt or sitemap.xml as valid files', async () => {
    const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt') || url.endsWith('.xml')) return fetched(shell, url);
      return fetched('<html><head><title>Home</title></head><body><h1>Home</h1></body></html>', url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 1 }).crawlForAudit('https://example.com');

    expect(result.robots).toEqual(expect.objectContaining({ available: false, error: expect.stringMatching(/HTML page/) }));
    expect(result.sitemap).toEqual(expect.objectContaining({ available: false, urls: [], error: expect.stringMatching(/HTML page/) }));
    expect(result.sitemap.sources?.map((source) => source.url)).toEqual(['https://example.com/sitemap.xml', 'https://example.com/sitemap_index.xml']);
  });

  it('extracts on-page signals the way search engines read them', async () => {
    const homepage = `<!doctype html><html><head>
      <title>
        Example   Company
      </title>
      <meta name="Description" content="  Case-insensitive   description  ">
      <script type="Application/LD+JSON; charset=utf-8"><!--
        {"@context":{"@vocab":"https://schema.org/"},"@type":"Organization","name":"Example"}
      --></script>
    </head><body>
      <svg><title>Icon title</title></svg>
      <h1><img src="logo.png" alt="Example Logo"></h1>
      <div role="heading" aria-level="2">Accessible subheading</div>
      <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Widget</span></div>
      <p>Four real visible words</p>
      <script>var tracking = "these script words must not count toward the page";</script>
      <style>.hidden { display: none }</style>
      <img src="decorative.png" alt="">
      <img src="hidden.png" aria-hidden="true">
      <img src="pixel.gif" width="1" height="1">
      <img src="content.png">
    </body></html>`;
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt') || url.endsWith('.xml')) return fetched('', url, 404, 'text/plain');
      return {
        response: new Response(homepage, { status: 200, headers: { 'content-type': 'text/html', 'x-robots-tag': 'otherbot: noarchive, googlebot: noindex' } }),
        finalUrl: url,
        redirectCount: 0,
      };
    });

    const [page] = (await new WebsiteCrawlerService({ maxPages: 1 }).crawlForAudit('https://example.com')).pages;

    expect(page.title).toBe('Example Company');
    expect(page.metaDescription).toBe('Case-insensitive description');
    expect(page.headings.h1).toEqual(['Example Logo']);
    expect(page.headings.h2).toEqual(['Accessible subheading']);
    expect(page.jsonLdErrors).toEqual([]);
    expect(page.schemaTypes).toEqual(expect.arrayContaining(['Organization', 'Product']));
    expect(page.imageCount).toBe(3);
    expect(page.imagesMissingAlt).toBe(1);
    expect(page.missingAltElements?.[0]?.source).toBe('content.png');
    expect(page.robotsDirective).toBe('x-robots-tag: noindex');
    expect(page.indexable).toBe(false);
    expect(page.contentExcerpt).not.toContain('tracking');
    expect(page.contentExcerpt).not.toContain('display');
  });

  it('samples homepage links alongside sitemap URLs so a large sitemap cannot crowd out key pages', async () => {
    const homepage = '<html><head><title>Home</title></head><body><h1>Home</h1><a href="/about">About</a><a href="/pricing">Pricing</a></body></html>';
    const posts = Array.from({ length: 10 }, (_, index) => `<url><loc>https://example.com/blog/post-${index}</loc></url>`).join('');
    fetchPublicHttpUrl.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/robots.txt')) return fetched('', url, 404, 'text/plain');
      if (url.endsWith('/sitemap.xml')) return fetched(`<urlset><url><loc>https://example.com/</loc></url>${posts}</urlset>`, url, 200, 'application/xml');
      if (init?.method === 'HEAD') return fetched('', url);
      if (url === 'https://example.com') return fetched(homepage, url);
      return fetched('<html><head><title>Page</title></head><body><h1>Page</h1><p>Words</p></body></html>', url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 4, maxLinkChecks: 0 }).crawlForAudit('https://example.com');

    expect(result.pages.map((page) => page.url)).toEqual([
      'https://example.com',
      'https://example.com/about',
      // The sitemap's first entry is the homepage itself, so it is skipped as a duplicate.
      'https://example.com/pricing',
      'https://example.com/blog/post-0',
    ]);
  });

  it('does not give script-only pages a shared content hash', async () => {
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt') || url.endsWith('.xml')) return fetched('', url, 404, 'text/plain');
      return fetched('<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>', url);
    });

    const [page] = (await new WebsiteCrawlerService({ maxPages: 1 }).crawlForAudit('https://example.com')).pages;

    expect(page.wordCount).toBe(0);
    expect(page.contentHash).toBeUndefined();
  });

  it('retries failed pages with the explicitly enabled browser fallback', async () => {
    const html = '<html><head><title>Rendered site</title></head><body><h1>Rendered site</h1><p>Client-rendered content.</p></body></html>';
    const goto = jest.fn(async (_url: string, _options?: unknown) => ({ status: () => 200, request: () => ({ redirectedFrom: () => null }) }));
    const page = {
      setExtraHTTPHeaders: jest.fn(async () => undefined),
      route: jest.fn(async () => undefined),
      goto,
      waitForLoadState: jest.fn(async () => undefined),
      url: jest.fn(() => 'https://example.com'),
      content: jest.fn(async () => html),
      close: jest.fn(async () => undefined),
    };
    const browser = { newPage: jest.fn(async () => page), close: jest.fn(async () => undefined) };
    launchSystemChromium.mockResolvedValue(browser);
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml')) return fetched('', url, 404, 'text/plain');
      return fetched('', url, 503);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 1, browserFallback: true }).crawlForAudit('https://example.com');

    expect(result.pages[0]).toEqual(expect.objectContaining({ crawlStatus: 'completed', title: 'Rendered site' }));
    expect(launchSystemChromium).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('verifies links with bounded HEAD requests and preserves redirect and unavailable evidence', async () => {
    const homepage = `<html><head><title>Links</title></head><body>
      <h1>Links</h1>
      <a href="/ok">OK</a>
      <a href="/missing">Missing</a>
      <a href="/moved">Moved</a>
      <a href="https://outside.example/slow">Slow</a>
      <a href="/head-unsupported">HEAD unsupported</a>
      <a href="/members">Members</a>
    </body></html>`;

    fetchPublicHttpUrl.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml')) return fetched('', url, 404, 'text/plain');
      if (url.endsWith('/missing')) return fetched('', url, 404);
      if (url.endsWith('/head-unsupported')) return init?.method === 'HEAD' ? fetched('', url, 404) : fetched('', url);
      if (url.endsWith('/members')) return fetched('', url, 403);
      if (init?.method === 'HEAD') {
        if (url.endsWith('/moved')) return fetched('', 'https://example.com/final', 200, 'text/html', 2);
        if (url.includes('outside.example')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return fetched('', url);
      }
      return fetched(homepage, url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 1, maxLinkChecks: 6 }).crawlForAudit('https://example.com');
    const crawled = result.pages[0];

    expect(crawled.brokenLinks).toEqual(['https://example.com/missing']);
    expect(crawled.linkChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://example.com/ok', status: 'ok', redirectCount: 0 }),
      expect.objectContaining({ url: 'https://example.com/missing', status: 'broken', statusCode: 404 }),
      expect.objectContaining({ url: 'https://example.com/moved', status: 'ok', redirectCount: 2, finalUrl: 'https://example.com/final' }),
      expect.objectContaining({ url: 'https://outside.example/slow', status: 'unavailable', error: 'Link check timed out' }),
      expect.objectContaining({ url: 'https://example.com/head-unsupported', status: 'ok', statusCode: 200 }),
      expect.objectContaining({ url: 'https://example.com/members', status: 'unavailable', statusCode: 403 }),
    ]));
    expect(crawled.brokenLinks).not.toContain('https://outside.example/slow');
  });

  it('records malformed and structurally invalid JSON-LD instead of silently dropping it', async () => {
    const homepage = `<html><head><title>Schema</title>
      <script type="application/ld+json">{"@type":</script>
      <script type="application/ld+json">{"name":"Missing context and type"}</script>
    </head><body><h1>Schema</h1></body></html>`;
    fetchPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml')) return fetched('', url, 404, 'text/plain');
      return fetched(homepage, url);
    });

    const result = await new WebsiteCrawlerService({ maxPages: 1 }).crawlForAudit('https://example.com');
    expect(result.pages[0].jsonLdErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ scriptIndex: 0, code: 'parse_error' }),
      expect.objectContaining({ scriptIndex: 1, code: 'context_missing' }),
      expect.objectContaining({ scriptIndex: 1, code: 'type_missing' }),
    ]));
  });
});
