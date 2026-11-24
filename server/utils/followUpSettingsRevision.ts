import { createHash } from 'node:crypto';

/** Stable across JSONB key ordering; contains no message content or credentials. */
export function followUpSettingsRevision(value: unknown): string {
  const serialized = JSON.stringify(value ?? null, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
  return createHash('sha256').update(serialized).digest('hex');
}

export class FollowUpSettingsConflictError extends Error {
  constructor() { super('These follow-up settings changed elsewhere. Keep your edits for comparison, or discard them and reload the saved settings.'); }
}
