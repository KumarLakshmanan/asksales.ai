/** The rows of a raw query result, or [] when the result has none. */
export function resultRows(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: Record<string, unknown>[] }).rows || []);
}
