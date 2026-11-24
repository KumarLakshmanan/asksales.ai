import { crawlerAccess, describeRule, explainRobots, type RobotsGroup } from './RobotsPolicy.js';
import type { AuditCrawlPage, AuditSitemapSource } from '../WebsiteCrawlerService.js';

/** Page-level SEO checks read the HTML the server returned, before any JavaScript runs. */
const SOURCE_NOTE = 'Checked in the HTML the server returns before JavaScript runs. Content added later by scripts is not visible to this check or to many crawlers.';

export const TITLE_LENGTH = { min: 20, max: 65 } as const;
export const DESCRIPTION_LENGTH = { min: 70, max: 160 } as const;

/** Properties search engines need before a structured-data type is eligible for rich results. */
const SCHEMA_RECOMMENDED: Record<string, string[][]> = {
  Organization: [['name'], ['url']],
  Corporation: [['name'], ['url']],
  LocalBusiness: [['name'], ['address']],
  Product: [['name'], ['offers', 'review', 'aggregateRating']],
  Article: [['headline']],
  BlogPosting: [['headline']],
  NewsArticle: [['headline']],
  FAQPage: [['mainEntity']],
  BreadcrumbList: [['itemListElement']],
  WebSite: [['url']],
  Event: [['name'], ['startDate'], ['location']],
};

export function normalizeAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch {
    return value.replace(/\/$/, '');
  }
}

function incompleteSchema(jsonLd: unknown[]): Array<{ type: string; missing: string[] }> {
  const findings: Array<{ type: string; missing: string[] }> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record['@graph']) visit(record['@graph']);
    const types = ([] as unknown[]).concat(record['@type'] ?? []).filter((item): item is string => typeof item === 'string');
    for (const type of types) {
      const requirements = SCHEMA_RECOMMENDED[type];
      if (!requirements) continue;
      const present = (key: string) => record[key] !== undefined && record[key] !== null && record[key] !== '';
      const missing = requirements.filter((options) => !options.some(present)).map((options) => options.join(' or '));
      if (missing.length) findings.push({ type, missing });
    }
  };
  jsonLd.forEach(visit);
  return findings;
}

export type SeoGroup =
  | 'technical'
  | 'on_page'
  | 'content'
  | 'internal_linking'
  | 'schema'
  | 'indexability';
export type SeoSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SeoIssue {
  ruleId: string;
  ruleVersion: number;
  group: SeoGroup;
  severity: SeoSeverity;
  affectedUrl?: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}

export interface SeoAnalysis {
  issues: SeoIssue[];
  subScores: Record<SeoGroup, number>;
  score: number;
}

/** Bump whenever a rule's detection or severity changes, so older measurements are labelled. */
export const SEO_RULE_VERSION = 4;
const RULE_VERSION = SEO_RULE_VERSION;
const IMPACT: Record<SeoSeverity, number> = {
  critical: 20,
  high: 12,
  medium: 7,
  low: 3,
  info: 0,
};

function issue(
  ruleId: string,
  group: SeoGroup,
  severity: SeoSeverity,
  page: AuditCrawlPage | undefined,
  evidence: Record<string, unknown>,
  recommendation: string,
): SeoIssue {
  return {
    ruleId,
    ruleVersion: RULE_VERSION,
    group,
    severity,
    affectedUrl: page?.finalUrl || page?.url,
    evidence,
    recommendation,
  };
}

