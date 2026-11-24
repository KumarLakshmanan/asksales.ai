type UnknownRecord = Record<string, unknown>;

export interface ReviewedLeadConstraints {
  regions?: string[];
  industry?: string;
  subIndustry?: string;
  targetAudience?: string;
}

export interface LeadRelevanceDecision {
  accepted: boolean;
  reasons: string[];
  geography: 'matched' | 'missing' | 'mismatched' | 'not_required';
  industry: 'matched' | 'unknown' | 'mismatched' | 'not_required';
  audience: 'matched' | 'missing' | 'mismatched' | 'not_required';
}

export interface SemanticLeadQualification {
  industry: 'match' | 'possible' | 'conflict' | 'unknown';
  audience: 'match' | 'possible' | 'conflict' | 'unknown';
  band: 'strong_fit' | 'qualified_fit' | 'limited_fit' | 'poor_fit' | 'unknown';
}

/**
 * Let validated semantic evidence resolve only soft industry text misses.
 * Geography, requested business type, luxury/independence verification and
 * explicit role contradictions remain deterministic hard constraints.
 */
export function applySemanticLeadRelevance(
  relevance: LeadRelevanceDecision,
  semantic: SemanticLeadQualification | undefined,
): LeadRelevanceDecision {
  if (!semantic || !['strong_fit', 'qualified_fit'].includes(semantic.band)) return relevance;
  if (semantic.industry !== 'match' || semantic.audience === 'conflict') return relevance;

  const softReasons = new Set(['industry_mismatch', 'industry_missing']);
  if (relevance.reasons.some((reason) => !softReasons.has(reason))) return relevance;
  if (relevance.reasons.length === 0 && relevance.industry !== 'unknown' && relevance.industry !== 'mismatched') {
    return relevance;
  }

  return {
    ...relevance,
    accepted: true,
    reasons: [],
    industry: relevance.industry === 'unknown' || relevance.industry === 'mismatched'
      ? 'matched'
      : relevance.industry,
    audience: relevance.audience === 'not_required' && semantic.audience === 'match'
      ? 'matched'
      : relevance.audience,
  };
}

export function hasStableTwitterProfileIdentity(lead: UnknownRecord): boolean {
  const handle = String(lead.twitterHandle || lead.twitterUsername || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle);
}

/**
 * Profile actors that resolve reviewed provider identifiers already apply the
 * user's explicit target in their input schema. Their returned profiles remain
 * authoritative instead of being rejected by a second text-based ICP classifier
 * after the provider run completes.
 */
export function shouldApplyPostProviderRelevanceValidation(
  platform: unknown,
  actorId?: unknown,
): boolean {
  const providerIdentity = normalizeLeadText([platform, actorId]);
  return !providerIdentity.includes('linkedin')
    && !providerIdentity.includes('apify instagram profile scraper')
    && !providerIdentity.includes('apify facebook followers following scraper')
    // An exact reviewed source handle plus the provider's follower relation is
    // the discovery constraint for this workflow. A follower's sparse bio must
    // not override that explicit public relationship after the provider run.
    && !providerIdentity.includes('twitter competitor followers');
}

const GEO_ALIASES: Record<string, string[]> = {
  bengaluru: ['bengaluru', 'bangalore'],
  bangalore: ['bengaluru', 'bangalore'],
  mumbai: ['mumbai', 'bombay'],
  bombay: ['mumbai', 'bombay'],
  chennai: ['chennai', 'madras'],
  madras: ['chennai', 'madras'],
  kolkata: ['kolkata', 'calcutta'],
  calcutta: ['kolkata', 'calcutta'],
};

const STOP_WORDS = new Set([
  'and', 'for', 'from', 'with', 'the', 'near', 'only', 'business', 'businesses',
  'company', 'companies', 'owner', 'owners', 'manager', 'managers', 'director',
  'directors', 'founder', 'founders', 'executive', 'executives', 'decision', 'makers',
  'services', 'service', 'solutions', 'india', 'usa', 'united', 'states',
]);

