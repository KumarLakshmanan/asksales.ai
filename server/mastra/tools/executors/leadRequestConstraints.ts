const RESULT_LIMIT_FIELDS = [
  'maxItems',
  'maxResults',
  'resultsLimit',
  'limit',
  'maxProfiles',
  'maxCrawledPlacesPerSearch',
] as const;

/** Extract an explicit total requested by the user, without guessing from unrelated numbers. */
export function extractRequestedLeadLimit(requirements?: string): number | undefined {
  if (!requirements) return undefined;
  const match = requirements.match(
    /\b(?:only\s+|up\s+to\s+|at\s+most\s+|max(?:imum)?(?:\s+of)?\s+|limit(?:ed)?\s+to\s+)?(\d{1,6})(?:\s+[a-z][\w&+/-]*){0,6}\s+(?:leads?|contacts?|prospects?|profiles?|accounts?|results?|compan(?:y|ies)|business(?:es)?|hotels?)\b/i,
  ) || requirements.match(
    /\b(?:global\s+)?(?:(?:saved[- ]?)?lead\s+)?cap(?:ped)?(?:\s+(?:of|at|to))?\s*[:=]?\s*(?:exactly\s+)?(\d{1,6})\b/i,
  ) || requirements.match(
    /\b(?:global\s+)?requested\s+lead\s+total(?:\s+(?:of|at|to))?\s*[:=]?\s*(?:exactly\s+)?(\d{1,6})\b/i,
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Read the current human request directly so a tool-call paraphrase cannot lose its cap. */
export function resolveLeadLimitRequirements(
  requirements?: string,
  history: Array<{ role?: string; content?: unknown; _getType?: () => string }> = [],
): string | undefined {
  const content = resolveOriginalLeadInputRequest(undefined, history);
  return extractRequestedLeadLimit(content) ? content : requirements;
}

const LEAD_SETTINGS_PREPARATION_CONTROL = 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.';

/** Read the latest substantive request, skipping only exact app-authored selection messages. */
function isLeadRegenerationControl(content: string): boolean {
  const prefix = `${LEAD_SETTINGS_PREPARATION_CONTROL}\n`;
  const rawControl = content.startsWith(prefix) ? content.slice(prefix.length) : content;
  return /^Regenerate the reviewed lead inputs using only [^\n.]+\.\s+(?:Keep the same ICP, geography, and industry targeting|Reuse the same ICP, geography, industry, and provider-specific targeting), enforce a global cap of exactly \d+ leads?(?: across all selected providers)?, and show the exact provider parameters for review(?: before execution)?\.(?: Do not execute yet, substitute a broad provider, or create duplicate leads\.)?$/i.test(rawControl);
}

function hasExplicitRequestRevision(content: string): boolean {
  return /\b(?:change|update|replace|switch|set|add|remove|include|exclude|omit)\b|\binstead\b/i.test(content)
    || /\b[a-z][\w-]*\b\s*(?::|=)\s*/i.test(content)
    || /\b[a-z][\w-]*\b\s+(?:\[[^\]\r\n]*\]|true\b|false\b|-?\d+\b|["'][^"'\r\n]+["'])/i.test(content);
}

/**
 * App/setup retries may point back to an earlier request without restating its
 * reviewed provider values. Treat those messages as controls, while keeping a
 * newer message authoritative whenever it actually revises a field.
 */
function isReferenceOnlyLeadControl(content: string): boolean {
  if (hasExplicitRequestRevision(content)) return false;
  const referencesEarlierContext = /\b(?:same|unchanged|original|existing|prior|previous)\b/i.test(content);
  const referencesLeadSetup = /\b(?:request|message|constraints?|settings?|inputs?|strateg(?:y|ies)|workflows?|icp|profiles?)\b/i.test(content);
  return referencesEarlierContext && referencesLeadSetup;
}

export function resolveOriginalLeadInputRequest(
  requirements?: string,
  history: Array<{ role?: string; content?: unknown; _getType?: () => string }> = [],
): string | undefined {
  for (const message of [...history].reverse()) {
    if (message.role !== 'user' && message._getType?.() !== 'human') continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;
    const content = message.content.trim();
    if (content === 'Show me all available strategies for each channel'
      || /^Hire [^\n]+ for lead generation$/i.test(content)
      || /^Use [^\n]+ and prepare the search settings for my review\.$/.test(content)
      || content === LEAD_SETTINGS_PREPARATION_CONTROL
      || isLeadRegenerationControl(content)
      || isReferenceOnlyLeadControl(content)) continue;
    return content;
  }
  return requirements;
}

/**
 * Keep the authoritative user request alongside any model-authored tool-call
 * summary. A summary is useful ranking context, but it may omit the exact
 * catalog title that the user explicitly selected.
 */
export function resolveWorkflowRecommendationRequirements(
  requirements?: string,
  history: Array<{ role?: string; content?: unknown; _getType?: () => string }> = [],
): string | undefined {
  const original = resolveOriginalLeadInputRequest(undefined, history)?.trim();
  const summary = requirements?.trim();
  if (!original) return summary || undefined;
  if (!summary || summary === original) return original;
  return `${original}\n\nTool-call summary: ${summary}`;
}

/** Extract a location that the reviewer named explicitly in the approval text. */
export function extractExplicitTargetLocation(requirements?: string): string | undefined {
  if (!requirements) return undefined;
  const match = requirements.match(
    /\blocation(?:\s+(?:is|of))?\s*[:=]?\s*["']([^"']{1,120})["']/i,
  ) || requirements.match(
    /\blocation(?:\s+(?:is|of))?\s*[:=]\s*([^.;\n]{1,120}?)(?=\.(?:\s|$)|;|\n|$)/i,
  ) || requirements.match(
    /\bin\s+["']([^"']{1,120})["']/i,
  ) || requirements.match(
    /\bin\s+([a-z][a-z .,'-]{1,120}?)(?=\.\s|\.\s*$|;|\s+(?:using|with)\b|\s+in\s+(?:the\s+)?[a-z][a-z &+/'-]*\s+industry\b|,\s*(?:industry|global\s+cap)\b|,\s*in\s+(?:the\s+)?[a-z]|$)/i,
  );
  return match?.[1]?.trim() || undefined;
}

export class FacebookCompetitorPageUrlsRequiredError extends Error {
  constructor() {
    super('Facebook Competitor Page Followers requires one or more HTTPS Facebook page URLs from the request. No search settings were saved.');
    this.name = 'FacebookCompetitorPageUrlsRequiredError';
  }
}

/** Keep the exact user-supplied Facebook page targets; never fall back to actor demo URLs. */
export function applyFacebookCompetitorPageUrls(
  inputs: Record<string, unknown>,
  workflowId: string | undefined,
  requirements?: string,
): Record<string, unknown> {
  if (workflowId !== 'facebook_competitor_pages') return inputs;
  const candidates = requirements?.match(/https?:\/\/(?:[a-z0-9-]+\.)*facebook\.com\/[^\s<>"'`]+/gi) || [];
  const urls = [...new Set(candidates.map((candidate) => candidate.replace(/[),.;!?]+$/g, '')))]
    .filter((candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'https:'
          && (parsed.hostname === 'facebook.com' || parsed.hostname.endsWith('.facebook.com'))
          && parsed.pathname.split('/').filter(Boolean).length > 0;
      } catch {
        return false;
      }
    });
  if (urls.length === 0) throw new FacebookCompetitorPageUrlsRequiredError();
  return {
    ...inputs,
    startUrls: urls.map((url) => ({ url })),
    followType: 'follower',
  };
}

type LeadIntentProfile = {
  subIndustry?: unknown;
  targetAudience?: unknown;
  industry?: unknown;
  primaryRegions?: unknown;
};

function normalizeAudienceSearchTerm(value?: string): string | undefined {
  if (!value) return undefined;
  const entity = value
    .replace(/\b(?:owners?|co-?founders?|founders?|general managers?|managers?|directors?|executives?|decision[- ]makers?|buyers?|leaders?)\b.*$/i, '')
    .trim();
  return entity || value;
}

/**
 * Replace demo prefills with deterministic ICP context when the configured LLM
 * provider is temporarily unavailable. Provider examples such as "restaurant"
 * and "New York" are useful schema hints, but must never become live searches.
 */
export function applyLeadIntentToFallbackInputs(
  inputs: Record<string, unknown>,
  inputMapping: Record<string, unknown>,
  icpProfile?: LeadIntentProfile | null,
  resolvedLocation?: unknown,
): Record<string, unknown> {
  const mappedFields = new Set(Object.keys(inputMapping));
  const constrained = { ...inputs };
  const firstString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const item = value.find(candidate => typeof candidate === 'string' && candidate.trim());
        if (typeof item === 'string') return item.trim();
      }
    }
    return undefined;
  };

  const searchTerm = firstString(icpProfile?.subIndustry)
    || normalizeAudienceSearchTerm(firstString(icpProfile?.targetAudience))
    || firstString(icpProfile?.industry);
  const reviewedLocation = firstString(resolvedLocation);
  const location = reviewedLocation || firstString(icpProfile?.primaryRegions);
  const locationParts = location?.split(',').map(part => part.trim()).filter(Boolean) || [];
  const locality = locationParts[0];
  const parentCity = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locality;
  const providerCity = reviewedLocation ? locality : parentCity;
  const locationScopedSearchTerm = searchTerm && locality
    ? (searchTerm.toLowerCase().includes(locality.toLowerCase()) ? searchTerm : `${searchTerm} ${locality}`)
    : searchTerm;
  const hashtag = locationScopedSearchTerm
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();

  const setMapped = (field: string, value: unknown) => {
    if (mappedFields.has(field) && value !== undefined) constrained[field] = value;
  };

  if (searchTerm) {
    setMapped('searchStringsArray', [searchTerm]);
    setMapped('searchQueries', [searchTerm]);
    setMapped('queries', [searchTerm]);
    setMapped('keywords', [searchTerm]);
    setMapped('search', locality ? `${searchTerm} near ${locality}` : searchTerm);
    setMapped('searchQuery', searchTerm);
    setMapped('query', locationScopedSearchTerm);
    setMapped('hashtags', hashtag ? [hashtag] : undefined);
  }
  if (location) {
    setMapped('locationQuery', location);
    setMapped('location', providerCity || location);
    setMapped('locations', [location]);
    setMapped('city', providerCity || location);
  }
  if (searchTerm && location && mappedFields.has('startUrls')) {
    const broadSearchTerm = /\bhotels?\b/i.test(searchTerm) ? 'hotels' : searchTerm;
    const queries = Array.from(new Set([
      `${searchTerm} near ${location}`,
      `${broadSearchTerm} near ${location}`,
    ]));
    constrained.startUrls = queries.map(query => ({
      url: `https://www.google.com/maps/search/${encodeURIComponent(query).replace(/%20/g, '+')}`,
    }));
  }

  return constrained;
}

