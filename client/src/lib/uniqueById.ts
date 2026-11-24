/**
 * Keep the first item for each id, preserving order. Library lists merge
 * results from several sources (offset pages, a fresh generation, a refetch
 * triggered by a socket event); the same saved asset must render once.
 */
export function uniqueById<T extends { id: string | number }>(items: readonly T[]): T[] {
  const seen = new Set<string | number>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/** Prepend fresh items, replacing any older copy with the same id. */
export function prependUniqueById<T extends { id: string | number }>(fresh: readonly T[], existing: readonly T[]): T[] {
  return uniqueById([...fresh, ...existing]);
}
