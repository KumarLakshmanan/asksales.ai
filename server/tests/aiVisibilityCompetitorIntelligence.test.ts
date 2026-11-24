import { describe, expect, it } from '@jest/globals';
import { buildCounterContentBrief, deriveCompetitorIntelligence } from '../services/aiVisibility/CompetitorIntelligenceService.js';

const competitor = { id: 9, name: 'Rival Labs', domain: 'https://rival.test', aliases: ['Rival'], active: true };

const pages = [
  { id: 1, competitorId: null, targetType: 'brand', crawlStatus: 'completed', indexable: true, pageType: 'homepage', url: 'https://brand.test', finalUrl: 'https://brand.test/', schemaTypes: ['Organization'] },
  { id: 2, competitorId: null, targetType: 'brand', crawlStatus: 'completed', indexable: true, pageType: 'services', url: 'https://brand.test/services', finalUrl: null, schemaTypes: [] },
  { id: 3, competitorId: 9, targetType: 'competitor', crawlStatus: 'completed', indexable: true, pageType: 'homepage', url: 'https://rival.test', finalUrl: null, schemaTypes: ['Organization'] },
  { id: 4, competitorId: 9, targetType: 'competitor', crawlStatus: 'completed', indexable: true, pageType: 'pricing', url: 'https://rival.test/pricing', finalUrl: null, schemaTypes: ['Product'] },
  { id: 5, competitorId: 9, targetType: 'competitor', crawlStatus: 'completed', indexable: true, pageType: 'pricing', url: 'https://rival.test/plans', finalUrl: null, schemaTypes: [] },
  { id: 6, competitorId: 9, targetType: 'competitor', crawlStatus: 'blocked', indexable: false, pageType: 'customers', url: 'https://rival.test/customers', finalUrl: null, schemaTypes: [] },
];

const runs = [
  { id: 1, promptId: 1, brandMentioned: true, brandRank: 2, competitors: ['Rival'], citations: [{ url: 'https://brand.test/guide' }, { url: 'https://source.test/report' }] },
  { id: 2, promptId: 2, brandMentioned: false, brandRank: null, competitors: ['Rival Labs'], citations: [{ url: 'https://rival.test/pricing' }] },
  { id: 3, promptId: 3, brandMentioned: false, brandRank: null, competitors: [], citations: [{ url: 'https://source.test/other' }] },
];

