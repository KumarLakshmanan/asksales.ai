import { describe, expect, it } from '@jest/globals';
import { analyzeSeo } from '../services/aiVisibility/SeoEngine.js';
import { crawlerAccess, explainRobots, parseRobotsPolicy, robotsAllows } from '../services/aiVisibility/RobotsPolicy.js';
import { generateAuditPrompts } from '../services/aiVisibility/PromptEngine.js';
import { calculateVisibilityScore } from '../services/aiVisibility/ScoringEngine.js';
import { normalizeDomain } from '../services/aiVisibility/domain.js';
import { parseAndValidateCommerceFeed } from '../services/aiVisibility/CommerceFeedService.js';
import type { AuditCrawlPage } from '../services/WebsiteCrawlerService.js';

const page: AuditCrawlPage = {
  url: 'https://example.com/',
  finalUrl: 'https://example.com/',
  crawlStatus: 'completed' as const,
  statusCode: 200,
  redirectCount: 0,
  title: 'Example',
  headings: { h1: [], h2: [] },
  indexable: true,
  wordCount: 80,
  imageCount: 2,
  imagesMissingAlt: 1,
  internalLinks: [],
  externalLinks: [],
  brokenLinks: [],
  linkChecks: [],
  jsonLd: [],
  jsonLdErrors: [],
  schemaTypes: [],
  pageType: 'homepage',
  contentHash: 'abc',
};

function completePage(overrides: Partial<AuditCrawlPage> = {}): AuditCrawlPage {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    crawlStatus: 'completed',
    statusCode: 200,
    redirectCount: 0,
    title: 'A complete and descriptive page title',
    metaDescription: 'A useful description of this page, the information it contains, and who it helps.',
    canonicalUrl: 'https://example.com/',
    headings: { h1: ['Example page'], h2: ['Useful details'] },
    indexable: true,
    wordCount: 450,
    imageCount: 1,
    imagesMissingAlt: 0,
    internalLinks: ['https://example.com/about'],
    externalLinks: [],
    brokenLinks: [],
    linkChecks: [],
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Example', url: 'https://example.com/' }],
    jsonLdErrors: [],
    schemaTypes: ['Organization'],
    pageType: 'homepage',
    contentHash: 'complete-content',
    ...overrides,
  };
}

