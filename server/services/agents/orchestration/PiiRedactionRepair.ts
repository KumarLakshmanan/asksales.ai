import { redactPiiWithStableTokens } from './PrivacyVaultService.js';

const TOKEN = /\[[A-Z][A-Z_]*_\d+\]/g;

export type RedactionRepairPlan =
  | { action: 'update'; content: string; piiTypes: string[]; tokensBefore: number; tokensAfter: number }
  | { action: 'skip'; reason: 'not_redacted' | 'already_current' | 'raw_mismatch'; tokensBefore: number };

/** True when `stored` is `raw` with some spans replaced by redaction tokens:
 * every literal segment between tokens must occur in `raw`, in order, with
 * the first anchored at the start and the last at the end. */
function isRedactionOf(stored: string, raw: string): boolean {
  const segments = stored.split(TOKEN);
  if (!raw.startsWith(segments[0])) return false;
  let cursor = segments[0].length;
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    const at = last ? (raw.endsWith(segment) && raw.length - segment.length >= cursor ? raw.length - segment.length : -1)
      : raw.indexOf(segment, cursor);
    if (at < 0) return false;
    cursor = at + segment.length;
  }
  return true;
}

/** Decide whether a stored redacted message should be rewritten from its
 * vault original with the current redactor. Never returns raw text unless the
 * current redactor finds nothing sensitive in it. */
export function planRedactionRepair(input: {
  rawText: string;
  storedContent: string;
  userId: number;
  conversationId: number;
}): RedactionRepairPlan {
  const tokensBefore = (input.storedContent.match(TOKEN) || []).length;
  if (tokensBefore === 0) return { action: 'skip', reason: 'not_redacted', tokensBefore };
  // The vault row must be the original of exactly this stored text (batched
  // turns, HTML-to-text conversion or manual edits would otherwise be clobbered).
  if (!isRedactionOf(input.storedContent, input.rawText)) return { action: 'skip', reason: 'raw_mismatch', tokensBefore };
  const current = redactPiiWithStableTokens(input.rawText, { userId: input.userId, conversationId: input.conversationId });
  if (current.redactedText === input.storedContent) return { action: 'skip', reason: 'already_current', tokensBefore };
  return { action: 'update', content: current.redactedText, piiTypes: current.piiTypes,
    tokensBefore, tokensAfter: current.tokenCount };
}
