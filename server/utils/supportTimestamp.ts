/** Raw SQL timestamps are UTC in this schema, but may lack a timezone suffix. */
export function serializeUtcTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = value.trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z` : timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export const serializeSupportTimestamp = serializeUtcTimestamp;
