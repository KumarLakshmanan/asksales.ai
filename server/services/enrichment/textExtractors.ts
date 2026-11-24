// ─── Lead Enrichment — Text Extraction Utilities ────────────────────────────────

import { hasValidCountryCode, PHONE_MIN_DIGITS, PHONE_MAX_DIGITS } from './phoneConstants.js';
import { cleanEnrichmentEmail, cleanEnrichmentPhone } from '../../../shared/enrichmentContactValidation.js';

export function extractEmailsFromText(text: string): string[] {
  if (!text) return [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  
  // Preserve syntactically valid company and personal mailboxes as candidates.
  // Ownership is a separate question, not inferred from the email provider.
  return [...new Set(matches.map(cleanEnrichmentEmail).filter((email): email is string => Boolean(email)))];
}

export function extractPhonesFromText(text: string): string[] {
  if (!text) return [];
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/(?<![\d.])[+-]?\d{1,3}\.\d{4,}(?![\d.])/g, ' ')
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ');
  
  const results = new Set<string>();

  // 1. General formatted numbers (supports international and local formats)
  const phoneRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}(?:\s*(?:x|ext|extension)\s*\d{1,5})?/gi;
  const matches1 = text.match(phoneRegex) || [];
  for (const match of matches1) {
    results.add(match.trim());
  }

  // 2. Labeled numbers (captures unformatted numbers preceded by typical phone labels)
  const labeledPhoneRegex = /(?:phone|tel|tele|mobile|call|mob|contact|ph|whatsapp|phones)\s*[:\-–—\s]?\s*(\+?\d[\d\s\-().]{6,20}\d)/gi;
  const matches2 = text.matchAll(labeledPhoneRegex);
  for (const match of matches2) {
    if (match[1]) {
      results.add(match[1].trim());
    }
  }

  // 3. Toll-free numbers specific formats, e.g. 1800 123 4567 or 1-800-123-4567
  const tollFreeRegex = /\b1[-.\s]?8[0-9]{2}[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;
  const matches3 = text.match(tollFreeRegex) || [];
  for (const match of matches3) {
    results.add(match.trim());
  }

  const validPhones = Array.from(results).filter(p => {
    if (!cleanEnrichmentPhone(p)) return false;
    const digits = p.replace(/\D/g, '');
    // E.164 max is 15 digits, min is PHONE_MIN_DIGITS (7)
    if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return false;
    // Reject obviously junk: all same digit repeated
    if (/^(\d)\1{6,}$/.test(digits)) return false;
    // Reject years/timestamps if no formatting (e.g. 20260709)
    if (/^(19|20)\d{6}$/.test(digits)) return false;
    
    // Check formatting
    const hasFormatting = /[\s\-().]/.test(p) || p.trim().startsWith('+');
    // If it's a completely raw unformatted digit string (no spaces, dashes, etc.),
    // only accept if it's prefixed by a label (captured in matches2) or if it starts with +
    if (!hasFormatting && !p.startsWith('+')) {
      const index = text.indexOf(p);
      if (index !== -1) {
        const before = text.substring(Math.max(0, index - 20), index).toLowerCase();
        const hasLabelBefore = /(?:phone|tel|tele|mobile|call|mob|contact|ph|whatsapp)/.test(before);
        if (!hasLabelBefore) return false;
      } else {
        return false;
      }
    }
    
    const hasPlus = p.trim().startsWith('+');
    if (hasPlus && !hasValidCountryCode(digits)) return false;
    return true;
  });

  // Normalize: strip non-digit except leading +, then dedup by digits-only form
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const phone of validPhones) {
    const digitsOnly = phone.replace(/\D/g, '');
    if (seen.has(digitsOnly)) continue;
    seen.add(digitsOnly);
    // Prefer the version with + prefix if available
    deduped.push(phone.trim());
  }
  return deduped;
}

/**
 * Normalize phone to E.164 format (+15551234567)
 */
export function normalizePhoneToE164(phone: string): string {
  // A local number has no known country code. Never silently prepend +1.
  return cleanEnrichmentPhone(phone) || '';
}

/**
 * Format phone for human-readable display: +1 (555) 123-4567
 */
export function formatPhoneForDisplay(phone: string): string {
  return normalizePhoneToE164(phone);
}

