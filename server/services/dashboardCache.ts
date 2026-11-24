import { getRedisConnection } from '../infrastructure/redis.js';
import { logger } from '../utils/logger.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';

export const DASHBOARD_CACHE_TTL_SECONDS = 5 * 60;

export function dashboardCacheKey(userId: number): string {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Dashboard account does not match the active business');
  return `dashboard:user:${userId}:business:${scope.businessProfileId}`;
}

export async function invalidateDashboardCache(userId: number): Promise<void> {
  try {
    // Wallet changes affect every business in this account. SCAN avoids a
    // blocking KEYS operation and also removes the pre-migration cache key.
    const redis = getRedisConnection();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `dashboard:user:${userId}:business:*`, 'COUNT', 100);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    await redis.del(`dashboard:user:${userId}`);
  } catch (err) {
    // Cache invalidation is best-effort: the TTL ensures eventual consistency.
    logger.warn({ err, userId }, '[dashboard] cache invalidation failed');
  }
}
