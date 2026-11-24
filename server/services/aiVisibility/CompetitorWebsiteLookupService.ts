import { getAllActiveAdminCredentials } from '../../models/adminApiCredentials/functions.js';
import { fetchPublicHttpUrl } from '../../utils/safeRemoteFetch.js';
import { deductCreditsForLLMUsage } from '../CreditDeductionHooks.js';
import { citedSiteKey } from './CompetitorIntelligenceService.js';

/**
 * Finds a competitor's official website with a web-searching model, then checks the page
 * itself. The result is only a suggestion: the person confirms it before it is tracked.
 */

// Listings, bookings, reviews, maps, social and directories are never a business's own site.
const NOT_OFFICIAL = new Set([
  'tripadvisor', 'booking', 'makemytrip', 'goibibo', 'expedia', 'hotels', 'agoda', 'airbnb', 'trivago',
  'trip', 'cleartrip', 'yatra', 'oyorooms', 'thrillophilia', 'justdial', 'sulekha', 'indiamart', 'yelp',
  'zomato', 'swiggy', 'magicpin', 'weddingwire', 'wedmegood', 'google', 'goo', 'bing', 'facebook',
  'instagram', 'linkedin', 'twitter', 'x', 'youtube', 'pinterest', 'wikipedia', 'crunchbase',
  'glassdoor', 'ambitionbox', 'amazon', 'flipkart', 'yellowpages', 'foursquare', 'quora', 'reddit',
  'medium', 'blogspot', 'wordpress',
]);

const GENERIC_WORDS = new Set([
  'the', 'and', 'of', 'in', 'at', 'by', 'a', 'an', 'hotel', 'hotels', 'resort', 'resorts', 'spa', 'villa',
  'villas', 'inn', 'stay', 'stays', 'retreat', 'club', 'luxury', 'rooms', 'room', 'company', 'pvt', 'ltd',
  'limited', 'private', 'inc', 'llc', 'group', 'services', 'solutions', 'india', 'bangalore', 'bengaluru',
]);

export interface CompetitorWebsiteLookup {
  website: string | null;
  /** The page answered and its title or address names the business. */
  verified: boolean;
  /**
   * False when the business only has a page on a larger site (a hotel on marriott.com):
   * competitors are tracked by domain, so tracking it would measure the whole parent site.
   */
  trackable: boolean;
  pageTitle: string | null;
  message: string;
}

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !GENERIC_WORDS.has(token));
}

function firstJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isOfficialCandidate(url: string, brandDomain: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return false;
    const site = citedSiteKey(host);
    return !NOT_OFFICIAL.has(site) && site !== citedSiteKey(new URL(brandDomain).hostname);
  } catch {
    return false;
  }
}

export function namesBusiness(name: string, pageTitle: string, host: string): boolean {
  const haystack = `${pageTitle} ${host.replace(/\./g, ' ')}`.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ');
  const compactHost = host.toLowerCase().replace(/[^a-z0-9]/g, '');
  return nameTokens(name).some((token) => haystack.includes(token) || compactHost.includes(token));
}

export async function lookupCompetitorWebsite(
  userId: number,
  input: { name: string; brandDomain: string; category?: string | null; geography?: string | null; country?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<CompetitorWebsiteLookup> {
  const credential = (await getAllActiveAdminCredentials('openrouter')).find((item) => item.apiKey?.trim());
  if (!credential?.apiKey) {
    return { website: null, verified: false, trackable: false, pageTitle: null, message: 'Website lookup is not available right now. Enter the website yourself.' };
  }
  const where = [input.geography, input.country].filter(Boolean).join(', ');
  const model = 'openai/gpt-4.1-mini';
  const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://asksales.ai',
      'X-Title': 'AskSales AI Visibility',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      plugins: [{ id: 'web', max_results: 5 }],
      messages: [
        {
          role: 'user',
          content: [
            `What is the official website of the business "${input.name}"${where ? ` in ${where}` : ''}${input.category ? ` (${input.category})` : ''}?`,
            'Give the business\'s own website only: never a booking, listing, review, map, directory or social media page.',
            'Reply with JSON only: {"website": "https://..."} or {"website": null} if you cannot find it.',
          ].join(' '),
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    return { website: null, verified: false, trackable: false, pageTitle: null, message: 'The website search did not answer. Try again or enter the website yourself.' };
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const cost = Number(data.usage?.cost);
  if (Number.isFinite(cost) && cost > 0) {
    await deductCreditsForLLMUsage(userId, {
      model,
      provider: 'openrouter',
      purpose: 'ai_visibility_competitor_website_lookup',
      service: 'ai_visibility',
      estimatedCostCents: cost * 100,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    });
  }
  const answer = firstJson(data.choices?.[0]?.message?.content || '');
  const proposed = typeof answer?.website === 'string' ? answer.website.trim() : '';
  if (!proposed || !isOfficialCandidate(proposed, input.brandDomain)) {
    return { website: null, verified: false, trackable: false, pageTitle: null, message: `No official website was found for ${input.name}. Enter it yourself if you know it.` };
  }
  // The page must answer; its own title or address must name the business.
  try {
    const { response: page, finalUrl } = await fetchPublicHttpUrl(proposed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AskSalesBot/1.0; +https://asksales.ai)' },
    });
    const html = page.ok ? (await page.text()).slice(0, 200_000) : '';
    const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null;
    // Keep the page path: a hotel on a group site (marriott.com/…/mulberry-shades…) is not the group.
    const landed = new URL(finalUrl);
    landed.search = '';
    landed.hash = '';
    const website = landed.pathname === '/' ? landed.origin : landed.toString();
    if (!page.ok || !isOfficialCandidate(website, input.brandDomain)) {
      return { website: null, verified: false, trackable: false, pageTitle: null, message: `The website found for ${input.name} did not open. Enter it yourself if you know it.` };
    }
    const verified = namesBusiness(input.name, pageTitle || '', landed.hostname);
    const trackable = landed.pathname === '/';
    return {
      website,
      verified,
      trackable,
      pageTitle,
      message: !trackable
        ? `${input.name} has a page on ${landed.hostname}, a larger company's site. Competitors are compared by whole website, so tracking it would compare you with all of ${landed.hostname}.`
        : verified
          ? `Found ${website}. Check it is ${input.name}'s own website, then track it.`
          : `Found ${website}, but its page does not clearly name ${input.name}. Check it before tracking.`,
    };
  } catch {
    return { website: null, verified: false, trackable: false, pageTitle: null, message: `The website found for ${input.name} did not open. Enter it yourself if you know it.` };
  }
}