describe('AI Visibility competitor intelligence', () => {
  it('calculates reproducible mention, share-of-voice, prompt-win, citation, and crawl metrics', () => {
    const result = deriveCompetitorIntelligence({ projectDomain: 'https://brand.test', competitors: [competitor], pages, runs });

    expect(result.brand).toEqual(expect.objectContaining({ mentions: 1, mentionRate: 0.3333, shareOfVoice: 0.3333, promptWins: 1, citationCount: 1, citationShare: 0.25, crawledPages: 2, schemaCoverage: 0.5 }));
    expect(result.competitors[0].metrics).toEqual(expect.objectContaining({ mentions: 2, mentionRate: 0.6667, shareOfVoice: 0.6667, promptWins: 1, citationCount: 1, citationShare: 0.25, crawledPages: 3, schemaCoverage: 0.6667 }));
    expect(result.totalMentionEvents).toBe(3);
    expect(result.totalCitations).toBe(4);
  });

  it('creates content gaps only from completed indexable competitor page types missing on the brand', () => {
    const result = deriveCompetitorIntelligence({ projectDomain: 'https://brand.test', competitors: [competitor], pages, runs });

    expect(result.competitors[0].contentGaps).toEqual([expect.objectContaining({
      key: '9:pricing',
      pageType: 'pricing',
      brandPageCount: 0,
      competitorPageCount: 2,
      evidenceUrls: ['https://rival.test/pricing', 'https://rival.test/plans'],
    })]);
    expect(result.competitors[0].contentGaps.some((gap) => gap.pageType === 'customers')).toBe(false);
  });

  it('reports cited domains from actual citation URLs without inventing sources', () => {
    const result = deriveCompetitorIntelligence({ projectDomain: 'https://brand.test', competitors: [competitor], pages, runs });

    expect(result.citedDomains).toEqual([
      { domain: 'source.test', citations: 2, share: 0.5, hosts: ['source.test'] },
      { domain: 'brand.test', citations: 1, share: 0.25, hosts: ['brand.test'] },
      { domain: 'rival.test', citations: 1, share: 0.25, hosts: ['rival.test'] },
    ]);
  });

  it("counts a site's country and language editions as one cited site", () => {
    const cite = (...urls: string[]) => urls.map((url) => ({ url }));
    const result = deriveCompetitorIntelligence({
      projectDomain: 'https://brand.test',
      competitors: [],
      pages: [],
      runs: [{
        id: 1, promptId: 1, brandMentioned: false, brandRank: null, competitors: [],
        citations: cite(
          'https://tripadvisor.com/a', 'https://tripadvisor.com/b', 'https://www.tripadvisor.in/c',
          'https://no.tripadvisor.com/d', 'https://www.tripadvisor.co.uk/e', 'https://makemytrip.com/f',
          'https://alice.blogspot.com/g', 'https://bob.blogspot.com/h',
        ),
      }],
    });
    expect(result.citedDomains[0]).toEqual({
      domain: 'tripadvisor.com',
      citations: 5,
      share: 0.625,
      hosts: ['tripadvisor.com', 'tripadvisor.in', 'tripadvisor.co.uk', 'no.tripadvisor.com'],
    });
    // Each blogspot.com subdomain belongs to a different owner.
    expect(result.citedDomains.filter((item) => item.domain.endsWith('blogspot.com'))).toHaveLength(2);
  });

  it('types pages by URL and never reports a page type the brand lists in its sitemap', () => {
    const page = (id: number, targetType: string, url: string, pageType = 'other') => ({
      id, competitorId: targetType === 'brand' ? null : 9, targetType, crawlStatus: 'completed',
      indexable: true, pageType, url, finalUrl: null, schemaTypes: [],
    });
    const result = deriveCompetitorIntelligence({
      projectDomain: 'https://orocircle.com',
      competitors: [competitor],
      runs: [],
      pages: [
        page(1, 'brand', 'https://orocircle.com/', 'homepage'),
        // Stored as "other" by the older keyword patterns.
        page(2, 'brand', 'https://orocircle.com/blogs/nandi-hills-sunrise/'),
        page(3, 'competitor', 'https://rival.test/blog'),
        page(4, 'competitor', 'https://rival.test/contact-rival'),
        page(5, 'competitor', 'https://rival.test/careers'),
      ],
      brandKnownUrls: ['https://orocircle.com/contact-us/'],
    });
    expect(result.competitors[0].contentGaps.map((gap) => [gap.pageType, gap.label])).toEqual([
      ['careers', 'Careers page'],
    ]);
  });

  it('builds a reviewable counter-content brief only from verified crawl evidence', () => {
    const result = deriveCompetitorIntelligence({ projectDomain: 'https://brand.test', competitors: [competitor], pages, runs });
    const gap = result.competitors[0].contentGaps[0];
    const brief = buildCounterContentBrief({ projectName: 'Brand', competitor: result.competitors[0], gap });

    expect(brief.title).toBe('Counter-content brief: Pricing page');
    expect(brief.content).toContain('https://rival.test/pricing');
    expect(brief.content).toContain('Do not copy competitor wording');
    expect(brief.validation).toEqual(expect.objectContaining({ valid: true, gapKey: '9:pricing' }));
    expect(() => buildCounterContentBrief({ projectName: 'Brand', competitor: result.competitors[0], gap: { ...gap, evidenceUrls: [] } })).toThrow(/verified competitor content gap/i);
  });
});
