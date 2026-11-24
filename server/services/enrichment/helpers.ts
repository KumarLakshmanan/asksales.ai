// ─── Lead Enrichment — Shared Helper Functions ───────────────────────────────────

import type { ExtractedInfo, EnrichmentPlatform, EnrichmentHandle, EnrichmentIterationResult, AggregatedEnrichmentData } from './types.js';
 
import { extractDomainFromUrl, extractEmailsFromText, extractPhonesFromText, extractUrlsFromText, extractSocialUrlsFromText, extractSocialLinksFromHtml, isRelevantSocialHandle, normalizeSocialProfile } from './textExtractors.js';
import { LLMProviderFactory } from '../agents/LLMProviderFactory.js';
import { WebsiteCrawlerService } from '../WebsiteCrawlerService.js';
import { logger } from '../../utils/logger.js';
import { cleanEnrichmentContacts } from '../../../shared/enrichmentContactValidation.js';

/**
 * Domains and subdomains that are blocked or filtered out from company websites
 * (e.g. social platforms, video hosting sites, app stores, URL shorteners).
 */
export const BLOCKED_WEBSITE_DOMAINS = new Set([
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com',
  'lnkd.in', 't.co', 'fb.com', 'fb.me', 'youtube.com', 'about.youtube', 'blog.youtube',
  'tv.youtube.com', 'studio.youtube.com', 'music.youtube.com', 'youtu.be',
  'vimeo.com', 'tiktok.com', 'google.com', 'business.google.com',
  'developers.google.com', 'policies.google.com', 'support.google.com',
  'accounts.google.com', 'mail.google.com', 'docs.google.com',
  'play.google.com', 'news.google.com', 'scholar.google.com',
  'servicesdirectory.withyoutube.com', 'apps.apple.com', 'itunes.apple.com',
  'market.android.com', 'microsoft.com', 'bit.ly', 'goo.gl',
  'tinyurl.com', 'ow.ly', 'buff.ly', 'lnk.to', 'linktr.ee', 'linkin.bio',
  'bio.link', 'beacons.ai', 'shorby.com', 'solo.to', 'wa.me', 't.me',
  'telegram.me', 'discord.gg', 'discord.com', 'line.me', 'line-scdn.net',
  'maps.google.com', 'analytics.google.com', 'ads.google.com',
  'github.com', 'gitlab.com', 'bitbucket.org'
]);

/**
 * Check if a URL belongs to a blocked/filtered domain.
 */
export function isBlockedWebsiteUrl(url: string): boolean {
  if (!url) return true;
  const domain = extractDomainFromUrl(url);
  if (!domain) return true;
  const lowerDomain = domain.toLowerCase();
  
  for (const blocked of BLOCKED_WEBSITE_DOMAINS) {
    if (lowerDomain === blocked || lowerDomain.endsWith(`.${blocked}`)) {
      return true;
    }
  }
  return false;
}

// ─── Merge & LLM Extraction ──────────────────────────────────────────────────────

/**
 * Merge two partial ExtractedInfo objects, deduplicating arrays and preferring non-empty values.
 */
export function mergeExtractedInfos(base: Partial<ExtractedInfo>, override: Partial<ExtractedInfo>): Partial<ExtractedInfo> {
  const contacts = cleanEnrichmentContacts({
    emails: [...(base.emails || []), ...(override.emails || [])],
    phones: [...(base.phones || []), ...(override.phones || [])],
    websites: [...(base.websites || []), ...(override.websites || [])],
  });

  return {
    ...contacts,
    websites: contacts.websites.filter(u => !isBlockedWebsiteUrl(u)),
    socialProfiles: { ...(base.socialProfiles || {}), ...(override.socialProfiles || {}) },
    company: (override.company && Object.keys(override.company).length)
      ? { ...(base.company || {}), ...override.company }
      : base.company,
    person: (override.person && Object.keys(override.person).length)
      ? { ...(base.person || {}), ...override.person }
      : base.person,
    socialStats: (() => {
      const b = base.socialStats || {};
      const o = override.socialStats || {};
      if (!Object.keys(b).length && !Object.keys(o).length) return undefined;
      return {
        followersCount: o.followersCount ?? b.followersCount,
        followingCount: o.followingCount ?? b.followingCount,
        postsCount: o.postsCount ?? b.postsCount,
        followers: [...(b.followers ?? []), ...(o.followers ?? [])].filter(Boolean).length
          ? [...new Set([...(b.followers ?? []), ...(o.followers ?? [])])]
          : undefined,
        following: [...(b.following ?? []), ...(o.following ?? [])].filter(Boolean).length
          ? [...new Set([...(b.following ?? []), ...(o.following ?? [])])]
          : undefined,
      };
    })(),
  };
}

