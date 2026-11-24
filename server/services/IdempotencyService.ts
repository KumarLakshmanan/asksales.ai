/**
 * Idempotency Service
 *
 * Provides server-side deduplication for inbound chat messages and other
 * non-idempotent operations. Uses Redis `SET key value NX EX ttl` to atomically
 * claim a messageId; subsequent calls with the same messageId return
 * `duplicate: true` and the stored response (when available).
 *
 * Use cases:
 *   - WebSocket reconnect replays queued messages from localStorage
 *   - Mobile clients that retry failed requests
 *   - At-least-once delivery from upstream services
 *
 * Failure mode: if Redis is unavailable, we **fail open** — the caller's
 * `checkAndStore` returns `{ status: 'fresh' }` and the operation proceeds.
 * This trades strict dedup for availability, which matches the rest of the
 * platform's posture (EventBus and rate limiter both fall back gracefully).
 */

import { getRedisConnection } from '../infrastructure/redis.js';
import { logger } from '../utils/logger.js';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const KEY_PREFIX = 'idem:msg:';

export type IdempotencyResult =
  | { status: 'fresh' }
  | { status: 'duplicate'; previousResponse?: string | null }
  | { status: 'error'; reason: string };

export interface CheckAndStoreOptions {
  /** Time-to-live for the dedup record. Defaults to 24h. */
  ttlSeconds?: number;
  /**
   * Optional cached response payload (string). When set and the same key
   * is replayed, this value is returned so the caller can short-circuit
   * duplicate work without re-running the operation.
   */
  cachedResponse?: string | null;
  /** Refuse the mutation when Redis cannot atomically claim the key. */
  failClosed?: boolean;
}

class IdempotencyService {
  /**
   * Atomically claim a messageId. Returns 'fresh' the first time and
   * 'duplicate' on subsequent calls within the TTL window.
   */
  async checkAndStore(
    messageId: string,
    options: CheckAndStoreOptions = {}
  ): Promise<IdempotencyResult> {
    if (!messageId || typeof messageId !== 'string') {
      return { status: 'error', reason: 'messageId is required' };
    }

    const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const key = KEY_PREFIX + messageId;
    const storedValue = options.cachedResponse ?? '';

    let redis: ReturnType<typeof getRedisConnection>;
    try {
      redis = getRedisConnection();
    } catch (err) {
      logger.warn({ err }, '[IdempotencyService] Redis unavailable');
      return options.failClosed
        ? { status: 'error', reason: 'Idempotency storage is unavailable' }
        : { status: 'fresh' };
    }

    try {
      // SET key value NX EX ttl — atomic claim
      const setResult = await redis.set(key, storedValue, 'EX', ttl, 'NX');

      if (setResult === 'OK') {
        return { status: 'fresh' };
      }

      // Key already existed → duplicate. Fetch the previous response if any.
      const previous = await redis.get(key);
      return { status: 'duplicate', previousResponse: previous || null };
    } catch (err) {
      logger.warn({ err, messageId }, '[IdempotencyService] Redis error');
      return options.failClosed
        ? { status: 'error', reason: 'Idempotency storage is unavailable' }
        : { status: 'fresh' };
    }
  }

  /**
   * Update the cached response for an already-claimed messageId.
   * Called after a successful operation so future replays can short-circuit.
   */
  async storeResponse(messageId: string, response: string): Promise<void> {
    if (!messageId) return;

    const key = KEY_PREFIX + messageId;
    try {
      const redis = getRedisConnection();
      // Preserve existing TTL by not passing EX; just SET.
      await redis.set(key, response, 'KEEPTTL');
    } catch (err) {
      logger.warn({ err, messageId }, '[IdempotencyService] Failed to store response');
    }
  }

  /**
   * For testing / admin use — clear a dedup record.
   */
  async forget(messageId: string): Promise<void> {
    if (!messageId) return;
    try {
      const redis = getRedisConnection();
      await redis.del(KEY_PREFIX + messageId);
    } catch (err) {
      logger.warn({ err, messageId }, '[IdempotencyService] Failed to forget key');
    }
  }
}

export const idempotencyService = new IdempotencyService();
export default idempotencyService;
