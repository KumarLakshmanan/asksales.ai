/** Recursively sort object keys so equal values always serialize the same way. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

/** JSON.stringify of canonicalize(value): key order never changes the output. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
