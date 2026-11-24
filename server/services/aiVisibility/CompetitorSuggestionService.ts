import { normalizeDomain } from './domain.js';

export type CompetitorSuggestionSourceType = 'business_profile_reference' | 'provider_observation';

export interface CompetitorSuggestionSource {
  type: CompetitorSuggestionSourceType;
  label: string;
  evidenceCount: number;
}

export interface CompetitorSuggestion {
  name: string;
  domain: string | null;
  aliases: string[];
  confidence: 'high' | 'medium';
  sources: CompetitorSuggestionSource[];
  lastObservedAt: string | null;
}

export interface ProviderCompetitorObservation {
  id: number;
  provider: string;
  competitors: string[];
  citations: Array<{ url: string; title?: string }>;
  capturedAt: Date | string;
}

interface ReferenceCandidate {
  name?: string;
  value: string;
}

interface SuggestionAccumulator {
  name: string;
  domain: string | null;
  aliases: Set<string>;
  sources: Map<string, CompetitorSuggestionSource>;
  lastObservedAt: string | null;
}

const SOCIAL_HOSTS = new Set([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
]);

const GENERIC_COMPETITOR_NAMES = new Set([
  'ai',
  'agent',
  'agents',
  'api',
  'app',
  'automation',
  'business',
  'chatbot',
  'cloud',
  'crm',
  'enterprise',
  'marketing',
  'platform',
  'sales',
  'search',
  'service',
  'services',
  'software',
  'solution',
  'solutions',
  'technology',
  'tool',
  'tools',
]);

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDomain(value: string): string | null {
  try {
    return normalizeDomain(value);
  } catch {
    return null;
  }
}

function referenceDomain(value: string): string | null {
  const domain = safeDomain(value);
  if (!domain) return null;
  const hostname = new URL(domain).hostname;
  return hostname.includes('.') ? domain : null;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function providerLabel(value: string): string {
  const labels: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Gemini',
    manual: 'Manual',
  };
  return labels[value.toLowerCase()] || titleCase(value);
}

function nameFromUrl(
  domain: string,
  originalValue: string,
): { name: string; domain: string | null } {
  const normalizedUrl = new URL(domain);
  const hostname = normalizedUrl.hostname.toLowerCase().replace(/^www\./, '');
  if (SOCIAL_HOSTS.has(hostname)) {
    const source = /^https?:\/\//i.test(originalValue) ? originalValue : `https://${originalValue}`;
    try {
      const account = new URL(source).pathname.split('/').filter(Boolean).at(-1)?.replace(/^@/, '');
      if (account) return { name: titleCase(account), domain: null };
    } catch {
      /* use the verified host label below */
    }
  }
  return { name: titleCase(hostname.split('.')[0] || hostname), domain };
}

function collectJsonReferences(value: unknown, result: ReferenceCandidate[]) {
  if (typeof value === 'string') {
    result.push({ value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonReferences(item, result);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const target = [record.url, record.domain, record.website, record.link, record.handle].find(
    (item): item is string => typeof item === 'string' && Boolean(item.trim()),
  );
  const name = [record.name, record.label, record.company, record.account].find(
    (item): item is string => typeof item === 'string' && Boolean(item.trim()),
  );
  if (target) result.push({ name, value: target });
  else for (const nested of Object.values(record)) collectJsonReferences(nested, result);
}

function parseReferenceAccounts(raw: string | null | undefined): ReferenceCandidate[] {
  if (!raw?.trim()) return [];
  const parsed: ReferenceCandidate[] = [];
  try {
    collectJsonReferences(JSON.parse(raw), parsed);
    if (parsed.length) return parsed;
  } catch {
    /* plain text is supported below */
  }
  return raw
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const urlMatch = entry.match(
        /(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s)]*)?/i,
      );
      if (!urlMatch) return { value: entry };
      const name =
        entry
          .slice(0, urlMatch.index)
          .replace(/[\s:–—|\-(]+$/g, '')
          .trim() || undefined;
      return { name, value: urlMatch[0] };
    });
}

function citationDomainForName(
  name: string,
  citations: ProviderCompetitorObservation['citations'],
): string | null {
  const normalizedCompetitor = normalizedName(name).replace(/\s+/g, '');
  if (normalizedCompetitor.length < 3) return null;
  const domains = new Set<string>();
  for (const citation of citations) {
    const domain = safeDomain(citation.url);
    if (!domain) continue;
    const hostLabel = new URL(domain).hostname
      .replace(/^www\./, '')
      .split('.')[0]
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
    // A citation title mentioning a company does not prove that the cited host is
    // its official website. Only an exact hostname-label match is safe to suggest.
    if (hostLabel === normalizedCompetitor) domains.add(domain);
  }
  return domains.size === 1 ? [...domains][0] : null;
}