/**
 * Use LLM to extract structured contact info and social profiles from website text.
 * Called per-iteration for website platform to augment regex-based extraction.
 */
export async function llmExtractFromWebContent(userId: number, combinedContent: string): Promise<Partial<ExtractedInfo>> {
  const provider = await LLMProviderFactory.createProviderForUser(userId);

  const systemPrompt = `You are a business intelligence and contact information extractor. Analyze the website content and extract ALL contact details, social media profiles, and company information.

IMPORTANT RULES:
- Only extract social profiles that belong to the company/person who OWNS this website
- Do NOT extract social links of random visitors, commenters, or third-party partners
- For social profiles, always prefer full URLs (https://...) over just handles. DO NOT return generic platform domains (e.g. "https://instagram.com", "instagram", "facebook") as handles or profile URLs. If there is no specific handle/profile, omit it.
- Extract ALL phone numbers found on the website (including multiple contact, support, or mobile numbers).
- Extract ALL emails found (contact, info, support, sales, team member emails)
- Extract physical address components separately

Return ONLY a valid JSON object (no markdown, no explanation) with these fields — omit any field where no data was found:
{
  "emails": ["email@domain.com"],
  "phones": ["+1-555-123-4567"],
  "websites": ["https://other-related-website.com"],
  "socialProfiles": {
    "instagram": "https://instagram.com/handle",
    "twitter": "https://twitter.com/handle or https://x.com/handle",
    "linkedin": "https://linkedin.com/company/name or https://linkedin.com/in/profile",
    "facebook": "https://facebook.com/page",
    "youtube": "https://youtube.com/@channel or channel URL",
    "github": "https://github.com/org",
    "tiktok": "https://tiktok.com/@handle",
    "pinterest": "https://pinterest.com/handle",
    "whatsapp": "phone number or wa.me link"
  },
  "company": {
    "name": "Company Name",
    "description": "2-3 sentence company description",
    "industry": "Industry type",
    "address": "Full physical address",
    "size": "Employee count or range (e.g. 11-50, 201-500)",
    "domain": "company-domain.com"
  },
  "person": {
    "fullName": "Founder/CEO name if found",
    "title": "Job title",
    "bio": "Brief bio"
  }
}`;

  const response = await provider.createChatCompletion({
    model: provider.defaultModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: combinedContent.slice(0, 15000) },
    ],
    temperature: 0.1,
    max_tokens: 1500,
    loggingContext: { userId, purpose: 'website_content_extraction', service: 'LeadEnrichmentOrchestrator' },
  });

  if (!response.success || !response.content) return {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseExtracted = (parsed: any): Partial<ExtractedInfo> => ({
    emails: Array.isArray(parsed.emails) ? parsed.emails.filter(Boolean) : [],
    phones: Array.isArray(parsed.phones) ? parsed.phones.filter(Boolean) : [],
    websites: Array.isArray(parsed.websites) ? parsed.websites.filter(Boolean) : [],
    socialProfiles: parsed.socialProfiles && typeof parsed.socialProfiles === 'object' ? parsed.socialProfiles : {},
    company: parsed.company && typeof parsed.company === 'object' ? parsed.company : undefined,
    person: parsed.person && typeof parsed.person === 'object' ? parsed.person : undefined,
  });

  let extracted: Partial<ExtractedInfo> = {};
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    extracted = parseExtracted(JSON.parse(jsonMatch[0]));
  } catch {
    try {
      extracted = parseExtracted(JSON.parse(response.content.trim()));
    } catch {
      logger.warn('[EnrichmentOrchestrator] Failed to parse LLM web content extraction response');
      return {};
    }
  }

  // Validate and clean social profiles from LLM using normalizeSocialProfile
  if (extracted.socialProfiles) {
    const normalizedProfiles: Record<string, string> = {};
    for (const [platform, value] of Object.entries(extracted.socialProfiles)) {
      if (!value) continue;
      const normalized = normalizeSocialProfile(platform, value);
      if (normalized) {
        normalizedProfiles[platform] = normalized;
      } else {
        logger.debug({ platform, value }, '[llmExtractFromWebContent] Removed invalid social profile');
      }
    }
    extracted.socialProfiles = normalizedProfiles;
  }

  // Augment LLM extraction with regex-based extraction from the full content
  // LLM only sees truncated content; regex can find patterns in the full text
  const regexEmails = extractEmailsFromText(combinedContent);
  const regexPhones = extractPhonesFromText(combinedContent);
  const regexSocials = extractSocialUrlsFromText(combinedContent);

  extracted.emails = [...new Set([...(extracted.emails || []), ...regexEmails])];

  // Deduplicate phones by digits-only form
  const allPhones = [...(extracted.phones || []), ...regexPhones];
  const phoneSeen = new Set<string>();
  extracted.phones = [];
  for (const p of allPhones) {
    const digits = p.replace(/\D/g, '');
    if (phoneSeen.has(digits)) continue;
    phoneSeen.add(digits);
    extracted.phones.push(p);
  }

  if (regexSocials) {
    extracted.socialProfiles = { ...(extracted.socialProfiles || {}), ...regexSocials };
  }

  return extracted;
}

