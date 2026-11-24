import { getEncoding } from 'js-tiktoken';

// This local encoding is an explicit retrieval budget, independent of stored
// token_count values. Provider adapters still check their actual context window.
const encoding = getEncoding('cl100k_base');
export const KNOWLEDGE_MAX_CHUNK_BYTES = 12_000;
export const KNOWLEDGE_MAX_EVIDENCE_BYTES = 24_000;

export function knowledgeTokenCount(text: string): number {
  return text ? encoding.encode(text, [], []).length : 0;
}

/** Bound text without splitting a UTF-16 surrogate pair. */
export function boundKnowledgeText(
  text: string,
  tokens: number,
  bytes: number,
): string {
  if (
    Buffer.byteLength(text, 'utf8') <= bytes &&
    knowledgeTokenCount(text) <= tokens
  )
    return text;
  let low = 0;
  // UTF-8 bytes are at least the UTF-16 length for valid text. Never tokenize
  // an enormous rejected prefix merely to find a small bounded output.
  let high = Math.min(text.length, bytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, middle);
    if (
      Buffer.byteLength(candidate, 'utf8') <= bytes &&
      knowledgeTokenCount(candidate) <= tokens
    )
      low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
}
