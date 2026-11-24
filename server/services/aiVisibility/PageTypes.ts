/**
 * Page types for analysis crawls, decided by the first path segment.
 *
 * The first segment says which section of the site a page belongs to: every page under
 * /blogs/ is an article even when its slug mentions "package" or "team", and a root page
 * such as /team-outing-resorts/ is not a team page. Words inside a slug never decide the type.
 */
const SECTION_TYPES: Array<{ type: string; segments: string[]; prefixes?: string[] }> = [
  {
    type: 'blog',
    segments: ['blog', 'blogs', 'news', 'insights', 'insight', 'articles', 'article', 'posts', 'post', 'stories', 'journal', 'updates'],
  },
  { type: 'contact', segments: ['contact', 'contactus', 'get-in-touch', 'locations', 'location'], prefixes: ['contact-'] },
  { type: 'about', segments: ['about', 'who-we-are', 'our-story', 'company'], prefixes: ['about-'] },
  { type: 'products', segments: ['products', 'product', 'shop', 'store', 'collections', 'collection', 'offerings', 'catalog', 'catalogue'] },
  { type: 'services', segments: ['services', 'service', 'solutions', 'solution', 'capabilities'] },
  { type: 'platform', segments: ['platform', 'technology', 'how-it-works'] },
  { type: 'pricing', segments: ['pricing', 'plans', 'prices', 'packages', 'tariff', 'rates'] },
  {
    type: 'customers',
    segments: ['customers', 'clients', 'case-studies', 'case-study', 'success-stories', 'testimonials', 'reviews'],
  },
  { type: 'industries', segments: ['industries', 'industry', 'verticals', 'sectors', 'use-cases'] },
  { type: 'features', segments: ['features', 'benefits', 'why-us'] },
  { type: 'partners', segments: ['partners', 'integrations', 'ecosystem'] },
  { type: 'support', segments: ['support', 'help', 'faq', 'faqs', 'knowledge-base'] },
  { type: 'docs', segments: ['docs', 'documentation', 'developers', 'resources', 'guides'] },
  { type: 'team', segments: ['team', 'our-team', 'leadership', 'people', 'founders', 'management'] },
  { type: 'careers', segments: ['careers', 'career', 'jobs', 'hiring', 'join-us', 'work-with-us'] },
  { type: 'portfolio', segments: ['portfolio', 'projects', 'showcase', 'gallery'] },
];

/** Pages that rarely say anything about the business: sampled only when nothing else is left. */
const UTILITY_SEGMENT =
  /^(privacy|privacy-policy|cookie|cookies|cookie-policy|terms|terms-and-conditions|terms-of-service|terms-of-use|legal|disclaimer|refund-policy|shipping-policy|thank-you|thanks|404|404-error|search|login|log-in|signin|sign-in|register|cart|checkout|my-account|account|wp-login\.php|feed|tag|tags|author)$/;

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname
      .toLowerCase()
      .split('/')
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function auditPageType(url: string): string {
  const segments = pathSegments(url);
  if (!segments) return 'other';
  if (!segments.length) return 'homepage';
  const first = segments[0];
  // /2024/05/post-title is a dated article.
  if (/^(19|20)\d{2}$/.test(first) && segments.length > 1) return 'blog';
  const section = SECTION_TYPES.find(
    (item) =>
      item.segments.includes(first) || (item.prefixes || []).some((prefix) => first.startsWith(prefix)),
  );
  return section?.type || 'other';
}

function isUtilityPage(url: string): boolean {
  const segments = pathSegments(url);
  if (!segments?.length) return false;
  return UTILITY_SEGMENT.test(segments[0]) || /-old$/.test(segments[0]);
}

const ARTICLE_LIMIT = 5;
const PER_SECTION_LIMIT = 3;

/**
 * Choose which pages an analysis crawls: the homepage, then the pages that describe the
 * business (one per root page, at most three from any one section), then a few articles,
 * then anything else. Homepage links keep their order ahead of sitemap entries in each tier,
 * so the site's own navigation decides ties. A large blog can no longer fill the sample.
 */
export function rankAuditCandidates(
  homepage: string,
  homepageLinks: string[],
  sitemapUrls: string[],
  limit: number,
  normalize: (url: string) => string = (url) => url,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const url of [homepage, ...homepageLinks, ...sitemapUrls]) {
    const key = normalize(url);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(url);
  }
  const [first, ...rest] = ordered;
  const keyPages: string[] = [];
  const articles: string[] = [];
  const remainder: string[] = [];
  const perSection = new Map<string, number>();
  for (const url of rest) {
    const type = auditPageType(url);
    const segments = pathSegments(url) || [];
    if (type === 'homepage') {
      remainder.push(url);
    } else if (type === 'blog') {
      // The blog's own index page is a key page; posts are sampled.
      if (segments.length === 1) keyPages.push(url);
      else if (articles.length < ARTICLE_LIMIT) articles.push(url);
      else remainder.push(url);
    } else if (isUtilityPage(url)) {
      remainder.push(url);
    } else {
      const section = segments.length > 1 ? segments[0] : `/${segments[0] || ''}`;
      const count = perSection.get(section) || 0;
      if (count < PER_SECTION_LIMIT) {
        perSection.set(section, count + 1);
        keyPages.push(url);
      } else {
        remainder.push(url);
      }
    }
  }
  return [first, ...keyPages, ...articles, ...remainder].filter(Boolean).slice(0, limit);
}