// ─── Handle Discovery ─────────────────────────────────────────────────────────────

/**
 * Build the initial handle queue from a lead's existing data fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildInitialHandles(lead: any): EnrichmentHandle[] {
  const handles: EnrichmentHandle[] = [];

  // Instagram
  if (lead.instagramHandle || lead.instagram || lead.instagramUrl) {
    const id = lead.instagramHandle || lead.instagram || lead.instagramUrl;
    handles.push({ platform: 'instagram', identifier: id, source: 'lead_record' });
  }

  // Twitter
  if (lead.twitterHandle || lead.twitterUsername || lead.twitter || lead.twitterUrl) {
    const id = lead.twitterHandle || lead.twitterUsername || lead.twitter || lead.twitterUrl;
    handles.push({ platform: 'twitter', identifier: id, source: 'lead_record' });
  }

  // LinkedIn
  if (lead.linkedinUrl || lead.linkedin || lead.linkedinUsername) {
    const id = lead.linkedinUrl || lead.linkedin || lead.linkedinUsername;
    handles.push({ platform: 'linkedin', identifier: id, source: 'lead_record' });
  }

  // Facebook
  if (lead.facebookUrl || lead.facebook) {
    const id = lead.facebookUrl || lead.facebook;
    handles.push({ platform: 'facebook', identifier: id, source: 'lead_record' });
  }

  // Website — normalize URLs and deduplicate by normalized URL
  const seenWebsiteDomains = new Set<string>();
  for (const rawUrl of [lead.website, lead.companyDomain].filter(Boolean)) {
    const normalized = rawUrl.replace(/\/$/, '').toLowerCase();
    if (!seenWebsiteDomains.has(normalized)) {
      seenWebsiteDomains.add(normalized);
      handles.push({ platform: 'website', identifier: rawUrl.replace(/\/$/, ''), source: 'lead_record' });
    }
  }

  // Profile URL (try to detect platform)
  if (lead.profileUrl) {
    const url = lead.profileUrl.toLowerCase();
    if (url.includes('linkedin.com')) handles.push({ platform: 'linkedin', identifier: lead.profileUrl, source: 'profile_url' });
    else if (url.includes('twitter.com') || url.includes('x.com')) handles.push({ platform: 'twitter', identifier: lead.profileUrl, source: 'profile_url' });
    else if (url.includes('instagram.com')) handles.push({ platform: 'instagram', identifier: lead.profileUrl, source: 'profile_url' });
    else if (url.includes('facebook.com')) handles.push({ platform: 'facebook', identifier: lead.profileUrl, source: 'profile_url' });
  }

  return handles;
}

/**
 * Discover new handles/profiles from the extracted data of a completed scrape iteration.
 * Returns new handles that have not yet been processed.
 * Optionally filters irrelevant handles using company domain/name context.
 */
