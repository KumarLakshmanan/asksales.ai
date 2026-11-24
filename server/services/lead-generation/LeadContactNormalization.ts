type LeadRecord = Record<string, unknown>;

/** Only label links as a social platform when their hostname proves it. */
export function socialProfileUrl(value: unknown, domains: string[]): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
      ? url.href : null;
  } catch {
    return null;
  }
}

function firstEmail(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(firstEmail).find(Boolean) || null;
  if (typeof value !== 'string') return null;
  const email = value.trim().replace(/^mailto:/i, '');
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    && !email.toLowerCase().includes('@placeholder.lead') ? email : null;
}

/** Run after custom mappings so aliases cannot reintroduce mislabeled links. */
export function normalizeLeadContacts(lead: LeadRecord, raw: LeadRecord): void {
  const source = String(lead.platformType || lead.source || raw.platform || '').toLowerCase();
  const username = raw.username || raw.userName || raw.ownerUsername;
  // A username only identifies an account on its originating network.
  // Generic mappings must not manufacture matching accounts on other sites.
  lead.instagramHandle = raw.instagramHandle || (source.startsWith('instagram') ? username : null) || null;
  lead.twitterHandle = raw.twitterHandle || (source.startsWith('twitter') || source === 'x' ? username || raw.screen_name : null) || null;
  lead.twitterUsername = raw.twitterUsername || lead.twitterHandle || null;
  const socialFields: Array<[string[], string[]]> = [
    [['facebookUrl', 'facebook'], ['facebook.com', 'fb.com', 'fb.me']],
    [['linkedinUrl', 'linkedin'], ['linkedin.com']],
    [['twitterUrl', 'twitter'], ['twitter.com', 'x.com']],
    [['instagramUrl', 'instagram'], ['instagram.com']],
  ];
  for (const [fields, domains] of socialFields) {
    const candidates = [...fields.map(field => lead[field]), ...fields.map(field => raw[field]), raw.pageUrl, raw.profileUrl, raw.url];
    const url = candidates.map(value => socialProfileUrl(value, domains)).find(Boolean) || null;
    lead[fields[0]] = url;
    for (const field of fields.slice(1)) {
      if (field in lead) lead[field] = socialProfileUrl(lead[field], domains);
    }
  }
  lead.email = [lead.email, raw.email, raw.email_address, raw.emailAddress, raw.emails]
    .map(firstEmail).find(Boolean) || null;
  lead.emailStatus = lead.email ? 'unverified' : 'unavailable';
}
