"use client";

/**
 * Keeps unsent form input while the user leaves a create page (browser Back,
 * a sidebar link) and comes back to the same page.
 *
 * Drafts live in memory only, per signed-in user and selected business, so
 * typed personal data never reaches browser storage. A reload or sign-out
 * discards them.
 */
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;
const drafts = new Map<string, { value: unknown; savedAt: number }>();

function identifiedScope(scope: string) {
  return Boolean(scope) && !scope.startsWith('anonymous:') && !scope.endsWith(':unselected');
}

const entryKey = (scope: string, form: string) => `${scope}|${form}`;

/** Saves the draft, or forgets it when it is empty. */
export function saveFormDraft<T>(scope: string, form: string, value: T, isEmpty: boolean) {
  if (!identifiedScope(scope)) return;
  if (isEmpty) drafts.delete(entryKey(scope, form));
  else drafts.set(entryKey(scope, form), { value, savedAt: Date.now() });
}

export function readFormDraft<T>(scope: string, form: string): T | undefined {
  if (!identifiedScope(scope)) return undefined;
  const stored = drafts.get(entryKey(scope, form));
  if (!stored) return undefined;
  if (Date.now() - stored.savedAt > DRAFT_TTL_MS) { drafts.delete(entryKey(scope, form)); return undefined; }
  return stored.value as T;
}

export function clearFormDraft(scope: string, form: string) {
  drafts.delete(entryKey(scope, form));
}

export function resetFormDraftsForTests() {
  drafts.clear();
}
