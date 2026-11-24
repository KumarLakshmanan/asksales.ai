/**
 * Smart Throttling Service
 * Enforces platform-specific rate limits to prevent account blocks.
 * Uses Redis for shared state across all PM2 processes.
 */

import { logger } from '../utils/logger.js';
import {
  CHANNEL_THROTTLE_CONFIGS,
  type ChannelThrottleConfig,
  THROTTLE_STATS_CLEANUP_INTERVAL_MS,
} from '../utils/rateLimitConstants';
import { getRedisConnection } from '../infrastructure/redis.js';


/** One Redis operation checks and consumes all UTC buckets. Legacy JSON counters
 * inherit their last-request bucket, so deployment cannot reset a hot sender. */
export const THROTTLE_OPERATION_LUA = `
local now = tonumber(ARGV[1])
if now < 0 then
  local clock = redis.call('TIME')
  now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end
local limits = cjson.decode(ARGV[2])
local mode = ARGV[3]
local stats = cjson.decode(ARGV[4])
local raw = redis.call('GET', KEYS[1])
if raw then stats = cjson.decode(raw) end
local day = math.floor(now / 86400000)
local hour = math.floor(now / 3600000)
local minute = math.floor(now / 60000)
-- Old versions stored only an ISO timestamp. JavaScript supplies normalized
-- legacy buckets once; new records keep integer epochs for independent resets.
local legacy = cjson.decode(ARGV[5])
if stats.lastRequestMs == nil then stats.lastRequestMs = legacy.lastRequestMs end
if stats.dayBucket == nil then stats.dayBucket = legacy.dayBucket end
if stats.hourBucket == nil then stats.hourBucket = legacy.hourBucket end
if stats.minuteBucket == nil then stats.minuteBucket = legacy.minuteBucket end
if stats.dayBucket ~= day then stats.todayCount = 0 end
if stats.hourBucket ~= hour then stats.hourCount = 0 end
if stats.minuteBucket ~= minute then stats.minuteCount = 0 end
stats.dayBucket = day; stats.hourBucket = hour; stats.minuteBucket = minute
stats.resetAt = (day + 1) * 86400000
local blocked = nil
local retry = 0
if mode ~= 'record' then
  if limits.dailyLimit and stats.todayCount >= limits.dailyLimit then blocked = 'Daily'; retry = stats.resetAt - now
  elseif limits.hourlyLimit and stats.hourCount >= limits.hourlyLimit then blocked = 'Hourly'; retry = (hour + 1) * 3600000 - now
  elseif limits.minuteLimit and stats.minuteCount >= limits.minuteLimit then blocked = 'Per-minute'; retry = (minute + 1) * 60000 - now
  elseif limits.minDelayMs and stats.lastRequestMs and now - stats.lastRequestMs < limits.minDelayMs then
    blocked = 'Minimum delay'; retry = limits.minDelayMs - (now - stats.lastRequestMs)
  end
end
if not blocked and mode ~= 'peek' then
  stats.todayCount = stats.todayCount + 1; stats.hourCount = stats.hourCount + 1; stats.minuteCount = stats.minuteCount + 1
  stats.lastRequestMs = now; stats.lastRequestAt = now
end
redis.call('SET', KEYS[1], cjson.encode(stats), 'EX', 604800)
return cjson.encode({allowed = not blocked, bucket = blocked, retryAfter = math.ceil(retry / 1000), stats = stats})
`;

export type PlatformLimits = ChannelThrottleConfig;

export interface UsageStats {
  platform: string;
  userId: number;
  accountId?: string;
  todayCount: number;
  hourCount: number;
  minuteCount: number;
  lastRequestAt: Date;
  resetAt: Date;
}

export class SmartThrottlingService {
  private static instance: SmartThrottlingService;
  
  // Platform-specific rate limits (initialized from constants)
  private readonly platformLimits: { [key: string]: PlatformLimits } = { ...CHANNEL_THROTTLE_CONFIGS };

