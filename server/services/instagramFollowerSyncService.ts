/**
 * Instagram Follower Sync Service
 * 
 * Periodically syncs current followers via the Instagram Graph API,
 * compares against stored `instagram_followers` table, and queues welcome messages
 * for new followers via BullMQ with randomized delays.
 */

import { db } from '../models/db.js';
 
import { eq, and } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { getInstagramApiForUser } from './instagramGraphApiService.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncResult {
  userId: number;
  totalFetched: number;
  newFollowers: number;
  welcomeMessagesQueued: number;
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Sync followers for a single user.
 * - Fetches current followers from Instagram service
 * - Compares with DB records
 * - Inserts new followers
 * - Queues welcome messages for new followers if enabled
 */
async function syncFollowersForUser(userId: number): Promise<SyncResult> {
  const result: SyncResult = { userId, totalFetched: 0, newFollowers: 0, welcomeMessagesQueued: 0 };

  // 1. Get user's Instagram settings
  const creds = await db.select()
    .from(channelCredentialsTable)
    .where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.platform, 'instagram')
    ))
    .limit(1);

  if (creds.length === 0) return result;

  // 1.5 Optimization: Check follower count via Graph API before fetching list
  try {
    const graphApi = await getInstagramApiForUser(userId);
    if (graphApi) {
      const accountInfo = await graphApi.getBusinessAccountInfo();
      if (accountInfo.success && accountInfo.account?.followersCount !== undefined) {
        const currentCount = accountInfo.account.followersCount;
        const redis = getRedisConnection();
        const redisKey = `instagram:followers_count:${userId}`;
        const lastKnownCountStr = await redis.get(redisKey);
        
        if (lastKnownCountStr !== null) {
          const lastKnownCount = parseInt(lastKnownCountStr, 10);
          if (currentCount === lastKnownCount) {
            logger.info({ userId, count: currentCount }, '[FollowerSync] Follower count unchanged, skipping list fetch');
            return result;
          }
        }
        
        // Update Redis with the new count (expire in 7 days just in case)
        await redis.set(redisKey, currentCount, 'EX', 7 * 24 * 60 * 60);
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, '[FollowerSync] Failed to check follower count via Graph API, proceeding with full sync');
  }

  // 2. Fetch current followers from Instagram
  // Note: Instagram Graph API doesn't support listing followers.
  // Full follower list fetch is not currently available after Flask microservice removal.
  // This sync requires an official follower-list endpoint.
  logger.warn({ userId }, '[FollowerSync] Follower list fetch not available — Graph API only provides follower count, not the list');
  return result;
}

/**
 * Run follower sync for ALL users with Instagram configured.
 * Called by the cron job every few hours.
 */
export async function processInstagramFollowerSync(): Promise<void> {
  try {
    // Find all users with Instagram credentials and welcome messages enabled
    const usersWithInstagram = await db.select({
      userId: channelCredentialsTable.userId,
    })
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.platform, 'instagram'),
        eq(channelCredentialsTable.isActive, true)
      ));

    if (usersWithInstagram.length === 0) return;

    logger.info({ userCount: usersWithInstagram.length }, '[FollowerSync] Starting sync cycle');

    for (const { userId } of usersWithInstagram) {
      if (userId === null) continue;
      try {
        const result = await syncFollowersForUser(userId);
        if (result.newFollowers > 0) {
          logger.info(result, '[FollowerSync] User sync completed with new followers');
        }
      } catch (err) {
        logger.error({ err, userId }, '[FollowerSync] Error syncing user');
      }
      // Small delay between users to avoid hammering the service
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err) {
    logger.error({ err }, '[FollowerSync] Sync cycle failed');
  }
}

export default { processInstagramFollowerSync, syncFollowersForUser };
