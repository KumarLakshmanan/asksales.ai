import { AUDIT_CRAWLER_TOKEN, parseRobotsPolicy, robotsAllows, type RobotsGroup } from './aiVisibility/RobotsPolicy.js';
import { auditPageType, rankAuditCandidates } from './aiVisibility/PageTypes.js';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { assertPublicHttpUrl, fetchPublicHttpUrl } from '../utils/safeRemoteFetch.js';
import type { Browser } from 'playwright-core';

export interface CrawlResult {
  success: boolean;
  url: string;
  title?: string;
  text?: string;
  markdown?: string;
  error?: string;
  /** Page category detected from URL path (e.g., 'about', 'products', 'homepage') */
  category?: string;
  /** Raw HTML preserved for link extraction (not included in output) */
  _html?: string;
  statusCode?: number;
  requestedUrl?: string;
  redirectCount?: number;
  redirectChain?: Array<{ url: string; statusCode: number | null; destination: string }>;
  /** X-Robots-Tag response header, when the server sent one. */
  xRobotsTag?: string;
}

interface CrawlOptions {
  maxPages?: number;
  maxContentLength?: number;
  timeoutMs?: number;
  /** Retry failed audit pages in a real browser when explicitly enabled. */
  browserFallback?: boolean;
  /** Maximum distinct links verified after page extraction. */
  maxLinkChecks?: number;
  /** Called after each page is crawled — enables real-time progress updates */
  onPageCrawled?: (page: CrawlResult, index: number, total: number) => void;
  /** Called after link analysis phase completes */
  onLinksAnalyzed?: (links: CategorizedLink[]) => void;
}

export interface AuditLinkCheck {
  url: string;
  finalUrl?: string;
  statusCode?: number;
  redirectCount: number;
  redirectChain?: Array<{ url: string; statusCode: number | null; destination: string }>;
  status: 'ok' | 'broken' | 'unavailable';
  error?: string;
}

export interface JsonLdValidationError {
  scriptIndex: number;
  code: 'parse_error' | 'invalid_root' | 'context_missing' | 'context_invalid' | 'type_missing';
  message: string;
}

export interface AuditCrawlPage {
  url: string;
  finalUrl?: string;
  crawlStatus: 'completed' | 'blocked' | 'timed_out' | 'uncrawlable' | 'failed';
  statusCode?: number;
  redirectCount: number;
  redirectChain?: Array<{ url: string; statusCode: number | null; destination: string }>;
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  robotsDirective?: string;
  indexable: boolean;
  headings: Record<string, string[]>;
  wordCount: number;
  imageCount: number;
  imagesMissingAlt: number;
  missingAltElements?: Array<{ index: number; source: string; html: string }>;
  internalLinks: string[];
  externalLinks: string[];
  brokenLinks: string[];
  linkChecks: AuditLinkCheck[];
  jsonLd: unknown[];
  jsonLdErrors: JsonLdValidationError[];
  schemaTypes: string[];
  pageType?: string;
  contentHash?: string;
  /** Bounded visible page text used for deterministic AEO coverage checks. */
  contentExcerpt?: string;
  rawHtml?: string;
  error?: string;
}

export interface AuditCrawlResult {
  pages: AuditCrawlPage[];
  discoveredUrls: string[];
  robots: { url: string; available: boolean; sitemaps: string[]; disallow: string[]; policy?: RobotsGroup[]; error?: string };
  sitemap: {
    urls: string[];
    available: boolean;
    error?: string;
    /** False when child sitemaps were skipped or the URL cap was hit, so absence from `urls` proves nothing. */
    complete?: boolean;
    /** Every sitemap document that was requested, with what it turned out to be. */
    sources?: AuditSitemapSource[];
    /** True when robots.txt declares at least one Sitemap: line. */
    declaredInRobots?: boolean;
  };
}

export interface AuditSitemapSource {
  url: string;
  statusCode?: number;
  kind: 'urlset' | 'sitemapindex' | 'invalid' | 'unreachable' | 'skipped';
  urlCount: number;
  error?: string;
}

const MAX_SITEMAP_DOCUMENTS = 30;
const MAX_SITEMAP_URLS = 5000;

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlText(value: string): string {
  return value
    .trim()
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
      if (entity[0] === '#') {
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      return XML_ENTITIES[entity.toLowerCase()] ?? '';
    })
    .trim();
}

/** Single-page apps often answer /robots.txt and /sitemap.xml with their HTML shell and a 200. The leading whitespace match also skips a byte-order mark. */
function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body);
}

/** Elements whose text is code or markup, not words a visitor reads. */
const NON_TEXT_ELEMENTS = 'script, style, noscript, template, svg';

/** Link with priority and category metadata for intelligent crawling decisions */
interface CategorizedLink {
  url: string;
  priority: number; // 1 = essential, 2 = important, 3 = useful, 4 = low
  category: string;
  anchorText: string;
}

const DEFAULT_OPTIONS = {
  maxPages: 12,
  maxContentLength: 20000,
  timeoutMs: 30000,
  maxLinkChecks: 50,
  browserFallback: ['1', 'true', 'yes'].includes((process.env.AI_VISIBILITY_BROWSER_FALLBACK || '').toLowerCase()),
} satisfies Omit<Required<CrawlOptions>, 'onPageCrawled' | 'onLinksAnalyzed'>;

const USER_AGENT = `Mozilla/5.0 (compatible; ${AUDIT_CRAWLER_TOKEN}/1.0)`;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('Response is too large to crawl');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Response is too large to crawl');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Page category patterns for intelligent link prioritization.
 * Categories are ordered by business relevance for ICP generation.
 */
const PAGE_CATEGORIES: { pattern: RegExp; category: string; priority: number }[] = [
  // Priority 1 — Essential for understanding the business
  { pattern: /\/(about|about-us|who-we-are|our-story|company)\b/i, category: 'about', priority: 1 },
  { pattern: /\/(products?|offerings?|what-we-do|our-work)\b/i, category: 'products', priority: 1 },
  { pattern: /\/(services?|solutions?|capabilities)\b/i, category: 'services', priority: 1 },
  { pattern: /\/(platform|technology|how-it-works)\b/i, category: 'platform', priority: 1 },

  // Priority 2 — Important for market positioning & audience
  { pattern: /\/(pricing|plans?|packages?)\b/i, category: 'pricing', priority: 2 },
  { pattern: /\/(customers?|clients?|case-stud|success-stor|testimonials?|reviews?)\b/i, category: 'customers', priority: 2 },
  { pattern: /\/(industries?|verticals?|sectors?|use-cases?)\b/i, category: 'industries', priority: 2 },
  { pattern: /\/(features?|benefits?|why-us|advantages?)\b/i, category: 'features', priority: 2 },
  { pattern: /\/(partners?|integrations?|ecosystem)\b/i, category: 'partners', priority: 2 },

  // Priority 3 — Useful supporting context
  { pattern: /\/(contact|contact-us|get-in-touch|locations?)\b/i, category: 'contact', priority: 3 },
  { pattern: /\/(support|help|faq|knowledge-base)\b/i, category: 'support', priority: 3 },
  { pattern: /\/(docs?|documentation|api|developers?|resources?)\b/i, category: 'docs', priority: 3 },
  { pattern: /\/(team|leadership|people|founders?|management)\b/i, category: 'team', priority: 3 },
  { pattern: /\/(blog|news|insights?|articles?)\b/i, category: 'blog', priority: 3 },
  { pattern: /\/(careers?|jobs?|hiring|join-us|work-with-us)\b/i, category: 'careers', priority: 3 },
  { pattern: /\/(portfolio|projects?|showcase)\b/i, category: 'portfolio', priority: 3 },
];