  // Redis-backed usage tracking (shared across all PM2 processes)
  // Acquire Redis on first use instead of during module import. Authentication
  // middleware imports this singleton, and opening a socket at import time made
  // CLI commands/tests hang even when they never performed rate limiting.
  private get redis(): ReturnType<typeof getRedisConnection> {
    return getRedisConnection();
  }

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    // Periodic cleanup of stale per-minute/hourly counters — Redis TTL handles expiry automatically
    this.cleanupTimer = setInterval(() => this.cleanupExpiredStats(), THROTTLE_STATS_CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  public destroy(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  public static getInstance(): SmartThrottlingService {
    if (!SmartThrottlingService.instance) {
      SmartThrottlingService.instance = new SmartThrottlingService();
    }
    return SmartThrottlingService.instance;
  }

  /**
   * Check if request is allowed (doesn't increment counter)
   */
  public async isAllowed(
    platform: string,
    userId: number,
    accountId?: string
  ): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    if (!this.platformLimits[platform]) return { allowed: true };
    return this.operation(platform, userId, accountId, 'peek');
  }

  /** Atomically reserve one provider attempt. Call immediately before dispatch;
   * uncertain sends retain their count, so retries cannot exceed the budget. */
  public async claimRequest(platform: string, userId: number, accountId?: string): Promise<{allowed:boolean;reason?:string;retryAfter?:number}> {
    if (!this.platformLimits[platform]) return { allowed: true };
    return this.operation(platform, userId, accountId, 'claim');
  }

  /** Compatibility accounting for events that have already happened. Delivery
   * must use claimRequest rather than a separate check followed by this call. */
  public async recordRequest(platform: string, userId: number, accountId?: string): Promise<void> {
    await this.operation(platform, userId, accountId, 'record');
  }

  /**
   * Wait until next request is allowed (with optional timeout)
   */
  public async waitForNextSlot(
    platform: string,
    userId: number,
    accountId?: string,
    timeoutMs: number = 60000 // Default 1 minute timeout
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const check = await this.claimRequest(platform, userId, accountId);
      
      if (check.allowed) {
        return true;
      }

      // Wait for suggested retry time (or 1 second minimum)
      const waitMs = check.retryAfter ? check.retryAfter * 1000 : 1000;
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, timeoutMs - (Date.now() - startTime))));
    }

    logger.warn(`[SmartThrottling] Timeout waiting for ${platform} slot after ${timeoutMs}ms`);
    return false;
  }

  /**
   * Get current usage stats for a platform
   */
  public async getUsageStats(
    platform: string,
    userId: number,
    accountId?: string
  ): Promise<UsageStats> {
    return this.getOrCreateStats(platform, userId, accountId);
  }

  /**
   * Get usage stats for all platforms for a user
   * Phase 4.5 / SERV-007: replaced `redis.keys()` (which is O(N) blocking and
   * unsafe on large datasets) with `scanStream()` (cursor-based, non-blocking).
   */
  public async getAllUsageStats(userId: number): Promise<UsageStats[]> {
    const pattern = `throttle:*:${userId}*`;
    const stats: UsageStats[] = [];
    // scanStream returns an async iterable of MATCH batches.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (this.redis as any).scanStream
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (this.redis as any).scanStream({ match: pattern, count: 100 })
      : null;
    if (!stream) {
      // Fallback: small keyspace + no scanStream → use KEYS (still O(N) but limited).
      const keys = await this.redis.keys(pattern);
      for (const key of keys) await this.collectStat(key, stats, userId);
      return stats;
    }
    return new Promise((resolve, reject) => {
      const keyBatches: string[][] = [];
      stream.on('data', (keys: string[]) => { keyBatches.push(keys); });
      stream.on('end', () => {
        void (async () => {
          for (const batch of keyBatches) {
            for (const key of batch) await this.collectStat(key, stats, userId);
          }
          resolve(stats);
        })().catch(reject);
      });
      stream.on('error', reject);
    });
  }

  private async collectStat(key: string, out: UsageStats[], userId: number): Promise<void> {
    const raw = await this.redis.get(key);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as UsageStats;
      if (s.userId !== userId || out.some(item => item.platform === s.platform && item.accountId === s.accountId)) return;
      out.push(await this.getUsageStats(s.platform, userId, s.accountId));
    } catch { /* skip corrupted entry */ }
  }

  /**
   * Reset usage stats for a platform (admin function)
   */
  public async resetUsage(platform: string, userId: number, accountId?: string): Promise<void> {
    const key = this.getCacheKey(platform, userId, accountId);
    await this.redis.del(`throttle:${key}`);
    logger.info(`[SmartThrottling] Reset usage stats for ${platform}`);
  }

  /**
   * Get recommended batch size for bulk operations
   */
  public getRecommendedBatchSize(platform: string): number {
    const limits = this.platformLimits[platform];
    
    if (!limits) return 10; // Default
    
    // Conservative batch size: 20% of hourly limit or 50, whichever is smaller
    const batchSize = Math.min(Math.floor((limits.hourlyLimit || limits.dailyLimit) * 0.2), 50);
    return Math.max(batchSize, 5); // Minimum 5
  }

  /**
   * Calculate optimal delay between messages for bulk send
   */
  public calculateOptimalDelay(
    platform: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    messageCount: number
  ): number {
    const limits = this.platformLimits[platform];
    
    if (!limits) return 1000; // Default 1 second

    // Calculate delay to stay within hourly limit
    const hourlyLimit = limits.hourlyLimit || Math.floor(limits.dailyLimit / 24);
    const delayForHourlyLimit = Math.ceil((3600 * 1000) / hourlyLimit);

    // Use the higher of: minimum delay or calculated delay for hourly limit
    return Math.max(limits.minDelayMs || 0, delayForHourlyLimit);
  }

  /**
   * Check if we're approaching rate limits (warn user)
   */
  public async isApproachingLimit(
    platform: string,
    userId: number,
    threshold: number = 0.8,
    accountId?: string
  ): Promise<boolean> {
    const stats = await this.getUsageStats(platform, userId, accountId);
    const limits = this.platformLimits[platform];
    if (!limits) return false;
    return stats.todayCount >= limits.dailyLimit * threshold;
  }

  /**
   * Get remaining quota for today
   */
  public async getRemainingQuota(
    platform: string,
    userId: number,
    accountId?: string
  ): Promise<{ daily: number; hourly: number; minute: number }> {
    const stats = await this.getUsageStats(platform, userId, accountId);
    const limits = this.platformLimits[platform];
    if (!limits) {
      return { daily: Infinity, hourly: Infinity, minute: Infinity };
    }
    return {
      daily: Math.max(0, limits.dailyLimit - stats.todayCount),
      hourly: limits.hourlyLimit ? Math.max(0, limits.hourlyLimit - stats.hourCount) : Infinity,
      minute: limits.minuteLimit ? Math.max(0, limits.minuteLimit - stats.minuteCount) : Infinity,
    };
  }

  /**
   * Update platform limits (admin function)
   */
  public updatePlatformLimits(platform: string, limits: Partial<PlatformLimits>): void {
    if (this.platformLimits[platform]) {
      this.platformLimits[platform] = {
        ...this.platformLimits[platform],
        ...limits,
      };
      logger.info(`[SmartThrottling] Updated limits for ${platform}`);
    } else {
      logger.warn(`[SmartThrottling] Unknown platform: ${platform}`);
    }
  }

  /**
   * Helper functions
   */
  private getCacheKey(platform: string, userId: number, accountId?: string): string {
    return `${platform}:${userId}${accountId ? ':' + accountId : ''}`;
  }

  private async getOrCreateStats(
    platform: string,
    userId: number,
    accountId?: string
  ): Promise<UsageStats> {
    return (await this.operation(platform, userId, accountId, 'peek')).stats;
  }

  private async operation(platform: string, userId: number, accountId: string | undefined, mode: 'peek' | 'record' | 'claim') {
    const key = `throttle:${this.getCacheKey(platform, userId, accountId)}`;
    // A pre-read is used only to translate old ISO timestamps. Lua alone reads,
    // checks and mutates authoritative counters, preventing lost increments.
    const raw = await this.redis.get(key);
    const old = raw ? JSON.parse(raw) : null;
    const lastMs = old ? Number(old.lastRequestMs ?? new Date(old.lastRequestAt).getTime()) : 0;
    const legacy = {lastRequestMs:lastMs, dayBucket: Math.floor(lastMs / 86400000), hourBucket: Math.floor(lastMs / 3600000), minuteBucket: Math.floor(lastMs / 60000)};
    const initial = { platform, userId, accountId, todayCount:0, hourCount:0, minuteCount:0,
      lastRequestAt:0, lastRequestMs:lastMs, resetAt:0 };
    const result = JSON.parse(String(await this.redis.eval(THROTTLE_OPERATION_LUA, 1, key,
      -1, JSON.stringify(this.platformLimits[platform] || {}), mode, JSON.stringify(initial), JSON.stringify(legacy)))) as {
        allowed:boolean; bucket?:string; retryAfter:number; stats:UsageStats;
      };
    result.stats.lastRequestAt = new Date(result.stats.lastRequestAt);
    result.stats.resetAt = new Date(result.stats.resetAt);
    return {allowed:result.allowed, reason:result.allowed ? undefined : `${result.bucket} limit reached for ${platform}`,
      retryAfter:result.allowed ? undefined : result.retryAfter, stats:result.stats};
  }

  private cleanupExpiredStats(): void {
    // Redis TTL handles expiry automatically.
    // No-op — left for compatibility with THROTTLE_STATS_CLEANUP_INTERVAL_MS.
  }

  /**
   * Get platform limits configuration
   */
  public getPlatformLimits(platform: string): PlatformLimits | null {
    return this.platformLimits[platform] || null;
  }

  /**
   * List all supported platforms
   */
  public getSupportedPlatforms(): string[] {
    return Object.keys(this.platformLimits);
  }
}
