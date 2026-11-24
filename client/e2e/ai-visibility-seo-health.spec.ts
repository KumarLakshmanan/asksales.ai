import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { Page } from '@playwright/test';
import { join } from 'node:path';

// Synthetic, read-only SEO data. No crawl, provider call or mutation runs.
const project = {
  id: 1, name: 'Synthetic website', domain: 'https://example.test', workspaceId: 3,
  workspace: { role: 'owner', workspaceName: 'Synthetic workspace', workspaceKind: 'private' },
  source: 'website_search', scoringProfile: 'general', country: 'US', locale: 'en-US',
  monitoringEnabled: false, geoPrompts: [], brandAliases: [], configurationRevision: 1,
};
const audit = {
  id: 29, projectId: 1, status: 'completed', trigger: 'manual', warningCount: 0, error: null,
  cancellationRequested: false, summary: {}, inputSnapshot: {}, createdAt: '2026-11-18T09:00:00Z', completedAt: '2026-11-18T09:03:00Z',
};
const pageUrls = Array.from({ length: 25 }, (_, index) => (index === 0 ? 'https://example.test/' : `https://example.test/page-${index}`));
const pages = pageUrls.map((url, index) => ({
  id: index + 1, url, finalUrl: url, crawlStatus: index === 24 ? 'blocked' : index === 23 ? 'failed' : 'completed',
  statusCode: index === 24 ? 403 : index === 23 ? 404 : 200,
  title: index === 0 ? 'Example | Home' : `Example page ${index} with a descriptive title`,
  metaDescription: index % 3 ? 'A specific description of this page that explains exactly what a visitor will learn here.' : null,
  canonicalUrl: url, indexable: true, wordCount: 180 + index * 40, imageCount: 4, imagesMissingAlt: index % 4 ? 0 : 2,
  headings: { h1: index % 5 ? ['Heading'] : [], h2: ['Section'] }, schemaTypes: index % 2 ? ['Organization'] : [],
  pageType: index === 0 ? 'homepage' : 'other', robotsDirective: null, error: index === 24 ? 'HTTP 403 Forbidden' : null,
}));
let nextId = 1;
const finding = (ruleId: string, group: string, severity: string, affectedUrl: string | null, evidence: Record<string, unknown>, recommendation: string) =>
  ({ id: nextId++, ruleId, ruleVersion: 4, group, severity, affectedUrl, evidence, recommendation });
