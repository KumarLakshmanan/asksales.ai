const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram',
  twitter: 'Twitter / X', google_maps: 'Google Maps', justdial: 'JustDial',
};

export function normalizeLeadPlatform(platform: string): string {
  const value = platform.trim().toLowerCase().replace(/[ -]+/g, '_');
  if (value === 'x' || value === 'x.com') return 'twitter';
  if (['google', 'maps', 'googlemaps'].includes(value)) return 'google_maps';
  return Object.keys(PLATFORM_LABELS).find(key => value === key || value.startsWith(`${key}_`)) || value;
}

export function leadPlatformLabel(platform: string): string {
  const key = normalizeLeadPlatform(platform);
  return PLATFORM_LABELS[key] || platform.replace(/_/g, ' ');
}

export function matchesLeadPlatform(source: string, target: string): boolean {
  return !!source && !!target && normalizeLeadPlatform(source) === normalizeLeadPlatform(target);
}

export function filterLeadsByPlatform<T extends { platformType?: string | null; source?: string | null; leadType?: string | null }>(
  leads: T[], platform: string, leadType = 'all',
): T[] {
  return leads.filter(lead => matchesLeadPlatform(lead.platformType || lead.source || '', platform)
    && (leadType === 'all' || (lead.leadType || 'profile').toLowerCase() === leadType.toLowerCase()));
}
