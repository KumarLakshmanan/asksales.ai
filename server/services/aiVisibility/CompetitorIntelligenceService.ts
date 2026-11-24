import { isFirstPartyCitation } from './measurement.js';
import { auditPageType } from './PageTypes.js';
import { type CompetitorVisibilityMetrics as CompetitorMetrics } from '../../../shared/aiVisibilityTypes.js';
export type { CompetitorMetrics };
export interface CompetitorIntelligenceCompetitorInput {
  id: number;
  name: string;
  domain: string;
  aliases: string[];
  active: boolean;
}

export interface CompetitorIntelligencePageInput {
  id: number;
  competitorId: number | null;
  targetType: string;
  crawlStatus: string;
  indexable: boolean;
  pageType: string | null;
  url: string;
  finalUrl: string | null;
  schemaTypes: string[];
}

export interface CompetitorIntelligenceRunInput {
  id: number;
  promptId: number;
  brandMentioned: boolean | null;
  brandRank: number | null;
  competitors: string[];
  citations: Array<{ url: string; title?: string | null }>;
}

export interface CompetitorContentGap {
  key: string;
  pageType: string;
  label: string;
  brandPageCount: number;
  competitorPageCount: number;
  evidenceUrls: string[];
}

export interface CompetitorIntelligenceEntry {
  competitorId: number;
  name: string;
  domain: string;
  active: boolean;
  metrics: CompetitorMetrics;
  contentGaps: CompetitorContentGap[];
}

export interface CompetitorIntelligenceResult {
  promptCount: number;
  totalMentionEvents: number;
  totalCitations: number;
  brand: CompetitorMetrics;
  competitors: CompetitorIntelligenceEntry[];
  /** Cited websites, with a site's country and language editions counted together. */
  citedDomains: Array<{ domain: string; citations: number; share: number; hosts?: string[] }>;
}

const TYPE_LABELS: Record<string, string> = {
  contact: 'Contact page',
  careers: 'Careers page',
  team: 'Team page',
  portfolio: 'Portfolio or gallery',
  about: 'Company overview',
  products: 'Product page',
  services: 'Service page',
  platform: 'Platform explanation',
  pricing: 'Pricing page',
  customers: 'Customer proof or case study',
  industries: 'Industry page',
  features: 'Feature page',
  partners: 'Partner or integration page',
  support: 'Support or FAQ page',
  docs: 'Documentation or resource page',
  blog: 'Article or insight',
};

function boundedRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatches(value: string, names: string[]): boolean {
  const normalized = normalizeName(value);
  return names.some((name) => {
    const candidate = normalizeName(name);
    return (
      candidate.length >= 3 &&
      (normalized === candidate ||
        (candidate.length >= 4 &&
          (normalized.includes(candidate) || candidate.includes(normalized))))
    );
  });
}

function hostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function hostMatches(candidate: string | null, domain: string): boolean {
  return candidate !== null && isFirstPartyCitation(`https://${candidate}`, domain);
}

/**
 * The page type from its URL. Older analyses stored types from keyword patterns that missed
 * sections such as /blogs/, so stored values are not used.
 */
function pageTypeOf(page: CompetitorIntelligencePageInput): string {
  return auditPageType(page.finalUrl || page.url);
}

function pageTypeCounts(pages: CompetitorIntelligencePageInput[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const page of pages) {
    const pageType = pageTypeOf(page);
    counts[pageType] = (counts[pageType] || 0) + 1;
  }
  return counts;
}

// Second-level suffixes, so tripadvisor.co.uk groups with tripadvisor.com.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'gob']);
// Hosts where each subdomain is a different owner's site.
const SHARED_HOSTS = /(^|\.)(blogspot\.com|wordpress\.com|medium\.com|substack\.com|github\.io|wixsite\.com|notion\.site|tumblr\.com|weebly\.com|webflow\.io|vercel\.app|netlify\.app)$/;

/** One key per website brand: no.tripadvisor.com, tripadvisor.in and tripadvisor.ca → tripadvisor. */
export function citedSiteKey(host: string): string {
  const bare = host.toLowerCase().replace(/^www\./, '');
  if (SHARED_HOSTS.test(bare)) return bare;
  const labels = bare.split('.');
  if (labels.length < 2) return bare;
  const suffixLength =
    labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2
      ? 2
      : 1;
  return labels[labels.length - suffixLength - 1] || bare;
}