export function discoverNewHandles(
  info: Partial<ExtractedInfo>,
  sourcePlatform: EnrichmentPlatform,
  processedHandles: Set<string>,
  context?: { companyDomain?: string; companyName?: string }
): EnrichmentHandle[] {
  const newHandles: EnrichmentHandle[] = [];

  // Domains that should never be added to the website crawl queue
  const BLOCKED_CRAWL_DOMAINS = [
    // Social media
    'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com',
    't.co', 'fb.com', 'fb.me',
    // Video platforms & subdomains
    'youtube.com', 'about.youtube', 'blog.youtube', 'tv.youtube.com',
    'studio.youtube.com', 'music.youtube.com', 'youtu.be',
    'vimeo.com', 'tiktok.com',
    // Google properties
    'google.com', 'business.google.com', 'developers.google.com',
    'policies.google.com', 'support.google.com', 'accounts.google.com',
    'mail.google.com', 'docs.google.com', 'play.google.com',
    'news.google.com', 'scholar.google.com', 'servicesdirectory.withyoutube.com',
    // Video
    'youtu.be', 'youtube.com', 'vimeo.com', 'tiktok.com',
    // Code
    'github.com', 'gitlab.com', 'bitbucket.org',
    // App stores – prevent recursive Play Store / App Store crawling
    'play.google.com', 'apps.apple.com', 'itunes.apple.com',
    'market.android.com', 'microsoft.com',
    // URL shorteners
    'lnkd.in', 'bit.ly', 'goo.gl', 'tinyurl.com', 'ow.ly', 'buff.ly', 'lnk.to',
    'linktr.ee', 'linkin.bio', 'bio.link', 'beacons.ai', 'shorby.com', 'solo.to',
    // Messaging
    'wa.me', 't.me', 'telegram.me', 'discord.gg', 'discord.com',
    'line.me', 'line-scdn.net',
    // Maps
    'maps.google.com', 'google.com',
    // Analytics
    'analytics.google.com', 'ads.google.com',
  ];

  // From websites → website platform
  for (const url of info.websites || []) {
    const domain = extractDomainFromUrl(url);
    if (!domain) continue;
    // Allow Play Store developer pages through (they contain contact info)
    const isPlayStoreDev = url.includes('play.google.com/store/apps/dev');
    // Skip blocked domains (app stores, social media, URL shorteners, etc.)
    // Check both exact match and subdomain match (e.g., about.youtube matches youtube)
    const isBlocked = !isPlayStoreDev && BLOCKED_CRAWL_DOMAINS.some(s =>
      domain === s || domain.endsWith(`.${s}`) || domain.endsWith(s.replace(/\.com$/, ''))
    );
    if (isBlocked) continue;
    const normalizedUrl = url.replace(/\/$/, '').toLowerCase();
    const key = `website:primary:${normalizedUrl}`;
    if (!processedHandles.has(key)) {
      newHandles.push({ platform: 'website', identifier: url.replace(/\/$/, ''), source: `${sourcePlatform}_scrape` });
    }
  }

  // From social profiles
  const profiles = info.socialProfiles || {};
  // Filter social profile handles for relevance before queueing
  const domain = context?.companyDomain;
  const name = context?.companyName;

  // Helper: extract handle from profile value (could be URL or bare handle)
  const extractHandle = (val: string): string => {
    const urlMatch = val.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i) ||
                     val.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i) ||
                     val.match(/facebook\.com\/([a-zA-Z0-9.]+)/i) ||
                     val.match(/linkedin\.com\/(?:in|company)\/([a-zA-Z0-9_-]+)/i) ||
                     val.match(/github\.com\/([a-zA-Z0-9-]+)/i);
    return urlMatch ? urlMatch[1] : val.replace(/^@/, '');
  };

  if (profiles.linkedin && !processedHandles.has(`linkedin:primary:${profiles.linkedin.toLowerCase()}`)) {
    const handle = extractHandle(profiles.linkedin);
    if (handle.length >= 3 && isRelevantSocialHandle(profiles.linkedin, domain, name)) {
      newHandles.push({ platform: 'linkedin', ...(profiles.linkedin.includes('/company/') ? { subType: 'company' as const } : {}), identifier: profiles.linkedin, source: `${sourcePlatform}_scrape` });
    }
  }
  if (profiles.twitter && !processedHandles.has(`twitter:primary:${profiles.twitter.toLowerCase()}`)) {
    const handle = extractHandle(profiles.twitter);
    if (handle.length >= 3 && isRelevantSocialHandle(profiles.twitter, domain, name)) {
      newHandles.push({ platform: 'twitter', identifier: profiles.twitter, source: `${sourcePlatform}_scrape` });
    }
  }
  if (profiles.instagram && !processedHandles.has(`instagram:primary:${profiles.instagram.toLowerCase()}`)) {
    const handle = extractHandle(profiles.instagram);
    if (handle.length >= 3 && isRelevantSocialHandle(profiles.instagram, domain, name)) {
      newHandles.push({ platform: 'instagram', identifier: profiles.instagram, source: `${sourcePlatform}_scrape` });
    }
  }
  if (profiles.facebook && !processedHandles.has(`facebook:primary:${profiles.facebook.toLowerCase()}`)) {
    const handle = extractHandle(profiles.facebook);
    if (handle.length >= 3 && isRelevantSocialHandle(profiles.facebook, domain, name)) {
      newHandles.push({ platform: 'facebook', identifier: profiles.facebook, source: `${sourcePlatform}_scrape` });
    }
  }
  // YouTube footer/legal contacts belong to the platform, not the subject.
  // Retain the link, but do not recursively crawl it as a company website.
  // Blogger → crawl as website
  if (profiles.blogger) {
    const blogNorm = profiles.blogger.replace(/\/$/, '').toLowerCase();
    if (!processedHandles.has(`website:primary:${blogNorm}`)) {
      newHandles.push({ platform: 'website', identifier: profiles.blogger.replace(/\/$/, ''), source: `${sourcePlatform}_scrape` });
    }
  }

  return newHandles;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────────