/**
 * Intelligent website crawler that:
 * 1. Fetches the homepage and extracts ALL internal links
 * 2. Categorizes and prioritizes links by business relevance
 * 3. Deep-crawls essential/important pages in priority order
 * 4. Structures each page's content with proper labeling
 * 5. Returns well-organized, context-rich combined content
 */
export class WebsiteCrawlerService {
  private options: Required<Pick<CrawlOptions, 'maxPages' | 'maxContentLength' | 'timeoutMs' | 'maxLinkChecks' | 'browserFallback'>> & Pick<CrawlOptions, 'onPageCrawled' | 'onLinksAnalyzed'>;

  constructor(options?: CrawlOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Intelligent crawl: analyze → prioritize → deep-crawl → structure.
   */
  async crawl(url: string): Promise<{ pages: CrawlResult[]; combinedContent: string; discoveredLinks: string[] }> {
    const pages: CrawlResult[] = [];
    const visited = new Set<string>();

    // ── Phase 1: Fetch homepage and extract HTML + content ──
    logger.info({ url }, '[WebsiteCrawler] Phase 1: Fetching homepage');
    const mainResult = await this.fetchAndParse(url);
    mainResult.category = 'homepage';
    pages.push(mainResult);
    visited.add(this.normalizeUrl(url));
    this.options.onPageCrawled?.(mainResult, 0, 1);

    if (!mainResult.success || !mainResult._html) {
      return { pages, combinedContent: '', discoveredLinks: [] };
    }

    // ── Phase 2: Analyze links from homepage HTML (no re-fetch!) ──
    logger.info('[WebsiteCrawler] Phase 2: Analyzing and categorizing links');
    const categorizedLinks = this.extractAndCategorizeLinks(mainResult._html, url);
    const allDiscoveredLinks = categorizedLinks.map(l => l.url);

    logger.info(
      { totalLinks: categorizedLinks.length, categories: [...new Set(categorizedLinks.map(l => l.category))] },
      '[WebsiteCrawler] Links categorized'
    );
    this.options.onLinksAnalyzed?.(categorizedLinks);

    // ── Phase 3: Select pages to crawl based on priority ──
    // Ensure we get at least one page from each important category
    const selectedLinks = this.selectPagesToDeepCrawl(categorizedLinks, visited);
    logger.info(
      { selected: selectedLinks.length, pages: selectedLinks.map(l => `${l.category}: ${l.url}`) },
      '[WebsiteCrawler] Selected pages for deep crawl'
    );

    // ── Phase 4: Deep-crawl selected pages in batches ──
    for (let i = 0; i < selectedLinks.length; i += 4) {
      const batch = selectedLinks.slice(i, i + 4);
      const results = await Promise.allSettled(
        batch.map(async link => {
          visited.add(this.normalizeUrl(link.url));
          const result = await this.fetchAndParse(link.url);
          result.category = link.category;
          return result;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          pages.push(result.value);
          this.options.onPageCrawled?.(result.value, pages.length - 1, selectedLinks.length + 1);
          // If a priority-1 page has sub-links (e.g., /products/ has individual product pages),
          // extract and queue them for the next batch
          if (result.value.success && result.value._html && result.value.category) {
            const subPagePriority = result.value.category === 'products' || result.value.category === 'services' ? 2 : 3;
            if (subPagePriority <= 2 && pages.length < this.options.maxPages) {
              const subLinks = this.extractAndCategorizeLinks(result.value._html, result.value.url)
                .filter(sl => !visited.has(this.normalizeUrl(sl.url)) && sl.priority <= 3)
                .slice(0, 2); // At most 2 sub-pages per parent
              for (const sl of subLinks) {
                if (selectedLinks.length + pages.length < this.options.maxPages) {
                  selectedLinks.push(sl);
                }
              }
            }
          }
        }
      }

      // Stop if we've hit the page limit
      if (pages.length >= this.options.maxPages) break;
    }

    // ── Phase 5: Structure combined content with proper labeling ──
    const combinedContent = this.buildStructuredContent(pages);

    // Clean up internal HTML from results before returning
    for (const p of pages) { delete p._html; }

    logger.info(
      { totalPages: pages.filter(p => p.success).length, contentLength: combinedContent.length },
      '[WebsiteCrawler] Crawl complete'
    );

    return { pages, combinedContent, discoveredLinks: allDiscoveredLinks };
  }

  /**
   * Audit-specific crawl contract. It deliberately exposes technical metadata
   * without changing the knowledge-base crawler's existing response shape.
   */
  async crawlForAudit(url: string): Promise<AuditCrawlResult> {
    const origin = new URL(url).origin;
    const robotsUrl = `${origin}/robots.txt`;
    const defaultSitemapUrl = `${origin}/sitemap.xml`;
    const robots = { url: robotsUrl, available: false, sitemaps: [] as string[], disallow: [] as string[], policy: [] as RobotsGroup[], error: undefined as string | undefined };
    const sitemap = {
      urls: [] as string[],
      available: false,
      error: undefined as string | undefined,
      complete: true,
      sources: [] as AuditSitemapSource[],
      declaredInRobots: false,
    };

    try {
      const robotsText = await this.fetchTextResource(robotsUrl);
      const ok = robotsText.statusCode >= 200 && robotsText.statusCode < 300;
      if (ok && looksLikeHtml(robotsText.body)) {
        robots.error = 'robots.txt answered with an HTML page instead of plain-text crawler directives.';
      } else {
        robots.available = ok;
        robots.sitemaps = robotsText.body.split(/\r?\n/).map((line) => line.match(/^\s*Sitemap:\s*(\S+)/i)?.[1]).filter((value): value is string => Boolean(value));
        robots.policy = robots.available ? parseRobotsPolicy(robotsText.body) : [];
        robots.disallow = robots.policy.filter((group) => group.agents.includes('*')).flatMap((group) => group.rules.filter((rule) => !rule.allow).map((rule) => rule.path));
      }
    } catch (error) {
      robots.error = error instanceof Error ? error.message : 'Unable to fetch robots.txt';
    }
    sitemap.declaredInRobots = robots.sitemaps.length > 0;

    let browser: Browser | null = null;
    let browserUnavailable = false;
    const getBrowser = async (): Promise<Browser | null> => {
      if (!this.options.browserFallback || browserUnavailable) return null;
      if (browser) return browser;
      try {
        const { launchSystemChromium } = await import('../utils/browserAutomation.js');
        browser = await launchSystemChromium();
        return browser;
      } catch (error) {
        browserUnavailable = true;
        logger.warn({ err: error }, '[WebsiteCrawler] Browser fallback unavailable; retaining HTTP crawl result');
        return null;
      }
    };
    const crawlWithFallback = async (candidate: string, initial: CrawlResult): Promise<CrawlResult> => {
      if (initial.success || !this.options.browserFallback) return initial;
      const fallbackBrowser = await getBrowser();
      if (!fallbackBrowser) return initial;
      const fallback = await this.fetchAndParseWithBrowser(candidate, fallbackBrowser);
      return fallback.success ? fallback : initial;
    };

    try {
      let homepage: CrawlResult = robotsAllows(url, robots.policy, USER_AGENT)
        ? await this.fetchAndParse(url) : { success: false, url, error: 'Blocked by robots.txt' };
      if (robotsAllows(url, robots.policy, USER_AGENT)) homepage = await crawlWithFallback(url, homepage);
      // example.com → www.example.com (or http → https) is the site itself, not an external host.
      const siteOrigins = new Set([origin]);
      try {
        if (homepage.success) siteOrigins.add(new URL(homepage.url).origin);
      } catch { /* keep the requested origin */ }
      await this.readSitemaps(robots.sitemaps, defaultSitemapUrl, origin, siteOrigins, sitemap);
      const discoveredLinks = homepage._html
        ? this.extractAndCategorizeLinks(homepage._html, homepage.url).map((link) => link.url)
        : [];
      const discoveredUrls = [...new Set([...sitemap.urls, ...discoveredLinks])];
      const crawlable = (candidate: string) =>
        this.isLikelyHtmlUrl(candidate) && robotsAllows(candidate, robots.policy, USER_AGENT);
      // Key business pages first, then a few articles, so a large blog cannot fill the sample.
      const candidates = rankAuditCandidates(
        url,
        discoveredLinks.filter(crawlable),
        sitemap.urls.filter(crawlable),
        this.options.maxPages,
        (candidate) => this.normalizeUrl(candidate),
      );
      const pages: AuditCrawlPage[] = [];
      for (let index = 0; index < candidates.length; index += 4) {
        const batch = candidates.slice(index, index + 4);
        const results = await Promise.all(batch.map(async (candidate) => {
          const initial = candidate === url ? homepage : await this.fetchAndParse(candidate);
          return candidate === url ? initial : crawlWithFallback(candidate, initial);
        }));
        for (let offset = 0; offset < results.length; offset += 1) {
          const result = results[offset];
          const requestedUrl = batch[offset];
          pages.push(this.toAuditPage(result, requestedUrl, siteOrigins));
          this.options.onPageCrawled?.(result, index + offset, candidates.length);
        }
      }
      await this.verifyExtractedLinks(pages);
      return { pages, discoveredUrls, robots, sitemap };
    } finally {
      if (browser) await browser.close().catch((error) => logger.warn({ err: error }, '[WebsiteCrawler] Failed to close browser fallback'));
    }
  }


  /**
   * Read declared sitemaps (or /sitemap.xml, then /sitemap_index.xml) and expand
   * sitemap indexes into their child sitemaps, within fixed document and URL caps.
   * Child sitemaps are read as sitemaps only; they never enter the page crawl queue.
   */
  private async readSitemaps(
    declared: string[],
    defaultUrl: string,
    origin: string,
    siteOrigins: Set<string>,
    sitemap: AuditCrawlResult['sitemap'] & { sources: AuditSitemapSource[]; urls: string[] },
  ): Promise<void> {
    const queue: Array<{ url: string; probe: boolean }> = declared.length
      ? [...new Set(declared)].map((url) => ({ url, probe: false }))
      : [{ url: defaultUrl, probe: true }];
    const seen = new Set<string>();
    const pageUrls = new Set<string>();
    let fallbackQueued = declared.length > 0;
    let complete = true;
    const locsIn = (xml: string) => [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) => decodeXmlText(match[1]));
    while (queue.length) {
      const { url: sitemapUrl, probe } = queue.shift()!;
      if (seen.has(sitemapUrl)) continue;
      if (seen.size >= MAX_SITEMAP_DOCUMENTS) {
        complete = false;
        sitemap.sources.push({ url: sitemapUrl, kind: 'skipped', urlCount: 0, error: `Only the first ${MAX_SITEMAP_DOCUMENTS} sitemap files are read per analysis.` });
        continue;
      }
      seen.add(sitemapUrl);
      let source: AuditSitemapSource;
      try {
        const { body, statusCode } = await this.fetchTextResource(sitemapUrl);
        if (statusCode < 200 || statusCode >= 300) {
          source = { url: sitemapUrl, statusCode, kind: 'unreachable', urlCount: 0, error: `HTTP ${statusCode}` };
        } else if (/<sitemapindex[\s>]/i.test(body)) {
          const children = [...body.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)].flatMap((match) => locsIn(match[1]).slice(0, 1));
          const pages = [...body.matchAll(/<url>([\s\S]*?)<\/url>/gi)].flatMap((match) => locsIn(match[1]).slice(0, 1));
          for (const child of children) {
            try {
              if (siteOrigins.has(new URL(child).origin) || new URL(child).origin === new URL(sitemapUrl).origin) queue.push({ url: child, probe: false });
            } catch { /* invalid child sitemap URL */ }
          }
          pages.forEach((value) => pageUrls.add(value));
          source = { url: sitemapUrl, statusCode, kind: 'sitemapindex', urlCount: children.length };
        } else if (/<urlset[\s>]/i.test(body)) {
          const pages = locsIn(body);
          pages.forEach((value) => pageUrls.add(value));
          source = { url: sitemapUrl, statusCode, kind: 'urlset', urlCount: pages.length };
        } else {
          const compressed = body.charCodeAt(0) === 0x1f || /\.gz$/i.test(new URL(sitemapUrl).pathname);
          source = {
            url: sitemapUrl,
            statusCode,
            kind: compressed ? 'skipped' : 'invalid',
            urlCount: 0,
            error: compressed
              ? 'Compressed (.gz) sitemaps are not read by this analysis.'
              : looksLikeHtml(body)
                ? 'Answered with an HTML page instead of an XML sitemap.'
                : 'The response is not a <urlset> or <sitemapindex> XML document.',
          };
        }
      } catch (error) {
        source = { url: sitemapUrl, kind: 'unreachable', urlCount: 0, error: error instanceof Error ? error.message : 'Unable to fetch sitemap' };
      }
      sitemap.sources.push(source);
      const usable = source.kind === 'urlset' || source.kind === 'sitemapindex';
      if (!usable && !probe) complete = false;
      if (!usable && probe && !fallbackQueued) {
        fallbackQueued = true;
        queue.push({ url: `${origin}/sitemap_index.xml`, probe: true });
      }
    }
    for (const value of pageUrls) {
      try {
        const candidate = new URL(value);
        if (!siteOrigins.has(candidate.origin)) continue;
        if (sitemap.urls.length >= MAX_SITEMAP_URLS) {
          complete = false;
          break;
        }
        sitemap.urls.push(candidate.toString());
      } catch { /* invalid sitemap URL */ }
    }
    sitemap.available = sitemap.sources.some((source) => source.kind === 'urlset' || source.kind === 'sitemapindex');
    sitemap.complete = sitemap.available && complete;
    if (!sitemap.available) sitemap.error = sitemap.sources.find((source) => source.error)?.error;
  }