export function deriveCompetitorIntelligence(input: {
  projectDomain: string;
  competitors: CompetitorIntelligenceCompetitorInput[];
  pages: CompetitorIntelligencePageInput[];
  runs: CompetitorIntelligenceRunInput[];
  /**
   * Brand pages known from its sitemap but not necessarily crawled. A page type the brand
   * lists there is not a gap, even when the sample did not reach it.
   */
  brandKnownUrls?: string[];
}): CompetitorIntelligenceResult {
  const brandPages = input.pages.filter(
    (page) => page.targetType === 'brand' && page.crawlStatus === 'completed' && page.indexable,
  );
  const brandContentTypes = pageTypeCounts(brandPages);
  const brandKnownTypes = new Set((input.brandKnownUrls || []).map(auditPageType));
  const brandMentions = input.runs.filter((run) => run.brandMentioned === true).length;
  const brandPromptWins = input.runs.filter(
    (run) => run.brandMentioned === true && run.brandRank !== null && run.brandRank <= 3,
  ).length;
  const allCitations = input.runs
    .flatMap((run) => run.citations)
    .filter((citation) => hostname(citation.url));
  const brandCitationCount = allCitations.filter((citation) =>
    hostMatches(hostname(citation.url), input.projectDomain),
  ).length;

  const competitorMentionCounts = new Map<number, number>();
  for (const competitor of input.competitors) {
    const names = [competitor.name, ...competitor.aliases];
    competitorMentionCounts.set(
      competitor.id,
      input.runs.filter((run) => run.competitors.some((name) => nameMatches(name, names))).length,
    );
  }
  const totalMentionEvents =
    brandMentions + [...competitorMentionCounts.values()].reduce((sum, value) => sum + value, 0);
  const brandSchemaPages = brandPages.filter((page) => page.schemaTypes.length > 0).length;
  const brand: CompetitorMetrics = {
    mentions: brandMentions,
    mentionRate: boundedRatio(brandMentions, input.runs.length),
    shareOfVoice: boundedRatio(brandMentions, totalMentionEvents),
    promptWins: brandPromptWins,
    promptWinRate: boundedRatio(brandPromptWins, input.runs.length),
    citationCount: brandCitationCount,
    citationShare: boundedRatio(brandCitationCount, allCitations.length),
    crawledPages: brandPages.length,
    schemaCoverage: boundedRatio(brandSchemaPages, brandPages.length),
    contentTypes: brandContentTypes,
  };

  const competitors = input.competitors.map((competitor): CompetitorIntelligenceEntry => {
    const names = [competitor.name, ...competitor.aliases];
    const mentions = competitorMentionCounts.get(competitor.id) || 0;
    const promptWins = input.runs.filter(
      (run) =>
        run.competitors.some((name) => nameMatches(name, names)) &&
        !(run.brandMentioned === true && run.brandRank !== null && run.brandRank <= 3),
    ).length;
    const citationCount = allCitations.filter((citation) =>
      hostMatches(hostname(citation.url), competitor.domain),
    ).length;
    const pages = input.pages.filter(
      (page) =>
        page.targetType === 'competitor' &&
        page.competitorId === competitor.id &&
        page.crawlStatus === 'completed' &&
        page.indexable,
    );
    const contentTypes = pageTypeCounts(pages);
    const contentGaps = Object.entries(contentTypes)
      .filter(
        ([pageType]) =>
          !['homepage', 'other'].includes(pageType) &&
          !brandContentTypes[pageType] &&
          !brandKnownTypes.has(pageType),
      )
      .map(
        ([pageType, competitorPageCount]): CompetitorContentGap => ({
          key: `${competitor.id}:${pageType}`,
          pageType,
          label: TYPE_LABELS[pageType] || pageType.replaceAll('_', ' '),
          brandPageCount: 0,
          competitorPageCount,
          evidenceUrls: pages
            .filter((page) => pageTypeOf(page) === pageType)
            .map((page) => page.finalUrl || page.url)
            .slice(0, 5),
        }),
      )
      .sort(
        (a, b) =>
          b.competitorPageCount - a.competitorPageCount || a.pageType.localeCompare(b.pageType),
      );
    return {
      competitorId: competitor.id,
      name: competitor.name,
      domain: competitor.domain,
      active: competitor.active,
      metrics: {
        mentions,
        mentionRate: boundedRatio(mentions, input.runs.length),
        shareOfVoice: boundedRatio(mentions, totalMentionEvents),
        promptWins,
        promptWinRate: boundedRatio(promptWins, input.runs.length),
        citationCount,
        citationShare: boundedRatio(citationCount, allCitations.length),
        crawledPages: pages.length,
        schemaCoverage: boundedRatio(
          pages.filter((page) => page.schemaTypes.length > 0).length,
          pages.length,
        ),
        contentTypes,
      },
      contentGaps,
    };
  });

  const citedSites = new Map<string, Map<string, number>>();
  for (const citation of allCitations) {
    const host = hostname(citation.url);
    if (!host) continue;
    const site = citedSites.get(citedSiteKey(host)) || new Map<string, number>();
    site.set(host, (site.get(host) || 0) + 1);
    citedSites.set(citedSiteKey(host), site);
  }
  const citedDomains = [...citedSites.values()]
    .map((hosts) => {
      // The most cited edition names the site; ties go to .com, then the shortest host.
      const dotCom = (host: string) => (/^[^.]+\.com$/.test(host) ? 0 : 1);
      const ranked = [...hosts.entries()].sort(
        (a, b) =>
          b[1] - a[1] ||
          dotCom(a[0]) - dotCom(b[0]) ||
          a[0].length - b[0].length ||
          a[0].localeCompare(b[0]),
      );
      const citations = ranked.reduce((sum, [, count]) => sum + count, 0);
      return {
        domain: ranked[0][0],
        citations,
        share: Number((citations / allCitations.length).toFixed(4)),
        hosts: ranked.map(([host]) => host),
      };
    })
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain))
    .slice(0, 15);
  return {
    promptCount: input.runs.length,
    totalMentionEvents,
    totalCitations: allCitations.length,
    brand,
    competitors,
    citedDomains,
  };
}