export function analyzeSeo(
  pages: AuditCrawlPage[],
  site: {
    robotsAvailable: boolean;
    robotsDisallow?: string[];
    robotsPolicy?: RobotsGroup[];
    /** Why robots.txt was unusable, e.g. it answered with an HTML page. */
    robotsError?: string;
    sitemapAvailable: boolean;
    sitemapUrls?: string[];
    /** False when the sitemap inventory is partial, so a page's absence proves nothing. */
    sitemapComplete?: boolean;
    sitemapDeclaredInRobots?: boolean;
    sitemapSources?: AuditSitemapSource[];
  },
): SeoAnalysis {
  const issues: SeoIssue[] = [];
  const successful = pages.filter((page) => page.crawlStatus === 'completed');
  const normalizeUrl = normalizeAuditUrl;
  const sitemapComplete = site.sitemapComplete !== false;
  const knownPages = new Set(successful.map((page) => normalizeUrl(page.finalUrl || page.url)));
  const sitemapUrls = new Set((site.sitemapUrls || []).map(normalizeUrl));
  const robotsPolicy = site.robotsPolicy || [
    {
      agents: ['*'],
      rules: (site.robotsDisallow || []).map((path) => ({
        path,
        allow: false,
      })),
    },
  ];
  // Page indexability is a search-engine question, so robots rules are evaluated as Googlebot.
  const SEARCH_AGENT = 'Googlebot';
  const inboundLinks = new Map<string, number>();
  successful.forEach((page) => {
    const self = normalizeUrl(page.finalUrl || page.url);
    // A page linking to itself does not make it discoverable.
    new Set(page.internalLinks.map(normalizeUrl)).forEach((normalized) => {
      if (normalized !== self && knownPages.has(normalized))
        inboundLinks.set(normalized, (inboundLinks.get(normalized) || 0) + 1);
    });
  });
  const pagesWith = (value: (page: AuditCrawlPage) => string | undefined) => {
    const map = new Map<string, AuditCrawlPage[]>();
    successful.forEach((page) => {
      const key = value(page)?.trim().toLowerCase();
      if (key) map.set(key, [...(map.get(key) || []), page]);
    });
    return map;
  };
  const titleOwners = pagesWith((page) => page.title);
  const descriptionOwners = pagesWith((page) => page.metaDescription);
  for (const page of pages) {
    if (page.crawlStatus !== 'completed') {
      issues.push(
        issue(
          'crawl.page_unavailable',
          'technical',
          page.statusCode && page.statusCode >= 500 ? 'high' : 'medium',
          page,
          {
            crawlStatus: page.crawlStatus,
            statusCode: page.statusCode,
            error: page.error,
          },
          'Restore public crawler access or resolve the response error, then re-run the audit.',
        ),
      );
      continue;
    }
    if (!page.title)
      issues.push(
        issue(
          'metadata.missing_title',
          'on_page',
          'high',
          page,
          { source: SOURCE_NOTE },
          'Add a unique, descriptive HTML title.',
        ),
      );
    else if (page.title.length < TITLE_LENGTH.min || page.title.length > TITLE_LENGTH.max)
      issues.push(
        issue(
          'metadata.title_length',
          'on_page',
          'low',
          page,
          {
            length: page.title.length,
            title: page.title,
            problem: page.title.length < TITLE_LENGTH.min ? 'too_short' : 'too_long',
            recommendedRange: `${TITLE_LENGTH.min}–${TITLE_LENGTH.max} characters`,
          },
          page.title.length < TITLE_LENGTH.min
            ? `Expand the title to at least ${TITLE_LENGTH.min} characters so it describes the page, not just the brand.`
            : `Shorten the title to ${TITLE_LENGTH.max} characters or fewer so search results do not cut it off.`,
        ),
      );
    if (page.title) {
      const owners = titleOwners.get(page.title.trim().toLowerCase()) || [];
      if (owners.length > 1)
        issues.push(
          issue(
            'metadata.duplicate_title',
            'on_page',
            'medium',
            page,
            { title: page.title, duplicateUrls: owners.map((item) => item.finalUrl || item.url) },
            'Give each page its own title that names what is different about it.',
          ),
        );
    }
    if (!page.metaDescription)
      issues.push(
        issue(
          'metadata.missing_description',
          'on_page',
          'medium',
          page,
          { source: SOURCE_NOTE },
          'Add a useful meta description that matches the page intent.',
        ),
      );
    else {
      const length = page.metaDescription.length;
      if (length < DESCRIPTION_LENGTH.min || length > DESCRIPTION_LENGTH.max)
        issues.push(
          issue(
            'metadata.description_length',
            'on_page',
            'low',
            page,
            {
              length,
              description: page.metaDescription,
              problem: length < DESCRIPTION_LENGTH.min ? 'too_short' : 'too_long',
              recommendedRange: `${DESCRIPTION_LENGTH.min}–${DESCRIPTION_LENGTH.max} characters`,
            },
            length < DESCRIPTION_LENGTH.min
              ? `Expand the meta description to at least ${DESCRIPTION_LENGTH.min} characters with a specific summary of the page.`
              : `Shorten the meta description to ${DESCRIPTION_LENGTH.max} characters or fewer so it is not truncated in results.`,
          ),
        );
      const owners = descriptionOwners.get(page.metaDescription.trim().toLowerCase()) || [];
      if (owners.length > 1)
        issues.push(
          issue(
            'metadata.duplicate_description',
            'on_page',
            'low',
            page,
            {
              description: page.metaDescription,
              duplicateUrls: owners.map((item) => item.finalUrl || item.url),
            },
            'Write a distinct meta description for each page instead of reusing one template.',
          ),
        );
    }
    const h1s = page.headings.h1 || [];
    if (h1s.length === 0)
      issues.push(
        issue(
          'headings.missing_h1',
          'on_page',
          'high',
          page,
          {
            h1Count: 0,
            otherHeadings: Object.fromEntries(
              ['h2', 'h3'].map((tag) => [tag, (page.headings[tag] || []).length]),
            ),
            source: SOURCE_NOTE,
          },
          'Add one clear H1 that states the page subject.',
        ),
      );
    if (h1s.length > 1)
      issues.push(
        issue(
          'headings.multiple_h1',
          'on_page',
          'low',
          page,
          { count: h1s.length, headings: h1s },
          'Use one primary H1 and organize supporting topics under H2/H3 headings.',
        ),
      );
    if (page.wordCount < 200)
      issues.push(
        issue(
          'content.thin',
          'content',
          'medium',
          page,
          { wordCount: page.wordCount },
          'Expand the page with original, useful information that fully answers its search intent.',
        ),
      );
    if (!page.canonicalUrl)
      issues.push(
        issue(
          'canonical.missing',
          'indexability',
          'medium',
          page,
          {},
          'Add a self-referencing or intentional canonical URL.',
        ),
      );
    else if (
      page.canonicalUrl !== page.finalUrl &&
      normalizeUrl(page.canonicalUrl) !== normalizeUrl(page.finalUrl || page.url)
    ) {
      issues.push(
        issue(
          'canonical.mismatch',
          'indexability',
          'medium',
          page,
          {
            canonicalUrl: page.canonicalUrl,
            finalUrl: page.finalUrl || page.url,
          },
          'Point the canonical URL to this page unless a deliberate consolidation is documented.',
        ),
      );
    }
    if (!page.indexable)
      issues.push(
        issue(
          'indexability.noindex',
          'indexability',
          page.pageType === 'homepage' ? 'critical' : 'high',
          page,
          { robotsDirective: page.robotsDirective },
          'Remove the noindex directive if this page should appear in search and AI retrieval.',
        ),
      );
    if (page.imageCount > 0 && page.imagesMissingAlt > 0)
      issues.push(
        issue(
          'images.missing_alt',
          'on_page',
          'low',
          page,
          {
            imageCount: page.imageCount,
            missingAlt: page.imagesMissingAlt,
            elements: page.missingAltElements || [],
            evidenceComplete: Boolean(page.missingAltElements?.length),
          },
          'Add accurate alternative text to meaningful images.',
        ),
      );
    const jsonLdErrors = page.jsonLdErrors || [];
    if (jsonLdErrors.length > 0)
      issues.push(
        issue(
          'schema.invalid_json_ld',
          'schema',
          'high',
          page,
          { errors: jsonLdErrors },
          'Repair malformed or incomplete JSON-LD so it declares a valid schema.org context and type.',
        ),
      );
    if (page.schemaTypes.length === 0 && jsonLdErrors.length === 0)
      issues.push(
        issue(
          'schema.missing',
          'schema',
          'medium',
          page,
          { formatsChecked: ['JSON-LD', 'Microdata', 'RDFa'], source: SOURCE_NOTE },
          'Add valid JSON-LD appropriate to the page and business type.',
        ),
      );
    const incomplete = incompleteSchema(page.jsonLd || []);
    if (incomplete.length)
      issues.push(
        issue(
          'schema.incomplete',
          'schema',
          'low',
          page,
          { types: incomplete },
          'Fill in the listed properties so search engines and AI assistants can use this structured data.',
        ),
      );
    if (page.internalLinks.length === 0 && page.pageType !== 'homepage')
      issues.push(
        issue(
          'links.no_internal_links',
          'internal_linking',
          'medium',
          page,
          {},
          'Add relevant internal links that connect this page to related topics and conversion pages.',
        ),
      );
    if (
      page.pageType !== 'homepage' &&
      !inboundLinks.get(normalizeUrl(page.finalUrl || page.url))
    ) {
      issues.push(
        issue(
          'links.orphan_page',
          'internal_linking',
          'medium',
          page,
          {},
          'Add an internal link from a relevant crawled page so this page is discoverable to visitors and crawlers.',
        ),
      );
    }
    const linkChecks = page.linkChecks || [];
    const brokenChecks = linkChecks.filter((check) => check.status === 'broken');
    const unavailableChecks = linkChecks.filter((check) => check.status === 'unavailable');
    // A link is reported once: single hops as redirecting, multi-hop as a redirect chain.
    const redirectingChecks = linkChecks.filter(
      (check) => check.status === 'ok' && check.redirectCount === 1,
    );
    const redirectChains = linkChecks.filter(
      (check) => check.status === 'ok' && check.redirectCount > 1,
    );
    if ((page.brokenLinks || []).length > 0)
      issues.push(
        issue(
          'links.broken',
          'technical',
          'high',
          page,
          { links: page.brokenLinks, checks: brokenChecks },
          'Repair or remove links whose verified public targets return an error response.',
        ),
      );
    if (redirectingChecks.length > 0)
      issues.push(
        issue(
          'links.redirecting',
          'technical',
          'low',
          page,
          { checks: redirectingChecks },
          'Update internal links to point directly to their verified final destinations.',
        ),
      );
    if (redirectChains.length > 0)
      issues.push(
        issue(
          'links.redirect_chain',
          'technical',
          'medium',
          page,
          { checks: redirectChains },
          'Replace links that traverse multiple redirects with their verified final destinations.',
        ),
      );
    if (unavailableChecks.length > 0)
      issues.push(
        issue(
          'links.unverified',
          'technical',
          'info',
          page,
          { checks: unavailableChecks },
          'Recheck these links later; network or access failures prevented a verified status and were not treated as broken.',
        ),
      );
    if (page.redirectCount > 1)
      issues.push(
        issue(
          'redirect.chain',
          'technical',
          'medium',
          page,
          {
            redirectCount: page.redirectCount,
            redirectChain: page.redirectChain || [],
            evidenceComplete: page.redirectChain?.length === page.redirectCount,
          },
          'Replace redirect chains with one direct redirect to the final canonical URL.',
        ),
      );
    const normalizedPageUrl = normalizeUrl(page.finalUrl || page.url);
    if (site.sitemapAvailable && sitemapUrls.size > 0) {
      const requestedInSitemap = sitemapUrls.has(normalizeUrl(page.url));
      if (requestedInSitemap && normalizeUrl(page.url) !== normalizedPageUrl)
        issues.push(
          issue(
            'sitemap.redirecting_url',
            'indexability',
            'low',
            page,
            { sitemapUrl: page.url, finalUrl: page.finalUrl || page.url },
            'List the final URL in the sitemap instead of a URL that redirects.',
          ),
        );
      if (
        sitemapUrls.has(normalizedPageUrl) &&
        page.canonicalUrl &&
        normalizeUrl(page.canonicalUrl) !== normalizedPageUrl
      )
        issues.push(
          issue(
            'sitemap.non_canonical_url',
            'indexability',
            'medium',
            page,
            { sitemapUrl: page.finalUrl || page.url, canonicalUrl: page.canonicalUrl },
            'List only canonical URLs in the sitemap, or point this page’s canonical to itself.',
          ),
        );
      if (sitemapUrls.has(normalizedPageUrl) && !page.indexable)
        issues.push(
          issue(
            'sitemap.noindex_url',
            'indexability',
            'high',
            page,
            { robotsDirective: page.robotsDirective },
            'Remove this URL from the sitemap or make the page indexable.',
          ),
        );
      // Only claim a page is missing when every sitemap file was read.
      if (
        sitemapComplete &&
        !sitemapUrls.has(normalizedPageUrl) &&
        !sitemapUrls.has(normalizeUrl(page.url)) &&
        page.indexable &&
        page.pageType !== 'homepage'
      )
        issues.push(
          issue(
            'sitemap.missing_indexable_page',
            'indexability',
            'low',
            page,
            { sitemapUrlsRead: sitemapUrls.size },
            'Add this important indexable page to the XML sitemap if it should be discovered by search engines.',
          ),
        );
    }
    const robotsDecision = explainRobots(page.finalUrl || page.url, robotsPolicy, SEARCH_AGENT);
    if (!robotsDecision.allowed)
      issues.push(
        issue(
          'robots.disallowed_page',
          'indexability',
          page.indexable ? 'high' : 'medium',
          page,
          {
            evaluatedAs: SEARCH_AGENT,
            matchedRule: describeRule(robotsDecision.rule),
            robotsTxtLine: robotsDecision.rule?.line,
            userAgentGroup: robotsDecision.group.join(', '),
            testedPath: (() => {
              try {
                const url = new URL(page.finalUrl || page.url);
                return url.pathname + url.search;
              } catch {
                return page.finalUrl || page.url;
              }
            })(),
          },
          'Align robots.txt, sitemap inclusion, canonical ownership, and page-level indexability for this URL.',
        ),
      );
  }
  // A sitemap URL that the crawl could not open sends crawlers to a dead end.
  if (site.sitemapAvailable && sitemapUrls.size > 0)
    for (const page of pages) {
      if (page.crawlStatus === 'completed' || !page.statusCode || page.statusCode < 400) continue;
      if (!sitemapUrls.has(normalizeUrl(page.url))) continue;
      issues.push(
        issue(
          'sitemap.error_url',
          'indexability',
          'high',
          page,
          { statusCode: page.statusCode, crawlStatus: page.crawlStatus },
          'Remove this URL from the sitemap or restore the page so it returns 200.',
        ),
      );
    }
  const hashes = new Map<string, AuditCrawlPage[]>();
  successful.forEach((page) => {
    if (!page.contentHash) return;
    hashes.set(page.contentHash, [...(hashes.get(page.contentHash) || []), page]);
  });
  for (const duplicatePages of hashes.values()) {
    if (duplicatePages.length > 1) {
      for (const page of duplicatePages)
        issues.push(
          issue(
            'content.duplicate',
            'content',
            'high',
            page,
            {
              duplicateUrls: duplicatePages.map((item) => item.finalUrl || item.url),
            },
            'Consolidate duplicate pages or clarify canonical ownership with distinct content.',
          ),
        );
    }
  }
  if (!site.robotsAvailable)
    issues.push(
      issue(
        'site.robots_unavailable',
        'technical',
        'low',
        undefined,
        site.robotsError ? { error: site.robotsError } : {},
        'Publish a reachable robots.txt with intentional crawler directives.',
      ),
    );
  const failedSitemaps = (site.sitemapSources || []).filter(
    (source) => source.kind !== 'urlset' && source.kind !== 'sitemapindex',
  );
  if (!site.sitemapAvailable)
    issues.push(
      issue(
        'site.sitemap_unavailable',
        'technical',
        'medium',
        undefined,
        failedSitemaps.length ? { sitemapsTried: failedSitemaps } : {},
        'Publish a valid XML sitemap and reference it from robots.txt.',
      ),
    );
  else {
    if (!sitemapComplete && failedSitemaps.length)
      issues.push(
        issue(
          'site.sitemap_partial',
          'technical',
          'low',
          undefined,
          { unreadSitemaps: failedSitemaps },
          'Fix or remove sitemap files that cannot be read; pages listed only in them are invisible to crawlers that rely on the sitemap.',
        ),
      );
    if (site.robotsAvailable && site.sitemapDeclaredInRobots === false)
      issues.push(
        issue(
          'site.sitemap_not_in_robots',
          'technical',
          'low',
          undefined,
          {},
          'Add a "Sitemap: https://…/sitemap.xml" line to robots.txt so every crawler can find the sitemap.',
        ),
      );
  }
  // AI answer engines can only cite pages their crawlers are allowed to fetch.
  if (site.robotsAvailable && robotsPolicy.length) {
    const homepage = successful.find((page) => page.pageType === 'homepage') || pages[0];
    const homepageUrl = homepage ? homepage.finalUrl || homepage.url : undefined;
    const blocked = homepageUrl
      ? crawlerAccess(homepageUrl, robotsPolicy).filter(
          (access) => !access.allowed && access.purpose !== 'search',
        )
      : [];
    if (blocked.length)
      issues.push(
        issue(
          'robots.ai_crawler_blocked',
          'indexability',
          blocked.some((access) => access.purpose !== 'ai_training') ? 'high' : 'low',
          undefined,
          { evaluatedUrl: homepageUrl, crawlers: blocked },
          blocked.some((access) => access.purpose !== 'ai_training')
            ? 'Allow AI search crawlers (such as OAI-SearchBot, PerplexityBot and Claude-SearchBot) in robots.txt so AI assistants can read and cite this site.'
            : 'Only AI training crawlers are blocked. Keep this if it is deliberate; it does not stop AI search assistants from citing the site.',
        ),
      );
  }

  const groups: SeoGroup[] = [
    'technical',
    'on_page',
    'content',
    'internal_linking',
    'schema',
    'indexability',
  ];
  const subScores = Object.fromEntries(
    groups.map((group) => {
      // Version 2: average page-level penalties, plus site-wide penalties.
      // A repeated template issue does not make a larger sampled site inherently worse.
      const groupIssues = issues.filter((item) => item.group === group);
      const perPage =
        groupIssues
          .filter((item) => item.affectedUrl)
          .reduce((sum, item) => sum + IMPACT[item.severity], 0) / Math.max(1, pages.length);
      const siteWide = groupIssues
        .filter((item) => !item.affectedUrl)
        .reduce((sum, item) => sum + IMPACT[item.severity], 0);
      const penalty = perPage + siteWide;
      return [group, Math.max(0, Math.round(100 - penalty))];
    }),
  ) as Record<SeoGroup, number>;
  const score =
    successful.length === 0
      ? 0
      : Math.round(Object.values(subScores).reduce((sum, value) => sum + value, 0) / groups.length);
  return { issues, subScores, score };
}
