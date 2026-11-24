import { crawlerAccess, type RobotsGroup } from './RobotsPolicy.js';
import { SEO_RULE_VERSION } from './SeoEngine.js';

/**
 * The SEO rule version a measurement was produced with: the version stored on the
 * seo_analysis stage (recorded from rule version 4), otherwise the newest version on
 * its stored issues. Null when neither exists (an older measurement with no findings).
 */
export function measurementRuleVersion(
  seo: Record<string, unknown>,
  issueRuleVersions: Array<number | null | undefined>,
): number | null {
  if (typeof seo.ruleVersion === 'number') return seo.ruleVersion;
  const versions = issueRuleVersions.filter((value): value is number => typeof value === 'number');
  return versions.length ? Math.max(...versions) : null;
}

interface SummaryPage {
  pageType: string | null;
  crawlStatus: string;
  url: string;
  finalUrl?: string | null;
}

/**
 * Site-level SEO facts for one measurement, read from the stored brand_crawl and
 * seo_analysis stage outputs.
 *
 * Measurements recorded before rule-level robots evidence existed stored only
 * `robotsDisallow`, not the parsed `robotsPolicy`. For those, rule counts and crawler
 * access are unknown (null), never evaluated against an empty policy: an empty policy
 * would report every crawler as allowed even when the site's robots.txt blocks some.
 */
export function buildSeoSiteSummary(
  crawl: Record<string, unknown>,
  seo: Record<string, unknown>,
  pages: SummaryPage[],
  issueRuleVersions: Array<number | null | undefined> = [],
) {
  const robotsPolicy = Array.isArray(crawl.robotsPolicy) ? (crawl.robotsPolicy as RobotsGroup[]) : null;
  const ruleVersion = measurementRuleVersion(seo, issueRuleVersions);
  const homepage =
    pages.find((page) => page.pageType === 'homepage' && page.crawlStatus === 'completed') || pages[0];
  const homepageUrl = homepage ? homepage.finalUrl || homepage.url : null;
  return {
    score: typeof seo.score === 'number' ? seo.score : null,
    subScores:
      seo.subScores && typeof seo.subScores === 'object' ? (seo.subScores as Record<string, number>) : null,
    robots: {
      available: crawl.robotsAvailable === true,
      error: typeof crawl.robotsError === 'string' ? crawl.robotsError : null,
      groups: robotsPolicy ? robotsPolicy.length : null,
      rules: robotsPolicy ? robotsPolicy.reduce((sum, group) => sum + group.rules.length, 0) : null,
    },
    sitemap: {
      available: crawl.sitemapAvailable === true,
      urlCount:
        typeof crawl.sitemapUrlCount === 'number'
          ? crawl.sitemapUrlCount
          : Array.isArray(crawl.sitemapUrls)
            ? crawl.sitemapUrls.length
            : 0,
      complete: typeof crawl.sitemapComplete === 'boolean' ? crawl.sitemapComplete : null,
      declaredInRobots:
        typeof crawl.sitemapDeclaredInRobots === 'boolean' ? crawl.sitemapDeclaredInRobots : null,
      sources: Array.isArray(crawl.sitemapSources) ? crawl.sitemapSources : [],
    },
    discoveredPages: typeof crawl.discoveredPages === 'number' ? crawl.discoveredPages : null,
    pageLimit: typeof crawl.pageLimit === 'number' ? crawl.pageLimit : null,
    checkedLinks: typeof crawl.checkedLinks === 'number' ? crawl.checkedLinks : null,
    crawlerAccess:
      crawl.robotsAvailable === true && homepageUrl && robotsPolicy
        ? crawlerAccess(homepageUrl, robotsPolicy)
        : null,
    crawlerAccessUrl: homepageUrl,
    ruleVersion,
    currentRuleVersion: SEO_RULE_VERSION,
    /** True when the measurement used older checks than a new analysis would. */
    rulesOutdated: ruleVersion !== null && ruleVersion < SEO_RULE_VERSION,
  };
}