const issues = [
  finding('metadata.title_length', 'on_page', 'low', pageUrls[0], { length: 14, title: 'Example | Home', problem: 'too_short', recommendedRange: '20–65 characters' }, 'Expand the title to at least 20 characters so it describes the page, not just the brand.'),
  ...pages.filter((item) => item.crawlStatus === 'completed' && !item.metaDescription).map((item) => finding('metadata.missing_description', 'on_page', 'medium', item.url, {}, 'Add a useful meta description that matches the page intent.')),
  ...pages.filter((item) => item.crawlStatus === 'completed' && !item.headings.h1.length).map((item) => finding('headings.missing_h1', 'on_page', 'high', item.url, { h1Count: 0 }, 'Add one clear H1 that states the page subject.')),
  ...pages.filter((item) => item.crawlStatus === 'completed' && item.imagesMissingAlt).map((item) => finding('images.missing_alt', 'on_page', 'low', item.url, { imageCount: 4, missingAlt: 2 }, 'Add accurate alternative text to meaningful images.')),
  ...pages.filter((item) => item.crawlStatus === 'completed' && !item.schemaTypes.length).map((item) => finding('schema.missing', 'schema', 'medium', item.url, {}, 'Add valid JSON-LD appropriate to the page and business type.')),
  finding('robots.disallowed_page', 'indexability', 'high', pageUrls[7], { evaluatedAs: 'Googlebot', matchedRule: 'Disallow: /page-7', robotsTxtLine: 4, userAgentGroup: '*', testedPath: '/page-7' }, 'Align robots.txt, sitemap inclusion, canonical ownership, and page-level indexability for this URL.'),
  finding('links.broken', 'technical', 'high', pageUrls[3], { links: ['https://example.test/missing'] }, 'Repair or remove links whose verified public targets return an error response.'),
  finding('sitemap.error_url', 'indexability', 'high', pageUrls[23], { statusCode: 404 }, 'Remove this URL from the sitemap or restore the page so it returns 200.'),
  finding('robots.ai_crawler_blocked', 'indexability', 'high', null, { crawlers: [{ crawler: 'PerplexityBot', rule: 'Disallow: /' }] }, 'Allow AI search crawlers in robots.txt so AI assistants can read and cite this site.'),
  finding('links.unverified', 'technical', 'info', pageUrls[2], {}, 'Recheck these links later.'),
];
const site = {
  score: 68,
  subScores: { technical: 82, on_page: 41, content: 88, internal_linking: 95, schema: 52, indexability: 61 },
  robots: { available: true, error: null, groups: 3, rules: 7 },
  sitemap: {
    available: true, urlCount: 142, complete: true, declaredInRobots: false,
    sources: [
      { url: 'https://example.test/sitemap.xml', statusCode: 200, kind: 'sitemapindex', urlCount: 2 },
      { url: 'https://example.test/page-sitemap.xml', statusCode: 200, kind: 'urlset', urlCount: 120 },
      { url: 'https://example.test/post-sitemap.xml', statusCode: 200, kind: 'urlset', urlCount: 22 },
    ],
  },
  discoveredPages: 168, pageLimit: 25, checkedLinks: 50,
  crawlerAccess: [
    { crawler: 'Googlebot', owner: 'Google', purpose: 'search', allowed: true, group: ['*'] },
    { crawler: 'Bingbot', owner: 'Microsoft', purpose: 'search', allowed: true, group: ['*'] },
    { crawler: 'OAI-SearchBot', owner: 'OpenAI', purpose: 'ai_search', allowed: true, group: ['*'] },
    { crawler: 'ChatGPT-User', owner: 'OpenAI', purpose: 'ai_user', allowed: true, group: ['*'] },
    { crawler: 'PerplexityBot', owner: 'Perplexity', purpose: 'ai_search', allowed: false, rule: 'Disallow: /', line: 9, group: ['perplexitybot'] },
    { crawler: 'Claude-SearchBot', owner: 'Anthropic', purpose: 'ai_search', allowed: true, group: ['*'] },
    { crawler: 'GPTBot', owner: 'OpenAI', purpose: 'ai_training', allowed: false, rule: 'Disallow: /', line: 12, group: ['gptbot'] },
    { crawler: 'ClaudeBot', owner: 'Anthropic', purpose: 'ai_training', allowed: true, group: ['*'] },
    { crawler: 'Google-Extended', owner: 'Google', purpose: 'ai_training', allowed: true, group: ['*'] },
    { crawler: 'CCBot', owner: 'Common Crawl', purpose: 'ai_training', allowed: true, group: ['*'] },
  ],
  crawlerAccessUrl: 'https://example.test/',
};

async function installSeoData(page: Page, baseURL: string) {
  const writes: string[] = [];
  await page.context().addCookies([{ name: 'connect.sid', value: 'synthetic-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${path}`);
      return json({ error: 'Mutations are blocked in this synthetic check.' }, 409);
    }
    if (!path.startsWith('/api/ai-visibility/')) return route.fallback();
    if (path === '/api/ai-visibility/projects') return json({ projects: [project] });
    if (path === '/api/ai-visibility/projects/1') return json({ project });
    if (path.endsWith('/overview')) return json({ project, measurementAudit: audit, latestAudit: audit, latestScore: null, openRecommendations: 3 });
    if (path.endsWith('/audits')) return json({ audits: [audit] });
    if (path.endsWith('/audits/estimate')) return json({ estimate: null });
    if (path.endsWith('/providers')) return json({ providers: [] });
    if (path.endsWith('/alerts')) return json({ alerts: [] });
    if (path.endsWith('/seo')) return json({ audit, issues, pages, site });
    if (path.endsWith('/recommendations')) return json({ recommendations: [] });
    if (path.endsWith('/gsc')) return json({ connected: false, available: false, unavailableReason: 'Search Console is not connected.', connection: null, snapshots: [], rows: [], opportunities: [] });
    return json({});
  });
  return writes;
}