describe('AI Visibility deterministic engines', () => {
  it('normalizes a bare domain without accepting embedded credentials', () => {
    expect(normalizeDomain('Example.com/path?q=1')).toBe('https://example.com');
    expect(normalizeDomain('http://Example.com:8080/a#section')).toBe('http://example.com:8080');
    expect(() => normalizeDomain('https://user:pass@example.com')).toThrow(/without credentials/i);
    expect(() => normalizeDomain('ftp://example.com')).toThrow(/HTTP or HTTPS/i);
    expect(() => normalizeDomain('')).toThrow(/valid HTTP or HTTPS/i);
  });

  it('returns normalized versioned SEO issues and reproducible scores', () => {
    const first = analyzeSeo([page], { robotsAvailable: false, sitemapAvailable: false });
    const second = analyzeSeo([page], { robotsAvailable: false, sitemapAvailable: false });
    expect(first).toEqual(second);
    expect(first.issues.map((issue) => issue.ruleId)).toEqual(expect.arrayContaining(['headings.missing_h1', 'content.thin', 'schema.missing']));
    expect(first.issues.every((issue) => issue.ruleVersion === 4)).toBe(true);
  });

  it('gives a fully compliant crawl a perfect deterministic SEO score', () => {
    const result = analyzeSeo([completePage()], { robotsAvailable: true, sitemapAvailable: true });
    expect(result.issues).toEqual([]);
    expect(result.score).toBe(100);
    expect(Object.values(result.subScores)).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it('keeps failed crawl evidence visible and never scores an uncrawled site', () => {
    const result = analyzeSeo([completePage({
      crawlStatus: 'failed',
      statusCode: 503,
      error: 'upstream unavailable',
    })], { robotsAvailable: true, sitemapAvailable: true });
    expect(result.score).toBe(0);
    expect(result.issues).toContainEqual(expect.objectContaining({
      ruleId: 'crawl.page_unavailable',
      severity: 'high',
      evidence: expect.objectContaining({ statusCode: 503, error: 'upstream unavailable' }),
    }));
  });

  it('marks a noindexed homepage as critical and applies the versioned penalty', () => {
    const result = analyzeSeo([completePage({ indexable: false, robotsDirective: 'noindex' })], { robotsAvailable: true, sitemapAvailable: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ ruleId: 'indexability.noindex', severity: 'critical' }));
    expect(result.subScores.indexability).toBe(80);
  });

  it('reports every duplicated URL and penalizes the content pillar reproducibly', () => {
    const pages = [
      completePage({ url: 'https://example.com/a', finalUrl: 'https://example.com/a', contentHash: 'same' }),
      completePage({ url: 'https://example.com/b', finalUrl: 'https://example.com/b', contentHash: 'same' }),
    ];
    const result = analyzeSeo(pages, { robotsAvailable: true, sitemapAvailable: true });
    const duplicates = result.issues.filter((issue) => issue.ruleId === 'content.duplicate');
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].evidence.duplicateUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(result.subScores.content).toBe(88);
  });

  it('detects crawl-snapshot orphan pages, canonical mismatches, and redirect chains', () => {
    const result = analyzeSeo([
      completePage({ url: 'https://example.com/', finalUrl: 'https://example.com/', internalLinks: ['https://example.com/linked'] }),
      completePage({ url: 'https://example.com/linked', finalUrl: 'https://example.com/linked', pageType: 'other', canonicalUrl: 'https://example.com/linked', internalLinks: [] }),
      completePage({ url: 'https://example.com/orphan', finalUrl: 'https://example.com/orphan', pageType: 'other', canonicalUrl: 'https://example.com/different', redirectCount: 2, internalLinks: [] }),
    ], { robotsAvailable: true, sitemapAvailable: true });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'links.orphan_page', affectedUrl: 'https://example.com/orphan' }),
      expect.objectContaining({ ruleId: 'canonical.mismatch', affectedUrl: 'https://example.com/orphan' }),
      expect.objectContaining({ ruleId: 'redirect.chain', affectedUrl: 'https://example.com/orphan' }),
    ]));
  });

  it('uses verified link and JSON-LD evidence without treating unavailable checks as broken', () => {
    const result = analyzeSeo([completePage({
      brokenLinks: ['https://example.com/missing'],
      linkChecks: [
        { url: 'https://example.com/missing', finalUrl: 'https://example.com/missing', statusCode: 404, redirectCount: 0, status: 'broken' },
        { url: 'https://example.com/moved', finalUrl: 'https://example.com/final', statusCode: 200, redirectCount: 2, status: 'ok' },
        { url: 'https://outside.example/slow', redirectCount: 0, status: 'unavailable', error: 'Link check timed out' },
      ],
      jsonLd: [],
      jsonLdErrors: [{ scriptIndex: 0, code: 'parse_error', message: 'Invalid JSON' }],
      schemaTypes: [],
    })], { robotsAvailable: true, sitemapAvailable: true });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'links.broken', evidence: expect.objectContaining({ links: ['https://example.com/missing'] }) }),
      expect.objectContaining({ ruleId: 'links.redirect_chain' }),
      expect.objectContaining({ ruleId: 'links.unverified', severity: 'info' }),
      expect.objectContaining({ ruleId: 'schema.invalid_json_ld', severity: 'high' }),
    ]));
    expect(result.issues.find((item) => item.ruleId === 'links.broken')?.evidence.links).not.toContain('https://outside.example/slow');
  });

  it('detects sitemap and robots indexability conflicts from verified crawl inputs', () => {
    const result = analyzeSeo([completePage({
      url: 'https://example.com/private',
      finalUrl: 'https://example.com/private',
      pageType: 'other',
      indexable: false,
      robotsDirective: 'noindex',
    })], {
      robotsAvailable: true,
      robotsDisallow: ['/private'],
      sitemapAvailable: true,
      sitemapUrls: ['https://example.com/private'],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'sitemap.noindex_url', severity: 'high' }),
      expect.objectContaining({ ruleId: 'robots.disallowed_page' }),
    ]));
  });

  it('cites the exact robots.txt rule, line and user-agent group that blocks a page for Googlebot', () => {
    const robotsPolicy = parseRobotsPolicy(String.fromCharCode(0xfeff) + 'User-agent: *\nDisallow: /private\nAllow: /private/press\n\nUser-agent: Googlebot/2.1\nDisallow: /drafts/*.html$\n');
    const pages = ['https://example.com/private/plan', 'https://example.com/private/press/kit', 'https://example.com/drafts/a.html']
      .map((url) => completePage({ url, finalUrl: url, canonicalUrl: url, pageType: 'other' }));
    const result = analyzeSeo(pages, { robotsAvailable: true, robotsPolicy, sitemapAvailable: true });
    const blocked = result.issues.filter((item) => item.ruleId === 'robots.disallowed_page');

    // Googlebot has its own group, so only that group's rules apply to it.
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual(expect.objectContaining({
      affectedUrl: 'https://example.com/drafts/a.html',
      evidence: expect.objectContaining({
        evaluatedAs: 'Googlebot',
        matchedRule: 'Disallow: /drafts/*.html$',
        robotsTxtLine: 6,
        userAgentGroup: 'googlebot',
        testedPath: '/drafts/a.html',
      }),
    }));
    expect(explainRobots('https://example.com/private/press/kit', robotsPolicy, 'OtherBot')).toEqual(expect.objectContaining({
      allowed: true,
      rule: expect.objectContaining({ path: '/private/press', allow: true, line: 3 }),
    }));
    expect(robotsAllows('https://example.com/private/plan', robotsPolicy, 'Mozilla/5.0 (compatible; OtherBot/1.0)')).toBe(false);
  });

  it('flags AI search crawlers blocked at the homepage and explains training-only blocks', () => {
    const searchBlocked = analyzeSeo([completePage()], {
      robotsAvailable: true,
      robotsPolicy: parseRobotsPolicy('User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /'),
      sitemapAvailable: true,
    }).issues.find((item) => item.ruleId === 'robots.ai_crawler_blocked');
    expect(searchBlocked).toEqual(expect.objectContaining({ severity: 'high', affectedUrl: undefined }));
    expect((searchBlocked?.evidence.crawlers as Array<{ crawler: string; rule: string }>).map((item) => [item.crawler, item.rule]))
      .toEqual([['PerplexityBot', 'Disallow: /'], ['GPTBot', 'Disallow: /']]);

    const trainingOnly = analyzeSeo([completePage()], {
      robotsAvailable: true,
      robotsPolicy: parseRobotsPolicy('User-agent: GPTBot\nDisallow: /'),
      sitemapAvailable: true,
    }).issues.find((item) => item.ruleId === 'robots.ai_crawler_blocked');
    expect(trainingOnly?.severity).toBe('low');
    expect(crawlerAccess('https://example.com/', parseRobotsPolicy('User-agent: GPTBot\nDisallow: /'))
      .filter((item) => !item.allowed).map((item) => item.crawler)).toEqual(['GPTBot']);
  });

  it('only reports pages missing from the sitemap when every sitemap file was read', () => {
    const pages = [completePage(), completePage({ url: 'https://example.com/about', finalUrl: 'https://example.com/about', canonicalUrl: 'https://example.com/about', pageType: 'about' })];
    const site = { robotsAvailable: true, sitemapAvailable: true, sitemapUrls: ['https://example.com/'] };
    expect(analyzeSeo(pages, site).issues.map((item) => item.ruleId)).toContain('sitemap.missing_indexable_page');
    expect(analyzeSeo(pages, { ...site, sitemapComplete: false }).issues.map((item) => item.ruleId)).not.toContain('sitemap.missing_indexable_page');
  });

  it('reports sitemap URLs that redirect, are not canonical, or return errors', () => {
    const result = analyzeSeo([
      completePage(),
      completePage({ url: 'https://example.com/old', finalUrl: 'https://example.com/new', canonicalUrl: 'https://example.com/new', pageType: 'other', redirectCount: 1 }),
      completePage({ url: 'https://example.com/copy', finalUrl: 'https://example.com/copy', canonicalUrl: 'https://example.com/original', pageType: 'other' }),
      completePage({ url: 'https://example.com/gone', finalUrl: 'https://example.com/gone', crawlStatus: 'failed', statusCode: 404, pageType: 'other' }),
    ], {
      robotsAvailable: true,
      sitemapAvailable: true,
      sitemapUrls: ['https://example.com/', 'https://example.com/old', 'https://example.com/copy', 'https://example.com/gone'],
      sitemapDeclaredInRobots: false,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'sitemap.redirecting_url', affectedUrl: 'https://example.com/new' }),
      expect.objectContaining({ ruleId: 'sitemap.non_canonical_url', affectedUrl: 'https://example.com/copy' }),
      expect.objectContaining({ ruleId: 'sitemap.error_url', affectedUrl: 'https://example.com/gone', evidence: expect.objectContaining({ statusCode: 404 }) }),
      expect.objectContaining({ ruleId: 'site.sitemap_not_in_robots' }),
    ]));
  });

  it('checks title and meta description length and reuse across pages', () => {
    const shared = 'Shared description that is long enough to pass the minimum length check easily.';
    const result = analyzeSeo([
      completePage({ title: 'Home | Acme', metaDescription: 'Too short.' }),
      completePage({ url: 'https://example.com/a', finalUrl: 'https://example.com/a', canonicalUrl: 'https://example.com/a', pageType: 'other', title: 'Acme widgets for every team', metaDescription: shared }),
      completePage({ url: 'https://example.com/b', finalUrl: 'https://example.com/b', canonicalUrl: 'https://example.com/b', pageType: 'other', title: 'ACME widgets for every team', metaDescription: `${shared}`.padEnd(200, '.') }),
      completePage({ url: 'https://example.com/c', finalUrl: 'https://example.com/c', canonicalUrl: 'https://example.com/c', pageType: 'other', metaDescription: shared }),
    ], { robotsAvailable: true, sitemapAvailable: true });
    const byRule = (ruleId: string) => result.issues.filter((item) => item.ruleId === ruleId);

    expect(byRule('metadata.title_length')[0].evidence).toEqual(expect.objectContaining({ length: 11, problem: 'too_short', recommendedRange: '20–65 characters' }));
    expect(byRule('metadata.description_length').map((item) => item.evidence.problem)).toEqual(['too_short', 'too_long']);
    expect(byRule('metadata.duplicate_title').map((item) => item.affectedUrl)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(byRule('metadata.duplicate_description').map((item) => item.affectedUrl)).toEqual(['https://example.com/a', 'https://example.com/c']);
  });

  it('reports incomplete structured data and never double-reports a redirecting link', () => {
    const result = analyzeSeo([completePage({
      jsonLd: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Product', name: 'Widget' }, { '@type': 'Organization', name: 'Acme', url: 'https://example.com' }] }],
      schemaTypes: ['Product', 'Organization'],
      internalLinks: ['https://example.com/', 'https://example.com/about'],
      linkChecks: [
        { url: 'https://example.com/one-hop', finalUrl: 'https://example.com/x', statusCode: 200, redirectCount: 1, status: 'ok' },
        { url: 'https://example.com/two-hop', finalUrl: 'https://example.com/y', statusCode: 200, redirectCount: 2, status: 'ok' },
      ],
    })], { robotsAvailable: true, sitemapAvailable: true });

    expect(result.issues.find((item) => item.ruleId === 'schema.incomplete')?.evidence.types).toEqual([
      { type: 'Product', missing: ['offers or review or aggregateRating'] },
    ]);
    const urls = (ruleId: string) => (result.issues.find((item) => item.ruleId === ruleId)?.evidence.checks as Array<{ url: string }>).map((item) => item.url);
    expect(urls('links.redirecting')).toEqual(['https://example.com/one-hop']);
    expect(urls('links.redirect_chain')).toEqual(['https://example.com/two-hop']);
  });

  it('does not count a self-link as an inbound link', () => {
    const result = analyzeSeo([
      completePage({ internalLinks: [] }),
      completePage({ url: 'https://example.com/self', finalUrl: 'https://example.com/self', canonicalUrl: 'https://example.com/self', pageType: 'other', internalLinks: ['https://example.com/self/'] }),
    ], { robotsAvailable: true, sitemapAvailable: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ ruleId: 'links.orphan_page', affectedUrl: 'https://example.com/self' }));
  });

  it.each(['b2b_saas', 'ecommerce', 'local_business', 'general'] as const)('generates multi-industry prompts for %s without vertical or currency hard-coding', (profile) => {
    const prompts = generateAuditPrompts({ brandName: 'Orbit', aliases: [], category: 'project management', profile, locale: 'en-US', geography: 'Canada' });
    expect(prompts).toHaveLength(8);
    expect(prompts.some((prompt) => prompt.isGeneric)).toBe(true);
    expect(prompts.some((prompt) => !prompt.isGeneric && prompt.prompt.includes('Orbit'))).toBe(true);
    expect(prompts.map((prompt) => prompt.prompt).join(' ')).not.toMatch(/skincare|₹|INR/i);
  });

  it('creates the expected keyword, AEO and GEO mix with cache-safe generic flags', () => {
    const prompts = generateAuditPrompts({ brandName: 'Orbit', aliases: ['Orbit AI'], category: 'analytics', profile: 'b2b_saas', locale: 'en-CA', geography: 'Canada' });
    expect(prompts.filter((prompt) => prompt.kind === 'keyword')).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt.kind === 'aeo')).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt.kind === 'geo')).toHaveLength(4);
    expect(prompts.filter((prompt) => prompt.isGeneric)).toHaveLength(4);
    expect(prompts.filter((prompt) => !prompt.isGeneric)).toHaveLength(4);
    expect(prompts.every((prompt) => prompt.locale === 'en-CA' && prompt.promptHash.length === 64)).toBe(true);
    expect(prompts.filter((prompt) => prompt.isGeneric).every((prompt) => !prompt.prompt.includes('Orbit'))).toBe(true);
  });

  it('normalizes prompt whitespace before hashing cache keys', () => {
    const compact = generateAuditPrompts({ brandName: 'Orbit', aliases: [], category: 'project management', profile: 'general', locale: 'en-US' });
    const spaced = generateAuditPrompts({ brandName: 'Orbit', aliases: [], category: 'project   management', profile: 'general', locale: 'en-US' });
    expect(spaced.map((prompt) => prompt.promptHash)).toEqual(compact.map((prompt) => prompt.promptHash));
  });

  it('re-normalizes scoring weights when commerce is not applicable', () => {
    const result = calculateVisibilityScore('ecommerce', {
      seo: { score: 80, status: 'scored' },
      aeo: { score: 60, status: 'scored' },
      geo: { score: 40, status: 'scored' },
      commerce: { score: null, status: 'not_applicable' },
    });
    expect(result.normalizedWeights.commerce).toBe(0);
    expect(Object.values(result.normalizedWeights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(result.overallScore).toBeGreaterThan(40);
    expect(result.inputFingerprint).toHaveLength(64);
  });

  it('uses the exact configured ecommerce weights when all pillars are scored', () => {
    const result = calculateVisibilityScore('ecommerce', {
      seo: { score: 80, status: 'scored' },
      aeo: { score: 60, status: 'scored' },
      geo: { score: 40, status: 'scored' },
      commerce: { score: 100, status: 'scored' },
    });
    expect(result.normalizedWeights).toEqual({ seo: 0.25, aeo: 0.2, geo: 0.3, commerce: 0.25 });
    expect(result.overallScore).toBe(69);
    expect(result.version).toBe(2);
  });

  it('returns zero without inventing a score when all pillars are unavailable', () => {
    const result = calculateVisibilityScore('general', {
      seo: { score: null, status: 'unavailable' },
      aeo: { score: null, status: 'unavailable' },
      geo: { score: null, status: 'unavailable' },
      commerce: { score: null, status: 'not_applicable' },
    });
    expect(result.overallScore).toBe(0);
    expect(result.normalizedWeights).toEqual({ seo: 0, aeo: 0, geo: 0, commerce: 0 });
  });

  it('fingerprints the versioned inputs and changes when an input changes', () => {
    const pillars = {
      seo: { score: 80, status: 'scored' as const },
      aeo: { score: 60, status: 'scored' as const },
      geo: { score: 40, status: 'scored' as const },
      commerce: { score: null, status: 'not_applicable' as const },
    };
    const first = calculateVisibilityScore('general', pillars);
    const second = calculateVisibilityScore('general', pillars);
    const changed = calculateVisibilityScore('general', { ...pillars, geo: { score: 41, status: 'scored' } });
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(changed.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  it('scores only real ingested commerce fields and reports missing signals', () => {
    const result = parseAndValidateCommerceFeed(Buffer.from([
      'id,title,description,image_link,price,currency,availability,review_count',
      'sku-1,Widget,Useful widget,https://example.com/a.jpg,10.00,USD,in stock,12',
      'sku-2,Second Widget,,https://example.com/b.jpg,20.00,USD,out of stock,',
    ].join('\n')), 'products.csv', 'text/csv');
    expect(result.itemCount).toBe(2);
    expect(result.validItemCount).toBe(1);
    expect(result.fieldCoverage.identifier).toBe(1);
    expect(result.issues.some((issue) => issue.field === 'description' && issue.missing === 1)).toBe(true);
    expect(result.inputFingerprint).toHaveLength(64);
  });

  it('parses nested JSON feeds and scores complete real product data at 100', () => {
    const result = parseAndValidateCommerceFeed(Buffer.from(JSON.stringify({ products: [{
      id: 'sku-1', title: 'Widget', description: 'Useful widget', image: 'https://example.com/widget.jpg',
      price: 10, currency: 'USD', availability: 'in_stock', variants: ['blue'], shipping: 'free',
      returns: '30 days', reviews: 12,
    }] })), 'products.json', 'application/json');
    expect(result.sourceType).toBe('json');
    expect(result.itemCount).toBe(1);
    expect(result.validItemCount).toBe(1);
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
  });

  it('parses namespaced XML product records', () => {
    const xml = '<rss><channel><item><g:id>sku-1</g:id><g:title>Widget</g:title><g:description>Useful</g:description><g:image_link>https://example.com/a.jpg</g:image_link><g:price>10</g:price><g:currency>USD</g:currency><g:availability>in stock</g:availability></item></channel></rss>';
    const result = parseAndValidateCommerceFeed(Buffer.from(xml), 'feed.xml', 'application/xml');
    expect(result.sourceType).toBe('xml');
    expect(result.itemCount).toBe(1);
    expect(result.validItemCount).toBe(1);
    expect(result.fieldCoverage.identifier).toBe(1);
  });

  it('rejects unsupported, malformed and empty commerce inputs instead of creating placeholder data', () => {
    expect(() => parseAndValidateCommerceFeed(Buffer.from('x'), 'feed.txt', 'text/plain')).toThrow(/CSV, JSON, or XML/i);
    expect(() => parseAndValidateCommerceFeed(Buffer.from('{bad json'), 'feed.json', 'application/json')).toThrow();
    expect(() => parseAndValidateCommerceFeed(Buffer.from('[]'), 'feed.json', 'application/json')).toThrow(/recognizable product/i);
  });

  it('rejects semantically invalid commerce values and duplicate identifiers', () => {
    const result = parseAndValidateCommerceFeed(Buffer.from([
      'id,title,description,image_link,price,currency,availability',
      'sku-1,Widget,Useful widget,not-a-url,-10,US,in stock',
      'sku-1,Second,Another widget,https://example.com/two.jpg,20,USD,sometimes',
    ].join('\n')), 'products.csv', 'text/csv');

    expect(result.validItemCount).toBe(0);
    expect(result.score).toBeLessThan(100);
    expect(result.summary.validationVersion).toBe(2);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'identifier', code: 'invalid_or_duplicate', invalid: 2 }),
      expect.objectContaining({ field: 'image', code: 'invalid', invalid: 1 }),
      expect.objectContaining({ field: 'price', code: 'invalid', invalid: 1 }),
      expect.objectContaining({ field: 'currency', code: 'invalid', invalid: 1 }),
      expect.objectContaining({ field: 'availability', code: 'invalid', invalid: 1 }),
    ]));
  });
});
