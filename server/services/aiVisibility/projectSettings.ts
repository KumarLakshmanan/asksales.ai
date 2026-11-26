/** Stable JSON: object keys sorted, so jsonb values compare equal whatever order Postgres returns. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  return value ?? null;
}

/**
 * True when at least one already-normalized setting in `update` differs from the stored project.
 * Saving the form unchanged must not raise the configuration revision: the revision drives the
 * "settings changed" notice, extraction reuse and score comparisons.
 */
export function projectSettingsChanged(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  return Object.keys(update).some(
    (key) => JSON.stringify(stable(update[key])) !== JSON.stringify(stable(current[key])),
  );
}