function isUsefulCompetitorName(value: string): boolean {
  const normalized = normalizedName(value);
  if (!normalized || GENERIC_COMPETITOR_NAMES.has(normalized)) return false;
  if (!/[a-z]/.test(normalized) || normalized.length < 2) return false;
  return normalized.split(' ').length <= 8;
}

function addSource(
  accumulator: SuggestionAccumulator,
  source: Omit<CompetitorSuggestionSource, 'evidenceCount'>,
) {
  const key = `${source.type}:${source.label}`;
  const existing = accumulator.sources.get(key);
  accumulator.sources.set(key, {
    ...source,
    evidenceCount: (existing?.evidenceCount || 0) + 1,
  });
}

export function buildCompetitorSuggestions(input: {
  referenceAccounts?: string | null;
  observations: ProviderCompetitorObservation[];
  projectDomain: string;
  projectNames: string[];
  existingCompetitors: Array<{ name: string; domain: string }>;
}): CompetitorSuggestion[] {
  const projectDomain = safeDomain(input.projectDomain);
  const projectHostnameName = projectDomain
    ? titleCase(new URL(projectDomain).hostname.replace(/^www\./, '').split('.')[0])
    : '';
  const excludedDomains = new Set(
    [projectDomain, ...input.existingCompetitors.map((item) => safeDomain(item.domain))].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const excludedNames = new Set(
    [
      projectHostnameName,
      ...input.projectNames,
      ...input.existingCompetitors.map((item) => item.name),
    ]
      .map(normalizedName)
      .filter(Boolean),
  );
  const excludedCompactNames = new Set(
    [...excludedNames].map((value) => value.replace(/\s+/g, '')),
  );
  const candidates = new Map<string, SuggestionAccumulator>();

  const upsert = (nameValue: string, domainValue: string | null, alias?: string) => {
    const name = nameValue.trim().slice(0, 255);
    const normalized = normalizedName(name);
    const domain = domainValue ? safeDomain(domainValue) : null;
    if (
      !isUsefulCompetitorName(name) ||
      excludedNames.has(normalized) ||
      excludedCompactNames.has(normalized.replace(/\s+/g, '')) ||
      (domain && excludedDomains.has(domain))
    )
      return null;
    const matched = [...candidates.entries()].find(
      ([, candidate]) =>
        normalizedName(candidate.name) === normalized ||
        Boolean(domain && candidate.domain === domain),
    );
    const key = matched?.[0] || domain || normalized;
    const existing = matched?.[1] || {
      name,
      domain,
      aliases: new Set<string>(),
      sources: new Map<string, CompetitorSuggestionSource>(),
      lastObservedAt: null,
    };
    if (alias?.trim() && normalizedName(alias) !== normalized)
      existing.aliases.add(alias.trim().slice(0, 255));
    if (!existing.domain && domain) existing.domain = domain;
    candidates.set(key, existing);
    return existing;
  };

  for (const reference of parseReferenceAccounts(input.referenceAccounts)) {
    const domain = referenceDomain(reference.value);
    const derived = domain
      ? nameFromUrl(domain, reference.value)
      : { name: titleCase(reference.value.replace(/^@/, '')), domain: null };
    const candidate = upsert(
      reference.name || derived.name,
      derived.domain,
      reference.name ? derived.name : undefined,
    );
    if (candidate)
      addSource(candidate, {
        type: 'business_profile_reference',
        label: 'Listed in your Business Profile',
      });
  }

  for (const observation of input.observations) {
    for (const competitor of observation.competitors) {
      const domain = citationDomainForName(competitor, observation.citations);
      const candidate = upsert(competitor, domain);
      if (!candidate) continue;
      addSource(candidate, {
        type: 'provider_observation',
        label: `Named in ${providerLabel(observation.provider)} answers`,
      });
      const capturedAt = new Date(observation.capturedAt);
      if (
        !Number.isNaN(capturedAt.valueOf()) &&
        (!candidate.lastObservedAt || capturedAt > new Date(candidate.lastObservedAt))
      ) {
        candidate.lastObservedAt = capturedAt.toISOString();
      }
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      name: candidate.name,
      domain: candidate.domain,
      aliases: [...candidate.aliases].slice(0, 20),
      confidence: [...candidate.sources.values()].some(
        (source) => source.type === 'business_profile_reference',
      )
        ? ('high' as const)
        : ('medium' as const),
      sources: [...candidate.sources.values()],
      lastObservedAt: candidate.lastObservedAt,
    }))
    .sort((left, right) => {
      const leftEvidence = left.sources.reduce((sum, source) => sum + source.evidenceCount, 0);
      const rightEvidence = right.sources.reduce((sum, source) => sum + source.evidenceCount, 0);
      return (
        Number(right.confidence === 'high') - Number(left.confidence === 'high') ||
        rightEvidence - leftEvidence ||
        left.name.localeCompare(right.name)
      );
    })
    .slice(0, 10);
}