// Domains that should never be queued as website crawl targets
const BLOCKED_URL_DOMAINS = [
  // Social media (handled via dedicated actors)
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com',
  't.co/', 'fb.com', 'fb.me',
  // App stores (cause infinite recursive crawling)
  'play.google.com', 'apps.apple.com', 'itunes.apple.com',
  'market.android.com', 'appstore.com', 'microsoft.com/store',
  // Video platforms & subdomains
  'youtu.be', 'youtube.com', 'about.youtube', 'blog.youtube',
  'tv.youtube.com', 'studio.youtube.com', 'music.youtube.com',
  'vimeo.com', 'tiktok.com',
  // Google properties
  'google.com', 'business.google.com', 'developers.google.com',
  'policies.google.com', 'support.google.com', 'accounts.google.com',
  'mail.google.com', 'docs.google.com', 'sheets.google.com',
  'play.google.com', 'news.google.com', 'scholar.google.com',
  'servicesdirectory.withyoutube.com',
  // URL shorteners & redirectors
  'bit.ly', 'goo.gl', 'tinyurl.com', 'ow.ly', 'buff.ly', 'dlvr.it',
  'lnk.to', 'linktr.ee', 'linkin.bio', 'bio.link', 'beacons.ai',
  'shorby.com', 'solo.to', 't.ly',
  // Messaging / chat
  'wa.me', 'api.whatsapp.com', 't.me', 'telegram.me',
  'discord.gg', 'discord.com',
  // Maps
  'maps.google.com', 'google.com/maps', 'goo.gl/maps',
  // Analytics / tracking
  'analytics.google.com', 'ads.google.com', 'doubleclick.net',
  // CDN / asset hosts
  'cdn.', 'static.', 'assets.',
  // Generic platforms
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  'wix.com', 'squarespace.com', 'weebly.com',
  // Job/professional platforms (often appear in bios)
  'glassdoor.com', 'indeed.com', 'ziprecruiter.com',
];

export function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  const matches = text.match(urlRegex) || [];
  const filtered = matches.filter(u =>
    !u.match(/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i) &&
    !BLOCKED_URL_DOMAINS.some(blocked => u.includes(blocked))
  );
  // Normalize trailing slashes and deduplicate
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of filtered) {
    const normalized = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(url.replace(/\/+$/, ''));
  }
  return deduped;
}

export function extractSocialHandlesFromText(text: string): Record<string, string> {
  if (!text) return {};
  const handles: Record<string, string> = {};

  // Skip handles that look like email parts or generic terms
  const SKIP_HANDLES = new Set([
    'gmail', 'yahoo', 'outlook', 'hotmail', 'protonmail', 'icloud',
    'example', 'test', 'admin', 'info', 'support', 'contact', 'email',
    'media', 'import', 'keyframes', 'charset', 'font', 'type', 'page',
    'include', 'endif', 'else', 'if', 'mixin', 'extend', 'apply',
    'grams', 'photo', 'photos', 'image', 'images', 'video', 'videos',
    'post', 'posts', 'story', 'stories', 'reel', 'reels', 'live',
    'follow', 'like', 'share', 'comment', 'tag', 'explore', 'search',
    'home', 'feed', 'profile', 'account', 'settings', 'about', 'contact',
    'help', 'support', 'faq', 'terms', 'privacy', 'policy', 'legal',
    'login', 'signup', 'register', 'download', 'app', 'store', 'shop',
    'youtube', 'twitter', 'facebook', 'instagram', 'linkedin', 'tiktok',
    'pinterest', 'snapchat', 'reddit', 'discord', 'telegram', 'whatsapp',
    'prediction', 'predictions', 'forecast', 'trend', 'trends',
    'business', 'official', 'real', 'genuine', 'verified', 'authentic',
    'web', 'site', 'website', 'blog', 'news', 'press', 'release',
  ]);

  // Look for platform-specific patterns with context
  // Pattern: "Instagram: @handle" or "Follow us on Instagram @handle"
  const platformPatterns: { platform: string; regex: RegExp }[] = [
    { platform: 'instagram', regex: /(?:instagram|ig|insta)\b\s*[:\-–—]?\s*@([a-zA-Z0-9_.]{3,30})/gi },
    { platform: 'twitter', regex: /(?:twitter|tweet|x\.com)\b\s*[:\-–—]?\s*@([a-zA-Z0-9_]{3,30})/gi },
    { platform: 'tiktok', regex: /(?:tiktok|tik\s*tok)\b\s*[:\-–—]?\s*@([a-zA-Z0-9_.]{3,30})/gi },
  ];

  for (const { platform, regex } of platformPatterns) {
    for (const match of text.matchAll(regex)) {
      const handle = match[1]?.trim();
      if (!handle || SKIP_HANDLES.has(handle.toLowerCase())) continue;
      // Skip if it looks like a domain (contains dots followed by TLD)
      if (/\.(com|org|net|io|co|me|dev)$/i.test(handle)) continue;
      // Skip if it's all numeric (phone numbers, IDs)
      if (/^\d+$/.test(handle)) continue;
      if (!handles[platform]) {
        handles[platform] = handle;
        break;
      }
    }
  }

  return handles;
}