const INDUSTRY_ALIASES: Record<string, string[]> = {
  technology: ['technology', 'technologies'],
  cafe: ['cafe', 'coffee shop', 'coffeehouse'],
  hospitality: ['hospitality', 'hotel', 'resort', 'travel', 'tour', 'tourism'],
  travel: ['travel', 'tour', 'tourism', 'hospitality'],
  hotel: ['hotel', 'hospitality', 'resort', 'accommodation'],
  tourism: ['tourism', 'tour', 'travel', 'hospitality'],
};

const PERSON_ROLE_ALIASES: Array<{ key: string; requested: RegExp; candidate: RegExp }> = [
  { key: 'owner', requested: /\bowners?\b|\bproprietors?\b/, candidate: /\bowners?\b|\bproprietors?\b/ },
  { key: 'founder', requested: /\bco[ -]?founders?\b|\bfounders?\b/, candidate: /\bco[ -]?founders?\b|\bfounders?\b/ },
  { key: 'general_manager', requested: /\bgeneral managers?\b|\bgm\b/, candidate: /\bgeneral managers?\b|\bgm\b/ },
  { key: 'manager', requested: /\bmanagers?\b/, candidate: /\bmanagers?\b/ },
  { key: 'director', requested: /\bdirectors?\b/, candidate: /\bdirectors?\b/ },
  { key: 'head', requested: /\bheads?\b/, candidate: /\bheads?\b/ },
  { key: 'vice_president', requested: /\bvice presidents?\b|\bvp\b/, candidate: /\bvice presidents?\b|\bvp\b/ },
  { key: 'president', requested: /\bpresidents?\b/, candidate: /\bpresidents?\b/ },
  { key: 'chief', requested: /\bchiefs?\b/, candidate: /\bchiefs?\b/ },
  { key: 'ceo', requested: /\bceo\b|\bchief executive officers?\b/, candidate: /\bceo\b|\bchief executive officers?\b/ },
  { key: 'coo', requested: /\bcoo\b|\bchief operating officers?\b/, candidate: /\bcoo\b|\bchief operating officers?\b/ },
  { key: 'cfo', requested: /\bcfo\b|\bchief financial officers?\b/, candidate: /\bcfo\b|\bchief financial officers?\b/ },
  { key: 'cto', requested: /\bcto\b|\bchief technology officers?\b/, candidate: /\bcto\b|\bchief technology officers?\b/ },
  { key: 'cmo', requested: /\bcmo\b|\bchief marketing officers?\b/, candidate: /\bcmo\b|\bchief marketing officers?\b/ },
  { key: 'partner', requested: /\bpartners?\b/, candidate: /\bpartners?\b/ },
];

export function normalizeLeadText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(normalizeLeadText).filter(Boolean).join(' ');
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function meaningfulTokens(...values: unknown[]): string[] {
  return Array.from(new Set(values
    .flatMap((value) => normalizeLeadText(value).split(' '))
    .map((token) => token === 'cafes' ? 'cafe' : token.replace(/(?:ies|es|s)$/i, (suffix) => suffix === 'ies' ? 'y' : ''))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))));
}

function regionAliases(region: string): string[] {
  const normalized = normalizeLeadText(region);
  const parts = normalized.split(' ').filter((part) => part.length >= 3 && !STOP_WORDS.has(part));
  return Array.from(new Set(parts.flatMap((part) => GEO_ALIASES[part] || [part])));
}

function candidateLocationText(lead: UnknownRecord): string {
  return normalizeLeadText([
    lead.location,
    lead.address,
    lead.companyHeadquarters,
    lead.companyLocations,
    (lead.rawData as UnknownRecord | undefined)?.address,
    (lead.rawData as UnknownRecord | undefined)?.city,
    (lead.rawData as UnknownRecord | undefined)?.state,
    (lead.rawData as UnknownRecord | undefined)?.country,
  ]);
}

