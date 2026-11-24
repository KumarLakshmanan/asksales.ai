/** Syntactic candidate checks, not proof of ownership or deliverability. */
export function cleanEnrichmentPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const input = value.trim().replace(/^tel:/i, '').trim();
  // Coordinates, decimals, dates and scientific notation must be rejected
  // before punctuation is removed; otherwise they look like phone digits.
  if (/^[+-]?\d{1,3}\.\d+$/.test(input)
    || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\b|T)/.test(input)
    || /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(input)
    || /[eE][+-]?\d/.test(input)) return null;
  const match = input.match(/^(\+?[\d ().-]+?)(?:\s*(?:ext\.?|extension|x|;ext=)\s*(\d{1,6}))?$/i);
  if (!match) return null;
  const base = match[1].trim();
  if (base.startsWith('-') || (base.match(/\(/g)?.length || 0) !== (base.match(/\)/g)?.length || 0)) return null;
  const digits = base.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return null;
  if (/^(?:19|20)\d{6}$/.test(digits) || /^1[5-9]\d{11}$/.test(digits)) return null;
  // Reject impossible NANP numbers produced by the old '+1' formatter.
  if (base.startsWith('+1') && !/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  const normalized = base.startsWith('+') ? `+${digits}` : base.replace(/\s+/g, ' ');
  return normalized + (match[2] ? ` ext ${match[2]}` : '');
}

export function cleanEnrichmentEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().replace(/^mailto:/i, '').toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) return null;
  const [local, domain] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || email.includes('..')) return null;
  if (domain.split('.').some(label => label.startsWith('-') || label.endsWith('-'))) return null;
  if (/(?:^|\.)(?:example\.(?:com|org|net)|sentry\.io|placeholder\.lead)$/.test(domain)
    || /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)$/.test(domain)) return null;
  return email;
}

export function cleanEnrichmentWebsite(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const raw = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (['linkedin.com', 'lnkd.in', 'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'google.com', 'bit.ly', 't.co', 'linktr.ee'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Read-time projection: repair legacy display without rewriting audit records. */
export function cleanEnrichmentRun<T extends { summary?: unknown }>(run: T) {
  if (!run.summary || typeof run.summary !== 'object' || Array.isArray(run.summary)) return run;
  const raw = run.summary as Record<string, unknown>;
  const summary = cleanEnrichmentContacts(raw);
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const removed = count(raw.emails) + count(raw.phones) + count(raw.websites)
    - summary.emails.length - summary.phones.length - summary.websites.length;
  const company = raw.company && typeof raw.company === 'object' && !Array.isArray(raw.company)
    ? { ...raw.company as Record<string, unknown> } : {};
  if (company.domain && !cleanEnrichmentWebsite(company.domain)) delete company.domain;
  const socialProfiles = raw.socialProfiles && typeof raw.socialProfiles === 'object' && !Array.isArray(raw.socialProfiles)
    ? { ...raw.socialProfiles as Record<string, unknown> } : {};
  const person = raw.person && typeof raw.person === 'object' ? raw.person as Record<string, unknown> : {};
  if (person.fullName && typeof socialProfiles.linkedin === 'string' && /linkedin\.com\/company\//i.test(socialProfiles.linkedin)) {
    delete socialProfiles.linkedin;
  }
  return {
    ...run,
    emailsFound: summary.emails.length,
    phonesFound: summary.phones.length,
    websitesFound: summary.websites.length,
    summary: {
      ...summary,
      company,
      socialProfiles,
      // Older runs mixed different identities and cannot be safely attributed.
      socialStats: raw.identityScoped === true ? raw.socialStats : {},
      leadScore: removed > 0 ? null : raw.leadScore,
      contactValidation: { version: 1, ownershipVerified: false,
        hiddenOrDuplicateValues: Math.max(removed, Number((raw.contactValidation as Record<string, unknown> | undefined)?.hiddenOrDuplicateValues) || 0) },
    },
  };
}

function cleanList(value: unknown, clean: (item: unknown) => string | null, key: (item: string) => string = item => item): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    const candidate = clean(item);
    if (!candidate || seen.has(key(candidate))) return [];
    seen.add(key(candidate));
    return [candidate];
  });
}

export function cleanEnrichmentContacts<T extends { emails?: unknown; phones?: unknown; websites?: unknown }>(data: T) {
  return {
    ...data,
    emails: cleanList(data.emails, cleanEnrichmentEmail),
    phones: cleanList(data.phones, cleanEnrichmentPhone, phone => phone.replace(/[^\dx]/g, '')),
    websites: cleanList(data.websites, cleanEnrichmentWebsite, site => site.replace(/^https?:\/\//, '')),
  };
}
