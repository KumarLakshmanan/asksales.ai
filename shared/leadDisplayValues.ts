/** Locations arrive as strings or structured provider data, never React nodes. */
export function formatLeadLocation(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const location = value as Record<string, unknown>;
  const parts = [location.city, location.state, location.country, location.address]
    .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    .map(part => part.trim());
  return [...new Set(parts)].join(', ');
}