function candidateIndustryText(lead: UnknownRecord): string {
  return normalizeLeadText([
    lead.industry,
    lead.subIndustry,
    lead.categories,
    lead.company,
    lead.companyName,
    lead.name,
    lead.headline,
    lead.bio,
    (lead.rawData as UnknownRecord | undefined)?.categoryName,
    (lead.rawData as UnknownRecord | undefined)?.categories,
    (lead.rawData as UnknownRecord | undefined)?.description,
    // Derived post-author/commenter/liker profiles may have sparse bios. The
    // originating post is the direct evidence that tied the profile to the
    // reviewed topic, so preserve it in the relevance decision.
    (lead.rawData as UnknownRecord | undefined)?.sourcePostText,
  ]);
}

function candidatePersonIndustryText(lead: UnknownRecord): string {
  const rawData = lead.rawData as UnknownRecord | undefined;
  const industries = Array.isArray(rawData?.industries) ? rawData.industries as UnknownRecord[] : [];
  const currentPosition = Array.isArray(rawData?.currentPosition) ? rawData.currentPosition as UnknownRecord[] : [];
  return normalizeLeadText([
    lead.industry,
    lead.subIndustry,
    lead.company,
    lead.companyName,
    industries.map((industry) => [industry.name, industry.title]),
    currentPosition[0]?.companyName,
  ]);
}

function candidatePersonRoleText(lead: UnknownRecord): string {
  const rawData = lead.rawData as UnknownRecord | undefined;
  const experience = Array.isArray(rawData?.experience) ? rawData.experience as UnknownRecord[] : [];
  const currentPosition = Array.isArray(rawData?.currentPosition) ? rawData.currentPosition as UnknownRecord[] : [];
  const explicitRole = normalizeLeadText([
    lead.role,
    lead.title,
    experience[0]?.position,
    currentPosition[0]?.position,
    currentPosition[0]?.title,
  ]);
  return explicitRole || normalizeLeadText(lead.headline);
}

