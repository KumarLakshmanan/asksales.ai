/** NFKC, lower-case (en-US), punctuation and symbols to single spaces, trimmed: for exact word/phrase matching. */
export function normalizeMatchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Escape RegExp metacharacters so the value matches literally inside a pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