export function extractSocialUrlsFromText(text: string): Record<string, string> {
  if (!text) return {};
  const profiles: Record<string, string> = {};

  // URLs that are navigation/utility pages, not actual profiles
  const isShareOrUtility = (url: string) => /\/(intent|share|sharer|dialog|hashtag|search|explore|login|signup|register|shareArticle|sharing|help|about|legal|policies|privacy|terms)\b/i.test(url);

  for (const m of text.matchAll(/https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[^\s<>"')\]]+/gi)) {
    if (!profiles.linkedin && !isShareOrUtility(m[0])) profiles.linkedin = m[0].replace(/\/+$/, '');
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/gi)) {
    const handle = m[1];
    if (!profiles.twitter && !isShareOrUtility(m[0]) && handle.length >= 3) profiles.twitter = m[0].replace(/\/+$/, '');
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)/gi)) {
    const handle = m[1];
    if (!profiles.instagram && !isShareOrUtility(m[0]) && handle.length >= 3 && !/^(explore|accounts|p|reel|stories|direct)$/.test(handle)) profiles.instagram = m[0].replace(/\/+$/, '');
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9.]+)/gi)) {
    const handle = m[1];
    if (!profiles.facebook && !isShareOrUtility(m[0]) && handle.length >= 3 && !/^(groups|events|pages|marketplace|watch|gaming)$/.test(handle)) profiles.facebook = m[0].replace(/\/+$/, '');
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9-]+)/gi)) {
    const handle = m[1];
    if (!profiles.github && handle.length >= 2 && !/^(about|features|pricing|enterprise|sponsors|topics|collections|trending|explore)$/.test(handle)) profiles.github = m[0].replace(/\/+$/, '');
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)?([a-zA-Z0-9_-]+)/gi)) {
    const handle = m[1];
    if (!profiles.youtube && handle.length >= 2 && !/^(watch|feed|results|playlist|shorts|embed|features)$/.test(handle)) profiles.youtube = m[0].replace(/\/+$/, '');
  }
  for (const m of text.matchAll(/https?:\/\/[a-zA-Z0-9-]+\.blogspot\.com(?:\/[^\s<>"')\]]*)?/gi)) {
    if (!profiles.blogger) profiles.blogger = m[0].replace(/\/+$/, '');
  }
  return profiles;
}

/**
 * Extract social media profile URLs directly from HTML anchor hrefs.
 * Works even when text-based extraction misses them (links are often in footer/header).
 */
export function extractSocialLinksFromHtml(html: string): Record<string, string> {
  const patterns: Record<string, RegExp> = {
    linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>]+/gi,
    twitter: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+/gi,
    facebook: /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9.]+/gi,
    instagram: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.]+/gi,
    youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|user|@)[^\s"'<>]+/gi,
    github: /https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9-]+/gi,
  };

  // Platform-specific page slugs that are NOT profiles
  const PLATFORM_SKIP: Record<string, RegExp> = {
    twitter: /\/(intent|share|hashtag|search|explore|login|signup|i|compose|settings|home)\b/i,
    facebook: /\/(sharer|dialog|share|groups|events|pages|marketplace|watch|login|recover)\b/i,
    linkedin: /\/(shareArticle|sharing|login|signup|feed|pulse|search|learning)\b/i,
    instagram: /\/(explore|accounts|p|reel|stories|direct|developer|about)\b/i,
    github: /\/(about|features|pricing|enterprise|sponsors|topics|explore|trending)\b/i,
    youtube: /\/(watch|feed|results|playlist|shorts|embed|features|about)\b/i,
  };

  const result: Record<string, string> = {};
  for (const [key, regex] of Object.entries(patterns)) {
    if (result[key]) continue;
    const allMatches = [...html.matchAll(regex)];
    for (const match of allMatches) {
      // Clean trailing punctuation, quotes, or fragments
      let cleaned = match[0].replace(/['")\]}>]+$/, '');
      // Remove tracking fragments
      cleaned = cleaned.split('?')[0].replace(/\/$/, '');

      // Skip generic/share/intent pages
      if (PLATFORM_SKIP[key]?.test(cleaned)) continue;

      // Extract handle from URL and check minimum length
      const handleMatch = cleaned.match(/\/([a-zA-Z0-9_.-]+)\/?$/);
      const handle = handleMatch?.[1] || '';
      if (handle.length < 3) continue;
      // Skip numeric-only handles (phone numbers, IDs)
      if (/^\d+$/.test(handle)) continue;
      // Skip generic words
      if (/^(about|explore|search|home|feed|profile|account|settings|help|support|login|signup|register|download|app|store|shop|business|official|real|genuine|verified|authentic|web|site|website|blog|news|press|release|prediction|predictions|forecast|trend|trends)$/i.test(handle)) continue;

      result[key] = cleaned;
      break;
    }
  }
  return result;
}

/**
 * Forbidden handles, usernames, and generic URL paths that do not represent real social profiles.
 */
export const FORBIDDEN_HANDLES = new Set([
  'share', 'intent', 'login', 'signup', 'home', 'about', 'help',
  'support', 'privacy', 'terms', 'contact', 'search', 'explore',
  'settings', 'notifications', 'messages', 'javascript', 'void',
  'youtube', 'twitter', 'facebook', 'instagram', 'linkedin', 'tiktok',
  'pinterest', 'snapchat', 'reddit', 'discord', 'telegram', 'whatsapp',
  'x', 'github', 'blogger', 'medium', 'substack', 'wordpress', 'blogspot',
  'prediction', 'predictions', 'forecast', 'trend', 'trends',
  'business', 'official', 'real', 'genuine', 'verified', 'authentic',
  'web', 'site', 'website', 'blog', 'news', 'press', 'release',
  'photo', 'photos', 'image', 'images', 'video', 'videos',
  'post', 'posts', 'story', 'stories', 'reel', 'reels', 'live',
  'follow', 'like', 'share', 'comment', 'tag', 'user', 'channel',
  'company', 'page', 'in', 'pages', 'groups', 'events', 'marketplace',
  'watch', 'gaming', 'developer', 'developers', 'features', 'pricing',
  'enterprise', 'sponsors', 'topics', 'collections', 'trending',
  'sharer', 'dialog', 'hashtag', 'sharearticle', 'sharing',
  'facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'github.com', 'x.com'
]);

/**
 * Validate that a social handle appears to belong to the subject website/company,
 * not a random third-party or generic handle. Returns true if likely relevant.
 */
export function isRelevantSocialHandle(handle: string, companyDomain?: string, companyName?: string): boolean {
  if (!handle) return false;
  const lower = handle.toLowerCase().replace(/^@/, '');

  // Check if forbidden or too short
  if (FORBIDDEN_HANDLES.has(lower) || lower.length < 3) return false;

  // Skip numeric-only handles (phone numbers, IDs)
  if (/^\d+$/.test(lower)) return false;

  // If we have company info, check for relevance
  if (companyDomain) {
    const domainBase = companyDomain.replace(/^www\./, '').split('.')[0].toLowerCase();
    if (lower.includes(domainBase) || domainBase.includes(lower)) return true;
  }
  if (companyName) {
    const nameWords = companyName.toLowerCase().split(/[\s_-]+/);
    if (nameWords.some(w => w.length > 2 && lower.includes(w))) return true;
  }

  // If we have company context but the handle doesn't match, reject it
  if (companyDomain || companyName) return false;

  // Default: accept only if no company context at all
  return true;
}

export function extractDomainFromUrl(url: string): string | undefined {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

// ─── Social Profile Normalization ─────────────────────────────────────────────────

const PLATFORM_DOMAINS: Record<string, string> = {
  instagram: 'instagram.com',
  twitter: 'x.com',
  x: 'x.com',
  linkedin: 'linkedin.com',
  facebook: 'facebook.com',
  youtube: 'youtube.com',
  github: 'github.com',
  tiktok: 'tiktok.com',
  pinterest: 'pinterest.com',
  whatsapp: 'wa.me',
};

/**
 * Convert a social handle or URL to a full profile URL
 * Returns the full URL for storage
 */
export function normalizeSocialProfile(platform: string, value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  
  // Already a full URL
  if (trimmed.startsWith('http')) {
    try {
      const parsed = new URL(trimmed);
      const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!path) return null;
      
      const pathLower = path.toLowerCase();
      if (FORBIDDEN_HANDLES.has(pathLower)) return null;
      
      // Skip generic/share/intent pages
      const isShareOrUtility = /\/(intent|share|sharer|dialog|hashtag|search|explore|login|signup|register|shareArticle|sharing|help|about|legal|policies|privacy|terms)\b/i.test(trimmed);
      if (isShareOrUtility) return null;
    } catch {
      return null;
    }
    return trimmed.replace(/\/+$/, '');
  }
  
  // Handle @handle format
  const handle = trimmed.replace(/^@/, '');
  const handleLower = handle.toLowerCase();
  
  // Skip invalid handles (emails, domains, etc.)
  if (handle.includes('@') && handle.includes('.')) return null; // email
  if (/\.(com|org|net|io|co|me|dev|ai)$/i.test(handle)) return null; // domain
  // Skip handles that are too short (likely fragments)
  if (handle.length < 3) return null;
  
  // Skip forbidden handles
  if (FORBIDDEN_HANDLES.has(handleLower)) return null;

  const domain = PLATFORM_DOMAINS[platform.toLowerCase()];
  if (!domain) return null;
  
  // Special handling for WhatsApp
  if (platform.toLowerCase() === 'whatsapp') {
    return `https://wa.me/${handle.replace(/\D/g, '')}`;
  }
  
  // Special handling for LinkedIn - could be company or profile
  if (platform.toLowerCase() === 'linkedin') {
    if (handle.includes('/company/') || handle.includes('/in/')) {
      return `https://linkedin.com/${handle}`;
    }
    // Default to profile
    return `https://linkedin.com/in/${handle}`;
  }
  
  // Special handling for Twitter/X
  if (platform.toLowerCase() === 'twitter' || platform.toLowerCase() === 'x') {
    return `https://x.com/${handle}`;
  }
  
  return `https://${domain}/${handle}`;
}

/**
 * Extract bare handle from a social URL for display
 */
export function extractHandleFromUrl(platform: string, url: string): string {
  if (!url) return '';
  
  // If it's already a bare handle (no http, no domain)
  if (!url.startsWith('http') && !url.includes('.')) {
    return url.replace(/^@/, '');
  }
  
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const pathname = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    
    // Platform-specific handle extraction
    switch (platform.toLowerCase()) {
      case 'instagram':
        return pathname.split('/')[0] || '';
      case 'twitter':
      case 'x':
        return pathname.split('/')[0] || '';
      case 'linkedin':
        // Handle both /in/username and /company/name
        // eslint-disable-next-line no-case-declarations
        const parts = pathname.split('/');
        if (parts[0] === 'in' || parts[0] === 'company') {
          return parts[1] || '';
        }
        return parts[0] || '';
      case 'facebook':
        return pathname.split('/')[0] || '';
      case 'youtube':
        // Handle @handle, /channel/ID, /c/name, /user/name
        if (pathname.startsWith('@')) return pathname.slice(1);
        // eslint-disable-next-line no-case-declarations
        const ytParts = pathname.split('/');
        return ytParts[ytParts.length - 1] || '';
      case 'github':
        return pathname.split('/')[0] || '';
      case 'tiktok':
        return pathname.replace(/^@/, '') || '';
      case 'pinterest':
        return pathname.split('/')[0] || '';
      case 'whatsapp':
        return parsed.searchParams.get('phone') || pathname || '';
      default:
        return pathname.split('/')[0] || '';
    }
  } catch {
    return url.replace(/^@/, '');
  }
}

/**
 * Sanitize all social profiles in a Record:
 * - Reject profiles that are just the platform domain
 * - Reject profiles with generic/forbidden handles
 * - Normalize handles to full URLs
 */
export function sanitizeSocialProfiles(profiles: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [platform, value] of Object.entries(profiles)) {
    if (!value) continue;
    // Extract base platform (e.g. linkedin_company -> linkedin)
    const basePlatform = platform.split('_')[0].toLowerCase();
    const normalized = normalizeSocialProfile(basePlatform, value);
    if (normalized) {
      try {
        const parsed = new URL(normalized);
        const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
        if (path && !FORBIDDEN_HANDLES.has(path.toLowerCase())) {
          sanitized[platform] = normalized;
        }
      } catch {
        // Skip
      }
    }
  }
  return sanitized;
}