export function buildCounterContentBrief(input: {
  projectName: string;
  competitor: Pick<CompetitorIntelligenceEntry, 'competitorId' | 'name'>;
  gap: CompetitorContentGap;
}): { title: string; content: string; validation: Record<string, unknown> } {
  if (
    !input.gap.evidenceUrls.length ||
    input.gap.competitorPageCount < 1 ||
    input.gap.brandPageCount !== 0
  ) {
    throw new Error('A verified competitor content gap is required before creating a brief.');
  }
  const evidence = input.gap.evidenceUrls.map((url) => `- ${url}`).join('\n');
  const title = `Counter-content brief: ${input.gap.label}`;
  const content = [
    `# ${title}`,
    '',
    `Brand: ${input.projectName}`,
    `Observed competitor: ${input.competitor.name}`,
    `Verified gap: the latest crawl found ${input.gap.competitorPageCount} ${input.gap.label.toLowerCase()} page${input.gap.competitorPageCount === 1 ? '' : 's'} for the competitor and none for the brand.`,
    '',
    '## Crawl evidence',
    evidence,
    '',
    '## Recommended brief',
    `Create an original ${input.gap.label.toLowerCase()} that answers the audience need behind this page type.`,
    '- Lead with a concise, factual answer or positioning statement.',
    '- Support every product, service, pricing, or outcome claim with a primary source.',
    '- Add decision criteria, limitations, author/reviewer details, and a review date.',
    '- Link to relevant first-party pages and use supported structured data when applicable.',
    '- Do not copy competitor wording, claims, examples, or proprietary material.',
    '',
    'Editorial review is required before approval or publishing.',
  ].join('\n');
  return {
    title,
    content,
    validation: {
      valid: true,
      validator: 'verified_competitor_gap_v1',
      competitorId: input.competitor.competitorId,
      gapKey: input.gap.key,
      evidenceUrls: input.gap.evidenceUrls,
    },
  };
}