test('SEO health charts, filters and rule-level evidence render without overflow', async ({ page, baseURL }, testInfo) => {
  const writes = await installSeoData(page, baseURL!);
  await page.goto('/dashboard/ai-visibility/websites/1/seo');
  await expect(page.getByRole('img', { name: 'SEO score 68 out of 100' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Crawler access and site files' })).toBeVisible();
  const evidenceDir = process.env.SEO_EVIDENCE_DIR;
  const shot = async (name: string) => testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true, path: evidenceDir ? join(evidenceDir, `${testInfo.project.name}-${name}.png`) : undefined }),
    contentType: 'image/png',
  });
  await shot('seo-overview');
  await expectNoHorizontalOverflow(page);
  for (const [name, region] of [
    ['seo-severity-crawl', page.getByRole('region', { name: 'Findings and crawl overview' })],
    ['seo-top-issues', page.getByRole('heading', { name: 'Top issues to fix' }).locator('xpath=ancestor::div[contains(@class,"rounded")][1]')],
    ['seo-crawler-access', page.getByRole('region', { name: 'Crawler access and site files' })],
  ] as const) {
    await region.scrollIntoViewIfNeeded();
    await testInfo.attach(name, {
      body: await region.screenshot({ path: evidenceDir ? join(evidenceDir, `${testInfo.project.name}-${name}.png`) : undefined }),
      contentType: 'image/png',
    });
  }

  await page.getByRole('button', { name: /Page blocked by robots.txt/ }).click();
  await page.getByText('Page blocked by robots.txt', { exact: true }).last().click();
  await page.getByRole('button', { name: /Align robots.txt/ }).click();
  const evidence = page.getByRole('complementary', { name: 'Finding evidence' });
  await expect(evidence).toContainText('Disallow: /page-7');
  await expect(evidence).toContainText('line 4');
  await evidence.scrollIntoViewIfNeeded();
  await testInfo.attach('seo-robots-evidence', {
    body: await page.locator('.scroll-mt-4').screenshot({ path: evidenceDir ? join(evidenceDir, `${testInfo.project.name}-seo-robots-evidence.png`) : undefined }),
    contentType: 'image/png',
  });
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Page inventory (25)' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await shot('seo-inventory');
  expect(writes).toEqual([]);
});

test('SEO health charts stay legible in the dark theme', async ({ page, baseURL }, testInfo) => {
  await installSeoData(page, baseURL!);
  // Registered after the shared shell mocks, so this preference response wins.
  await page.route('**/api/settings/preferences', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ theme: 'dark', language: 'en', timezone: 'UTC' }) }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/dashboard/ai-visibility/websites/1/seo');
  await expect(page.getByRole('img', { name: 'SEO score 68 out of 100' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const evidenceDir = process.env.SEO_EVIDENCE_DIR;
  for (const [name, region] of [
    ['dark-summary', page.getByRole('region', { name: 'SEO summary' })],
    ['dark-severity-crawl', page.getByRole('region', { name: 'Findings and crawl overview' })],
    ['dark-crawler-access', page.getByRole('region', { name: 'Crawler access and site files' })],
  ] as const) {
    await region.scrollIntoViewIfNeeded();
    await testInfo.attach(name, {
      body: await region.screenshot({ path: evidenceDir ? join(evidenceDir, `${testInfo.project.name}-${name}.png`) : undefined }),
      contentType: 'image/png',
    });
  }
  await expectNoHorizontalOverflow(page);
});