  private isLikelyHtmlUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      return !/\.(?:pdf|jpe?g|png|gif|svg|css|js|mjs|json|xml|txt|zip|docx?|xlsx?|pptx?|mp4|mp3|webp|ico|woff2?|ttf|eot)$/i.test(pathname);
    } catch {
      return false;
    }
  }

  private async verifyExtractedLinks(pages: AuditCrawlPage[]): Promise<void> {
    const completed = pages.filter((page) => page.crawlStatus === 'completed');
    const links = [...new Set(completed.flatMap((page) => [...page.internalLinks, ...page.externalLinks]))]
      .slice(0, this.options.maxLinkChecks);
    const checks = new Map<string, AuditLinkCheck>();
    for (let index = 0; index < links.length; index += 6) {
      const batch = links.slice(index, index + 6);
      const results = await Promise.all(batch.map((link) => this.verifyLink(link)));
      results.forEach((result) => checks.set(result.url, result));
    }
    for (const page of completed) {
      page.linkChecks = [...page.internalLinks, ...page.externalLinks]
        .map((link) => checks.get(link))
        .filter((check): check is AuditLinkCheck => Boolean(check));
      page.brokenLinks = page.linkChecks.filter((check) => check.status === 'broken').map((check) => check.url);
    }
  }

  private async verifyLink(url: string): Promise<AuditLinkCheck> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.options.timeoutMs, 10_000));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (timeout as any).unref === 'function') (timeout as any).unref();
    try {
      let result = await fetchPublicHttpUrl(url, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        signal: controller.signal,
      }, 5);
      // Many servers mishandle HEAD (405, 501, or even 404/403). Confirm any HEAD error with a real GET.
      if (result.response.status >= 400) {
        await result.response.body?.cancel();
        result = await fetchPublicHttpUrl(url, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Range: 'bytes=0-0' },
          signal: controller.signal,
        }, 5);
      }
      const statusCode = result.response.status;
      await result.response.body?.cancel();
      // 401/403/429 (and LinkedIn's 999) mean "not for bots" or "slow down", not "this page is gone".
      const restricted = [401, 403, 429, 999].includes(statusCode);
      return {
        url,
        finalUrl: result.finalUrl,
        statusCode,
        redirectCount: result.redirectCount,
        redirectChain: result.redirectChain,
        status: restricted ? 'unavailable' : statusCode >= 400 ? 'broken' : 'ok',
        ...(restricted ? { error: `Access restricted for automated checks (HTTP ${statusCode})` } : {}),
      };
    } catch (error) {
      return {
        url,
        redirectCount: 0,
        status: 'unavailable',
        error: error instanceof Error && error.name === 'AbortError' ? 'Link check timed out' : error instanceof Error ? error.message : 'Link check failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract all internal links from HTML and categorize them by business relevance.
   * Uses the already-fetched HTML — no additional network request needed.
   */
  private extractAndCategorizeLinks(html: string, baseUrl: string): CategorizedLink[] {
    const $ = cheerio.load(html);
    const baseUrlObj = new URL(baseUrl);
    const linksMap = new Map<string, CategorizedLink>();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      try {
        const resolved = new URL(href, baseUrl);
        // Only same-origin
        if (resolved.hostname !== baseUrlObj.hostname) return;
        // Skip anchors to same page, files, query-only difference
        if (resolved.hash && resolved.pathname === baseUrlObj.pathname) return;
        if (!this.isLikelyHtmlUrl(resolved.toString())) return;
        // Skip homepage self-link
        if (resolved.pathname === '/' || resolved.pathname === baseUrlObj.pathname) return;

        const fullUrl = resolved.origin + resolved.pathname.replace(/\/$/, '');
        if (linksMap.has(fullUrl)) return; // Already seen

        const path = resolved.pathname.toLowerCase();
        const anchorText = $(el).text().replace(/\s+/g, ' ').trim().substring(0, 100);

        // Categorize based on URL path
        let category = 'other';
        let priority = 4;
        for (const cat of PAGE_CATEGORIES) {
          if (cat.pattern.test(path)) {
            category = cat.category;
            priority = cat.priority;
            break;
          }
        }

        // Boost priority based on anchor text if URL didn't match any pattern
        if (priority === 4 && anchorText) {
          const lowerAnchor = anchorText.toLowerCase();
          for (const cat of PAGE_CATEGORIES) {
            // Check if the anchor text contains category keywords
            const keywords = cat.category.split(/[-_]/).join('|');
            if (new RegExp(`\\b(${keywords})\\b`, 'i').test(lowerAnchor)) {
              category = cat.category;
              priority = Math.min(cat.priority + 1, 4); // Slightly lower priority than URL match
              break;
            }
          }
        }

        // Skip very deep URLs (usually not top-level pages)
        const depth = path.split('/').filter(Boolean).length;
        if (depth > 3) priority = Math.max(priority, 3);

        linksMap.set(fullUrl, { url: fullUrl, priority, category, anchorText });
      } catch { /* invalid URL — skip */ }
    });

    // Sort by priority, then alphabetically within same priority
    return [...linksMap.values()].sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url));
  }

  /**
   * Select the best pages to deep-crawl from categorized links.
   * Ensures diversity: picks at least one page from each important category.
   */
  private selectPagesToDeepCrawl(links: CategorizedLink[], visited: Set<string>): CategorizedLink[] {
    const maxAdditional = this.options.maxPages - 1; // -1 for homepage
    const selected: CategorizedLink[] = [];
    const seenCategories = new Set<string>();

    // First pass: one page per category (essential → important → useful)
    for (const link of links) {
      if (selected.length >= maxAdditional) break;
      if (visited.has(this.normalizeUrl(link.url))) continue;
      if (seenCategories.has(link.category) && link.priority > 2) continue; // Allow duplicates for priority 1-2

      selected.push(link);
      seenCategories.add(link.category);
    }

    // Second pass: fill remaining slots with remaining priority 1-3 pages
    if (selected.length < maxAdditional) {
      for (const link of links) {
        if (selected.length >= maxAdditional) break;
        if (visited.has(this.normalizeUrl(link.url))) continue;
        if (selected.some(s => s.url === link.url)) continue;
        if (link.priority <= 3) {
          selected.push(link);
        }
      }
    }

    return selected;
  }

  /**
   * Build well-structured combined content with clear page labels and categories.
   */
  private buildStructuredContent(pages: CrawlResult[]): string {
    const successfulPages = pages.filter(p => p.success && (p.text || p.markdown));
    if (successfulPages.length === 0) return '';

    const perPageLimit = Math.max(
      1500,
      Math.floor(this.options.maxContentLength / Math.max(successfulPages.length, 1))
    );

    const sections: string[] = [];

    for (const page of successfulPages) {
      const categoryLabel = page.category
        ? page.category.charAt(0).toUpperCase() + page.category.slice(1)
        : 'Page';
      const title = page.title ? ` — ${page.title}` : '';
      const header = `## [${categoryLabel}]${title}\nURL: ${page.url}`;
      const content = (page.text || page.markdown || '').substring(0, perPageLimit);
      sections.push(`${header}\n\n${content}`);
    }

    return sections.join('\n\n---\n\n').substring(0, this.options.maxContentLength);
  }

  /**
   * Fetch a single URL and extract clean text content.
   * Preserves raw HTML in _html field for link extraction.
   */
  async fetchPage(url: string): Promise<CrawlResult> {
    return this.fetchAndParse(url);
  }

  /**
   * Build structured combined content from multiple crawl results.
   */
  buildContent(pages: CrawlResult[]): string {
    return this.buildStructuredContent(pages);
  }

  /**
   * Extract and categorize all internal links from an already-fetched HTML string.
   * Public wrapper used by the setup controller for multi-round crawling.
   */
  extractLinks(html: string, baseUrl: string): CategorizedLink[] {
    return this.extractAndCategorizeLinks(html, baseUrl);
  }

  private async fetchAndParseWithBrowser(url: string, browser: Browser): Promise<CrawlResult> {
    let page: Awaited<ReturnType<Browser['newPage']>> | undefined;
    try {
      await assertPublicHttpUrl(url);
      page = await browser.newPage();
      await page.setExtraHTTPHeaders({ 'User-Agent': USER_AGENT });
      await page.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        if (!/^https?:\/\//i.test(requestUrl)) {
          await route.continue();
          return;
        }
        try {
          await assertPublicHttpUrl(requestUrl);
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(this.options.timeoutMs, 10_000) }).catch(() => undefined);
      const finalUrl = page.url();
      await assertPublicHttpUrl(finalUrl);
      const statusCode = response?.status() || 200;
      if (statusCode >= 400) return { success: false, requestedUrl: url, url: finalUrl, statusCode, error: `HTTP ${statusCode}` };
      const html = await page.content();
      if (!html || Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) {
        return { success: false, requestedUrl: url, url: finalUrl, statusCode, error: html ? 'Response is too large to crawl' : 'Browser returned an empty document' };
      }
      const redirectChain: Array<{ url: string; statusCode: number | null; destination: string }> = [];
      let request = response?.request();
      while (request?.redirectedFrom()) {
        const previous = request.redirectedFrom()!;
        const previousResponse = await previous.response();
        redirectChain.unshift({ url: previous.url(), statusCode: previousResponse?.status() ?? null, destination: request.url() });
        request = previous;
      }
      const headers = await Promise.resolve(response?.allHeaders?.()).catch(() => undefined);
      const xRobotsTag = headers?.['x-robots-tag'];
      return { success: true, requestedUrl: url, url: finalUrl, redirectCount: redirectChain.length, redirectChain, statusCode, _html: html, xRobotsTag };
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError' ? 'Request timed out' : error instanceof Error ? error.message : 'Browser crawl failed';
      logger.warn({ url, err: error }, '[WebsiteCrawler] Browser fallback failed');
      return { success: false, requestedUrl: url, url, error: message };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /**
   * Fetch a single URL and extract clean text content.
   * Preserves raw HTML in _html field for link extraction.
   *
   * Phase 9.12 / SERV-009: uses `AbortController` with a 30s timeout
   * (configurable via `CrawlOptions.timeoutMs`). The timer is `unref()`'d
   * so a stuck fetch can never keep the Node process alive after all
   * other work has finished. The clear path is in `finally` so it runs
   * on both success and failure (the previous version only cleared on
   * the success path, leaking timer handles on a thrown fetch).
   */
  private async fetchAndParse(url: string): Promise<CrawlResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (timeout as any).unref === 'function') (timeout as any).unref();

    try {
      const { response, finalUrl: currentUrl, redirectCount, redirectChain } = await fetchPublicHttpUrl(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: controller.signal,
        }, 5);

      if (!response.ok) {
        return { success: false, requestedUrl: url, url: currentUrl, redirectCount, redirectChain, statusCode: response.status, error: `HTTP ${response.status} ${response.statusText}` };
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return { success: false, requestedUrl: url, url: currentUrl, redirectCount, redirectChain, statusCode: response.status, error: `Non-HTML content type: ${contentType}` };
      }

      const html = await readLimitedText(response);
      const { title, text, markdown } = this.extractContent(html, currentUrl);

      const xRobotsTag = response.headers.get('x-robots-tag') || undefined;
      return { success: true, requestedUrl: url, url: currentUrl, redirectCount, redirectChain, statusCode: response.status, title, text, markdown, _html: html, xRobotsTag };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const message = error.name === 'AbortError' ? 'Request timed out' : error.message;
      logger.warn({ url, err: error }, '[WebsiteCrawler] Fetch failed');
      return { success: false, requestedUrl: url, url, error: message };
    } finally {
      // Phase 9.12: clear the timer in BOTH the success and the error
      // path. The previous `clearTimeout` only ran on the happy path
      // and was easy to leak when fetch threw.
      clearTimeout(timeout);
    }
  }

  private async fetchTextResource(url: string): Promise<{ body: string; statusCode: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (timeout as any).unref === 'function') (timeout as any).unref();
    try {
      const { response } = await fetchPublicHttpUrl(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal }, 5);
      return { body: await readLimitedText(response), statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  private toAuditPage(result: CrawlResult, requestedUrl: string, siteOrigins: Set<string>): AuditCrawlPage {
    if (!result.success || !result._html) {
      const error = result.error || 'Page could not be crawled';
      const crawlStatus = /timed out/i.test(error) ? 'timed_out'
        : /blocked by robots/i.test(error) || result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 429 ? 'blocked'
          : /non-html/i.test(error) ? 'uncrawlable' : 'failed';
      return {
        url: requestedUrl,
        finalUrl: result.url,
        crawlStatus,
        statusCode: result.statusCode,
        redirectCount: result.redirectCount ?? (result.url !== requestedUrl ? 1 : 0),
      redirectChain: result.redirectChain,
        indexable: false,
        headings: {},
        wordCount: 0,
        imageCount: 0,
        imagesMissingAlt: 0,
        internalLinks: [],
        externalLinks: [],
        brokenLinks: [],
        linkChecks: [],
        jsonLd: [],
        jsonLdErrors: [],
        schemaTypes: [],
        error,
      };
    }

    const $ = cheerio.load(result._html);
    const collapse = (value: string | undefined) => (value || '').replace(/\s+/g, ' ').trim();
    // A heading's accessible text includes image alt text, e.g. <h1><img alt="Acme"></h1>.
    const headingText = (element: Parameters<typeof $>[0]) => {
      const node = $(element).clone();
      node.find('img[alt]').each((_, img) => { $(img).replaceWith(` ${$(img).attr('alt')} `); });
      node.find(NON_TEXT_ELEMENTS).remove();
      return collapse(node.text()) || collapse($(element).attr('aria-label'));
    };
    const headings: Record<string, string[]> = {};
    for (const level of [1, 2, 3, 4, 5, 6]) {
      headings[`h${level}`] = $(`h${level}, [role="heading"][aria-level="${level}"]`)
        .map((_, element) => headingText(element)).get().filter(Boolean);
    }
    // Attribute values are matched case-insensitively: <meta name="Description"> is still a description.
    const metaContent = (...names: string[]) => $('meta').filter((_, element) => names.includes(($(element).attr('name') || '').trim().toLowerCase()))
      .map((_, element) => $(element).attr('content')).get().map(collapse).filter(Boolean);
    const headTitle = $('head title').first();
    const titleElement = headTitle.length ? headTitle : $('title').filter((_, element) => !$(element).closest('svg').length).first();
    const title = collapse(titleElement.text()) || undefined;
    const canonicalHref = $('link').filter((_, element) => ($(element).attr('rel') || '').toLowerCase().split(/\s+/).includes('canonical')).first().attr('href')?.trim();
    const internalLinks = new Set<string>();
    const externalLinks = new Set<string>();
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      try {
        const resolved = new URL(href, result.url);
        if (!['http:', 'https:'].includes(resolved.protocol)) return;
        (siteOrigins.has(resolved.origin) ? internalLinks : externalLinks).add(resolved.toString().split('#')[0]);
      } catch { /* ignore invalid link */ }
    });
    const jsonLd: unknown[] = [];
    const jsonLdErrors: JsonLdValidationError[] = [];
    // type="application/ld+json" is matched case-insensitively and with optional parameters.
    $('script').filter((_, element) => /^application\/ld\+json\s*(;|$)/i.test(($(element).attr('type') || '').trim())).each((scriptIndex, element) => {
      try {
        // Some CMSs wrap JSON-LD in HTML comments or CDATA markers; browsers and Google ignore them.
        const source = ($(element).html() || '')
          .trim()
          .replace(/^(?:<!--|\/\/\s*<!\[CDATA\[|\/\*\s*<!\[CDATA\[\s*\*\/)/, '')
          .replace(/(?:-->|\/\/\s*\]\]>|\/\*\s*\]\]>\s*\*\/)$/, '')
          .trim();
        const value = JSON.parse(source || 'null');
        const structuralErrors = this.validateJsonLd(value, scriptIndex);
        jsonLdErrors.push(...structuralErrors);
        if (value) jsonLd.push(value);
      } catch (error) {
        jsonLdErrors.push({
          scriptIndex,
          code: 'parse_error',
          message: error instanceof Error ? `Invalid JSON: ${error.message}` : 'Invalid JSON-LD syntax',
        });
      }
    });
    const schemaTypes = new Set<string>();
    const visitSchema = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(visitSchema);
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const type = record['@type'];
      if (typeof type === 'string') schemaTypes.add(type);
      if (Array.isArray(type)) type.filter((item): item is string => typeof item === 'string').forEach((item) => schemaTypes.add(item));
      if (record['@graph']) visitSchema(record['@graph']);
    };
    jsonLd.forEach(visitSchema);
    // Microdata (itemtype) and RDFa (typeof) are valid structured data too.
    $('[itemtype]').each((_, element) => {
      for (const itemType of ($(element).attr('itemtype') || '').split(/\s+/)) {
        const match = /^https?:\/\/schema\.org\/([A-Za-z0-9]+)\/?$/i.exec(itemType);
        if (match) schemaTypes.add(match[1]);
      }
    });
    $('[typeof]').each((_, element) => {
      const vocab = $(element).closest('[vocab]').attr('vocab') || '';
      for (const typeName of ($(element).attr('typeof') || '').split(/\s+/)) {
        const prefixed = /^schema:([A-Za-z0-9]+)$/.exec(typeName);
        if (prefixed) schemaTypes.add(prefixed[1]);
        else if (/^https?:\/\/schema\.org\/?$/i.test(vocab) && /^[A-Z][A-Za-z0-9]*$/.test(typeName)) schemaTypes.add(typeName);
      }
    });
    // Meta robots directives plus the X-Robots-Tag header (only the generic or Googlebot-scoped parts).
    const headerDirectives: string[] = [];
    let headerScope: string | undefined;
    for (const raw of (result.xRobotsTag || '').split(/[,\n]/)) {
      let part = raw.trim();
      const scoped = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(part);
      // "googlebot: noindex" scopes the rest of the header; "max-snippet: 50" is a directive with a value.
      if (scoped && !/^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(scoped[1])) {
        headerScope = scoped[1].toLowerCase();
        part = scoped[2].trim();
      }
      if (part && (!headerScope || headerScope === 'googlebot')) headerDirectives.push(part);
    }
    const robotsDirective = [...metaContent('robots', 'googlebot'), ...headerDirectives.map((part) => `x-robots-tag: ${part}`)]
      .join(', ').toLowerCase();
    const body = $('body').clone();
    body.find(NON_TEXT_ELEMENTS).remove();
    const visibleText = collapse(body.text());
    // alt="" is the correct markup for decorative images; only a missing alt attribute is a defect.
    // Images hidden from assistive tech and 1x1 tracking pixels are not content.
    const images = $('img').filter((_, element) => {
      const image = $(element);
      if ((image.attr('aria-hidden') || '').toLowerCase() === 'true') return false;
      if (['presentation', 'none'].includes((image.attr('role') || '').toLowerCase())) return false;
      return !(image.attr('width') === '1' && image.attr('height') === '1');
    });
    const missingAlt = images.filter((_, element) => $(element).attr('alt') === undefined);
    const category = auditPageType(result.url);
    return {
      url: requestedUrl,
      finalUrl: result.url,
      crawlStatus: 'completed',
      statusCode: result.statusCode,
      redirectCount: result.redirectCount ?? (result.url !== requestedUrl ? 1 : 0),
      redirectChain: result.redirectChain,
      title,
      metaDescription: metaContent('description')[0],
      canonicalUrl: canonicalHref ? (() => { try { return new URL(canonicalHref, result.url).toString(); } catch { return undefined; } })() : undefined,
      robotsDirective: robotsDirective || undefined,
      indexable: !/(^|,)\s*(?:x-robots-tag:\s*)?(noindex|none)\b/.test(robotsDirective),
      headings,
      wordCount: visibleText ? visibleText.split(/\s+/).length : 0,
      imageCount: images.length,
      imagesMissingAlt: missingAlt.length,
      missingAltElements: images.toArray().flatMap((element, index) => $(element).attr('alt') !== undefined ? [] : [{ index: index + 1, source: $(element).attr('src') || $(element).attr('data-src') || '', html: $.html(element).slice(0, 1200) }]),
      internalLinks: [...internalLinks],
      externalLinks: [...externalLinks],
      brokenLinks: [],
      linkChecks: [],
      jsonLd,
      jsonLdErrors,
      schemaTypes: [...schemaTypes],
      pageType: category,
      // Script-rendered shells have no server text; an empty hash would mark them all as duplicates.
      contentHash: visibleText ? createHash('sha256').update(visibleText).digest('hex') : undefined,
      contentExcerpt: visibleText.slice(0, 12_000),
      rawHtml: result._html,
    };
  }

  private validateJsonLd(value: unknown, scriptIndex: number): JsonLdValidationError[] {
    const errors: JsonLdValidationError[] = [];
    const roots = Array.isArray(value) ? value : [value];
    if (!roots.length || roots.some((root) => !root || typeof root !== 'object' || Array.isArray(root))) {
      return [{ scriptIndex, code: 'invalid_root', message: 'JSON-LD must contain an object or an array of objects.' }];
    }
    for (const root of roots as Record<string, unknown>[]) {
      const context = root['@context'];
      if (context === undefined) {
        errors.push({ scriptIndex, code: 'context_missing', message: 'JSON-LD is missing @context.' });
      } else {
        const contextValues = Array.isArray(context) ? context : [context];
        const isSchemaOrg = (item: unknown) => typeof item === 'string' && /^https?:\/\/schema\.org\/?$/i.test(item.trim());
        // {"@vocab": "https://schema.org/"} and {"schema": "https://schema.org/"} are valid object contexts.
        const hasSchemaContext = contextValues.some((item) => isSchemaOrg(item)
          || (Boolean(item) && typeof item === 'object' && Object.values(item as Record<string, unknown>).some(isSchemaOrg)));
        if (!hasSchemaContext) errors.push({ scriptIndex, code: 'context_invalid', message: 'JSON-LD @context must include schema.org.' });
      }
      const graph = Array.isArray(root['@graph']) ? root['@graph'] as unknown[] : [];
      const hasType = typeof root['@type'] === 'string'
        || (Array.isArray(root['@type']) && root['@type'].some((item) => typeof item === 'string'))
        || graph.some((item) => Boolean(item && typeof item === 'object' && (item as Record<string, unknown>)['@type']));
      if (!hasType) errors.push({ scriptIndex, code: 'type_missing', message: 'JSON-LD does not declare a schema @type.' });
    }
    return errors;
  }

  /**
   * Extract clean text content from HTML using cheerio.
   * Extracts from both main content area AND body-level elements (footer, header, nav)
   * to capture contact details, addresses, phone numbers, and other key business info.
   */
  private extractContent(html: string, url: string): { title: string; text: string; markdown: string } {
    const $ = cheerio.load(html);

    // Remove unwanted elements — keep nav, footer, header for business context (address, phone, links)
    $('script, style, noscript, iframe, svg, .cookie-banner, .popup, #cookie-consent, .ad, .advertisement, .social-share').remove();

    const title = $('title').text().trim() || $('h1').first().text().trim() || '';

    // Extract main content area if identifiable
    const mainContent = $('main, article, [role="main"], .content, .main-content, #content, #main').first();
    const contentRoot = mainContent.length > 0 ? mainContent : $('body');

    // Build text content from main area
    const textParts: string[] = [];

    contentRoot.find('h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, figcaption, dt, dd, address, span, div > a, footer, nav a, small').each((_, el) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tagName = ((el as any).tagName || '').toLowerCase();
      const elText = $(el).text().replace(/\s+/g, ' ').trim();
      if (!elText || elText.length < 3) return;

      // For links, include the href as well
      if (tagName === 'a') {
        const href = $(el).attr('href') || '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          textParts.push(`${elText} (${href})`);
          return;
        }
      }

      textParts.push(elText);
      if (tagName.startsWith('h')) {
        textParts.push('');
      }
    });

    // ── Extract supplementary info from outside main content (footer, header, etc.) ──
    // Only needed if we scoped to a main content area; otherwise body already covers everything
    const supplementaryParts: string[] = [];
    if (mainContent.length > 0) {
      // Extract from header, footer, and contact sections outside main
      $('body').find('header, footer, [role="contentinfo"], [role="banner"], .footer, .header, .contact, .contact-info, #footer, #header').each((_, section) => {
        // Skip if this element is inside the main content area
        if ($(section).closest('main, article, [role="main"], .content, .main-content, #content, #main').length > 0) return;

        $(section).find('h1, h2, h3, h4, h5, h6, p, li, address, a[href^="tel:"], a[href^="mailto:"], span, small, div').each((_, el) => {
          const elText = $(el).text().replace(/\s+/g, ' ').trim();
          if (!elText || elText.length < 3) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tagName = ((el as any).tagName || '').toLowerCase();
          if (tagName === 'a') {
            const href = $(el).attr('href') || '';
            if (href.startsWith('tel:') || href.startsWith('mailto:')) {
              supplementaryParts.push(`${elText} (${href})`);
              return;
            }
          }
          supplementaryParts.push(elText);
        });
      });
    }

    // ── Screen-reader content: image alt text, title attributes ──
    $('img[alt]').each((_, el) => {
      const alt = $(el).attr('alt')?.trim();
      if (alt && alt.length > 3 && alt.length < 300) {
        supplementaryParts.push(`Image: ${alt}`);
      }
    });

    $('[title]').each((_, el) => {
      const titleAttr = $(el).attr('title')?.trim();
      if (titleAttr && titleAttr.length > 5 && titleAttr.length < 200) {
        supplementaryParts.push(titleAttr);
      }
    });

    // ── Visually hidden / sr-only text (screen reader text) ──
    $('.sr-only, .visually-hidden, [class*="screen-reader"], [class*="screenreader"]').each((_, el) => {
      const srText = $(el).text().replace(/\s+/g, ' ').trim();
      if (srText && srText.length > 3 && srText.length < 200) {
        supplementaryParts.push(srText);
      }
    });

    // ── ARIA labels (accessible names for interactive elements) ──
    $('[aria-label]').each((_, el) => {
      const ariaLabel = $(el).attr('aria-label')?.trim();
      if (ariaLabel && ariaLabel.length > 3 && ariaLabel.length < 200) {
        // Include the href if it's a link (e.g., aria-label="Visit our Instagram")
        const href = $(el).attr('href') || '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          supplementaryParts.push(`${ariaLabel} (${href})`);
        } else {
          supplementaryParts.push(ariaLabel);
        }
      }
    });

    // ── Hero / tagline / mission / vision sections ──
    $('body').find('.hero, .banner, .tagline, .mission, .vision, .slogan, [class*="hero"], [class*="banner"], [class*="tagline"], [class*="mission"], [class*="vision"], [class*="value-prop"], [class*="value_prop"]').each((_, section) => {
      const sectionText = $(section).text().replace(/\s+/g, ' ').trim();
      if (sectionText && sectionText.length > 10 && sectionText.length < 500) {
        supplementaryParts.push(sectionText);
      }
    });

    // ── Headings that contain mission/vision/values keywords (anywhere in page) ──
    $('body').find('h1, h2, h3, h4').each((_, el) => {
      const hText = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
      if (/\b(mission|vision|values|our story|who we are|what we do|our purpose)\b/.test(hText)) {
        // Grab the heading + next sibling paragraph(s) for context
        const heading = $(el).text().replace(/\s+/g, ' ').trim();
        supplementaryParts.push(heading);
        $(el).nextAll('p, ul, ol').slice(0, 3).each((_, sibling) => {
          const sibText = $(sibling).text().replace(/\s+/g, ' ').trim();
          if (sibText && sibText.length > 10) {
            supplementaryParts.push(sibText);
          }
        });
      }
    });

    // ── Extract structured data (JSON-LD) for business details ──
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const jsonText = $(el).html();
        if (!jsonText) return;
        const data = JSON.parse(jsonText);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item.telephone) supplementaryParts.push(`Phone: ${item.telephone}`);
          if (item.email) supplementaryParts.push(`Email: ${item.email}`);
          if (item.address) {
            const addr = typeof item.address === 'string'
              ? item.address
              : [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion, item.address.postalCode, item.address.addressCountry].filter(Boolean).join(', ');
            if (addr) supplementaryParts.push(`Address: ${addr}`);
          }
          if (item.description && typeof item.description === 'string') {
            supplementaryParts.push(item.description);
          }
        }
      } catch { /* invalid JSON-LD — skip */ }
    });

    // ── Extract meta tag content (description, keywords, author, etc.) ──
    const metaDesc = $('meta[name="description"]').attr('content')?.trim();
    if (metaDesc) supplementaryParts.push(`Meta Description: ${metaDesc}`);
    const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
    if (ogDesc && ogDesc !== metaDesc) supplementaryParts.push(`OG Description: ${ogDesc}`);
    const metaKeywords = $('meta[name="keywords"]').attr('content')?.trim();
    if (metaKeywords) supplementaryParts.push(`Keywords: ${metaKeywords}`);

    // ── Scan for tel: and mailto: links anywhere in the page ──
    $('a[href^="tel:"], a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const elText = $(el).text().replace(/\s+/g, ' ').trim();
      const val = href.replace(/^(tel:|mailto:)/, '');
      if (val) {
        const label = href.startsWith('tel:') ? 'Phone' : 'Email';
        supplementaryParts.push(`${label}: ${elText || val}`);
      }
    });

    // ── Extract aria-label text from key elements ──
    $('[aria-label]').each((_, el) => {
      const label = $(el).attr('aria-label')?.trim();
      if (label && label.length > 10 && label.length < 200) {
        supplementaryParts.push(label);
      }
    });

    // Deduplicate supplementary parts and append to main text
    const uniqueSupplementary = [...new Set(supplementaryParts)];
    if (uniqueSupplementary.length > 0) {
      textParts.push('', '--- Contact & Business Details ---');
      textParts.push(...uniqueSupplementary);
    }

    const text = textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Build simplified markdown
    const mdParts: string[] = [];
    if (title) mdParts.push(`# ${title}\n`);
    mdParts.push(`Source: ${url}\n`);

    contentRoot.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, address, small, footer p, footer li, nav a').each((_, el) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tagName = ((el as any).tagName || '').toLowerCase();
      const elText = $(el).text().replace(/\s+/g, ' ').trim();
      if (!elText || elText.length < 3) return;

      if (tagName === 'h1') mdParts.push(`\n# ${elText}`);
      else if (tagName === 'h2') mdParts.push(`\n## ${elText}`);
      else if (tagName === 'h3') mdParts.push(`\n### ${elText}`);
      else if (tagName.startsWith('h')) mdParts.push(`\n#### ${elText}`);
      else if (tagName === 'li') mdParts.push(`- ${elText}`);
      else if (tagName === 'blockquote') mdParts.push(`> ${elText}`);
      else if (tagName === 'a') {
        const href = $(el).attr('href') || '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          mdParts.push(`- [${elText}](${href})`);
        } else {
          mdParts.push(elText);
        }
      } else if (tagName === 'address' || tagName === 'small') {
        mdParts.push(`*${elText}*`);
      } else mdParts.push(elText);
    });

    // Append supplementary business details to markdown
    if (uniqueSupplementary.length > 0) {
      mdParts.push('\n---\n\n### Contact & Business Details\n');
      for (const item of uniqueSupplementary) {
        mdParts.push(`- ${item}`);
      }
    }

    const markdown = mdParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    return { title, text, markdown };
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/\/$/, '');
    } catch {
      return url;
    }
  }
}