/**
 * Normalize a partial ExtractedInfo object into a complete one, deduplicating arrays.
 */
export function normalizeExtractedInfo(info: Partial<ExtractedInfo>): ExtractedInfo {
  return {
    ...cleanEnrichmentContacts(info),
    socialProfiles: info.socialProfiles || {},
    company: info.company,
    person: info.person,
    socialStats: info.socialStats,
  };
}

/**
 * Aggregate all per-iteration enrichment results into a single summary object.
 */
export function aggregateResults(results: EnrichmentIterationResult[]): AggregatedEnrichmentData {
  const aggregated: AggregatedEnrichmentData = {
    emails: [],
    phones: [],
    websites: [],
    socialProfiles: {},
    company: {},
    person: {},
    socialStats: {},
    rawScrapedData: {},
  };

  for (const result of results) {
    aggregated.emails.push(...result.extractedInfo.emails);
    aggregated.phones.push(...result.extractedInfo.phones);
    aggregated.websites.push(...result.extractedInfo.websites);

    // Discovered employer/footer profiles are not the original subject.
    if (result.isSubject) Object.assign(aggregated.socialProfiles, result.extractedInfo.socialProfiles);

    // Merge company info (prefer non-empty values)
    if (result.extractedInfo.company) {
      for (const [key, val] of Object.entries(result.extractedInfo.company)) {
        if (val && !aggregated.company[key]) {
          aggregated.company[key] = val;
        }
      }
    }

    // Merge person info (prefer non-empty values)
    if (result.isSubject && result.extractedInfo.person) {
      for (const [key, val] of Object.entries(result.extractedInfo.person)) {
        if (val && !aggregated.person[key]) {
          aggregated.person[key] = val;
        }
      }
    }

    // Merge social stats (prefer first non-null value; merge lists)
    if (result.isSubject && result.extractedInfo.socialStats) {
      const s = result.extractedInfo.socialStats;
      if (s.followersCount != null && aggregated.socialStats.followersCount == null) aggregated.socialStats.followersCount = s.followersCount;
      if (s.followingCount != null && aggregated.socialStats.followingCount == null) aggregated.socialStats.followingCount = s.followingCount;
      if (s.postsCount != null && aggregated.socialStats.postsCount == null) aggregated.socialStats.postsCount = s.postsCount;
      if (s.followers?.length) aggregated.socialStats.followers = [...(aggregated.socialStats.followers ?? []), ...s.followers];
      if (s.following?.length) aggregated.socialStats.following = [...(aggregated.socialStats.following ?? []), ...s.following];
    }

    // Store raw data keyed by platform
    aggregated.rawScrapedData[`${result.platform}_${result.identifier}`] = result.rawData;
  }

  const cleaned = cleanEnrichmentContacts(aggregated);
  cleaned.websites = cleaned.websites.filter(u => !isBlockedWebsiteUrl(u));
  if (cleaned.company.domain && isBlockedWebsiteUrl(cleaned.company.domain)) delete cleaned.company.domain;
  return cleaned;
}

// ─── Play Store / App Store Developer Info Extraction ─────────────────────────────

/**
 * Scrape a Google Play Store developer page to extract:
 * - Developer website URL
 * - Developer email
 * - Developer name, address
 * - App listing pages (to find support emails/websites)
 */
