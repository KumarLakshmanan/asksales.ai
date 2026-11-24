/**
 * TokenCounter — Accurate token counting using tiktoken encodings.
 *
 * Replaces the word × 1.3 heuristic with proper BPE tokenisation,
 * adds per-text caching, and exposes helpers for measuring system
 * prompts, tool definitions, and message arrays.
 */

import { encodingForModel, getEncoding, type TiktokenModel } from 'js-tiktoken';
import { logger } from './logger.js';
import { TOKEN_CACHE_MAX_SIZE, TOKEN_CACHE_KEY_THRESHOLD, PER_MESSAGE_OVERHEAD, REPLY_PRIMING_TOKENS } from './chatConstants';

// ─── Encoder Cache ──────────────────────────────────────────────────────────────

const encoderCache = new Map<string, ReturnType<typeof getEncoding>>();

function getEncoder(modelName?: string): ReturnType<typeof getEncoding> {
  const key = modelName || 'cl100k_base';

  if (encoderCache.has(key)) {
    return encoderCache.get(key)!;
  }

  try {
    // Try model-specific encoding first (handles gpt-4o, gpt-4, gpt-3.5-turbo, etc.)
    const enc = encodingForModel(key as TiktokenModel);
    encoderCache.set(key, enc);
    return enc;
  } catch {
    // Fall back to cl100k_base (GPT-4 / GPT-3.5 encoding — good default)
    if (!encoderCache.has('cl100k_base')) {
      encoderCache.set('cl100k_base', getEncoding('cl100k_base'));
    }
    return encoderCache.get('cl100k_base')!;
  }
}

// ─── Per-Text Token Cache ───────────────────────────────────────────────────────

const tokenCountCache = new Map<string, number>();

function getCacheKey(text: string): string {
  // For short texts, use the text itself; for long texts, use a simple hash
  if (text.length <= TOKEN_CACHE_KEY_THRESHOLD) return text;
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `h:${hash}:${text.length}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Count tokens for a single string using the proper BPE tokenizer.
 * Results are cached per text to avoid repeated encoding.
 */
export function countTokens(text: string, modelName?: string): number {
  if (!text) return 0;

  const cacheKey = getCacheKey(text);
  if (tokenCountCache.has(cacheKey)) {
    return tokenCountCache.get(cacheKey)!;
  }

  const encoder = getEncoder(modelName);
  const count = encoder.encode(text).length;

  // Evict oldest entries if cache is too large
  if (tokenCountCache.size >= TOKEN_CACHE_MAX_SIZE) {
    const firstKey = tokenCountCache.keys().next().value;
    if (firstKey !== undefined) tokenCountCache.delete(firstKey);
  }
  tokenCountCache.set(cacheKey, count);

  return count;
}

/**
 * Count tokens for an array of message objects.
 * Includes per-message overhead (~4 tokens per message for role/formatting).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countMessageTokens(messages: Array<{ content: string | any; role?: string }>, modelName?: string): number {
  let total = 0;

  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    total += countTokens(content, modelName) + PER_MESSAGE_OVERHEAD;
  }

  // + reply priming tokens for the response
  total += REPLY_PRIMING_TOKENS;

  return total;
}

/**
 * Clear the token count cache. Useful during testing or when
 * switching models (different models use different encodings).
 */
export function clearTokenCache(): void {
  tokenCountCache.clear();
  logger.debug('[TokenCounter] Cache cleared');
}
