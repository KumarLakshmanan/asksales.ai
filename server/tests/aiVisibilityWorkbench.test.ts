import { describe, expect, it } from '@jest/globals';
import { parseRobotsPolicy, robotsAllows } from '../services/aiVisibility/RobotsPolicy.js';
import {
  latestCompletedAudit,
  isFirstPartyCitation,
  providerCoverage,
  isProviderAvailabilityFailure,
} from '../services/aiVisibility/measurement.js';
import {
  recommendationKey,
  reconcileRecommendations,
} from '../services/aiVisibility/RecommendationWorkflow.js';
import { parseAndValidateCommerceFeed } from '../services/aiVisibility/CommerceFeedService.js';
import { generateAuditPrompts } from '../services/aiVisibility/PromptEngine.js';
import { analyzeSeo } from '../services/aiVisibility/SeoEngine.js';
import type { AuditCrawlPage } from '../services/WebsiteCrawlerService.js';

const page = (overrides: Partial<AuditCrawlPage> = {}): AuditCrawlPage => ({
  url: 'https://example.com/',
  crawlStatus: 'completed',
  statusCode: 200,
  redirectCount: 0,
  title: 'A descriptive example page title',
  metaDescription: 'A useful description of the example page that explains what visitors will find.',
  canonicalUrl: 'https://example.com/',
  indexable: true,
  headings: { h1: ['Example'] },
  wordCount: 500,
  imageCount: 0,
  imagesMissingAlt: 0,
  internalLinks: [],
  externalLinks: [],
  brokenLinks: [],
  linkChecks: [],
  jsonLd: [],
  jsonLdErrors: [],
  schemaTypes: ['Organization'],
  pageType: 'homepage',
  ...overrides,
});
const finding = (overrides: Record<string, unknown> = {}) => ({
  auditId: 1,
  projectId: 7,
  userId: 4,
  module: 'seo',
  title: 'metadata missing title',
  severity: 'high',
  impact: 'high',
  effort: 'low',
  description: 'Add title',
  affectedUrl: 'https://example.com/page',
  evidence: { ruleId: 'metadata.missing_title' },
  status: 'open' as const,
  ...overrides,
});