export async function extractPlayStoreDeveloperInfo(
  developerUrl: string,
): Promise<Partial<ExtractedInfo>> {
  const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };

  try {
    const crawler = new WebsiteCrawlerService({ maxPages: 1, maxContentLength: 16000, timeoutMs: 20000 });

    // Fetch the developer page
    const page = await crawler.fetchPage(developerUrl);
    if (!page.success || !page.text) return info;

    const text = page.text;

    // Extract emails (support email, developer email)
    info.emails = extractEmailsFromText(text);

    // Extract phones
    info.phones = extractPhonesFromText(text);

    // Extract URLs from the page — these may include developer websites
    const urls = extractUrlsFromText(text);
    // Filter for actual developer websites (not play store links)
    for (const url of urls) {
      if (!url.includes('play.google.com') && !url.includes('google.com/store') &&
          !url.includes('policies.google.com') && !url.includes('support.google.com')) {
        info.websites!.push(url);
      }
    }

    // Extract developer name/address from text
    // eslint-disable-next-line no-useless-escape
    const addressMatch = text.match(/About the developer\s*\n?([\s\S]{10,200}?)(?:\n\n|\z)/i);
    if (addressMatch) {
      info.person = { bio: addressMatch[1].trim() };
    }

    // Also try to crawl an app listing to get the support page info
    if (page._html) {
      const links = crawler.extractLinks(page._html, developerUrl);
      // Find app detail links
      const appLinks = links
        .filter(l => l.url.includes('play.google.com/store/apps/details'))
        .slice(0, 2);

      for (const appLink of appLinks) {
        try {
          const appPage = await crawler.fetchPage(appLink.url);
          if (appPage.success && appPage.text) {
            const appEmails = extractEmailsFromText(appPage.text);
            const appPhones = extractPhonesFromText(appPage.text);
            const appUrls = extractUrlsFromText(appPage.text);
            info.emails!.push(...appEmails);
            info.phones!.push(...appPhones);
            for (const u of appUrls) {
              if (!u.includes('play.google.com') && !u.includes('google.com/store') &&
                  !u.includes('policies.google.com')) {
                info.websites!.push(u);
              }
            }
          }
        } catch { /* non-blocking */ }
      }
    }

    // Deduplicate
    info.emails = [...new Set(info.emails)];
    // Dedup phones by digits
    const phoneSeen = new Set<string>();
    info.phones = info.phones!.filter(p => {
      const d = p.replace(/\D/g, '');
      if (phoneSeen.has(d)) return false;
      phoneSeen.add(d);
      return true;
    });
    // Dedup websites
    const urlSeen = new Set<string>();
    info.websites = info.websites!.filter(u => {
      const n = u.replace(/\/+$/, '').toLowerCase();
      if (urlSeen.has(n)) return false;
      urlSeen.add(n);
      return true;
    });

    logger.info({
      developerUrl,
      emails: info.emails.length,
      websites: info.websites.length,
    }, '[extractPlayStoreDeveloperInfo] Developer info extracted');

    return info;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.warn({ err: err.message, developerUrl }, '[extractPlayStoreDeveloperInfo] Failed');
    return info;
  }
}

/**
 * Return an empty aggregation object (used as the default when enrichment fails early).
 */
export function emptyAggregation(): AggregatedEnrichmentData {
  return { emails: [], phones: [], websites: [], socialProfiles: {}, company: {}, person: {}, socialStats: {}, rawScrapedData: {} };
}

// ─── LLM-Guided Deep Website Crawl ───────────────────────────────────────────────

const PAGE_SELECTION_PROMPT_ENRICHMENT = `You are a web crawler assistant for lead enrichment. Select the most valuable pages to crawl from a company website to extract: contact details, social media profiles, team info, company info.

Each line below is: URL [category] "anchor text"

Return ONLY a JSON array of the selected URLs (no explanation, no markdown). Select up to 12 URLs.

MUST include if available (highest priority):
- contact / contact-us / get-in-touch pages (email, phone, address)
- about / about-us / company / our-story pages (company info, social links)
- team / leadership / people / founders pages (personal profiles)

Also include if available:
- products / services / solutions pages
- partners / integrations pages
- footer/header pages with social links

Skip: individual blog posts, news articles, login/signup, legal/privacy pages, asset files.

Example output: ["https://example.com/about", "https://example.com/contact"]`;

/**
 * Deep crawl a website using LLM-guided page selection (like analyzeWebsite).
 * Returns structured crawl results with HTML preserved for social link extraction.
 */