/** Preserve distinct generated search segments; ICP fallback is only for failed generation. */
export function preserveGeneratedLeadInputs(
  inputs: Record<string, unknown>,
  requirements?: string,
): Record<string, unknown> {
  const result = { ...inputs };
  // A city name (or a plausible-looking number) is not a resolved provider ID.
  // Use query-based geography unless the requester actually supplied this ID.
  if ('location_uid' in result) {
    const suppliedUid = requirements?.match(/\blocation[ _-]*uid\s*(?:is|:|=)?\s*["']?(\d+)\b/i)?.[1];
    if (suppliedUid) result.location_uid = suppliedUid;
    else delete result.location_uid;
  }
  return result;
}

/**
 * Enforce the reviewed result limit after LLM generation. Prompts are advisory;
 * this deterministic pass is the contract that prevents provider over-fetching.
 */
export function applyRequestedLeadLimit(
  inputs: Record<string, unknown>,
  requirements?: string,
  inputSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const requestedLimit = extractRequestedLeadLimit(requirements);
  if (!requestedLimit) return inputs;

  return applyLeadLimit(inputs, requestedLimit, inputSchema);
}

function applyLeadLimit(
  inputs: Record<string, unknown>,
  requestedLimit: number,
  inputSchema?: Record<string, unknown>,
): Record<string, unknown> {

  const constrained = { ...inputs };
  for (const field of RESULT_LIMIT_FIELDS) {
    if (field in constrained || (inputSchema && Object.hasOwn(inputSchema, field))) {
      constrained[field] = requestedLimit;
    }
  }

  // These actors apply limits per target. Divide the fetch allowance across
  // targets instead of silently deleting user-requested queries or hashtags.
  // At least one result per target is needed when targets outnumber the cap;
  // the separately persisted global save cap still bounds accepted leads.
  if (
    'maxCrawledPlacesPerSearch' in constrained &&
    Array.isArray(constrained.searchStringsArray) &&
    constrained.searchStringsArray.length > 1
  ) {
    constrained.maxCrawledPlacesPerSearch = Math.max(1, Math.floor(requestedLimit / constrained.searchStringsArray.length));
  }

  // Instagram hashtag search also applies resultsLimit per hashtag.
  if (
    'resultsLimit' in constrained &&
    Array.isArray(constrained.hashtags) &&
    constrained.hashtags.length > 1
  ) {
    constrained.resultsLimit = Math.max(1, Math.floor(requestedLimit / constrained.hashtags.length));
  }

  return constrained;
}

/**
 * Enforce a reviewed total across the complete provider batch. Without this
 * pass, an LLM-generated multi-search applies the requested number to every
 * actor input (for example, three searches × two leads = six provider rows).
 */
export function applyRequestedLeadLimitToBatch<T extends { inputs: Record<string, unknown> }>(
  entries: T[],
  requirements?: string,
  semanticLimit?: number | null,
): Array<T & { requestedLeadLimit?: number; requestedLeadTotal?: number }> {
  // A present semantic value (including null) supersedes legacy text parsing.
  const requestedLimit = semanticLimit !== undefined ? semanticLimit : extractRequestedLeadLimit(requirements);
  if (!requestedLimit || entries.length === 0) return entries;

  // Keep fallback coverage across every selected provider channel while
  // limiting duplicate searches within a channel. The executor applies the
  // remaining global allowance in sequence and skips later providers once the
  // reviewed total is reached.
  const retainedPerChannel = new Map<string, number>();
  const retained = entries.filter((entry, index) => {
    const candidate = entry as T & { platform?: unknown; provider?: unknown };
    const rawChannel = typeof candidate.platform === 'string'
      ? candidate.platform
      : typeof candidate.provider === 'string'
        ? candidate.provider
        : `entry-${index}`;
    const normalized = rawChannel.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const channel = normalized.startsWith('google_map')
      ? 'google_maps'
      : normalized.startsWith('justdial')
        ? 'justdial'
        : normalized.split('_')[0] || `entry-${index}`;
    const count = retainedPerChannel.get(channel) || 0;
    if (count >= requestedLimit) return false;
    retainedPerChannel.set(channel, count + 1);
    return true;
  });
  // Every provider may attempt to fill the complete reviewed total. Execution
  // passes the remaining global allowance to each provider in sequence, so an
  // empty first source does not strand its pre-allocated share and later
  // sources still cannot save more than the reviewed total.
  return retained.map(entry => ({
    ...entry,
    requestedLeadLimit: requestedLimit,
    requestedLeadTotal: requestedLimit,
    inputs: applyLeadLimit(entry.inputs, requestedLimit),
  }));
}

/**
 * Some actors impose a provider fetch minimum (for example Facebook post
 * search requires at least 10). Fetch at the provider minimum while keeping
 * the separately persisted requestedLeadLimit as the save/result cap.
 */
export function applyProviderMinimumFetchLimits(
  inputs: Record<string, unknown>,
  inputProperties: Record<string, { minimum?: number }>,
): Record<string, unknown> {
  const compatible = { ...inputs };
  for (const field of RESULT_LIMIT_FIELDS) {
    const value = compatible[field];
    const minimum = inputProperties[field]?.minimum;
    if (typeof value === 'number' && typeof minimum === 'number' && value < minimum) {
      compatible[field] = minimum;
    }
  }
  return compatible;
}
