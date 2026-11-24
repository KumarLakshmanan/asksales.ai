/**
 * Safe parameter parsing utilities for Express request handlers.
 * Use these instead of raw parseInt() to avoid NaN reaching the database.
 */

/**
 * Parse a path parameter as a positive integer.
 * Returns null if the value is not a valid positive integer.
 * Use for resource IDs (e.g., /api/users/:id)
 */
export function parseIdParam(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Parse a query parameter as a non-negative integer, clamped between min and max.
 * Returns the defaultValue if the value is absent or invalid.
 */
export function parseIntQuery(
  value: string | string[] | undefined,
  defaultValue: number,
  min = 0,
  max = 200
): number {
  if (value === undefined || value === null) return defaultValue;
  const str = Array.isArray(value) ? value[0] : String(value);
  const n = parseInt(str, 10);
  if (isNaN(n)) return defaultValue;
  return Math.min(Math.max(n, min), max);
}

/**
 * Parse and clamp pagination parameters from query.
 * Returns { limit, offset } with defaults and safe bounds.
 */
export function parsePagination(
  query: Record<string, string | string[] | undefined>,
  defaultLimit = 20,
  maxLimit = 200
): { limit: number; offset: number } {
  const limit = parseIntQuery(query.limit, defaultLimit, 1, maxLimit);
  const offset = parseIntQuery(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { limit, offset };
}

/**
 * Coerce any value (number, numeric string, query value) to a positive safe integer.
 * Returns null when it is not one. Use for ids that arrive as `unknown`.
 */
export function parsePositiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Same as parsePositiveId, but returns undefined instead of null. */
export function parsePositiveIdOrUndefined(value: unknown): number | undefined {
  return parsePositiveId(value) ?? undefined;
}

/** A path id made only of digits, as a positive safe integer; undefined otherwise. */
export function parseDigitsId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