export async function deepCrawlWebsite(
  url: string,
  userId: number,
): Promise<{
  success: boolean;
  pages: Array<{ success: boolean; url: string; text?: string; _html?: string; category?: string }>;
  combinedContent: string;
  socialLinksFromHtml: Record<string, string>;
  error?: string;
}> {
  const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;

  try {
    const crawler = new WebsiteCrawlerService({ maxPages: 1, maxContentLength: 16000, timeoutMs: 30000 });

    // Phase 1: Fetch homepage
    const homepagePage = await crawler.fetchPage(normalizedUrl);
    if (!homepagePage.success || !homepagePage._html) {
      return { success: false, pages: [], combinedContent: '', socialLinksFromHtml: {}, error: 'Could not reach website' };
    }
    homepagePage.category = 'homepage';
    const allPages = [homepagePage];

    // Phase 2: Extract and categorize links from homepage
    const homepageLinks = crawler.extractLinks(homepagePage._html, normalizedUrl);
    logger.info({ url: normalizedUrl, linksFound: homepageLinks.length }, '[deepCrawlWebsite] Homepage links discovered');

    const visitedSet = new Set<string>([normalizedUrl]);
    let selectedLinks: string[] = [];

    // Phase 3: LLM selects most relevant pages
    if (homepageLinks.length > 0) {
      try {
        const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
        const linkList = homepageLinks.slice(0, 80)
          .map(l => `${l.url} [${l.category}] "${l.anchorText}"`)
          .join('\n');

        const selectionResp = await llmProvider.createChatCompletion({
          model: llmProvider.defaultModel,
          messages: [
            { role: 'system', content: PAGE_SELECTION_PROMPT_ENRICHMENT },
            { role: 'user', content: `Homepage: ${normalizedUrl}\n\nDiscovered URLs:\n${linkList}` },
          ],
          temperature: 0.1,
          max_tokens: 800,
          loggingContext: { userId, purpose: 'enrichment_page_selection', service: 'LeadEnrichmentOrchestrator' },
        });

        if (selectionResp.success && selectionResp.content) {
          try {
            const cleaned = selectionResp.content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
            const selected = JSON.parse(cleaned);
            if (Array.isArray(selected)) {
              selectedLinks = selected.filter((u: unknown) => typeof u === 'string' && (u as string).startsWith('http')).slice(0, 12);
            }
          } catch {
            logger.warn('[deepCrawlWebsite] Failed to parse LLM page selection');
          }
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (llmErr: any) {
        logger.warn({ err: llmErr.message }, '[deepCrawlWebsite] LLM page selection failed, using priority-based fallback');
      }

      // Fallback: ensure contact + about + team are included if available
      const MUST_HAVE = ['contact', 'about', 'team', 'services', 'products'];
      for (const cat of MUST_HAVE) {
        const alreadyHave = selectedLinks.some(
          u => homepageLinks.find(l => l.url === u)?.category === cat
        );
        if (!alreadyHave) {
          const fallback = homepageLinks.find(l => l.category === cat && !visitedSet.has(l.url));
          if (fallback && !selectedLinks.includes(fallback.url)) {
            selectedLinks.push(fallback.url);
          }
        }
      }

      // If LLM returned nothing, use priority-based selection
      if (selectedLinks.length === 0) {
        selectedLinks = homepageLinks
          .filter(l => l.priority <= 3)
          .slice(0, 12)
          .map(l => l.url);
      }

      selectedLinks = selectedLinks.slice(0, 15);
    }

    // Phase 4: Deep crawl selected pages in parallel batches
    for (const u of selectedLinks) visitedSet.add(u);
    for (let i = 0; i < selectedLinks.length; i += 5) {
      const batch = selectedLinks.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(u => crawler.fetchPage(u)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success) allPages.push(r.value);
      }
    }

    // Phase 5: Sub-page discovery from crawled pages (round 2)
    const newLinksMap = new Map<string, { url: string; category: string; priority: number }>();
    for (const p of allPages.slice(1)) {
      if (!p._html || !p.url) continue;
      const subLinks = crawler.extractLinks(p._html, p.url);
      for (const sl of subLinks) {
        if (!visitedSet.has(sl.url) && !newLinksMap.has(sl.url) && sl.priority <= 2) {
          newLinksMap.set(sl.url, sl);
        }
      }
    }

    // Crawl up to 5 high-priority sub-pages
    if (newLinksMap.size > 0) {
      const round2Links = [...newLinksMap.values()]
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 5)
        .map(l => l.url);
      for (const u of round2Links) visitedSet.add(u);
      const r2Results = await Promise.allSettled(round2Links.map(u => crawler.fetchPage(u)));
      for (const r of r2Results) {
        if (r.status === 'fulfilled' && r.value.success) allPages.push(r.value);
      }
    }

    // Phase 6: Build combined content + extract social links from ALL HTML pages
    const combinedContent = crawler.buildContent(allPages);

    // Extract social links from HTML anchors across all pages
    const allHtml = allPages
      .filter(p => p.success && p._html)
      .map(p => p._html!)
      .join('\n');
    const socialLinksFromHtml = extractSocialLinksFromHtml(allHtml);

    logger.info({
      url: normalizedUrl,
      totalPages: allPages.filter(p => p.success).length,
      contentLength: combinedContent.length,
      socialLinksFound: Object.keys(socialLinksFromHtml).length,
    }, '[deepCrawlWebsite] Deep crawl complete');

    // Clean up HTML from results (keep slim)
    const cleanPages = allPages.map(p => ({ success: p.success, url: p.url, text: p.text, category: p.category }));

    return {
      success: true,
      pages: cleanPages,
      combinedContent,
      socialLinksFromHtml,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err: err.message, url }, '[deepCrawlWebsite] Deep crawl failed');
    return { success: false, pages: [], combinedContent: '', socialLinksFromHtml: {}, error: err.message };
  }
}

