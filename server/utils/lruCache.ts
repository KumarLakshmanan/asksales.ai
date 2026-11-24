/**
 * LRU Cache — Generic Least Recently Used cache with TTL support.
 *
 * Uses Map iteration order for O(1) get/set/evict operations.
 * When the cache exceeds maxSize, the least recently accessed entry is evicted.
 * Entries can also expire after a configurable TTL.
 */

export interface LRUCacheOptions {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Default TTL in milliseconds (0 = no expiration) */
  defaultTTL?: number;
  /** Called when an entry is evicted (for logging/cleanup) */
  onEvict?: (key: string, value: unknown) => void;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
  lastAccessed: number;
}

export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private defaultTTL: number;
  private onEvict?: (key: string, value: unknown) => void;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.defaultTTL = options.defaultTTL ?? 0;
    this.onEvict = options.onEvict;
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   * Updates the access time for LRU tracking.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL expiration
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.delete(key);
      return undefined;
    }

    // Update access time (move to end of Map for LRU)
    entry.lastAccessed = Date.now();
    // Re-insert to update Map iteration order
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set a value in the cache.
   * @param key Cache key
   * @param value Value to store
   * @param ttl Optional TTL override in milliseconds (0 = no expiration)
   */
  set(key: string, value: T, ttl?: number): void {
    // If key exists, delete it first to update Map order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    const effectiveTTL = ttl ?? this.defaultTTL;
    this.cache.set(key, {
      value,
      expiresAt: effectiveTTL > 0 ? Date.now() + effectiveTTL : null,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key from the cache.
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.onEvict?.(key, entry.value);
      return this.cache.delete(key);
    }
    return false;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    if (this.onEvict) {
      for (const [key, entry] of this.cache) {
        this.onEvict(key, entry.value);
      }
    }
    this.cache.clear();
  }

  /**
   * Get the current number of entries in the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all keys in the cache (in LRU order, oldest first).
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache (in LRU order, oldest first).
   */
  values(): T[] {
    return Array.from(this.cache.values()).map(e => e.value);
  }

  /**
   * Evict the oldest (least recently accessed) entry.
   */
  private evictOldest(): void {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.delete(oldestKey);
    }
  }

  /**
   * Remove all expired entries.
   * Useful for periodic cleanup.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.delete(key);
        pruned++;
      }
    }

    return pruned;
  }
}