export function evaluateLeadRelevance(
  lead: UnknownRecord,
  constraints: ReviewedLeadConstraints | undefined,
  platform: string,
): LeadRelevanceDecision {
  const reasons: string[] = [];
  const normalizedPlatform = normalizeLeadText(platform);
  const localProvider = /google maps|google places|justdial|yelp|local|place/.test(normalizedPlatform);
  // A keyword search is not an exact-identity lookup: the provider can return
  // fuzzy matches (e.g. "Bandalore" for "Bangalore"). For a geographically
  // constrained Twitter user search, require actual profile location evidence.
  const requiresLocationEvidence = localProvider || normalizedPlatform === 'twitter competitor users';
  const personProvider = normalizedPlatform === 'linkedin'
    || /linkedin profile|profile search|people search|person search|company employees/.test(normalizedPlatform);

  const regions = (constraints?.regions || []).map((region) => String(region)).filter(Boolean);
  const locationText = candidateLocationText(lead);
  let geography: LeadRelevanceDecision['geography'] = 'not_required';
  if (regions.length > 0) {
    const aliases = regions.flatMap(regionAliases);
    if (!locationText) {
      geography = 'missing';
      if (requiresLocationEvidence) reasons.push('geography_missing');
    } else if (aliases.some((alias) => locationText.includes(alias))) {
      geography = 'matched';
    } else {
      geography = 'mismatched';
      reasons.push('geography_mismatch');
    }
  }

  const sectorTokens = meaningfulTokens(constraints?.subIndustry, constraints?.industry);
  const expandedSectorTokens = Array.from(new Set(
    sectorTokens.flatMap((token) => INDUSTRY_ALIASES[token] || [token]),
  ));
  const audienceTokens = meaningfulTokens(constraints?.targetAudience);
  const industryText = personProvider ? candidatePersonIndustryText(lead) : candidateIndustryText(lead);
  let industry: LeadRelevanceDecision['industry'] = 'not_required';
  if (expandedSectorTokens.length > 0 || audienceTokens.length > 0) {
    if (!industryText) {
      industry = 'unknown';
      if (localProvider) reasons.push('industry_missing');
    } else {
      const sectorMatched = expandedSectorTokens.some((token) => industryText.includes(token));
      const audienceMatchCount = audienceTokens.filter((token) => industryText.includes(token)).length;
      const audienceMatched = expandedSectorTokens.length === 0
        ? audienceMatchCount >= 1
        : audienceMatchCount >= 2;
      if (sectorMatched || audienceMatched) {
        industry = 'matched';
      } else {
        industry = 'mismatched';
        reasons.push('industry_mismatch');
      }
    }
  }

  let audience: LeadRelevanceDecision['audience'] = 'not_required';
  // A sector keyword alone does not establish the requested business entity:
  // hotel schools, booking agents and consultants are not hotel properties.
  const requestedEntity = normalizeLeadText([
    constraints?.subIndustry, constraints?.targetAudience,
  ]) || normalizeLeadText(constraints?.industry);
  if (!personProvider && /\bhotels?\b|\bresorts?\b/.test(requestedEntity)) {
    const raw = lead.rawData as UnknownRecord | undefined;
    const identityText = normalizeLeadText([
      lead.companyName, lead.company, lead.name, lead.categories,
      lead.bio, lead.description, raw?.categoryName, raw?.categories,
      raw?.description, raw?.bio,
    ]);
    const nonProperty = /\b(institute|college|academy|school|university|consultancy|consultants?|consulting|recruitment|suppliers?|equipment|travel agency|tour operator|booking agency)\b/.test(identityText);
    const propertyEvidence = /\b(hotels?|resorts?|accommodation|lodging)\b/.test(industryText);
    if (nonProperty || !propertyEvidence) {
      industry = 'mismatched';
      reasons.push('requested_business_type_mismatch');
    }
    if (/\bluxury\b|\bfive star\b|\b5 star\b/.test(requestedEntity)) {
      // Review ratings are not hotel star classifications.
      const luxuryEvidence = /\bluxury\b|\bfive star\b|\b5 star\b/.test(industryText)
        || Number(raw?.hotelStars ?? raw?.starRating) === 5;
      if (!luxuryEvidence) {
        industry = 'mismatched';
        reasons.push('requested_luxury_tier_unverified');
      }
    }

    // "Independent"/"boutique" briefs must not silently admit an explicitly
    // affiliated chain, franchise, collection, or managed brand. Absence of a
    // chain marker is not treated as proof of independence; this is a narrow
    // exclusion for provider text that contradicts the reviewed brief.
    if (/\bindependent\b|\bboutique\b/.test(requestedEntity)) {
      const chainAffiliation = /\b(?:hotel|resort)\s+(?:chain|group)\b|\bchain\s+(?:hotel|resort)\b|\bfranchise(?:d|e)?\b|\b(?:unit|member|part)\s+of\b|\bmanaged\s+by\b|\bowned\s+by\b|\bcollection\s+of\b|\bbrand\s+portfolio\b|\ba\s+resort\s+rio\s+hotel\b/.test(identityText);
      if (chainAffiliation) {
        industry = 'mismatched';
        reasons.push('requested_independent_property_mismatch');
      }
    }
  }
  const targetAudience = normalizeLeadText(constraints?.targetAudience);
  const requestedRoleMatchers = personProvider && targetAudience
    ? PERSON_ROLE_ALIASES.filter(({ key, requested }) => {
      if (!requested.test(targetAudience)) return false;
      if (key === 'manager' && /\bgeneral managers?\b/.test(targetAudience)) return false;
      if (key === 'president' && /\bvice presidents?\b/.test(targetAudience)) return false;
      return true;
    })
    : [];
  if (requestedRoleMatchers.length > 0) {
    const roleText = candidatePersonRoleText(lead);
    if (!roleText) {
      audience = 'missing';
      reasons.push('audience_role_missing');
    } else if (requestedRoleMatchers.some(({ candidate }) => candidate.test(roleText))) {
      audience = 'matched';
    } else {
      audience = 'mismatched';
      reasons.push('audience_role_mismatch');
    }
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    geography,
    industry,
    audience,
  };
}

function normalizeUrlHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return normalizeLeadText(value) || null;
  }
}

/** Stable, cross-provider identity keys ordered from strongest to weakest. */
export function buildLeadIdentityKeys(lead: UnknownRecord): string[] {
  const keys: string[] = [];
  const add = (prefix: string, value: unknown) => {
    const normalized = normalizeLeadText(value);
    if (normalized) keys.push(`${prefix}:${normalized}`);
  };

  if (lead.email) add('email', lead.email);
  const phone = String(lead.phone || lead.companyPhone || '').replace(/\D/g, '');
  if (phone.length >= 7) keys.push(`phone:${phone.slice(-10)}`);
  if (lead.placeId) add('place', lead.placeId);
  const host = normalizeUrlHost(lead.website || lead.companyDomain);
  // Older mapped records may contain a directory/profile URL in website.
  // Shared provider hosts cannot identify an individual business or person.
  const sharedProfileHost = host && (
    /^(?:maps\.)?google\.[a-z.]+$/.test(host)
    || ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'justdial.com', 'yelp.com', 'maps.app.goo.gl', 'goo.gl']
      .some(domain => host === domain || host.endsWith(`.${domain}`))
  );
  if (host && !sharedProfileHost) keys.push(`domain:${host}`);

  for (const value of [
    lead.linkedinUrl,
    lead.linkedin,
    lead.googleUrl,
    lead.profileUrl,
    lead.facebookUrl,
    lead.instagramUrl,
  ]) {
    const normalized = normalizeUrlHost(value);
    const path = typeof value === 'string' ? normalizeLeadText(value.replace(/^https?:\/\//, '')) : '';
    if (normalized && path) keys.push(`profile:${normalized}/${path}`);
  }

  const name = normalizeLeadText(lead.companyName || lead.company || lead.fullName || lead.name);
  const location = candidateLocationText(lead);
  if (name && location) {
    const locationParts = location.split(' ').filter((token) => token.length >= 3).slice(0, 4);
    keys.push(`business:${name}|${locationParts.join('-')}`);
  }

  return Array.from(new Set(keys));
}

export function findDuplicateLead<T extends UnknownRecord>(
  candidate: UnknownRecord,
  existing: T[],
): T | undefined {
  const candidateKeys = new Set(buildLeadIdentityKeys(candidate));
  if (candidateKeys.size === 0) return undefined;
  return existing.find((lead) => buildLeadIdentityKeys(lead).some((key) => candidateKeys.has(key)));
}

function stableJsonFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonFingerprint(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonFingerprint(record[key])}`)
      .join(',')}}`;
  }
  const primitive = JSON.stringify(value);
  return primitive === undefined ? String(value) : primitive;
}

export function appendLeadSourceReceipt(
  existingReceipts: unknown,
  receipt: UnknownRecord,
): unknown[] {
  const prior = Array.isArray(existingReceipts) ? existingReceipts : [];
  const unique = prior.filter((value, index) => {
    const fingerprint = stableJsonFingerprint(value);
    return prior.findIndex((candidate) => stableJsonFingerprint(candidate) === fingerprint) === index;
  });
  const fingerprint = stableJsonFingerprint(receipt);
  return unique.some((value) => stableJsonFingerprint(value) === fingerprint)
    ? unique
    : [...unique, receipt];
}

export function appendLeadSourceRecord(
  existingRawData: unknown,
  sourceRecord: UnknownRecord,
): UnknownRecord {
  const existing: UnknownRecord = existingRawData && typeof existingRawData === 'object' && !Array.isArray(existingRawData)
    ? { ...(existingRawData as UnknownRecord) }
    : { value: existingRawData };
  const prior = Array.isArray(existing._sourceRecords) ? existing._sourceRecords as unknown[] : [];
  const fingerprint = stableJsonFingerprint(sourceRecord);
  const sourceRecords = prior.some((record) => stableJsonFingerprint(record) === fingerprint)
    ? prior
    : [...prior, sourceRecord];
  return { ...existing, _sourceRecords: sourceRecords };
}