// ─── Embeddings Integration ───────────────────────────────────────────────────────

const ENRICHMENT_CHUNK_SIZE = 1200;
const ENRICHMENT_CHUNK_OVERLAP = 200;

/**
 * Simple text chunking for enrichment content. Prefers natural break points.
 */
function chunkEnrichmentContent(text: string): string[] {
  if (!text || text.length < 100) return text ? [text] : [];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + ENRICHMENT_CHUNK_SIZE, text.length);
    // Try to break at a natural boundary
    if (end < text.length) {
      const minEnd = pos + Math.floor(ENRICHMENT_CHUNK_SIZE * 0.55);
      const slice = text.slice(minEnd, end);
      const dblNewline = slice.lastIndexOf('\n\n');
      if (dblNewline !== -1) { end = minEnd + dblNewline + 2; }
      else {
        const nl = slice.lastIndexOf('\n');
        if (nl !== -1) { end = minEnd + nl + 1; }
        else {
          const dot = slice.lastIndexOf('. ');
          if (dot !== -1) { end = minEnd + dot + 2; }
        }
      }
    }
    chunks.push(text.slice(pos, end));
    pos = end - ENRICHMENT_CHUNK_OVERLAP;
    if (pos < 0) pos = 0;
    if (end >= text.length) break;
  }
  return chunks;
}

/**
 * Store crawled website content as embeddings for a lead.
 * Returns number of chunks stored.
 */
export async function storeEnrichmentEmbeddings(
  userId: number,
  leadId: number,
  content: string,
  websiteUrl: string,
): Promise<number> {
  try {
    const { embeddingService } = await import('../embeddings/EmbeddingService.js');
    const chunks = chunkEnrichmentContent(content);
    if (chunks.length === 0) return 0;

    let stored = 0;
    for (const chunk of chunks) {
      try {
        await embeddingService.storeEmbedding({
          userId,
          text: chunk,
          sourceType: 'lead',
          sourceId: leadId,
          metadata: { website: websiteUrl, purpose: 'enrichment' },
        });
        stored++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.warn({ err: err.message, leadId }, '[storeEnrichmentEmbeddings] Failed to store chunk');
      }
    }

    logger.info({ leadId, totalChunks: chunks.length, stored }, '[storeEnrichmentEmbeddings] Embeddings stored');
    return stored;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.warn({ err: err.message, leadId }, '[storeEnrichmentEmbeddings] Embedding service unavailable');
    return 0;
  }
}

/**
 * Semantic search over enrichment embeddings for a lead.
 * Used to extract specific info from large crawled content.
 */
export async function searchEnrichmentEmbeddings(
  userId: number,
  leadId: number,
  query: string,
  limit = 5,
): Promise<string[]> {
  try {
    const { embeddingService } = await import('../embeddings/EmbeddingService.js');
    const results = await embeddingService.searchSimilar({
      userId,
      query,
      limit,
      threshold: 0.4,
      sourceType: 'lead',
    });

    // Filter to only this lead's embeddings
    return results
      .filter(r => r.sourceId === leadId)
      .map(r => r.content);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.warn({ err: err.message, leadId }, '[searchEnrichmentEmbeddings] Similarity search failed');
    return [];
  }
}
