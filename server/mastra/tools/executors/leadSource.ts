const KNOWN_PLATFORMS = new Set(['linkedin', 'google_maps', 'justdial', 'instagram', 'facebook', 'twitter']);

/** Use the actual extraction source when legacy rows put a lead type such as
 * `place` or `profile` into platform_type. Never infer a source from lead_type. */
export function canonicalLeadPlatform(platformType: string | null, source: string): string | null {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[ -]+/g, '_');
  const platform = normalize(platformType || '');
  if (KNOWN_PLATFORMS.has(platform)) return platform;
  const sourcePlatform = normalize(source);
  // Historical provenance is a display label, not permission to run a retired provider.
  if (sourcePlatform === 'yelp') return sourcePlatform;
  if (KNOWN_PLATFORMS.has(sourcePlatform)) return sourcePlatform;
  return platformType || null;
}
