import { describe, expect, it } from '@jest/globals';
import { buildSeoSiteSummary, measurementRuleVersion } from '../services/aiVisibility/SeoSiteSummary.js';
import { SEO_RULE_VERSION } from '../services/aiVisibility/SeoEngine.js';
import { parseRobotsPolicy } from '../services/aiVisibility/RobotsPolicy.js';

const pages = [
  { pageType: 'homepage', crawlStatus: 'completed', url: 'https://example.com', finalUrl: 'https://example.com/' },
];

describe('SEO site summary', () => {
  it('evaluates crawler access from the stored robots policy', () => {
    const robotsPolicy = parseRobotsPolicy('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /');
    const site = buildSeoSiteSummary({ robotsAvailable: true, robotsPolicy }, {}, pages);

    expect(site.robots).toMatchObject({ available: true, groups: 2, rules: 2 });
    expect(site.crawlerAccessUrl).toBe('https://example.com/');
    expect(site.crawlerAccess?.find((item) => item.crawler === 'GPTBot')?.allowed).toBe(false);
    expect(site.crawlerAccess?.find((item) => item.crawler === 'Googlebot')?.allowed).toBe(true);
  });

  it('treats an empty robots.txt as recorded with no rules', () => {
    const site = buildSeoSiteSummary({ robotsAvailable: true, robotsPolicy: [] }, {}, pages);

    expect(site.robots).toMatchObject({ groups: 0, rules: 0 });
    expect(site.crawlerAccess?.every((item) => item.allowed)).toBe(true);
  });

  it('does not report crawlers as allowed for measurements that stored no robots policy', () => {
    // Audits recorded before rule-level robots evidence kept only robotsDisallow.
    const legacyCrawl = {
      robotsAvailable: true,
      robotsDisallow: ['/wp-content/uploads/wpo/wpo-plugins-tables-list.json'],
      sitemapAvailable: true,
      sitemapUrls: ['https://example.com/', 'https://example.com/about'],
    };
    const site = buildSeoSiteSummary(legacyCrawl, { score: 79 }, pages);

    expect(site.robots).toEqual({ available: true, error: null, groups: null, rules: null });
    expect(site.crawlerAccess).toBeNull();
    expect(site.sitemap).toMatchObject({ available: true, urlCount: 2, complete: null, declaredInRobots: null });
    expect(site.score).toBe(79);
  });

  it('labels measurements made with older SEO checks', () => {
    expect(buildSeoSiteSummary({}, { ruleVersion: SEO_RULE_VERSION }, pages)).toMatchObject({
      ruleVersion: SEO_RULE_VERSION,
      currentRuleVersion: SEO_RULE_VERSION,
      rulesOutdated: false,
    });
    // Before the stage recorded its version, the issues carried it.
    expect(buildSeoSiteSummary({}, { score: 79 }, pages, [2, 2, null])).toMatchObject({
      ruleVersion: 2,
      rulesOutdated: true,
    });
    // An older measurement without findings has no version to compare.
    expect(buildSeoSiteSummary({}, { score: 100 }, pages, [])).toMatchObject({
      ruleVersion: null,
      rulesOutdated: false,
    });
  });

  it('prefers the version stored on the analysis over issue versions', () => {
    expect(measurementRuleVersion({ ruleVersion: 4 }, [2])).toBe(4);
    expect(measurementRuleVersion({}, [3, 2])).toBe(3);
    expect(measurementRuleVersion({}, [])).toBeNull();
  });

  it('leaves crawler access empty when robots.txt could not be read', () => {
    const site = buildSeoSiteSummary({ robotsAvailable: false, robotsError: 'HTTP 500' }, {}, pages);

    expect(site.robots).toMatchObject({ available: false, error: 'HTTP 500' });
    expect(site.crawlerAccess).toBeNull();
  });
});