describe('AI Visibility measurement and workbench regressions', () => {
  it('keeps a completed snapshot while newer attempts run or fail', () => {
    const audits = [
      { id: 1, status: 'completed', createdAt: '2026-01-01' },
      { id: 2, status: 'completed_with_warnings', createdAt: '2026-01-02' },
      { id: 3, status: 'running', createdAt: '2026-01-03' },
      { id: 4, status: 'failed', createdAt: '2026-01-04' },
    ];
    expect(latestCompletedAudit(audits)?.id).toBe(2);
    expect(latestCompletedAudit(audits.slice(2))).toBeUndefined();
    expect(audits.map((audit) => audit.id)).toEqual([1, 2, 3, 4]);
  });
  it('reports the historic 1-of-3 and 4-of-12 sample without inflating provider coverage', () => {
    const runs = ['openai', 'gemini', 'perplexity'].flatMap((provider) =>
      Array.from({ length: 4 }, () => ({
        provider,
        status: provider === 'perplexity' ? 'completed' : 'failed',
        extractionStatus: 'completed',
        citations: provider === 'perplexity' ? [{ url: 'https://example.com/' }] : [],
      })),
    );
    expect(providerCoverage(runs)).toMatchObject({
      attemptedProviders: 3,
      successfulProviders: 1,
      expectedObservations: 12,
      successfulObservations: 4,
      extractedObservations: 4,
      partial: true,
    });
  });
  it('excludes unconfigured observations and discloses partial extraction', () => {
    const result = providerCoverage([
      { provider: 'openai', status: 'excluded' },
      { provider: 'gemini', status: 'completed', extractionStatus: 'failed' },
    ]);
    expect(result).toMatchObject({
      attemptedProviders: 1,
      expectedObservations: 1,
      excludedObservations: 1,
      successfulObservations: 1,
      extractedObservations: 0,
      partial: true,
    });
  });
  it.each([
    'https://example.com/a',
    'https://www.example.com/a',
    'https://docs.example.com/a',
    'https://EXAMPLE.COM./a',
  ])('shares first-party ownership semantics for %s', (url) => {
    expect(isFirstPartyCitation(url, 'https://www.example.com')).toBe(true);
  });
  it.each(['https://notexample.com', 'https://example.com.evil.test', 'not a url'])(
    'rejects a first-party lookalike %s',
    (url) => {
      expect(isFirstPartyCitation(url, 'https://example.com')).toBe(false);
    },
  );
  it.each([
    'Quota exceeded',
    'Billing denied',
    'RESOURCE_EXHAUSTED',
    'Invalid API key',
    '401 unauthorized',
    'Model unavailable: model not found',
  ])('recognizes provider-wide incident: %s', (error) =>
    expect(isProviderAvailabilityFailure(error)).toBe(true),
  );
  it('does not classify a prompt-specific parse failure as a provider availability incident', () =>
    expect(isProviderAvailabilityFailure('Structured extraction JSON failed validation')).toBe(
      false,
    ));

  it('shares grouped robots rules, specific agents, wildcard matching and Allow tie-breaks', () => {
    const policy = parseRobotsPolicy(
      'User-agent: *\nDisallow: /\nUser-agent: SalesMarketingBot\nUser-agent: PartnerBot\nDisallow: /private/*\nAllow: /private/public/\nDisallow: /*.pdf$\nAllow: /same\nDisallow: /same\nUser-agent: SalesMarketingBot\nDisallow: /shared\n',
    );
    const allows = (path: string, agent = 'SalesMarketingBot/1.0') =>
      robotsAllows(`https://example.com${path}`, policy, agent);
    expect(allows('/home')).toBe(true);
    expect(allows('/private/secret')).toBe(false);
    expect(allows('/private/public/article')).toBe(true);
    expect(allows('/docs/file.pdf')).toBe(false);
    expect(allows('/docs/file.pdf?download=1')).toBe(true);
    expect(allows('/same')).toBe(true);
    expect(allows('/shared')).toBe(false);
    expect(allows('/home', 'UnknownBot')).toBe(false);
    expect(allows('/private/secret', 'PartnerBot')).toBe(false);
  });
  it('treats regular expression characters in robot paths literally', () => {
    const policy = parseRobotsPolicy('User-agent: *\nDisallow: /a+b[1]\n');
    expect(robotsAllows('https://example.com/a+b[1]/x', policy)).toBe(false);
    expect(robotsAllows('https://example.com/ab1/x', policy)).toBe(true);
  });
  it('normalizes repeated page-level penalties instead of penalizing sample size', () => {
    const first = analyzeSeo([page({ title: undefined })], {
      robotsAvailable: true,
      sitemapAvailable: true,
    });
    const forty = analyzeSeo(
      Array.from({ length: 40 }, (_, index) =>
        page({
          title: undefined,
          url: `https://example.com/${index}`,
          canonicalUrl: `https://example.com/${index}`,
          metaDescription: `A useful description of example page number ${index} explaining what visitors will find.`,
        }),
      ),
      { robotsAvailable: true, sitemapAvailable: true },
    );
    expect(forty.score).toBe(first.score);
    expect(forty.issues).toHaveLength(40);
    expect(forty.issues.every((issue) => issue.ruleVersion === 4)).toBe(true);
  });
  it('retains informational checks and complete link / image evidence', () => {
    const redirectChain = [
      {
        url: 'https://example.com/old',
        statusCode: 301,
        destination: 'https://example.com/middle',
      },
      {
        url: 'https://example.com/middle',
        statusCode: 302,
        destination: 'https://example.com/new',
      },
    ];
    const result = analyzeSeo(
      [
        page({
          imageCount: 1,
          imagesMissingAlt: 1,
          missingAltElements: [{ index: 1, source: '/image.png', html: '<img src="/image.png">' }],
          linkChecks: [
            {
              url: 'https://example.com/no',
              status: 'unavailable',
              redirectCount: 0,
              error: 'Timed out',
            },
            {
              url: 'https://example.com/old',
              status: 'ok',
              redirectCount: 2,
              redirectChain,
            },
          ],
        }),
      ],
      { robotsAvailable: true, sitemapAvailable: true },
    );
    expect(result.issues.find((issue) => issue.ruleId === 'links.unverified')?.severity).toBe(
      'info',
    );
    expect(
      result.issues.find((issue) => issue.ruleId === 'links.redirect_chain')?.evidence.checks,
    ).toEqual([expect.objectContaining({ redirectChain })]);
    expect(
      result.issues.find((issue) => issue.ruleId === 'images.missing_alt')?.evidence.elements,
    ).toEqual([expect.objectContaining({ source: '/image.png' })]);
  });
  it('retains a critical finding beyond position forty', () => {
    const findings = Array.from({ length: 81 }, (_, index) =>
      finding({
        affectedUrl: `https://example.com/${index}`,
        severity: index === 80 ? 'critical' : 'low',
      }),
    );
    const result = reconcileRecommendations(findings, [], {
      auditId: 2,
      completedUrls: [],
      siteChecksComplete: false,
    });
    expect(result).toHaveLength(81);
    expect(result[80].severity).toBe('critical');
  });
  it('carries assignment and evidence, and reopens a marked-resolved issue that persists', () => {
    const old = finding({
      status: 'resolved',
      assigneeUserId: 9,
      dueDate: '2026-09-15',
      resolutionEvidence: 'PR #23',
    });
    const result = reconcileRecommendations([finding({ auditId: 2 })], [old], {
      auditId: 2,
      completedUrls: ['https://example.com/page'],
      siteChecksComplete: true,
    });
    expect(result[0]).toMatchObject({
      status: 'open',
      verificationStatus: 'still_present',
      assigneeUserId: 9,
      dueDate: '2026-09-15',
      resolutionEvidence: 'PR #23',
    });
    expect(recommendationKey(old)).toBe(result[0].issueKey);
  });
  it('verifies disappearance only after a successful recrawl of the affected URL', () => {
    expect(
      reconcileRecommendations([], [finding()], {
        auditId: 2,
        completedUrls: [],
        siteChecksComplete: false,
      })[0],
    ).toMatchObject({ status: 'open', verificationStatus: 'not_rechecked' });
    expect(
      reconcileRecommendations([], [finding()], {
        auditId: 2,
        completedUrls: ['https://example.com/page'],
        siteChecksComplete: true,
      })[0],
    ).toMatchObject({ status: 'resolved', verificationStatus: 'verified' });
  });
  it('does not verify a broken-link fix when the destination check was omitted or failed', () => {
    const old = finding({
      title: 'links broken',
      evidence: {
        ruleId: 'links.broken',
        links: ['https://example.com/broken'],
      },
    });
    const context = {
      auditId: 2,
      completedUrls: ['https://example.com/page'],
      siteChecksComplete: true,
      pageEvidence: [
        {
          url: 'https://example.com/page',
          internalLinks: ['https://example.com/broken'],
          externalLinks: [],
          linkChecks: [],
        },
      ],
    };
    expect(reconcileRecommendations([], [old], context)[0].verificationStatus).toBe(
      'not_rechecked',
    );
    expect(
      reconcileRecommendations([], [old], {
        ...context,
        pageEvidence: [
          {
            ...context.pageEvidence[0],
            linkChecks: [
              {
                url: 'https://example.com/broken',
                status: 'ok',
                redirectCount: 0,
              },
            ],
          },
        ],
      })[0].verificationStatus,
    ).toBe('verified');
  });
  it('maps a custom feed and preserves issue drilldown for every product', () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      code: `sku-${index}`,
      label: `Product ${index}`,
      description: 'Actual product description',
      image: 'https://example.com/image.png',
      price: '10',
      currency: 'INR',
      availability: index === 74 ? 'invalid' : 'in_stock',
    }));
    const result = parseAndValidateCommerceFeed(
      Buffer.from(JSON.stringify(rows)),
      'products.json',
      'application/json',
      { identifier: 'code', title: 'label' },
    );
    expect(result.itemCount).toBe(75);
    expect(result.validItemCount).toBe(74);
    const products = result.summary.products as Array<{
      identifier: string;
      valid: boolean;
      issues: string[];
    }>;
    expect(products).toHaveLength(75);
    expect(products[74]).toMatchObject({ identifier: 'sku-74', valid: false });
    expect(products[74].issues.join(' ')).toMatch(/availability/i);
  });
  it('generates business-specific AEO ideas and locale-aware discovery observations', () => {
    const prompts = generateAuditPrompts({
      brandName: 'ORO Circle',
      aliases: [],
      category: 'hospitality',
      profile: 'local_business',
      locale: 'hi-IN',
      geography: 'Chennai',
    });
    expect(
      prompts
        .filter((prompt) => prompt.kind === 'aeo')
        .every((prompt) => prompt.prompt.includes('ORO Circle') && !prompt.isGeneric),
    ).toBe(true);
    expect(
      prompts
        .filter((prompt) => prompt.kind === 'geo')
        .every((prompt) => prompt.prompt.includes('Hindi') && prompt.prompt.includes('Chennai')),
    ).toBe(true);
    expect(
      prompts
        .filter((prompt) => prompt.isGeneric)
        .every((prompt) => !prompt.prompt.includes('ORO Circle')),
    ).toBe(true);
  });
});

describe('Missing-category and profile-specific prompt relevance', () => {
  it('keeps unknown-category runs branded instead of inventing a market category', () => {
    const prompts = generateAuditPrompts({
      brandName: 'Example',
      aliases: [],
      profile: 'general',
      locale: 'en-IN',
    });
    expect(prompts.filter((prompt) => prompt.kind === 'geo')).toHaveLength(4);
    expect(prompts.every((prompt) => !prompt.isGeneric && prompt.prompt.includes('Example'))).toBe(
      true,
    );
    expect(prompts.some((prompt) => prompt.prompt.includes('this type of business'))).toBe(false);
  });
  it.each([
    ['b2b_saas', 'integrations'],
    ['ecommerce', 'return policies'],
    ['local_business', 'booking conditions'],
  ] as const)('uses decision questions relevant to the %s profile', (profile, phrase) => {
    const prompts = generateAuditPrompts({
      brandName: 'Example',
      aliases: [],
      category: 'verified category',
      profile,
      locale: 'en-IN',
    });
    expect(
      prompts
        .filter((prompt) => prompt.kind === 'aeo')
        .some((prompt) => prompt.prompt.includes(phrase)),
    ).toBe(true);
  });
});
